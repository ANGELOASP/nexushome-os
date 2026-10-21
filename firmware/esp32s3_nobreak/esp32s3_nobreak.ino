// ============================================================
// NexusHome OS — Firmware ESP32-S3 · Nobreak (tela T4 do QAU, barramento RS-485 D)
// ------------------------------------------------------------
// Implementa o §12 de docs/projeto-unificado.md. A tela Waveshare ESP32-S3-Touch-LCD-4.3B
// é o ÚNICO mestre Modbus RTU do barramento D (9600 bps, 8N2) e:
//
//   · lê o PZEM-017 do banco LiFePO4 24 V (endereço 41, shunt 300 A / 75 mV no negativo)
//     e os PZEM-016 da entrada da rede (42) e da saída do inversor (43), ~1 volta por segundo
//   · detecta a FALTA DE ENERGIA (rede < 180 V por 5 s) e a volta da rede → alertas
//   · estima o SoC por contagem de Ah (recalibra em 100 % e 10 %) e a autonomia
//   · publica o estado no NexusHome (iot-gateway, POST em lote a cada 15 s, "source":"nobreak")
//     e o histórico (battery_soc, battery_voltage, grid_voltage, power_backup_w, energy_watts)
//     a cada 1 min — as quatro primeiras métricas exigem a migração 025
//   · mostra tudo na tela touch (ui.cpp, USE_DISPLAY 1)
//
// Linguagem: C++ (framework Arduino para ESP32, core 3.x). Placa: "ESP32S3 Dev Module".
// Modbus RTU (CRC16, funções 03/04/06) feito aqui, sem biblioteca, como na energia e na água.
// A lógica de SoC, autonomia e falta de energia está em nobreak_logic.h (funções puras,
// testáveis no PC).
//
// Tudo marcado CONFIRMAR é dado de fabricante que precisa ser conferido no manual do
// aparelho comprado antes de confiar no número da tela.
// ============================================================

#include <WiFi.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <math.h>
#include "ui.h"
#include "nobreak_logic.h"
#include "nobreak_meter.h"
// #define NEXUS_TLS_INSEGURO 1   // SÓ diagnóstico: HTTPS sem verificar o certificado (ver nh_tls.h)
#include "nh_tls.h"             // HTTPS verificado (pacote de CAs do core) + watchdog

// ---------------- Tela touch (Waveshare ESP32-S3-Touch-LCD-4.3B) ----------------
// 1 = mostra a interface do nobreak (ui.cpp). 0 = sem tela (outra placa ESP32-S3).
// Bibliotecas (Library Manager): ESP32_Display_Panel 1.0.4 e lvgl 8.4.0 — o script
// scripts/instalar-arduino.ps1 instala as duas.
#define USE_DISPLAY 1

// ---------------- Wi-Fi e NexusHome ----------------
#define WIFI_SSID        "SUA_REDE_WIFI"          // só 2.4 GHz
#define WIFI_PASSWORD    "SUA_SENHA_WIFI"
#define GATEWAY_URL      "https://gfjxcsvxhaojbtuixpjh.supabase.co/functions/v1/iot-gateway"
#define DEVICE_SECRET    "SUA_IOT_DEVICE_SECRET"   // = IOT_DEVICE_SECRET do Supabase

// "Nobreak — banco LiFePO4" (tipo solar, §15 do projeto unificado). Vazio = não publica.
const char* DEVICE_NOBREAK = "b4000000-0000-4000-8000-000000000001";

#define PUBLISH_INTERVAL_MS   15000     // estado ao vivo (painel/3D/P4)
#define HISTORY_INTERVAL_MS   60000     // histórico: 1 ponto por minuto de cada métrica

// ---------------- RS-485 (barramento D) ----------------
// ESP32-S3-Touch-LCD-4.3B: GPIO43/44 (direção automática, sem pino DE).
// O firmware troca RX/TX sozinho se ninguém responder (RS485_AUTO_SWAP).
#define RS485_PIN_A       43
#define RS485_PIN_B       44
#define RS485_AUTO_SWAP   true
#define RS485_DE_PIN      -1     // só com transceptor externo de controle manual
#define RS485_BAUD        9600   // PZEM-016 e PZEM-017 só falam 9600
// O PZEM-017 usa 8N2; o PZEM-016 é 8N1 mas aceita ouvir 2 stop bits (§2 item 22 — CONFIRMAR
// na bancada). Se os PZEM-016 não responderem em 8N2, use 1 aqui e grave o PZEM-017 em 8N1
// (ou dê a ele uma porta própria).
#define NOBREAK_STOPBITS  2
#define MB_TIMEOUT_MS     200    // o PZEM responde em ~50–100 ms
#define MB_RETRIES        2
#define CYCLE_MS          1000   // uma volta pelos 3 medidores por segundo

// ---------------- Medidores do barramento D (§5.2) ----------------
#define PZEM_BANK_ADDR    41     // PZEM-017 + shunt 300 A / 75 mV (negativo do banco)
#define PZEM_GRID_ADDR    42     // PZEM-016 (TC 100 A) — entrada da rede para o inversor (QDG)
#define PZEM_OUT_ADDR     43     // PZEM-016 (TC 100 A) — saída do inversor (QDC, cargas críticas)
#define PZEM_ADDR_REG     0x0002 // holding com o endereço (PZEM-016 e PZEM-017)
#define PZEM_GENERAL      0xF8   // endereço "geral" (responde qualquer PZEM — UM só no barramento)
#define METER_FAILS_OFF   3      // leituras seguidas sem resposta → medidor "offline"

// PZEM-016 (CA): entradas (função 04), 10 registradores a partir de 0x0000, 32 bits = palavra
// BAIXA primeiro: 0 tensão 0,1 V · 1–2 corrente 0,001 A · 3–4 potência 0,1 W · 5–6 energia 1 Wh
// · 7 frequência 0,1 Hz · 8 fator de potência 0,01 · 9 alarme. (Igual ao firmware de energia.)
#define PZEM016_REGS      10

// PZEM-017 (CC) — CONFIRMAR no manual do lote comprado (Peacefair PZEM-003/017):
//   entradas (função 04) a partir de 0x0000:
//     0 tensão × 0,01 V · 1 corrente × 0,01 A · 2–3 potência × 0,1 W (32 bits, palavra BAIXA
//     primeiro) · 4–5 energia × 1 Wh (32 bits) · 6 alarme de alta tensão · 7 alarme de baixa
//     tensão (0xFFFF = em alarme, 0x0000 = normal)
//   holding (03/06): 0x0000 limiar de alta tensão · 0x0001 limiar de baixa tensão ·
//     0x0002 endereço · 0x0003 faixa do shunt (0x0000 = 100 A, 0x0001 = 50 A, 0x0002 = 200 A,
//     0x0003 = 300 A)
#define PZEM017_REGS       8          // CONFIRMAR
#define PZEM017_V_SCALE    0.01f      // CONFIRMAR
#define PZEM017_A_SCALE    0.01f      // CONFIRMAR
#define PZEM017_W_SCALE    0.1f       // CONFIRMAR
#define PZEM017_SHUNT_REG  0x0003     // CONFIRMAR
// Faixa do shunt gravada no boot se for diferente: 3 = 300 A (o shunt do §4.1). -1 = não mexe.
#define SHUNT_RANGE_CODE   3          // CONFIRMAR (código 0x0003 = 300 A)

// ---------------- Banco de baterias (§4.1) ----------------
#define BANK_AH            200.0f     // 2 × LiFePO4 24 V 100 Ah em paralelo
#define BANK_NOMINAL_V     25.6f
#define CHARGE_EFF         0.99f      // eficiência coulômbica do LiFePO4 na carga
#define SOC_FULL_V         27.6f      // recalibra para 100 %: tensão ≥ 27,6 V (flutuação)...
#define SOC_FULL_A         5.0f       // ...e corrente < 5 A...
#define SOC_FULL_MS        600000UL   // ...por 10 min
#define SOC_EMPTY_V        24.0f      // recalibra para 10 %: tensão ≤ 24,0 V (corte do inversor)...
#define SOC_EMPTY_PCT      10.0f
#define SOC_EMPTY_MS       10000UL    // ...por 10 s (ignora o afundamento na partida de um motor)
#define SOC_MAX_DT_MS      30000UL    // maior intervalo integrado de uma vez (medidor parado)
#define SOC_DEFAULT        100.0f     // primeiro boot (sem SoC salvo): recalibra na 1ª flutuação
#define SOC_SAVE_MS        300000UL   // grava o SoC na flash a cada 5 min (e na queda da rede)
// Sentido da corrente (o shunt do PZEM-017 não tem sinal): 0 = sem rede descarrega, com rede
// carrega (§12; inversor em prioridade SUB/UPS, sem painéis FV). 1 = também descarrega quando a
// entrada da rede for menor que a saída do inversor (prioridade SBU sem FV) — ver nobreak_logic.h.
#define SOC_DIR_BALANCE    0
#define DIR_MARGIN_W       40.0f
// Autonomia = (SoC − reserva) × Ah × V nominal × eficiência do inversor ÷ média da saída (10 min).
// Com 10 % e 0,92: banco cheio ≈ 4,24 kWh úteis (o "≈ 4,2 kWh" do §4.1).
#define AUTONOMY_FLOOR_SOC 10.0f
#define INVERTER_EFF       0.92f

// ---------------- Rede (falta de energia) ----------------
#define GRID_MIN_V         180.0f     // rede presente = tensão do PZEM 42 ≥ 180 V
#define GRID_FAIL_MS       5000UL     // abaixo disso (ou PZEM 42 mudo) por 5 s → falta de energia
#define GRID_RETURN_MS     3000UL     // rede de volta por 3 s → "Energia da rede voltou"

// ---------------- Alertas ----------------
#define SOC_WARN_PCT       20.0f      // warning
#define SOC_CRIT_PCT       10.0f      // critical
#define SOC_HYST_PCT       5.0f       // histerese para alertar de novo
#define BANK_LOW_V         23.5f      // tensão do banco ≤ 23,5 V por 5 s → critical
#define BANK_LOW_REARM_V   24.5f
#define BANK_LOW_MS        5000UL

// ============================================================
// Modbus RTU mínimo (mestre) — mesmo núcleo dos firmwares de água e energia
// ============================================================
HardwareSerial RS485(1);

uint16_t mbCrc(const uint8_t* buf, size_t len) {
  uint16_t crc = 0xFFFF;
  for (size_t i = 0; i < len; i++) {
    crc ^= buf[i];
    for (int b = 0; b < 8; b++) crc = (crc & 1) ? (crc >> 1) ^ 0xA001 : crc >> 1;
  }
  return crc;
}

void mbSend(uint8_t* frame, size_t lenNoCrc) {
  nhWdtAlimenta();   // cada transação é curta, mas uma volta com escravos mudos soma dezenas de segundos
  uint16_t crc = mbCrc(frame, lenNoCrc);
  frame[lenNoCrc] = crc & 0xFF;
  frame[lenNoCrc + 1] = crc >> 8;
  while (RS485.available()) RS485.read();
  if (RS485_DE_PIN >= 0) digitalWrite(RS485_DE_PIN, HIGH);
  RS485.write(frame, lenNoCrc + 2);
  RS485.flush();
  if (RS485_DE_PIN >= 0) digitalWrite(RS485_DE_PIN, LOW);
  delay(2);   // silêncio mínimo entre quadros
}

// Lê `expect` bytes (ou a exceção, 5 bytes). >0 = ok · -1 sem resposta · -2 exceção · -3 CRC
int mbReceive(uint8_t* resp, size_t expect, uint8_t slave, uint8_t func) {
  size_t n = 0;
  unsigned long t0 = millis();
  while (millis() - t0 < MB_TIMEOUT_MS && n < expect) {
    if (RS485.available()) {
      resp[n++] = RS485.read();
      if (n == 5 && resp[1] == (func | 0x80)) break;
    } else {
      delay(1);
    }
  }
  if (n < 5 || (slave != PZEM_GENERAL && resp[0] != slave)) return -1;
  if (resp[1] == (func | 0x80)) return -2;
  if (n < expect) return -1;
  uint16_t crc = mbCrc(resp, expect - 2);
  if (resp[expect - 2] != (crc & 0xFF) || resp[expect - 1] != (crc >> 8)) return -3;
  return (int)n;
}

bool mbReadRegs(uint8_t slave, uint8_t func, uint16_t addr, uint16_t count, uint16_t* out, int retries = MB_RETRIES) {
  uint8_t req[8] = { slave, func, (uint8_t)(addr >> 8), (uint8_t)addr, (uint8_t)(count >> 8), (uint8_t)count };
  uint8_t resp[5 + 2 * 16];
  size_t expect = 5 + 2 * count;
  if (count == 0 || count > 16) return false;
  for (int attempt = 0; attempt <= retries; attempt++) {
    mbSend(req, 6);
    if (mbReceive(resp, expect, slave, func) > 0 && resp[2] == 2 * count) {
      for (uint16_t i = 0; i < count; i++) out[i] = (resp[3 + 2 * i] << 8) | resp[4 + 2 * i];
      return true;
    }
    delay(15);
  }
  return false;
}

bool mbWriteReg(uint8_t slave, uint16_t addr, uint16_t value) {
  uint8_t req[8] = { slave, 0x06, (uint8_t)(addr >> 8), (uint8_t)addr, (uint8_t)(value >> 8), (uint8_t)value };
  uint8_t resp[8];
  for (int attempt = 0; attempt <= MB_RETRIES; attempt++) {
    mbSend(req, 6);
    if (mbReceive(resp, 8, slave, 0x06) > 0) return true;
    delay(20);
  }
  return false;
}

bool rs485Swapped = false;
void rs485Begin() {
  int rx = rs485Swapped ? RS485_PIN_B : RS485_PIN_A;
  int tx = rs485Swapped ? RS485_PIN_A : RS485_PIN_B;
  RS485.end();
  RS485.begin(RS485_BAUD, NOBREAK_STOPBITS == 2 ? SERIAL_8N2 : SERIAL_8N1, rx, tx);
  Serial.printf("[rs485] UART RX=GPIO%d TX=GPIO%d · 9600 8N%d\n", rx, tx, NOBREAK_STOPBITS == 2 ? 2 : 1);
}
bool mbPing(uint8_t slave, uint8_t func = 0x04) {
  uint8_t req[8] = { slave, func, 0x00, 0x00, 0x00, 0x01 };
  uint8_t resp[8];
  mbSend(req, 6);
  int r = mbReceive(resp, 7, slave, func);
  return r > 0 || r == -2;
}
bool anySlaveAnswers() {
  // o 41 (banco) e o 43 (saída do inversor) respondem mesmo na falta de energia; o 42 não
  return mbPing(PZEM_BANK_ADDR) || mbPing(PZEM_OUT_ADDR) || mbPing(PZEM_GRID_ADDR);
}
void rs485AutoDetect() {
  if (!RS485_AUTO_SWAP || anySlaveAnswers()) return;
  rs485Swapped = !rs485Swapped;
  rs485Begin();
  if (!anySlaveAnswers()) { rs485Swapped = !rs485Swapped; rs485Begin(); }
}

// ============================================================
// Medidores
// ============================================================
enum { M_BANK = 0, M_GRID = 1, M_OUT = 2, METER_COUNT = 3 };
Meter M[METER_COUNT] = {
  { PZEM_BANK_ADDR, true,  "PZEM-017", "Banco 24 V" },
  { PZEM_GRID_ADDR, false, "PZEM-016", "Entrada da rede" },
  { PZEM_OUT_ADDR,  false, "PZEM-016", "Saída do inversor" },
};

static inline uint32_t lo_hi(uint16_t lo, uint16_t hi) { return ((uint32_t)hi << 16) | lo; }

bool readPzem016(uint8_t slave, Meter& m) {
  uint16_t r[PZEM016_REGS];
  if (!mbReadRegs(slave, 0x04, 0x0000, PZEM016_REGS, r, 1)) return false;
  m.v   = r[0] / 10.0f;
  m.a   = lo_hi(r[1], r[2]) / 1000.0f;
  m.w   = lo_hi(r[3], r[4]) / 10.0f;
  m.kwh = lo_hi(r[5], r[6]) / 1000.0f;
  m.hz  = r[7] / 10.0f;
  m.pf  = r[8] / 100.0f;
  return true;
}

bool readPzem017(uint8_t slave, Meter& m) {
  uint16_t r[PZEM017_REGS];
  if (!mbReadRegs(slave, 0x04, 0x0000, PZEM017_REGS, r, 1)) return false;
  m.v   = r[0] * PZEM017_V_SCALE;
  m.a   = r[1] * PZEM017_A_SCALE;
  m.w   = lo_hi(r[2], r[3]) * PZEM017_W_SCALE;
  m.kwh = lo_hi(r[4], r[5]) / 1000.0f;
  m.hvAlarm = r[6] != 0;
  m.lvAlarm = r[7] != 0;
  m.hz = m.pf = 0;
  return true;
}

// ============================================================
// Estado do nobreak (o loop escreve; a telemetria e a tela leem o retrato `live`)
// ============================================================
struct Live {
  float soc;
  uint8_t socLevel;
  bool battOk; float battV, battA, battW, battKwh;
  bool gridAnswered; float gridV, gridW, gridHz;
  bool outOk; float outV, outW, outKwh;
  bool gridFail, onBattery, battLowV;
  float autonomyH, avgOutW;
  bool meterOk[METER_COUNT];
  int metersOk;
  unsigned long cycleMs;
};
Live live;
portMUX_TYPE stateMux = portMUX_INITIALIZER_UNLOCKED;   // telemetria lê `live` no outro núcleo

const nb::SocParams SOC_P = { BANK_AH, CHARGE_EFF, SOC_FULL_V, SOC_FULL_A, SOC_FULL_MS,
                              SOC_EMPTY_V, SOC_EMPTY_MS, SOC_EMPTY_PCT, SOC_MAX_DT_MS };
const nb::GridParams GRID_P = { GRID_MIN_V, GRID_FAIL_MS, GRID_RETURN_MS };

nb::SocState socState;
nb::GridDetector grid;
nb::MovingAvg<60> outAvg;          // 60 × 10 s = média dos últimos 10 min da saída do inversor
nb::LowAlarm bankLow;
uint8_t socLevel = 0;
bool discharging = false;
bool socTimed = false;
unsigned long lastSocAt = 0, lastSocSave = 0, lastCycleAt = 0, cycleMs = 0;
float savedSoc = -1;
bool shuntChecked = false;
bool failBeforeBoot = false;       // reiniciou no meio de uma falta: a duração dela é desconhecida
Preferences prefs;

// alertas pendentes para o próximo POST (o loop escreve, a telemetria envia)
#define ALERT_SLOTS 8
struct PendingAlert { char severity[10]; char message[160]; };
PendingAlert alertQ[ALERT_SLOTS];
int alertCount = 0;
int alertInFlight = 0;                // os primeiros N da fila estão no POST em andamento
// Mesma política da tela de segurança (T3): com a fila cheia (Wi-Fi fora na própria falta de energia),
// um crítico ("Falta de energia", bateria crítica) toma o lugar do aviso mais antigo que não é crítico.
void raiseAlert(const char* severity, const char* fmt, ...) {
  char msg[160];
  va_list ap; va_start(ap, fmt); vsnprintf(msg, sizeof(msg), fmt, ap); va_end(ap);
  Serial.printf("[alerta %s] %s\n", severity, msg);
  bool critical = !strcmp(severity, "critical");
  portENTER_CRITICAL(&stateMux);
  if (alertCount >= ALERT_SLOTS && critical) {
    for (int a = 0; a < alertCount; a++) {
      if (strcmp(alertQ[a].severity, "critical")) {
        memmove(alertQ + a, alertQ + a + 1, sizeof(PendingAlert) * (alertCount - a - 1));
        alertCount--;
        if (a < alertInFlight) alertInFlight--;   // já está no POST em andamento: não remover outro no lugar dele
        break;
      }
    }
  }
  if (alertCount < ALERT_SLOTS) {
    strncpy(alertQ[alertCount].severity, severity, sizeof(alertQ[0].severity) - 1);
    alertQ[alertCount].severity[sizeof(alertQ[0].severity) - 1] = 0;
    strncpy(alertQ[alertCount].message, msg, sizeof(alertQ[0].message) - 1);
    alertQ[alertCount].message[sizeof(alertQ[0].message) - 1] = 0;
    alertCount++;
  }
  portEXIT_CRITICAL(&stateMux);
}

// ---- persistência (SoC e "estava em falta" sobrevivem a um reinício) ----
void saveSoc(const char* why) {
  float s = socState.soc;
  prefs.putFloat("soc", s);
  savedSoc = s;
  lastSocSave = millis();
  Serial.printf("[soc] %.1f %% gravado na flash (%s)\n", s, why);
}

void setSoc(float pct, const char* why) {
  nb::socInit(socState, pct);
  socLevel = nb::socAlarmLevel(0, socState.soc, SOC_WARN_PCT, SOC_CRIT_PCT, SOC_HYST_PCT);   // sem alerta pelo ajuste manual
  saveSoc(why);
}

// Pedidos da tela e da serial chegam por esta fila e são executados no loop
QueueHandle_t requestQueue;
void submitRequest(const UiRequest& r) { if (requestQueue) xQueueSend(requestQueue, &r, 0); }

void processRequests() {
  UiRequest r;
  while (requestQueue && xQueueReceive(requestQueue, &r, 0) == pdTRUE) {
    if (r.type == UI_REQ_SET_SOC && r.value >= 0 && r.value <= 100) setSoc(r.value, "ajuste manual");
  }
}

// ---- faixa do shunt do PZEM-017 (holding 0x0003) ----
// Devolve o código lido (0..3) ou -1 sem resposta.
int shuntRead() {
  uint16_t v;
  if (!mbReadRegs(PZEM_BANK_ADDR, 0x03, PZEM017_SHUNT_REG, 1, &v)) return -1;
  return v;
}
const char* shuntName(int code) {
  switch (code) { case 0: return "100 A"; case 1: return "50 A"; case 2: return "200 A"; case 3: return "300 A"; default: return "?"; }
}
bool shuntWrite(int code) {
  if (code < 0 || code > 3) return false;
  bool ok = mbWriteReg(PZEM_BANK_ADDR, PZEM017_SHUNT_REG, (uint16_t)code);
  Serial.printf("[shunt] gravar faixa %s no PZEM-017 (%u): %s\n", shuntName(code), PZEM_BANK_ADDR, ok ? "ok" : "SEM RESPOSTA");
  return ok;
}
// No boot (ou na 1ª vez que o 41 responder): confere a faixa e grava se diferente.
void shuntEnsure() {
  if (shuntChecked || SHUNT_RANGE_CODE < 0) { shuntChecked = true; return; }
  int cur = shuntRead();
  if (cur < 0) return;                       // tenta de novo quando o 41 responder
  shuntChecked = true;
  if (cur == SHUNT_RANGE_CODE) { Serial.printf("[shunt] PZEM-017 já está em %s\n", shuntName(cur)); return; }
  Serial.printf("[shunt] PZEM-017 em %s (código %d) — o shunt é de %s\n", shuntName(cur), cur, shuntName(SHUNT_RANGE_CODE));
  if (!shuntWrite(SHUNT_RANGE_CODE)) {
    shuntChecked = false;
    return;
  }
  int now = shuntRead();
  if (now != SHUNT_RANGE_CODE) {
    raiseAlert("warning", "PZEM-017 (banco) não aceitou a faixa do shunt %s: a corrente da bateria pode estar errada", shuntName(SHUNT_RANGE_CODE));
  }
}

// ============================================================
// Uma volta pelos medidores + lógica (falta de energia, SoC, alertas)
// ============================================================
void pollMeters() {
  for (int k = 0; k < METER_COUNT; k++) {
    Meter& m = M[k];
    Meter tmp = m;
    bool ok = m.dc ? readPzem017(m.addr, tmp) : readPzem016(m.addr, tmp);
    portENTER_CRITICAL(&stateMux);
    if (ok) {
      m = tmp;
      m.answered = true;
      m.ok = true;
      m.fails = 0;
    } else {
      m.answered = false;
      if (m.fails < 255) m.fails++;
      if (m.fails >= METER_FAILS_OFF) { m.ok = false; m.w = m.a = 0; }
    }
    portEXIT_CRITICAL(&stateMux);
  }
}

void checkMeterAlerts() {
  for (int k = 0; k < METER_COUNT; k++) {
    Meter& m = M[k];
    if (m.ok) {
      if (m.offAlerted) Serial.printf("[medidor] %s %u (%s) voltou a responder\n", m.model, m.addr, m.role);
      m.offAlerted = false;
      continue;
    }
    if (m.offAlerted) continue;
    m.offAlerted = true;
    // O PZEM-016 da entrada é alimentado pela rede: sem rede ele não responde. Esse caso vira o
    // alerta de falta de energia, não "medidor sem resposta".
    if (k == M_GRID) {
      Serial.printf("[medidor] %s %u (%s) sem resposta — sem tensão da rede ou cabo/endereço\n", m.model, m.addr, m.role);
      continue;
    }
    raiseAlert("warning", "Nobreak: medidor %s (endereço %u, %s) sem resposta no barramento RS-485 D",
               m.model, m.addr, m.role);
  }
}

void endOfCycle() {
  unsigned long now = millis();
  cycleMs = lastCycleAt ? now - lastCycleAt : 0;
  lastCycleAt = now;
  const Meter& bank = M[M_BANK];
  const Meter& gridM = M[M_GRID];
  const Meter& out = M[M_OUT];

  // ---- falta de energia ----
  bool gridNow = nb::gridSamplePresent(gridM.answered, gridM.v, GRID_MIN_V);
  nb::GridEvent ev = nb::gridStep(grid, gridNow, (uint32_t)now, GRID_P);

  // ---- sentido da corrente do banco ----
  // Com leitura do 42 nesta volta, o sentido sai dela; sem leitura, só o estado FILTRADO decide
  // (falta confirmada = descarga). Sem leitura e sem falta confirmada (falha Modbus isolada ou os
  // primeiros 5 s de uma queda) o sentido é desconhecido: a corrente NÃO é integrada nesta volta —
  // o tempo fica para a próxima volta com sentido conhecido (até SOC_MAX_DT_MS).
  int8_t dir = nb::batteryDirection(gridM.answered, gridM.v, grid.fail, GRID_MIN_V, SOC_DIR_BALANCE != 0,
                                    gridM.answered && out.ok, gridM.w, out.w, DIR_MARGIN_W);
  if (dir != nb::DIR_UNKNOWN) discharging = dir == nb::DIR_DISCHARGE;

  // ---- SoC ----
  if (bank.answered && dir != nb::DIR_UNKNOWN) {
    uint32_t dt = socTimed ? (uint32_t)(now - lastSocAt) : 0;
    socTimed = true;
    lastSocAt = now;
    nb::SocCal cal = nb::socStep(socState, SOC_P, bank.v, bank.a, discharging, dt, (uint32_t)now);
    if (cal == nb::CAL_FULL) { Serial.println("[soc] recalibrado para 100 % (flutuação ≥ 27,6 V, < 5 A por 10 min)"); saveSoc("recalibração 100 %"); }
    if (cal == nb::CAL_EMPTY) { Serial.println("[soc] recalibrado para 10 % (banco ≤ 24,0 V)"); saveSoc("recalibração 10 %"); }
  }
  if (out.answered) outAvg.add(out.w, (uint32_t)now);

  if (ev == nb::GRID_FAIL) {
    prefs.putBool("gf", true);
    failBeforeBoot = false;
    saveSoc("queda da rede");
    raiseAlert("critical", "Falta de energia: a casa está no inversor (bateria %.0f %%)", socState.soc);
  } else if (ev == nb::GRID_RETURN) {
    prefs.putBool("gf", false);
    unsigned long mins = (now - grid.failedAt) / 60000UL;
    if (failBeforeBoot) raiseAlert("info", "Energia da rede voltou (bateria %.0f %%)", socState.soc);
    else raiseAlert("info", "Energia da rede voltou (falta de %lu min, bateria %.0f %%)", mins, socState.soc);
    failBeforeBoot = false;
  }

  // ---- alertas da bateria ----
  uint8_t lvl = nb::socAlarmLevel(socLevel, socState.soc, SOC_WARN_PCT, SOC_CRIT_PCT, SOC_HYST_PCT);
  if (lvl > socLevel) {
    if (lvl == 1) raiseAlert("warning", "Bateria do nobreak em %.0f %%%s", socState.soc, grid.fail ? " — a casa está no inversor" : "");
    else raiseAlert("critical", "Bateria do nobreak em %.0f %%: desligue as cargas não essenciais%s", socState.soc,
                    grid.fail ? " (a casa está no inversor)" : "");
  }
  socLevel = lvl;
  if (bank.answered) {
    int r = nb::lowAlarmStep(bankLow, bank.v, BANK_LOW_V, BANK_LOW_REARM_V, BANK_LOW_MS, (uint32_t)now);
    if (r > 0) raiseAlert("critical", "Tensão do banco de baterias em %.1f V (limite %.1f V): o inversor vai desligar", bank.v, BANK_LOW_V);
    if (r < 0) Serial.printf("[banco] tensão normalizada: %.2f V\n", bank.v);
  }
  checkMeterAlerts();

  // ---- autonomia (só na falta de energia) ----
  float avg = outAvg.mean();
  float autonomy = grid.fail ? nb::autonomyHours(socState.soc, avg, BANK_AH, BANK_NOMINAL_V, AUTONOMY_FLOOR_SOC, INVERTER_EFF) : -1.0f;

  // ---- grava o SoC a cada 5 min (só se mudou) ----
  if (now - lastSocSave >= SOC_SAVE_MS) {
    if (fabsf(socState.soc - savedSoc) >= 0.1f) saveSoc("periódico");
    else lastSocSave = now;
  }

  // ---- retrato para a telemetria e a tela ----
  Live l;
  l.soc = socState.soc; l.socLevel = socLevel;
  l.battOk = bank.ok; l.battV = bank.v; l.battA = bank.a; l.battW = bank.w; l.battKwh = bank.kwh;
  l.gridAnswered = gridM.answered;
  l.gridV = gridM.answered ? gridM.v : 0; l.gridW = gridM.answered ? gridM.w : 0; l.gridHz = gridM.answered ? gridM.hz : 0;
  l.outOk = out.ok; l.outV = out.v; l.outW = out.w; l.outKwh = out.kwh;
  l.gridFail = grid.fail; l.onBattery = discharging; l.battLowV = bankLow.active;
  l.autonomyH = autonomy; l.avgOutW = avg;
  l.metersOk = 0;
  for (int k = 0; k < METER_COUNT; k++) { l.meterOk[k] = M[k].ok; l.metersOk += M[k].ok; }
  l.cycleMs = cycleMs;
  portENTER_CRITICAL(&stateMux);
  live = l;
  portEXIT_CRITICAL(&stateMux);
}

// ============================================================
// Telemetria (tarefa no núcleo 0 — HTTP lento não atrasa a leitura)
// ============================================================
int httpPost(const String& body) {
  if (WiFi.status() != WL_CONNECTED) return -1;
  NetworkClientSecure tls;             // antes do http: o http é destruído primeiro
  HTTPClient http;
  nhHttpsBegin(http, tls, GATEWAY_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-key", DEVICE_SECRET);
  http.setTimeout(8000);
  int code = http.POST(body);
  nhTlsConfere(tls, code, "iot");
  if (code != 200) Serial.printf("[iot] lote → HTTP %d %s\n", code, code > 0 ? http.getString().substring(0, 300).c_str() : "");
  http.end();
  return code;
}

static void appendBool(String& s, const char* key, bool v) { s += ",\""; s += key; s += v ? "\":true" : "\":false"; }
static void appendNum(String& s, const char* key, float v, int dec) { s += ",\""; s += key; s += "\":"; s += String(v, dec); }
// número ou null (medidor sem resposta: o painel não mostra um valor velho)
static void appendNumOrNull(String& s, const char* key, bool ok, float v, int dec) {
  if (ok) appendNum(s, key, v, dec);
  else { s += ",\""; s += key; s += "\":null"; }
}
static void appendMetric(String& s, const char* metric, float v, int dec) {
  s += ",{\"device_id\":\""; s += DEVICE_NOBREAK; s += "\",\"metric_type\":\""; s += metric;
  s += "\",\"value\":"; s += String(v, dec); s += '}';
}

static void appendJsonText(String& s, const char* txt) {
  s += '"';
  for (const char* p = txt; *p; p++) {
    if (*p == '"' || *p == '\\') s += '\\';
    if ((uint8_t)*p >= 0x20) s += *p;
  }
  s += '"';
}

void publishBatch(bool withHistory) {
  Live l;
  PendingAlert alerts[ALERT_SLOTS]; int nAlerts;
  portENTER_CRITICAL(&stateMux);
  l = live;
  nAlerts = alertCount;
  alertInFlight = nAlerts;
  memcpy(alerts, alertQ, sizeof(PendingAlert) * nAlerts);
  portEXIT_CRITICAL(&stateMux);

  String body;
  body.reserve(2048);
  body = "{\"source\":\"nobreak\",\"readings\":[";
  // 1) status completo, num item SÓ de status: sem a migração 025 o servidor recusa as métricas
  //    novas (itens 2), mas este item continua sendo gravado (painel ao vivo).
  body += "{\"device_id\":\""; body += DEVICE_NOBREAK; body += "\",\"status\":{\"in_total\":true";
  appendNum(body, "soc", l.soc, 1);
  appendNumOrNull(body, "batt_v", l.battOk, l.battV, 2);
  appendNumOrNull(body, "batt_a", l.battOk, l.battA, 2);
  appendNumOrNull(body, "batt_w", l.battOk, l.battW, 1);
  appendNum(body, "grid_v", l.gridV, 1);        // 0 = sem rede (o PZEM 42 não responde sem tensão)
  appendNum(body, "grid_w", l.gridW, 1);
  appendNumOrNull(body, "out_w", l.outOk, l.outW, 1);
  appendBool(body, "grid_fail", l.gridFail);
  appendBool(body, "on_battery", l.onBattery);
  appendNumOrNull(body, "autonomy_h", l.autonomyH >= 0, l.autonomyH, 1);
  body += ",\"meters_ok\":"; body += l.metersOk;
  body += ",\"meters\":"; body += METER_COUNT;
  body += "}}";
  // 2) histórico (1 por minuto): cada métrica é um item próprio
  if (withHistory) {
    appendMetric(body, "battery_soc", l.soc, 1);
    if (l.battOk) appendMetric(body, "battery_voltage", l.battV, 2);
    if (l.gridAnswered || l.gridFail) appendMetric(body, "grid_voltage", l.gridV, 1);
    if (l.outOk) {
      appendMetric(body, "power_backup_w", l.onBattery ? l.outW : 0.0f, 1);
      appendMetric(body, "energy_watts", l.outW, 1);   // consumo das cargas críticas (QDC)
    }
  }
  body += "]";
  if (nAlerts) {
    body += ",\"alerts\":[";
    for (int a = 0; a < nAlerts; a++) {
      if (a) body += ',';
      body += "{\"severity\":\""; body += alerts[a].severity; body += "\",\"message\":";
      appendJsonText(body, alerts[a].message);
      body += '}';
    }
    body += ']';
  }
  body += '}';

  int code = httpPost(body);
  portENTER_CRITICAL(&stateMux);
  if (code == 200 || code == 207) {
    // remove só os alertas enviados (o loop pode ter acrescentado outros nesse meio-tempo, e um
    // crítico pode ter tomado o lugar de um aviso já enviado: alertInFlight já desconta esse caso)
    int sent = alertInFlight;
    int rest = alertCount - sent;
    if (rest > 0) memmove(alertQ, alertQ + sent, sizeof(PendingAlert) * rest);
    alertCount = rest > 0 ? rest : 0;
  }
  alertInFlight = 0;
  portEXIT_CRITICAL(&stateMux);
}

void telemetryTask(void*) {
  unsigned long lastPublish = 0, lastHistory = 0;
  bool first = true;
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(1000));
    nhRedeBatida();                    // sinal de vida para o loop() (nhRedeConfere)
    if (!DEVICE_NOBREAK[0] || WiFi.status() != WL_CONNECTED) continue;
    unsigned long now = millis();
    if (first && now < 8000) continue;                 // primeira volta pelos medidores (só no boot: millis() dá a volta)
    bool alertsWaiting;
    portENTER_CRITICAL(&stateMux);
    alertsWaiting = alertCount > 0;
    portEXIT_CRITICAL(&stateMux);
    // alerta pendente sai já (falta de energia não espera os 15 s), mas no máx. 1 POST a cada 3 s
    if (!first && now - lastPublish < PUBLISH_INTERVAL_MS && !(alertsWaiting && now - lastPublish >= 3000)) continue;
    bool history = first || now - lastHistory >= HISTORY_INTERVAL_MS;
    first = false;
    lastPublish = now;
    if (history) lastHistory = now;
    publishBatch(history);
  }
}

// ============================================================
// Bancada (serial 115200)
// ============================================================
void printStatus() {
  Live l;
  portENTER_CRITICAL(&stateMux);
  l = live;
  portEXIT_CRITICAL(&stateMux);
  Serial.printf("RS485 %s 8N%d · volta %.1f s · %d/%d medidores · Wi-Fi %s\n",
                rs485Swapped ? "invertido" : "normal", NOBREAK_STOPBITS == 2 ? 2 : 1, l.cycleMs / 1000.0f,
                l.metersOk, METER_COUNT, WiFi.status() == WL_CONNECTED ? "ok" : "fora");
  Serial.printf("  rede: %s · %s\n", l.gridFail ? "FALTA DE ENERGIA" : "ok", l.onBattery ? "bateria alimentando a casa" : "bateria em carga/repouso");
  Serial.printf("  SoC %.1f %% (nível %u) · banco %.2f V %.2f A %.1f W · %.3f kWh no PZEM-017%s%s\n",
                l.soc, l.socLevel, l.battV, l.battA, l.battW, l.battKwh,
                M[M_BANK].hvAlarm ? " · ALARME ALTA TENSÃO" : "", M[M_BANK].lvAlarm ? " · ALARME BAIXA TENSÃO" : "");
  if (l.autonomyH >= 0) Serial.printf("  autonomia %.1f h com %.0f W médios (10 min)\n", l.autonomyH, l.avgOutW);
  else Serial.printf("  autonomia: — (média da saída %.0f W)\n", l.avgOutW);
  for (int k = 0; k < METER_COUNT; k++) {
    const Meter& m = M[k];
    if (m.dc) Serial.printf("  %u %-8s %-18s %s %7.2f V %7.2f A %8.1f W\n", m.addr, m.model, m.role, m.ok ? "ok" : "!!", m.v, m.a, m.w);
    else Serial.printf("  %u %-8s %-18s %s %7.1f V %7.3f A %8.1f W %5.1f Hz FP %.2f %9.3f kWh\n", m.addr, m.model, m.role,
                       m.ok ? "ok" : "!!", m.v, m.a, m.w, m.hz, m.pf, m.kwh);
  }
}

void scanBus() {
  Serial.println("[scan] endereços 1..60 (03 = holding, 04 = entradas):");
  for (uint8_t a = 1; a <= 60; a++) {
    bool h = mbPing(a, 0x03), in = mbPing(a, 0x04);
    if (h || in) Serial.printf("  slave %u responde%s%s\n", a, h ? " [03]" : "", in ? " [04]" : "");
  }
}

void mbDump(uint8_t slave) {
  for (uint8_t func = 3; func <= 4; func++) {
    uint16_t r[10];
    int n = func == 4 ? 10 : 4;
    bool ok = mbReadRegs(slave, func, 0, n, r);
    if (!ok && func == 4) { n = PZEM017_REGS; ok = mbReadRegs(slave, func, 0, n, r); }   // PZEM-017: 8 registradores
    if (!ok) { Serial.printf("slave %u · função %02X: sem resposta\n", slave, func); continue; }
    Serial.printf("slave %u · função %02X:", slave, func);
    for (int i = 0; i < n; i++) Serial.printf(" %u", r[i]);
    Serial.println();
  }
}

// pzemaddr NOVO   → grava pelo endereço geral 0xF8 (LIGUE SÓ ESSE PZEM no barramento)
// pzemaddr S NOVO → muda o PZEM que hoje está em S para NOVO
void pzemSetAddress(int from, int addr) {
  if (addr < 1 || addr > 247) { Serial.println("endereço deve ser 1..247"); return; }
  uint8_t slave = from > 0 ? (uint8_t)from : PZEM_GENERAL;
  bool ok = mbWriteReg(slave, PZEM_ADDR_REG, (uint16_t)addr);
  if (from > 0) Serial.printf("[pzem] %d → %d: %s\n", from, addr, ok ? "gravado — confira com 'dump N'" : "sem resposta");
  else Serial.printf("[pzem] endereço %d: %s\n", addr, ok ? "gravado — confira com 'dump N'" : "sem resposta (só um PZEM ligado?)");
}

void handleSerial() {
  static String line;
  while (Serial.available()) {
    char c = Serial.read();
    if (c != '\n' && c != '\r') { line += c; continue; }
    line.trim(); line.toLowerCase();
    if (line.startsWith("dump ")) mbDump((uint8_t)line.substring(5).toInt());
    else if (line.startsWith("pzemaddr ")) {
      String args = line.substring(9); args.trim();
      int sp = args.indexOf(' ');
      if (sp > 0) pzemSetAddress(args.substring(0, sp).toInt(), args.substring(sp + 1).toInt());
      else pzemSetAddress(0, args.toInt());
    }
    else if (line.startsWith("soc ")) {
      float v = line.substring(4).toFloat();
      if (v < 0 || v > 100) Serial.println("soc deve ser 0..100");
      else submitRequest(UiRequest{ UI_REQ_SET_SOC, v });
    }
    else if (line == "shunt") {
      int cur = shuntRead();
      if (cur < 0) Serial.println("[shunt] PZEM-017 sem resposta");
      else Serial.printf("[shunt] faixa atual: %s (código %d) · configurado: %s — 'shunt 0..3' grava (0=100 A 1=50 A 2=200 A 3=300 A)\n",
                         shuntName(cur), cur, SHUNT_RANGE_CODE >= 0 ? shuntName(SHUNT_RANGE_CODE) : "não mexe");
    }
    else if (line.startsWith("shunt ")) shuntWrite(line.substring(6).toInt());
    else if (line == "scan") scanBus();
    else if (line == "status") printStatus();
    else if (line.length()) Serial.println("comandos: status | scan | dump S | pzemaddr [S] NOVO | soc N | shunt [0..3]");
    line = "";
  }
}

// ============================================================
// Tela
// ============================================================
#if USE_DISPLAY
UiMeter uiMeters[METER_COUNT];
UiState uiState;

void refreshScreen() {
  static unsigned long last = 0;
  if (millis() - last < 400) return;
  last = millis();
  Live l;
  portENTER_CRITICAL(&stateMux);
  l = live;
  portEXIT_CRITICAL(&stateMux);
  uiState.soc = l.soc; uiState.socLevel = l.socLevel;
  uiState.battOk = l.battOk; uiState.battV = l.battV; uiState.battA = l.battA; uiState.battW = l.battW;
  uiState.battLowV = l.battLowV; uiState.discharging = l.onBattery;
  uiState.gridMeterOk = l.gridAnswered; uiState.gridV = l.gridV; uiState.gridW = l.gridW; uiState.gridHz = l.gridHz;
  uiState.outOk = l.outOk; uiState.outV = l.outV; uiState.outW = l.outW;
  uiState.gridFail = l.gridFail; uiState.autonomyH = l.autonomyH; uiState.avgOutW = l.avgOutW;
  for (int k = 0; k < METER_COUNT; k++) uiState.meterOk[k] = l.meterOk[k];
  uiState.metersOk = l.metersOk;
  uiState.wifiOk = WiFi.status() == WL_CONNECTED;
  uiState.bankAh = BANK_AH; uiState.bankV = BANK_NOMINAL_V;
  ui_update(uiState);
}
#endif

// ============================================================
// Setup / Loop
// ============================================================
void setup() {
  Serial.begin(115200);
  requestQueue = xQueueCreate(8, sizeof(UiRequest));
  prefs.begin("nobreak", false);
  nb::socInit(socState, prefs.getFloat("soc", SOC_DEFAULT));
  savedSoc = socState.soc;
  socLevel = nb::socAlarmLevel(0, socState.soc, SOC_WARN_PCT, SOC_CRIT_PCT, SOC_HYST_PCT);
  bool wasFailed = prefs.getBool("gf", false);
  failBeforeBoot = wasFailed;
  nb::gridInit(grid, wasFailed, millis());
  outAvg.reset(10000);
  memset(&live, 0, sizeof(live));
  live.soc = socState.soc; live.autonomyH = -1; live.avgOutW = -1; live.gridFail = wasFailed;
  if (socLevel) {   // reinício com bateria já baixa: avisa de novo (pode ter sido um desligamento pela bateria)
    raiseAlert(socLevel >= 2 ? "critical" : "warning", "Nobreak reiniciado com a bateria em %.0f %%", socState.soc);
  }
#if USE_DISPLAY
  for (int k = 0; k < METER_COUNT; k++) uiMeters[k] = UiMeter{ M[k].model, M[k].addr, M[k].role };
  if (!ui_begin(uiMeters, METER_COUNT, submitRequest))
    Serial.println("[tela] falha ao iniciar o display — o nobreak continua sem tela");
#endif
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);   // não bloqueia: a leitura e os alertas locais rodam sem Wi-Fi
  if (RS485_DE_PIN >= 0) { pinMode(RS485_DE_PIN, OUTPUT); digitalWrite(RS485_DE_PIN, LOW); }
  rs485Begin();
  delay(800);                 // escravos terminam o boot
  rs485AutoDetect();
  shuntEnsure();
  lastSocSave = millis();
  xTaskCreatePinnedToCore(telemetryTask, "telemetria", 12288, nullptr, 1, nullptr, 0);
  Serial.printf("[boot] nobreak: SoC %.1f %%%s · PZEM 41/42/43 — digite 'status'\n", socState.soc,
                wasFailed ? " · estava em FALTA DE ENERGIA" : "");
  nhWdtInicia();              // watchdog só depois do boot dos medidores
}

void loop() {
  nhWdtAlimenta();             // watchdog (nh_tls.h): loop travado por 15 s → reinício (SoC volta da NVS)
  nhRedeConfere(false);
  handleSerial();
  processRequests();
  static unsigned long cycleStart = 0;
  if (!cycleStart || millis() - cycleStart >= CYCLE_MS) {
    cycleStart = millis();
    pollMeters();             // 3 medidores: ~0,2 s (até ~1,3 s com medidores mudos)
    endOfCycle();
    if (!shuntChecked && M[M_BANK].answered) shuntEnsure();
    // barramento mudo por 2 voltas (nem o 41 nem o 43, que não dependem da rede): tenta a outra ordem RX/TX
    static int silent = 0;
    silent = (!M[M_BANK].ok && !M[M_OUT].ok && !M[M_GRID].ok) ? silent + 1 : 0;
    if (silent >= 2) { silent = 0; rs485AutoDetect(); }
  }
#if USE_DISPLAY
  refreshScreen();
#endif
  delay(5);
}
