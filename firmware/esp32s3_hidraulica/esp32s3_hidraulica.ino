// ============================================================
// NexusHome OS — Firmware ESP32-S3 · Automação Hidráulica (Modbus RTU)
// ------------------------------------------------------------
// Implementa o "Memorial Descritivo e Projeto de Automação Hidráulica"
// (Painel de Controle Laje). O ESP32-S3 (SpotPear Touch Industrial) é o
// MESTRE Modbus RTU do barramento RS-485 e:
//
//   · lê 2 contadores de pulsos FT-PFC-04 (7 medidores de vazão BT01/K24)
//   · lê a sonda hidrostática QDY30A (nível dos 2 reservatórios interligados)
//   · comanda a placa Waveshare Modbus RTU Relay 8-CH (8 válvulas motorizadas)
//   · aplica as 3 regras de segurança do item 3.2 do memorial
//   · publica a telemetria na Edge Function "iot-gateway" do NexusHome
//
// Linguagem: C++ (framework Arduino para ESP32, core 2.x ou 3.x).
// Placa na Arduino IDE: "ESP32S3 Dev Module".
// Bibliotecas: só as do core (WiFi, HTTPClient, Preferences). O protocolo Modbus RTU
// (CRC16, funções 01/03/04/05/0F) está implementado aqui mesmo, sem
// dependências externas. A lógica de decisão (vazão, regras, travas) fica em
// hid_logic.h, testável no PC com g++ (tests/hidraulica-firmware.test.mjs).
//
// Falha segura (relé ENERGIZADO = válvula FECHADA): por isso o estado travado
// (alarmes, pânico e válvulas) fica na NVS e volta antes do primeiro comando
// aos relés, e o estado completo das 8 bobinas é reenviado a cada 30 s e
// conferido lendo as bobinas de volta (função 01).
//
// Endereços do barramento (item 2.5 do memorial) — 9600 8N1 em todos:
//   Slave 1 = Contadora 1 (DI1 Cozinha, DI2 Banheiro 1, DI3 Banheiro 2, DI4 Área Serviço)
//   Slave 2 = Contadora 2 (DI1 Ramal 5, DI2 Ramal 6, DI3 Área Externa, DI4 reserva)
//   Slave 3 = Sonda QDY30A
//   Slave 4 = Placa de 8 relés Waveshare
//
// ⚠️ ANTES DE LIGAR AS VÁLVULAS, leia docs/automacao-hidraulica.md:
//   1) A fiação NO/NC do item 2.4 do memorial está INVERTIDA em relação à
//      nota de segurança: com relé desligado o COM fica no NC, e o NC no fio
//      "Fecha" FECHA a válvula no boot. Este firmware assume a ligação
//      corrigida: NC → fio Vermelho (Abre) e NO → fio Azul (Fecha), ou seja,
//      relé ENERGIZADO = válvula FECHADA, relé desligado = ABERTA.
//      (Ajuste RELAY_ENERGIZED_CLOSES se ligar diferente.)
//   2) O fator da sonda: 1000 L em ~70 cm de lâmina são ~14 L por cm, e não
//      1,3–1,4 L por cm. Calibre TANK_LITERS_PER_MM com as suas caixas.
//   3) Os mapas de registradores do FT-PFC-04 e da QDY30A variam entre lotes:
//      confirme no manual do fabricante (constantes marcadas CONFIRMAR).
// ============================================================

#include <WiFi.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <math.h>
#include <time.h>
#include "ui.h"
#include "hid_logic.h"

// ---------------- Tela touch (SpotPear/Waveshare ESP32-S3-Touch-LCD-4.3B) ----------------
// 1 = mostra a interface da caixa d'água (ui.cpp). 0 = sem tela (outra placa ESP32-S3).
// Bibliotecas (Library Manager): ESP32_Display_Panel 1.0.4 e lvgl 8.4.0 — o script
// scripts/instalar-arduino.ps1 instala as duas.
#define USE_DISPLAY 1

// ---------------- Wi-Fi e NexusHome ----------------
#define WIFI_SSID        "SUA_REDE_WIFI"          // só 2.4 GHz
#define WIFI_PASSWORD    "SUA_SENHA_WIFI"
#define GATEWAY_URL      "https://gfjxcsvxhaojbtuixpjh.supabase.co/functions/v1/iot-gateway"
#define DEVICE_SECRET    "SUA_IOT_DEVICE_SECRET"   // = IOT_DEVICE_SECRET do Supabase

// UUIDs na tabela `devices` — criados por supabase/seeds/hidraulica.sql (rode no SQL Editor).
// String vazia = não publica aquele item.
const char* DEVICE_RAMAL[7] = {
  "b1000000-0000-4000-8000-000000000001",   // Ramal 1 — Cozinha
  "b1000000-0000-4000-8000-000000000002",   // Ramal 2 — Banheiro 1
  "b1000000-0000-4000-8000-000000000003",   // Ramal 3 — Banheiro 2
  "b1000000-0000-4000-8000-000000000004",   // Ramal 4 — Área de Serviço
  "b1000000-0000-4000-8000-000000000005",   // Ramal 5
  "b1000000-0000-4000-8000-000000000006",   // Ramal 6
  "b1000000-0000-4000-8000-000000000007",   // Ramal 7 — Área Externa
};
const char* DEVICE_TANK         = "b1000000-0000-4000-8000-000000000008";   // Reservatórios (nível %)
const char* DEVICE_VALVE_GERAL  = "a3333333-3333-4333-8333-333333333333";  // Válvula de Água Geral (seed)

#define PUBLISH_INTERVAL_MS  15000      // telemetria (tarefa separada: não atrasa a segurança)
#define OFFLINE_QUEUE_LEN    480        // leituras guardadas sem Wi-Fi (≈ 30 min a cada 15 s × 9 medidas; RAM)
#define OFFLINE_FLUSH_MAX    18         // leituras reenviadas por ciclo depois que a rede volta

// ---------------- RS-485 (SpotPear / Waveshare ESP32-S3-Touch-LCD) ----------------
// Pinos do RS-485 nativo segundo a wiki Waveshare (a SpotPear revende o mesmo hardware):
//   · ESP32-S3-Touch-LCD-7 e LCD-4.3 (sem "B"): GPIO15 e GPIO16
//   · ESP32-S3-Touch-LCD-4.3B / LCD-4:          GPIO43 e GPIO44
// A wiki rotula RS485_TXD/RXD pelo lado do transceptor, então qual dos dois é o RX da UART
// muda conforme a página. O firmware testa uma ordem e, se ninguém responder, troca sozinho
// (RS485_AUTO_SWAP). A direção TX/RX do transceptor é automática nessas placas → DE = -1.
#define RS485_PIN_A    43     // ESP32-S3-Touch-LCD-4.3B (a placa comprada). LCD-7 / 4.3 sem "B": 15
#define RS485_PIN_B    44     //                                                               16
#define RS485_AUTO_SWAP true
#define RS485_DE_PIN   -1     // pino DE/RE só se usar um transceptor externo com controle manual
#define RS485_BAUD     9600
#define MB_TIMEOUT_MS  150    // espera por resposta de cada escravo
#define MB_RETRIES     2

#define SLAVE_COUNTER1  1
#define SLAVE_COUNTER2  2
#define SLAVE_SONDA     3
#define SLAVE_RELAYS    4

// ---------------- Mapas de registradores (CONFIRMAR no manual) ----------------
// FT-PFC-04 "NPN Cumulative 32bit": o fabricante (Hongzhi Feiteng) não publica o mapa de
// registradores online — ele vem no manual/PDF que acompanha a placa. Valor provisório:
// contagem acumulada de 32 bits por canal em 2 registradores a partir de COUNTER_REG_BASE.
// Para confirmar na bancada: "dump 1", gire a turbina do ramal 1, "dump 1" de novo.
#define COUNTER_FUNC        3        // 03 = holding registers (alguns lotes usam 04)
#define COUNTER_REG_BASE    0x0000   // canal 1 = base, canal 2 = base+2, ...
#define COUNTER_HIGH_FIRST  true     // palavra alta primeiro (big-endian)
// QDY30A (mapa comum dos transmissores de nível RS-485 desta família): 0x0002 = unidade,
// 0x0003 = casas decimais (0–3), 0x0004 = valor medido (int16 com sinal). Valor real =
// registrador 4 ÷ 10^(registrador 3). A unidade de fábrica costuma ser cm ou mm: confira com
// "dump 3" e ajuste SONDA_UNIT_TO_MM (cm → 10, m → 1000).
#define SONDA_FUNC          3
#define SONDA_DECIMALS_REG  0x0003
#define SONDA_VALUE_REG     0x0004
#define SONDA_UNIT_TO_MM    1.0f     // multiplicador se a sonda estiver configurada em cm (10) ou m (1000)
// Waveshare Modbus RTU Relay 8-CH (wiki Waveshare): bobinas 0x0000..0x0007, funções 01/05/0F,
// 0xFF00 = liga, 0x0000 = desliga. Endereço de fábrica 0x01 — mude para 4 antes de ligar ao barramento.
#define RELAY_COIL_BASE     0x0000
#define RELAY_REFRESH_MS    30000    // reenvia as 8 bobinas (placa reiniciada volta com tudo desligado = tudo ABERTO)
#define RELAY_READBACK      true     // confere as bobinas (função 01) depois de cada escrita
#define RELAY_FAIL_ALERT    3        // escritas sem confirmação seguidas até o alerta para o app (~3 s)

// ---------------- Calibragem (item 3.1) ----------------
float K_PULSES_PER_LITER[7] = { 4.5f, 4.5f, 4.5f, 4.5f, 4.5f, 4.5f,   // DN40: 4–5 pulsos/L (calibrar)
                                12.0f };                               // DN20: usar o fator gravado no corpo
#define TANK_CAPACITY_L     1000.0f  // 2 × 500 L interligadas
#define TANK_LITERS_PER_MM  1.4f     // ≈ 14 L por cm (calibrar: litros ÷ altura útil em mm)
#define TANK_EMPTY_MM       0.0f     // leitura da sonda com a caixa no nível mínimo útil

// ---------------- Válvulas / relés (item 2.4) ----------------
#define RELAY_ENERGIZED_CLOSES true   // ligação corrigida: NO→Fecha (azul), NC→Abre (vermelho)
#define VALVE_GERAL     6             // índice 0-based → Relé 7
#define VALVE_EXTERNA   7             // índice 0-based → Relé 8
const char* VALVE_NAME[8] = { "Ramal 1 (Cozinha)", "Ramal 2 (Banheiro 1)", "Ramal 3 (Banheiro 2)",
                              "Ramal 4 (Área Serviço)", "Ramal 5", "Ramal 6",
                              "Geral de Emergência", "Área Externa" };

// ---------------- Regras de segurança (item 3.2) ----------------
#define LEAK_DROP_FRACTION     0.10f      // queda > 10% da capacidade...
#define LEAK_WINDOW_MS         180000UL   // ...em menos de 180 s
#define LEAK_METERED_RATIO     0.30f      // e o medido pelos 7 ramais < 30% da queda → rompimento
#define EXT_QUIET_MS           60000UL    // 1 min sem nenhum pulso no ramal externo = fluxo parou
#define EXT_CONTINUOUS_MS      3600000UL  // 60 min de fluxo ininterrupto (nenhum minuto sem pulso)
#define FLOW_WINDOW_MS         60000UL    // vazão = pulsos acumulados na janela deslizante de 60 s
#define PANIC_BUTTON_PIN       0          // botão BOOT: segurar 2 s = pânico (só sem tela: na 4.3B o GPIO0 é do LCD)
#define COMMAND_POLL_MS        5000       // busca comandos do app (GET /iot-gateway/commands)

#define POLL_INTERVAL_MS       1000
#define TANK_SAMPLE_MS         10000      // amostra para a janela de 180 s
#define TANK_SAMPLES           ((int)(LEAK_WINDOW_MS / TANK_SAMPLE_MS) + 1)

// ============================================================
// Modbus RTU mínimo (mestre)
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
  uint16_t crc = mbCrc(frame, lenNoCrc);
  frame[lenNoCrc] = crc & 0xFF;
  frame[lenNoCrc + 1] = crc >> 8;
  while (RS485.available()) RS485.read();          // descarta lixo antigo
  if (RS485_DE_PIN >= 0) digitalWrite(RS485_DE_PIN, HIGH);
  RS485.write(frame, lenNoCrc + 2);
  RS485.flush();                                    // espera o último byte sair
  if (RS485_DE_PIN >= 0) digitalWrite(RS485_DE_PIN, LOW);
}

// Lê exatamente `expect` bytes (ou a resposta de exceção, 5 bytes). Retorna bytes lidos válidos.
int mbReceive(uint8_t* resp, size_t expect, uint8_t slave, uint8_t func) {
  size_t n = 0;
  unsigned long t0 = millis();
  while (millis() - t0 < MB_TIMEOUT_MS && n < expect) {
    if (RS485.available()) {
      resp[n++] = RS485.read();
      if (n == 5 && resp[1] == (func | 0x80)) break;   // exceção Modbus
    } else {
      delay(1);   // cede a CPU (tela/LVGL) enquanto o escravo responde
    }
  }
  if (n < 5 || resp[0] != slave) return -1;
  if (resp[1] == (func | 0x80)) return -2;
  if (n < expect) return -1;
  uint16_t crc = mbCrc(resp, expect - 2);
  if (resp[expect - 2] != (crc & 0xFF) || resp[expect - 1] != (crc >> 8)) return -3;
  return (int)n;
}

// Função 03/04: lê `count` registradores de 16 bits.
bool mbReadRegs(uint8_t slave, uint8_t func, uint16_t addr, uint16_t count, uint16_t* out) {
  uint8_t req[8] = { slave, func, (uint8_t)(addr >> 8), (uint8_t)addr, (uint8_t)(count >> 8), (uint8_t)count };
  uint8_t resp[5 + 2 * 16];
  size_t expect = 5 + 2 * count;
  if (count == 0 || count > 16) return false;
  for (int attempt = 0; attempt <= MB_RETRIES; attempt++) {
    mbSend(req, 6);
    if (mbReceive(resp, expect, slave, func) > 0 && resp[2] == 2 * count) {
      for (uint16_t i = 0; i < count; i++) out[i] = (resp[3 + 2 * i] << 8) | resp[4 + 2 * i];
      return true;
    }
    delay(20);
  }
  return false;
}

// Função 05: liga/desliga uma bobina (0xFF00 = ligado, 0x0000 = desligado).
bool mbWriteCoil(uint8_t slave, uint16_t addr, bool on) {
  uint8_t req[8] = { slave, 0x05, (uint8_t)(addr >> 8), (uint8_t)addr, (uint8_t)(on ? 0xFF : 0x00), 0x00 };
  uint8_t resp[8];
  for (int attempt = 0; attempt <= MB_RETRIES; attempt++) {
    mbSend(req, 6);
    if (mbReceive(resp, 8, slave, 0x05) > 0) return true;
    delay(20);
  }
  return false;
}

// Função 0F: escreve as 8 bobinas da placa de relés de uma vez (bit0 = relé 1).
// A wiki Waveshare lista 0x0F para as bobinas 0x0000–0x0007; se a placa RECUSAR (exceção Modbus),
// cai para oito comandos 0x05 (um por relé) — mais lento, mas ainda < 3 s para o pânico. Placa muda
// (sem resposta) não cai para os oito comandos: seriam ~4 s de espera a cada nova tentativa.
bool mbWriteCoils8(uint8_t slave, uint16_t addr, uint8_t bits) {
  uint8_t req[12] = { slave, 0x0F, (uint8_t)(addr >> 8), (uint8_t)addr, 0x00, 0x08, 0x01, bits };
  uint8_t resp[8];
  bool refused = false;
  for (int attempt = 0; attempt <= MB_RETRIES; attempt++) {
    mbSend(req, 8);
    int r = mbReceive(resp, 8, slave, 0x0F);
    if (r > 0) return true;
    if (r == -2) { refused = true; break; }
    delay(20);
  }
  if (!refused) return false;
  bool ok = true;
  for (int i = 0; i < 8; i++) ok &= mbWriteCoil(slave, addr + i, bits & (1 << i));
  return ok;
}

// Função 01: lê as 8 bobinas (bit0 = relé 1) — confere se a placa ficou com o que foi pedido.
bool mbReadCoils8(uint8_t slave, uint16_t addr, uint8_t &bits) {
  uint8_t req[8] = { slave, 0x01, (uint8_t)(addr >> 8), (uint8_t)addr, 0x00, 0x08 };
  uint8_t resp[6];
  for (int attempt = 0; attempt <= MB_RETRIES; attempt++) {
    mbSend(req, 6);
    if (mbReceive(resp, 6, slave, 0x01) > 0 && resp[1] == 0x01 && resp[2] == 1) { bits = resp[3]; return true; }
    delay(20);
  }
  return false;
}

// ---- seleção automática da ordem RX/TX do RS-485 ----
bool rs485Swapped = false;
void rs485Begin() {
  int rx = rs485Swapped ? RS485_PIN_B : RS485_PIN_A;
  int tx = rs485Swapped ? RS485_PIN_A : RS485_PIN_B;
  RS485.end();
  RS485.begin(RS485_BAUD, SERIAL_8N1, rx, tx);
  Serial.printf("[rs485] UART RX=GPIO%d TX=GPIO%d\n", rx, tx);
}
// Qualquer resposta válida — inclusive uma exceção Modbus ("função não suportada") — prova
// que a fiação e a ordem RX/TX estão certas.
bool mbPing(uint8_t slave) {
  uint8_t req[8] = { slave, 0x03, 0x00, 0x00, 0x00, 0x01 };
  uint8_t resp[8];
  mbSend(req, 6);
  int r = mbReceive(resp, 7, slave, 0x03);
  return r > 0 || r == -2;
}
bool anySlaveAnswers() {
  const uint8_t ids[4] = { SLAVE_RELAYS, SLAVE_SONDA, SLAVE_COUNTER1, SLAVE_COUNTER2 };
  for (int i = 0; i < 4; i++) if (mbPing(ids[i])) return true;
  return false;
}
// Chamada no boot e quando o barramento fica mudo: tenta a outra ordem dos pinos.
void rs485AutoDetect() {
  if (!RS485_AUTO_SWAP) return;
  if (anySlaveAnswers()) return;
  rs485Swapped = !rs485Swapped;
  rs485Begin();
  if (!anySlaveAnswers()) { rs485Swapped = !rs485Swapped; rs485Begin(); }   // ninguém responde: mantém a original
}

// Diagnóstico de bancada: "dump S" lista os registradores 0..31 do escravo S (funções 03 e 04).
// Gire a turbina e repita: o par de registradores que muda é a contagem daquele canal.
void mbDump(uint8_t slave) {
  for (uint8_t func = 3; func <= 4; func++) {
    Serial.printf("slave %u · função %02X:\n", slave, func);
    for (uint16_t base = 0; base < 32; base += 8) {
      uint16_t r[8];
      if (!mbReadRegs(slave, func, base, 8, r)) { Serial.printf("  0x%04X..: sem resposta\n", base); continue; }
      Serial.printf("  0x%04X: %5u %5u %5u %5u %5u %5u %5u %5u\n", base, r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7]);
    }
  }
}

// ============================================================
// Estado
// ============================================================
struct Snapshot {
  float flowLph[7];
  float totalL[7];
  bool  countersOk;
  float levelMm, volumeL, percent;
  bool  sondaOk;
  bool  valveOpen[8];
  bool  alarmBurst, alarmExternal, panic;
};

Snapshot snap;                         // copiado pela tarefa de telemetria
portMUX_TYPE snapMux = portMUX_INITIALIZER_UNLOCKED;

uint32_t lastPulses[7];
uint32_t cumPulses[7];                 // pulsos acumulados desde o boot (contagem própria, sem os saltos de contadora zerada)
bool     havePulses = false;
float    totalL[7] = {0};
float    flowLph[7] = {0};
FlowWindow flowWin;                    // janela deslizante de 60 s para a vazão (hid_logic.h)
unsigned long lastPoll = 0;

bool valveOpen[8];                     // estado desejado (true = aberta) — persiste na NVS
bool relaysOk = false;                 // última escrita aceita E confirmada pela leitura das bobinas
bool relayDirty = true;                // falta enviar/confirmar o estado das bobinas
unsigned long lastRelayWrite = 0;
RelayWatch relayWatch = { 0, false, false };

TankSample tank[TANK_SAMPLES];         // volume + litros medidos + instante, a cada TANK_SAMPLE_MS
int   tankHead = 0;
unsigned long lastTankSample = 0;
float levelMm = NAN, volumeL = NAN;

ExtFlow extFlow = {};                  // fluxo contínuo no ramal externo (nenhum minuto sem pulso)
bool alarmBurst = false, alarmExternal = false, panicActive = false;   // persistem na NVS

// ============================================================
// Alertas para o app (o loop enfileira, a tarefa de telemetria envia — mesmo padrão da T3)
// ============================================================
#define ALERT_SLOTS 8
struct PendingAlert { uint32_t id; char severity[10]; char message[240]; };
PendingAlert alertQ[ALERT_SLOTS];
int alertCount = 0;
uint32_t alertSeq = 0;

void raiseAlert(const char* severity, const char* fmt, ...) {
  char msg[240];
  va_list ap; va_start(ap, fmt); int n = vsnprintf(msg, sizeof(msg), fmt, ap); va_end(ap);
  if (n >= (int)sizeof(msg)) {         // cortou: não deixa um caractere UTF-8 pela metade (JSON inválido)
    size_t len = strlen(msg);
    while (len && ((uint8_t)msg[len - 1] & 0xC0) == 0x80) len--;
    if (len && (uint8_t)msg[len - 1] >= 0xC0) len--;
    msg[len] = 0;
  }
  for (char *p = msg; *p; p++) if (*p == '"' || *p == '\\') *p = '\'';   // vai cru no JSON
  Serial.printf("[alerta %s] %s\n", severity, msg);
  bool critical = !strcmp(severity, "critical");
  portENTER_CRITICAL(&snapMux);
  if (alertCount >= ALERT_SLOTS && critical) {
    // fila cheia: um crítico toma o lugar do aviso mais antigo que não é crítico
    for (int a = 0; a < alertCount; a++) {
      if (strcmp(alertQ[a].severity, "critical")) {
        memmove(alertQ + a, alertQ + a + 1, sizeof(PendingAlert) * (alertCount - a - 1));
        alertCount--;
        break;
      }
    }
  }
  if (alertCount < ALERT_SLOTS) {
    PendingAlert &a = alertQ[alertCount];
    a.id = ++alertSeq;
    strncpy(a.severity, severity, sizeof(a.severity) - 1);
    a.severity[sizeof(a.severity) - 1] = 0;
    strncpy(a.message, msg, sizeof(a.message) - 1);
    a.message[sizeof(a.message) - 1] = 0;
    alertCount++;
  }
  portEXIT_CRITICAL(&snapMux);
}

// ============================================================
// Persistência (NVS): alarmes, pânico e válvulas sobrevivem a um reinício
// ------------------------------------------------------------
// Um único valor de 16 bits (hid_logic.h), gravado só quando muda (borda) para não gastar a flash.
// Sem isto, um reinício no meio de um rompimento reabria as 8 válvulas no setup().
// ============================================================
Preferences prefs;
uint16_t savedState = 0xFFFF;          // último valor gravado (0xFFFF = nenhum: nunca é um estado válido)

void saveState() {
  uint16_t v = hidPackState(valveOpen, alarmBurst, alarmExternal, panicActive);
  if (v == savedState) return;
  prefs.putUShort("estado", v);
  savedState = v;
}

void loadState() {
  uint16_t v = prefs.getUShort("estado", HID_STATE_DEFAULT);
  hidUnpackState(v, valveOpen, alarmBurst, alarmExternal, panicActive, VALVE_GERAL, VALVE_EXTERNA);
  savedState = v;
  saveState();                         // a trava do alarme corrigiu alguma válvula: grava a versão coerente
  if (alarmBurst || alarmExternal || panicActive)
    Serial.printf("[boot] alarme travado restaurado da NVS: rompimento=%d externo=%d pânico=%d — só \"Rearmar\" libera\n",
                  alarmBurst, alarmExternal, panicActive);
}

// ============================================================
// Válvulas
// ============================================================
void closedValveNames(char *out, size_t n) {
  out[0] = 0;
  bool all = true;
  for (int i = 0; i < 8; i++) all &= !valveOpen[i];
  if (all) { snprintf(out, n, "todas as 8"); return; }
  for (int i = 0; i < 8; i++) {
    if (valveOpen[i]) continue;
    size_t len = strlen(out);
    snprintf(out + len, n - len, "%s%s", len ? ", " : "", VALVE_NAME[i]);
  }
}

// Envia o estado completo das 8 bobinas e confere lendo de volta (função 01). Sem confirmação o
// estado fica "sujo" e o loop tenta de novo na próxima volta; RELAY_FAIL_ALERT falhas seguidas
// viram alerta para o app (crítico se alguma válvula deveria estar fechada: pela fiação X7, relé
// desenergizado = válvula ABERTA).
bool applyValves() {
  uint8_t bits = hidRelayBits(valveOpen, RELAY_ENERGIZED_CLOSES);
  lastRelayWrite = millis();
  bool ok = mbWriteCoils8(SLAVE_RELAYS, RELAY_COIL_BASE, bits);
  if (!ok) {
    Serial.println("[relés] FALHA ao comandar a placa (slave 4) — verifique o barramento");
  } else if (RELAY_READBACK) {
    uint8_t got = 0;
    if (!mbReadCoils8(SLAVE_RELAYS, RELAY_COIL_BASE, got)) {
      ok = false;
      Serial.println("[relés] escrita aceita, mas a leitura das bobinas (função 01) não respondeu");
    } else if (got != bits) {
      ok = false;
      Serial.printf("[relés] bobinas divergem: pedido 0x%02X, lido 0x%02X\n", bits, got);
    }
  }
  if (ok != relaysOk) Serial.printf("[relés] placa das válvulas (slave 4): %s\n", ok ? "confirmada" : "SEM CONFIRMAÇÃO");
  relaysOk = ok;
  relayDirty = !ok;                    // falhou: tenta de novo na próxima volta do loop

  char names[160];
  switch (hidRelayStep(relayWatch, ok, hidAnyClosed(valveOpen), RELAY_FAIL_ALERT)) {
    case RW_CRITICAL:
      closedValveNames(names, sizeof(names));
      raiseAlert("critical", "Água: válvula não confirmou fechamento — sem o relé ela REABRE pela fiação. Verifique a "
                             "placa de relés (slave 4) e o barramento C. Deveriam estar fechadas: %s.", names);
      break;
    case RW_WARN:
      raiseAlert("warning", "Água: a placa de relés das válvulas (slave 4) não confirma os comandos. Verifique o barramento C.");
      break;
    case RW_RECOVERED:
      raiseAlert("info", "Água: a placa de relés das válvulas voltou a confirmar os comandos.");
      break;
    default: break;
  }
  return ok;
}

void setValve(int idx, bool open, const char* why) {
  if (idx < 0 || idx > 7) return;
  valveOpen[idx] = open;
  saveState();                         // grava antes de comandar: um reinício no meio não perde a decisão
  applyValves();
  Serial.printf("[válvula] %s → %s (%s)\n", VALVE_NAME[idx], open ? "ABERTA" : "FECHADA", why);
}

// Rotina de Pânico Geral (item 3.2.3): fecha as 8 válvulas num único comando.
void panicCloseAll() {
  for (int i = 0; i < 8; i++) valveOpen[i] = false;
  panicActive = true;
  saveState();
  unsigned long t0 = millis();
  bool ok = false;
  for (int i = 0; i < 3 && !ok && millis() - t0 < 2500; i++) ok = applyValves();
  Serial.printf("[PÂNICO] fechar todas as válvulas: %s em %lu ms\n", ok ? "OK" : "FALHOU", millis() - t0);
}

// Libera alarmes e reabre tudo (só por comando explícito do usuário) — e limpa o que foi gravado.
void resetAll() {
  alarmBurst = alarmExternal = panicActive = false;
  extFlow = ExtFlow{};
  for (int i = 0; i < 8; i++) valveOpen[i] = true;
  saveState();
  applyValves();
  Serial.println("[reset] alarmes liberados, válvulas abertas");
}

// Válvula travada: fechada por alarme/pânico — só "Rearmar" (tela ou serial) libera.
bool valveBlocked(int i) {
  return panicActive || (i == VALVE_GERAL && alarmBurst) || (i == VALVE_EXTERNA && alarmExternal);
}

// Pedidos da tela e do app chegam por esta fila e são executados no loop (o barramento
// Modbus só é usado por uma tarefa — nunca pela tela nem pela tarefa de rede).
QueueHandle_t requestQueue;

void submitRequest(const UiRequest &r) {
  if (requestQueue) xQueueSend(requestQueue, &r, 0);
}

void processRequests() {
  UiRequest r;
  while (requestQueue && xQueueReceive(requestQueue, &r, 0) == pdTRUE) {
    const char *origem = r.remote ? "app" : "tela";
    if (r.type == UI_REQ_PANIC) {
      Serial.printf("[pânico] acionado pela %s\n", origem);
      panicCloseAll();
    } else if (r.type == UI_REQ_RESET) {
      if (r.remote) Serial.println("[reset] recusado: rearmar só no painel (tela/serial)");
      else resetAll();
    } else if (r.type == UI_REQ_SET_VALVE && r.valve >= 0 && r.valve < 8) {
      if (r.open && valveBlocked(r.valve)) {
        Serial.printf("[válvula] %s travada por alarme — abertura pelo %s recusada\n", VALVE_NAME[r.valve], origem);
      } else if (valveOpen[r.valve] != r.open) {
        setValve(r.valve, r.open, r.remote ? "comando do app" : "toque na tela");
      }
    }
  }
}

// ============================================================
// Leituras
// ============================================================
bool readCounters(uint32_t out[7]) {
  uint16_t r[8];
  const uint8_t slaves[2] = { SLAVE_COUNTER1, SLAVE_COUNTER2 };
  for (int b = 0; b < 2; b++) {
    if (!mbReadRegs(slaves[b], COUNTER_FUNC, COUNTER_REG_BASE, 8, r)) return false;
    for (int ch = 0; ch < 4; ch++) {
      int idx = b * 4 + ch;
      if (idx >= 7) break;                       // Contadora 2 / DI4 = reserva
      uint16_t hi = COUNTER_HIGH_FIRST ? r[2 * ch] : r[2 * ch + 1];
      uint16_t lo = COUNTER_HIGH_FIRST ? r[2 * ch + 1] : r[2 * ch];
      out[idx] = ((uint32_t)hi << 16) | lo;
    }
  }
  return true;
}

bool readSonda(float* mm) {
  uint16_t r[2];
  if (!mbReadRegs(SLAVE_SONDA, SONDA_FUNC, SONDA_DECIMALS_REG, 2, r)) return false;
  int16_t raw = (int16_t)r[1];
  float div = 1.0f;
  for (uint16_t d = 0; d < r[0] && d < 4; d++) div *= 10.0f;
  *mm = (raw / div) * SONDA_UNIT_TO_MM;
  return true;
}

float meteredTotal() { float s = 0; for (int i = 0; i < 7; i++) s += totalL[i]; return s; }

// ============================================================
// Regras de segurança
// ============================================================
void checkBurstRule(bool countersOk, uint32_t now) {
  if (alarmBurst || isnan(volumeL)) return;
  // maior volume (e o medido naquele instante) entre as amostras dos últimos 180 s (com carimbo de tempo)
  BurstEval e = hidBurstEval(tank, TANK_SAMPLES, now, LEAK_WINDOW_MS, volumeL, meteredTotal());
  BurstVerdict v = hidBurstVerdict(e, countersOk, TANK_CAPACITY_L, LEAK_DROP_FRACTION, LEAK_METERED_RATIO);
  if (v == BV_SUSPENDED) {
    // sem os contadores não dá para distinguir consumo de rompimento: avisa e não corta
    static unsigned long lastWarn = 0;
    static bool warned = false;
    if (!warned || hidElapsed(now, lastWarn, 60000)) {
      warned = true; lastWarn = now;
      Serial.printf("[segurança] queda de %.0f L sem leitura dos medidores — corte suspenso\n", e.drop);
    }
  } else if (v == BV_ALARM) {
    alarmBurst = true;
    setValve(VALVE_GERAL, false, "rompimento de adutora: nível caiu sem consumo nos ramais");
    Serial.printf("[ALARME] queda %.0f L em ≤180 s, medido só %.0f L\n", e.drop, e.metered);
  }
}

// Fluxo contínuo na área externa (ramal 7): nenhum minuto sem pulso por 60 min. `readOk` = houve
// leitura nova das contadoras; sem ela (falha Modbus) a contagem só pausa, não zera.
void checkExternalRule(bool readOk, uint32_t extPulses, uint32_t now) {
  uint32_t continuousMs = hidExtStep(extFlow, readOk, extPulses, now, EXT_QUIET_MS);
  if (alarmExternal) return;
  if (continuousMs >= EXT_CONTINUOUS_MS) {
    alarmExternal = true;
    setValve(VALVE_EXTERNA, false, "vazamento externo: fluxo contínuo por 60 min");
  }
}

// ============================================================
// Telemetria (tarefa separada no núcleo 0 — HTTP lento não atrasa a segurança)
// ============================================================
// Retorna o código HTTP (200 = ok) ou -1 sem Wi-Fi/dispositivo.
int postTelemetry(const char* deviceId, const char* metric, float value, const char* statusJson, const char* tsIso = nullptr) {
  if (!deviceId || !deviceId[0] || WiFi.status() != WL_CONNECTED) return -1;
  HTTPClient http;
  http.begin(GATEWAY_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-key", DEVICE_SECRET);
  http.setTimeout(5000);
  char body[440];
  // leitura reenviada (fila offline): leva o horário real ("ts") e NÃO manda status antigo
  if (tsIso) snprintf(body, sizeof(body), "{\"device_id\":\"%s\",\"metric_type\":\"%s\",\"value\":%.2f,\"ts\":\"%s\",\"replayed\":true}",
                      deviceId, metric, value, tsIso);
  else snprintf(body, sizeof(body), "{\"device_id\":\"%s\",\"metric_type\":\"%s\",\"value\":%.2f%s%s}",
                deviceId, metric, value, statusJson ? ",\"status\":" : "", statusJson ? statusJson : "");
  int code = http.POST(body);
  if (code != 200) Serial.printf("[iot] %s → HTTP %d %s\n", metric, code, code > 0 ? http.getString().c_str() : "");
  http.end();
  return code;
}

// Falha de rede ou do servidor (5xx) vale tentar de novo; 4xx (dado recusado) não.
static bool retryable(int code) { return code <= 0 || code >= 500; }

// v2.16: alarmes viram alertas no NexusHome (tabela alerts → push e Telegram).
// Lote só com "alerts" (readings vazio); "source":"agua" identifica o módulo.
int postAlert(const char* severity, const char* message) {
  if (WiFi.status() != WL_CONNECTED) return -1;
  HTTPClient http;
  http.begin(GATEWAY_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-key", DEVICE_SECRET);
  http.setTimeout(5000);
  char body[480];
  snprintf(body, sizeof(body), "{\"readings\":[],\"alerts\":[{\"severity\":\"%s\",\"message\":\"%s\"}],\"source\":\"agua\"}",
           severity, message);
  int code = http.POST(body);
  if (code != 200) Serial.printf("[iot] alerta → HTTP %d\n", code);
  http.end();
  return code;
}

// Borda de subida de cada alarme: avisa uma vez; sem rede, tenta de novo no próximo ciclo.
void publishAlarmEdges(bool burst, bool external, bool panic) {   // (bools: o protótipo do Arduino vem antes do Snapshot)
  static bool sentBurst = false, sentExternal = false, sentPanic = false;
  struct { bool active; bool* sent; const char* msg; } al[] = {
    { burst,    &sentBurst,    "Água: rompimento detectado (nível caiu sem consumo nos ramais) — válvula geral FECHADA. Rearme na tela do quadro." },
    { external, &sentExternal, "Água: vazamento na área externa (fluxo contínuo por 60 min) — válvula externa FECHADA." },
    { panic,    &sentPanic,    "Água: PÂNICO acionado — todas as válvulas FECHADAS." },
  };
  for (auto& a : al) {
    if (!a.active) { *a.sent = false; continue; }
    if (*a.sent) continue;
    int code = postAlert("critical", a.msg);
    if (code == 200 || (code > 0 && !retryable(code))) *a.sent = true;
  }
}

// Alertas enfileirados pelo loop (raiseAlert): envia do mais antigo ao mais novo. Só sai da fila com
// HTTP 200 ou recusa definitiva (4xx); sem rede/5xx fica para o próximo ciclo (5 s). Remove pelo id,
// porque o loop pode ter reordenado a fila (crítico tomando o lugar de um aviso) durante o POST.
void flushAlerts() {
  for (int n = 0; n < ALERT_SLOTS; n++) {
    PendingAlert a;
    bool have = false;
    portENTER_CRITICAL(&snapMux);
    if (alertCount) { a = alertQ[0]; have = true; }
    portEXIT_CRITICAL(&snapMux);
    if (!have) return;
    int code = postAlert(a.severity, a.message);
    if (code != 200 && retryable(code)) return;
    portENTER_CRITICAL(&snapMux);
    for (int i = 0; i < alertCount; i++) {
      if (alertQ[i].id != a.id) continue;
      memmove(alertQ + i, alertQ + i + 1, sizeof(PendingAlert) * (alertCount - i - 1));
      alertCount--;
      break;
    }
    portEXIT_CRITICAL(&snapMux);
  }
}

// ------------------------------------------------------------
// Fila offline (v2.7): sem Wi-Fi as leituras ficam na RAM com o millis()
// da medida; quando a rede e o relógio (NTP) voltam, são reenviadas com o
// horário real. Fila cheia descarta a mais antiga. Reiniciar a placa perde
// a fila (a segurança hidráulica não depende dela).
// ------------------------------------------------------------
struct PendingReading { const char* dev; const char* metric; float value; uint32_t ms; };
static PendingReading offlineQ[OFFLINE_QUEUE_LEN];
static int qHead = 0, qCount = 0;
static uint32_t qDropped = 0;

bool timeSynced() { return time(nullptr) > 1700000000; }   // NTP já respondeu (após nov/2023)

void enqueueReading(const char* dev, const char* metric, float value) {
  if (!dev || !dev[0]) return;
  if (qCount == OFFLINE_QUEUE_LEN) { qHead = (qHead + 1) % OFFLINE_QUEUE_LEN; qCount--; qDropped++; }
  offlineQ[(qHead + qCount) % OFFLINE_QUEUE_LEN] = PendingReading{ dev, metric, value, millis() };
  qCount++;
}

// envia a leitura agora; se não der, guarda na fila
void sendOrQueue(const char* dev, const char* metric, float value, const char* statusJson) {
  int code = postTelemetry(dev, metric, value, statusJson);
  if (code != 200 && retryable(code)) enqueueReading(dev, metric, value);
}

void flushOfflineQueue() {
  if (!qCount || WiFi.status() != WL_CONNECTED || !timeSynced()) return;
  time_t now = time(nullptr);
  uint32_t nowMs = millis();
  for (int n = 0; n < OFFLINE_FLUSH_MAX && qCount; n++) {
    PendingReading &r = offlineQ[qHead];
    time_t t = now - (time_t)((nowMs - r.ms) / 1000);
    struct tm tmv; gmtime_r(&t, &tmv);
    char iso[24]; strftime(iso, sizeof(iso), "%Y-%m-%dT%H:%M:%SZ", &tmv);
    int code = postTelemetry(r.dev, r.metric, r.value, nullptr, iso);
    if (code != 200 && retryable(code)) break;   // rede/servidor fora: tenta no próximo ciclo (4xx: descarta)
    qHead = (qHead + 1) % OFFLINE_QUEUE_LEN; qCount--;
  }
  if (!qCount) Serial.println("[iot] fila offline reenviada por completo");
}

// Índice da válvula a partir do UUID do dispositivo (-1 = não é deste painel)
int valveForDevice(const char *id) {
  for (int i = 0; i < 6; i++) if (DEVICE_RAMAL[i][0] && !strcmp(id, DEVICE_RAMAL[i])) return i;
  if (DEVICE_RAMAL[6][0] && !strcmp(id, DEVICE_RAMAL[6])) return VALVE_EXTERNA;
  if (DEVICE_VALVE_GERAL[0] && !strcmp(id, DEVICE_VALVE_GERAL)) return VALVE_GERAL;
  return -1;
}

// GET /iot-gateway/commands → {"commands":[{"id":"…","device_id":"…","command":{"open":false}}]}
// Parser mínimo (sem biblioteca JSON): para cada device_id, lê o "open" que vem depois.
void pollCommands() {
  if (WiFi.status() != WL_CONNECTED) return;
  HTTPClient http;
  // só os comandos dos dispositivos deste painel (várias casas no mesmo projeto)
  String url = String(GATEWAY_URL) + "/commands?devices=";
  bool first = true;
  auto addId = [&](const char *id) { if (id && id[0]) { if (!first) url += ","; url += id; first = false; } };
  for (int i = 0; i < 7; i++) addId(DEVICE_RAMAL[i]);
  addId(DEVICE_VALVE_GERAL);
  http.begin(url);
  http.addHeader("x-device-key", DEVICE_SECRET);
  http.setTimeout(5000);
  int code = http.GET();
  if (code != 200) {
    if (code > 0) Serial.printf("[cmd] HTTP %d %s\n", code, http.getString().c_str());
    http.end();
    return;
  }
  String body = http.getString();
  http.end();
  int pos = 0;
  while ((pos = body.indexOf("\"device_id\":\"", pos)) >= 0) {
    pos += 13;
    String id = body.substring(pos, pos + 36);
    int o = body.indexOf("\"open\":", pos);
    int next = body.indexOf("\"device_id\":\"", pos);
    if (o < 0 || (next >= 0 && o > next)) continue;          // comando sem "open": ignora
    bool open = body.startsWith("true", o + 7);
    int v = valveForDevice(id.c_str());
    if (v < 0) continue;
    Serial.printf("[cmd] app pediu %s → %s\n", VALVE_NAME[v], open ? "abrir" : "fechar");
    submitRequest(UiRequest{ UI_REQ_SET_VALVE, (int8_t)v, open, true });
  }
}

void telemetryTask(void*) {
  unsigned long lastPublish = 0;
  bool wasOnline = false;
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(COMMAND_POLL_MS));
    bool online = WiFi.status() == WL_CONNECTED;
    if (online && !wasOnline) configTime(0, 0, "pool.ntp.org", "time.google.com");   // relógio para a fila offline
    wasOnline = online;
    if (online) { flushAlerts(); pollCommands(); flushOfflineQueue(); }
    if (millis() - lastPublish < PUBLISH_INTERVAL_MS) continue;
    lastPublish = millis();
    Snapshot s;
    portENTER_CRITICAL(&snapMux); s = snap; portEXIT_CRITICAL(&snapMux);
    char st[200];
    if (s.countersOk) {
      for (int i = 0; i < 7; i++) {
        int v = i < 6 ? i : VALVE_EXTERNA;      // ramal 7 é comandado pela válvula da Área Externa
        snprintf(st, sizeof(st), "{\"flow_lph\":%.1f,\"total_l\":%.1f,\"open\":%s}",
                 s.flowLph[i], s.totalL[i], s.valveOpen[v] ? "true" : "false");
        sendOrQueue(DEVICE_RAMAL[i], "water_flow_lph", s.flowLph[i], st);
      }
    }
    if (s.sondaOk) {
      snprintf(st, sizeof(st), "{\"level_mm\":%.0f,\"volume_l\":%.0f,\"level_pct\":%.1f}", s.levelMm, s.volumeL, s.percent);
      sendOrQueue(DEVICE_TANK, "water_level_pct", s.percent, st);
    }
    float sumFlow = 0; for (int i = 0; i < 7; i++) sumFlow += s.flowLph[i];
    snprintf(st, sizeof(st), "{\"open\":%s,\"alarm_burst\":%s,\"alarm_external\":%s,\"panic\":%s}",
             s.valveOpen[VALVE_GERAL] ? "true" : "false", s.alarmBurst ? "true" : "false",
             s.alarmExternal ? "true" : "false", s.panic ? "true" : "false");
    sendOrQueue(DEVICE_VALVE_GERAL, "water_flow_lph", sumFlow, st);
    if (online) publishAlarmEdges(s.alarmBurst, s.alarmExternal, s.panic);
  }
}

// ============================================================
// Comandos pela serial (teste de bancada): abrir N · fechar N · panico · reset · status · dump S
// ============================================================
void handleSerial() {
  static String line;
  while (Serial.available()) {
    char c = Serial.read();
    if (c != '\n' && c != '\r') { line += c; continue; }
    line.trim(); line.toLowerCase();
    // abrir/fechar vão pela MESMA fila dos toques na tela: respeitam a trava do alarme/pânico
    if (line.startsWith("abrir ") || line.startsWith("fechar ")) {
      bool open = line.startsWith("abrir ");
      int v = line.substring(open ? 6 : 7).toInt() - 1;
      if (v < 0 || v > 7) Serial.println("[serial] use abrir N / fechar N com N de 1 a 8");
      else submitRequest(UiRequest{ UI_REQ_SET_VALVE, (int8_t)v, open, false });
    }
    else if (line == "panico") submitRequest(UiRequest{ UI_REQ_PANIC, -1, false, false });
    else if (line == "reset") submitRequest(UiRequest{ UI_REQ_RESET, -1, true, false });
    else if (line.startsWith("dump ")) mbDump((uint8_t)line.substring(5).toInt());
    else if (line == "status") {
      Serial.printf("nível %.0f mm · %.0f L · relés %s · RS485 %s · alarmes: rompimento=%d externo=%d pânico=%d\n",
                    levelMm, volumeL, relaysOk ? "ok" : "FALHA", rs485Swapped ? "invertido" : "normal",
                    alarmBurst, alarmExternal, panicActive);
      Serial.printf("  área externa: fluxo contínuo há %lu min · alertas na fila: %d\n",
                    (unsigned long)((extFlow.active ? extFlow.accMs : 0) / 60000UL), alertCount);
      for (int i = 0; i < 7; i++) Serial.printf("  ramal %d: %.1f L/h · total %.1f L\n", i + 1, flowLph[i], totalL[i]);
      Serial.printf("  fila offline: %d leituras · %lu descartadas · relógio %s\n", qCount, (unsigned long)qDropped, timeSynced() ? "ok" : "sem NTP");
    }
    line = "";
  }
}

void checkPanicButton() {
#if USE_DISPLAY
  return;   // na 4.3B o GPIO0 (BOOT) é linha de dados do LCD: o pânico fica na tela
#endif
  static unsigned long pressedAt = 0;
  if (digitalRead(PANIC_BUTTON_PIN) == LOW) {
    if (!pressedAt) pressedAt = millis();
    else if (!panicActive && millis() - pressedAt > 2000) panicCloseAll();
  } else pressedAt = 0;
}

// ============================================================
// Setup / Loop
// ============================================================
void setup() {
  Serial.begin(115200);
  requestQueue = xQueueCreate(16, sizeof(UiRequest));
#if USE_DISPLAY
  if (!ui_begin(submitRequest)) Serial.println("[tela] falha ao iniciar o display — o controle continua sem tela");
#else
  pinMode(PANIC_BUTTON_PIN, INPUT_PULLUP);
#endif
  if (RS485_DE_PIN >= 0) { pinMode(RS485_DE_PIN, OUTPUT); digitalWrite(RS485_DE_PIN, LOW); }
  rs485Begin();

  // Estado travado ANTES do primeiro comando aos relés: um reinício no meio de um rompimento/pânico
  // mantém as válvulas fechadas (NVS vazia = abastecimento normal, tudo aberto).
  prefs.begin("hidraulica", false);
  loadState();
  for (int i = 0; i < TANK_SAMPLES; i++) tank[i].valid = false;
  hidFlowReset(flowWin);
  delay(500);                                         // escravos terminam o boot
  rs485AutoDetect();
  applyValves();

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);              // não bloqueia: a segurança roda mesmo sem Wi-Fi
  xTaskCreatePinnedToCore(telemetryTask, "telemetria", 8192, nullptr, 1, nullptr, 0);
  Serial.println("[boot] automação hidráulica iniciada — comandos: abrir N | fechar N | panico | reset | status");
}

#if USE_DISPLAY
void refreshScreen(bool countersOk, bool sondaOk) {
  static unsigned long last = 0;
  if (millis() - last < 300) return;
  last = millis();
  UiState u;
  for (int i = 0; i < 7; i++) u.flowLpm[i] = flowLph[i] / 60.0f;
  u.totalL = meteredTotal();
  u.levelPct = sondaOk ? volumeL / TANK_CAPACITY_L * 100.0f : 0;
  u.volumeL = sondaOk ? volumeL : 0;
  u.sondaOk = sondaOk; u.countersOk = countersOk; u.relaysOk = relaysOk;
  u.wifiOk = WiFi.status() == WL_CONNECTED;
  for (int i = 0; i < 8; i++) { u.valveOpen[i] = valveOpen[i]; u.blocked[i] = valveBlocked(i); }
  u.alarmBurst = alarmBurst; u.alarmExternal = alarmExternal; u.panic = panicActive;
  ui_update(u);
}
#endif

void loop() {
  handleSerial();
  checkPanicButton();
  processRequests();          // toques na tela e comandos do app (antes da leitura: resposta rápida)

  unsigned long now = millis();
  if (now - lastPoll < POLL_INTERVAL_MS) return;
  lastPoll = now;

  // 0) relés: reenvia se a última escrita não foi confirmada e, a cada 30 s, o estado completo
  //    (placa reiniciada/brownout volta com as bobinas desligadas = válvulas ABERTAS pela fiação)
  if (relayDirty || hidElapsed(now, lastRelayWrite, RELAY_REFRESH_MS)) applyValves();

  // 1) vazão: pulsos acumulados → litros; L/h pela janela deslizante de 60 s
  uint32_t pulses[7], delta[7] = {0};
  bool countersOk = readCounters(pulses);
  bool haveDelta = false;                                 // leitura nova com diferença válida (não a 1ª)
  if (countersOk) {
    if (havePulses) {
      for (int i = 0; i < 7; i++) {
        uint32_t d = pulses[i] - lastPulses[i];          // subtração sem sinal cobre o estouro de 32 bits
        if (d > 100000) d = 0;                            // contador zerado/reiniciado: ignora o salto
        delta[i] = d;
        cumPulses[i] += d;
        totalL[i] += d / K_PULSES_PER_LITER[i];
      }
      haveDelta = true;
    }
    memcpy(lastPulses, pulses, sizeof(pulses));
    havePulses = true;
    hidFlowPush(flowWin, now, cumPulses);
    for (int i = 0; i < 7; i++) flowLph[i] = hidFlowLph(flowWin, i, FLOW_WINDOW_MS, K_PULSES_PER_LITER[i]);
  } else {
    for (int i = 0; i < 7; i++) flowLph[i] = 0;
    Serial.println("[contadores] sem resposta (slave 1/2)");
  }
  static int silentPolls = 0;   // barramento mudo por 30 s: tenta a outra ordem RX/TX
  silentPolls = countersOk ? 0 : silentPolls + 1;
  if (silentPolls >= 30) { silentPolls = 0; rs485AutoDetect(); }

  // 2) nível do reservatório
  float mm;
  bool sondaOk = readSonda(&mm);
  if (sondaOk) {
    levelMm = mm;
    volumeL = constrain((mm - TANK_EMPTY_MM) * TANK_LITERS_PER_MM, 0.0f, TANK_CAPACITY_L);
  } else {
    levelMm = volumeL = NAN;
    Serial.println("[sonda] sem resposta (slave 3)");
  }

  // 3) regras de segurança
  checkBurstRule(countersOk, now);
  checkExternalRule(haveDelta, delta[6], now);
  if (sondaOk && hidElapsed(now, lastTankSample, TANK_SAMPLE_MS)) {
    lastTankSample = now;
    tank[tankHead] = TankSample{ volumeL, meteredTotal(), (uint32_t)now, true };
    tankHead = (tankHead + 1) % TANK_SAMPLES;
  }

  // 4) retrato para a telemetria
  Snapshot s;
  memcpy(s.flowLph, flowLph, sizeof(flowLph));
  memcpy(s.totalL, totalL, sizeof(totalL));
  memcpy(s.valveOpen, valveOpen, sizeof(valveOpen));
  s.countersOk = countersOk;
  s.sondaOk = sondaOk;
  s.levelMm = levelMm; s.volumeL = volumeL;
  s.percent = sondaOk ? volumeL / TANK_CAPACITY_L * 100.0f : 0;
  s.alarmBurst = alarmBurst; s.alarmExternal = alarmExternal; s.panic = panicActive;
  portENTER_CRITICAL(&snapMux); snap = s; portEXIT_CRITICAL(&snapMux);
#if USE_DISPLAY
  refreshScreen(countersOk, sondaOk);
#endif
}
