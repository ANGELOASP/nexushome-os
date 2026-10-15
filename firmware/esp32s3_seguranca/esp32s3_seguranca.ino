// ============================================================
// NexusHome OS — Firmware ESP32-S3 · Segurança e Iluminação (tela T3, barramento RS-485 B)
// ------------------------------------------------------------
// Projeto unificado (docs/projeto-unificado.md, v2.16). A tela T3 (SpotPear / Waveshare
// ESP32-S3-Touch-LCD-4.3B, na tampa do QAU) é o ÚNICO MESTRE Modbus RTU do barramento B
// (9600 8N1) e:
//
//   · comanda as 10 luzes em THREE-WAY (Relay (D) 90 e 91): o estado real vem do relé de
//     retorno KRn na entrada digital; um comando só INVERTE o canal se o pedido for diferente
//     do retorno — sem comando o relé nunca mexe (o interruptor de parede manda)   §8 X4, §9
//   · supervisiona o gás (transmissores 50 e 51): pré-alarme ≥ 10 % LEL, corte ≥ 20 % LEL
//     (Relay 91 CH7 + sirenes) TRAVADO até o rearme na tela. O corte de verdade é POR FIO
//     (AL2 em série com a válvula NF); com gás NADA é ligado (nem exaustor, nem luz)  §10.1
//   · fumaça/térmico (93), portas (93), presença (92), pânico e fonte F2 (91)       §8 X6, §10
//   · alarme da casa (desarmado / em casa / ausente) com atraso de entrada de 30 s   §10.3
//   · exaustores dos banheiros pela umidade dos XY-MD02 85 e 86                       §10.4
//   · publica tudo no NexusHome (iot-gateway, POST em lote a cada 15 s, "source":"seguranca")
//     e recebe os comandos do app (GET /iot-gateway/commands a cada 5 s)              §15
//
// Linguagem: C++ (framework Arduino para ESP32, core 3.x). Placa: "ESP32S3 Dev Module".
// Modbus RTU (CRC16, funções 01/02/03/04/05/06/0F) escrito aqui, sem biblioteca — o mesmo
// núcleo do firmware de energia. Tela: ESP32_Display_Panel 1.0.4 + lvgl 8.4.0 (ui.cpp).
// As decisões (three-way, gás, alarme, exaustor) ficam em seg_logic.h, sem Arduino, para
// poderem ser testadas no PC.
//
// ⚠️ Tudo marcado com CONFIRMAR é dado de fabricante: confira no manual do aparelho comprado
//    (registradores do Relay (D), do IO 8CH e principalmente do TRANSMISSOR DE GÁS).
// ============================================================

#include <WiFi.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <math.h>
#include <stdarg.h>
#include "ui.h"
#include "seg_logic.h"

// ---------------- Tela touch (SpotPear/Waveshare ESP32-S3-Touch-LCD-4.3B) ----------------
// 1 = mostra a interface da segurança (ui.cpp). 0 = sem tela (a lógica roda igual).
#define USE_DISPLAY 1

// ---------------- Wi-Fi e NexusHome ----------------
#define WIFI_SSID        "SUA_REDE_WIFI"          // só 2.4 GHz
#define WIFI_PASSWORD    "SUA_SENHA_WIFI"
#define GATEWAY_URL      "https://gfjxcsvxhaojbtuixpjh.supabase.co/functions/v1/iot-gateway"
#define DEVICE_SECRET    "SUA_IOT_DEVICE_SECRET"   // = IOT_DEVICE_SECRET do Supabase

#define PUBLISH_INTERVAL_MS   15000     // estado ao vivo (painel/3D): tudo num POST
#define COMMAND_POLL_MS       5000      // comandos do app (luzes, válvula, exaustores, alarme)
#define CLIMATE_LOG_MS        300000    // histórico de temperatura/umidade: 1 a cada 5 min por cômodo
#define GAS_LOG_MS            60000     // histórico de % LEL: 1 por minuto por transmissor (migração 025)

// ---------------- RS-485 (mesma placa das telas de água e energia) ----------------
// ESP32-S3-Touch-LCD-4.3B: GPIO43/44 · LCD-7 e LCD-4.3 sem "B": GPIO15/16.
// O firmware troca RX/TX sozinho se ninguém responder (RS485_AUTO_SWAP).
#define RS485_PIN_A     43
#define RS485_PIN_B     44
#define RS485_AUTO_SWAP true
#define RS485_DE_PIN    -1      // só com transceptor externo de controle manual
#define RS485_BAUD      9600    // barramento B: 9600 8N1 (XY-MD02 e Waveshare de fábrica)
#define MB_TIMEOUT_MS   200
#define MB_RETRIES      2

// ---------------- Endereços do barramento B (§5.2) ----------------
#define ADDR_GAS_KITCHEN    50   // transmissor de gás — Cozinha
#define ADDR_GAS_LAUNDRY    51   // transmissor de gás — Lavanderia
#define ADDR_MD_FIRST       80   // XY-MD02 80..87
#define MD_COUNT            8
#define ADDR_RELAY_LIGHTS   90   // Relay (D) 8CH + 8DI: luzes L01–L08 + retornos
#define ADDR_RELAY_AUX      91   // Relay (D) 8CH + 8DI: L09–L10, exaustores, sirenes, corte de gás + entradas
#define ADDR_IO_PRESENCE    92   // IO 8CH: presença × 8
#define ADDR_IO_SAFETY      93   // IO 8CH: fumaça/térmico × 6 + portas × 2

// ---------------- Waveshare Modbus RTU Relay (D) e IO 8CH ----------------
#define RELAYD_COIL_BASE    0x0000   // bobinas CH1..CH8 (funções 01/05/0F) — CONFIRMAR no manual do Relay (D)
#define RELAYD_DI_FUNC      0x02     // entradas DI1..DI8: "read discrete inputs" — CONFIRMAR
#define RELAYD_DI_BASE      0x0000   // primeira entrada — CONFIRMAR
#define IO8_DI_FUNC         0x02     // IO 8CH: entradas DI1..DI8 — CONFIRMAR no manual do IO 8CH
#define IO8_DI_BASE         0x0000   // CONFIRMAR
#define RELAY_ADDR_REG      0x4000   // endereço do módulo Waveshare (holding, função 06); de fábrica = 1
#define RELAY_REFRESH_MS    30000    // reenvia as bobinas (módulo reiniciado volta com tudo desligado)
// Inverte entradas por módulo (bit 0 = DI1), se a ligação "fonte/dreno" deixar o sinal ao contrário.
#define DI_INVERT_90        0x00
#define DI_INVERT_91        0x00
#define DI_INVERT_92        0x00
#define DI_INVERT_93        0x00
#define DI_FAILS_OFF        3        // leituras seguidas sem resposta → módulo "offline"
#define DI_OFFLINE_RETRY_MS 5000     // módulo offline: tenta de novo a cada 5 s (não atrasa a volta)
#define MODULE_ALERT_MS     30000UL  // módulo (ou transmissor) mudo por 30 s → alerta warning

// Mapa do Relay (D) 91 (§8 "Mapa completo do módulo 91")
#define AUX_CH_FAN1         3        // exaustor Banheiro 1 (relé de interface 24 V)
#define AUX_CH_FAN2         4        // exaustor Banheiro 2
#define AUX_CH_SIREN_IN     5        // sirene interna
#define AUX_CH_SIREN_OUT    6        // sirene externa com strobe
#define AUX_CH_GAS_CUT      7        // corte de gás: o NF está na cadeia da válvula (ligado = gás cortado)
#define AUX_DI_VALVE        3        // +24 V da bobina da válvula depois da cadeia de corte: 1 = aberta
#define AUX_DI_AC_FAIL      4        // DRC-100B "AC fail": 1 = sem 220 V, segurança na bateria
#define AUX_DI_BATT_LOW     5        // DRC-100B "bateria baixa"
#define AUX_DI_PANIC        7        // botão de pânico (NA)
// IO 8CH 93
#define SAFETY_DI_FRONT     7        // porta de entrada (magnético NF: 0 = aberta)
#define SAFETY_DI_SERVICE   8        // porta da cozinha/serviço (NF)
#define DOOR_CONTACT_NC     true     // contato NF: entrada em 0 = porta aberta

// ---------------- XY-MD02 (temperatura/umidade) ----------------
#define MD_FUNC             0x04     // input registers
#define MD_REG_TEMP         0x0001   // temperatura × 0,1 °C (com sinal) — verificar no lote comprado
#define MD_REG_HUM          0x0002   // umidade × 0,1 %
#define MD_ADDR_REG         0x0101   // endereço (holding, função 06)
#define MD_POLL_MS          10000    // cada sensor a cada ~10 s (grandezas lentas)
#define MD_FAILS_OFF        3

// ---------------- Transmissores de gás — CONFIRMAR TUDO NO MANUAL DO MODELO COMPRADO ----------------
#define GAS_FUNC            3        // função de leitura (03 holding ou 04 input) — CONFIRMAR
#define GAS_REG_LEL         0x0000   // registrador da concentração — CONFIRMAR
#define GAS_SCALE           1.0f     // valor bruto × escala = % LEL (ex.: 0.1 se vier em décimos) — CONFIRMAR
#define GAS_REG_STATUS      -1       // registrador com o estado AL1/AL2 (-1 = não usa: deriva da leitura) — CONFIRMAR
#define GAS_AL1_MASK        0x0001   // bit de AL1 no registrador de estado — CONFIRMAR
#define GAS_AL2_MASK        0x0002   // bit de AL2 — CONFIRMAR
#define GAS_POLL_MS         2000     // cada transmissor a cada 2 s (o corte é por fio; isto é supervisão)
#define GAS_OFFLINE_RETRY_MS 10000
#define GAS_FAILS_OFF       3
#define GAS_WARN_LEL        10.0f    // AL1: pré-alarme (warning)
#define GAS_WARN_OFF_LEL    5.0f     // histerese do pré-alarme
#define GAS_CUT_LEL         20.0f    // AL2: corte + sirenes, travado até o rearme
#define GAS_BLOCK_AREA_LIGHTS 1      // com gás na área, a luz dela não é comutada (nem acender, nem apagar)

// ---------------- Luzes three-way ----------------
#define LIGHT_CONFIRM_MS       300   // confere o retorno 300 ms depois de inverter o relé...
#define LIGHT_CONFIRM_RETRY_MS 500   // ...e mais uma vez 500 ms depois, antes de avisar
#define LIGHT_CONFIRM_TRIES    2

// ---------------- Sirenes, alarme e exaustores ----------------
#define SIREN_MS            180000UL  // fumaça, pânico e intrusão: sirenes por 3 min
#define GAS_SIREN_MS        0UL       // gás: 0 = tocam até o rearme ou "Silenciar"
#define ALARM_EXIT_MS       60000UL   // atraso de saída ao armar (para sair sem disparar)
#define ALARM_ENTRY_MS      30000UL   // atraso de entrada na porta de entrada (93/DI7)
#define ALARM_PRESENCE_MASK 0xFF      // presenças que disparam no "ausente" (bit 0 = 92/DI1). Ex.: 0x7F tira a Área Externa
#define FAN_ON_HUM          75.0f     // UR > 75 % liga
#define FAN_OFF_HUM         60.0f     // UR < 60 % desliga
#define FAN_MIN_MS          300000UL  // mínimo 5 min ligado
#define FAN_MAX_MS          3600000UL // máximo 60 min ligado
#define FAN_MANUAL_MS       1800000UL // comando manual (app/tela) vale por 30 min

// bits de um byte na serial ("DI8..1 = 00000101")
#define BYTE_FMT "%c%c%c%c%c%c%c%c"
#define BYTE_ARGS(b) (((b) & 0x80) ? '1' : '0'), (((b) & 0x40) ? '1' : '0'), (((b) & 0x20) ? '1' : '0'), \
                     (((b) & 0x10) ? '1' : '0'), (((b) & 0x08) ? '1' : '0'), (((b) & 0x04) ? '1' : '0'), \
                     (((b) & 0x02) ? '1' : '0'), (((b) & 0x01) ? '1' : '0')

// ============================================================
// Tabelas (§8 X4/X6, §10.4, §15.1)
// ============================================================
enum { MOD_LIGHTS = 0, MOD_AUX = 1, MOD_PRESENCE = 2, MOD_SAFETY = 3, DI_MODULES = 4 };
struct DiModule { uint8_t slave; uint8_t func; uint16_t base; uint8_t invert; const char* name; };
const DiModule DIMOD[DI_MODULES] = {
  { ADDR_RELAY_LIGHTS, RELAYD_DI_FUNC, RELAYD_DI_BASE, DI_INVERT_90, "Relay (D) 90 (retornos L01–L08)" },
  { ADDR_RELAY_AUX,    RELAYD_DI_FUNC, RELAYD_DI_BASE, DI_INVERT_91, "Relay (D) 91 (L09–L10, válvula, fonte F2, pânico)" },
  { ADDR_IO_PRESENCE,  IO8_DI_FUNC,    IO8_DI_BASE,    DI_INVERT_92, "IO 8CH 92 (presença)" },
  { ADDR_IO_SAFETY,    IO8_DI_FUNC,    IO8_DI_BASE,    DI_INVERT_93, "IO 8CH 93 (fumaça e portas)" },
};

struct RelayBoard { uint8_t slave; const char* name; };
const RelayBoard BOARDS[] = {
  { ADDR_RELAY_LIGHTS, "Relay (D) 90 (luzes L01–L08)" },
  { ADDR_RELAY_AUX,    "Relay (D) 91 (L09–L10, exaustores, sirenes, corte de gás)" },
};
const int BOARD_COUNT = sizeof(BOARDS) / sizeof(BOARDS[0]);

// Luzes L01–L10: board = índice em BOARDS · ch = canal 1..8 · retorno = módulo/DI ·
// gas = transmissor da mesma área (-1 = nenhum): com gás ali, a luz não é comutada
struct Light { const char* uuid; const char* tag; const char* room; uint8_t board; uint8_t ch; uint8_t diMod; uint8_t di; int8_t gas; };
const Light LIGHTS[] = {
  { "b3000000-0000-4000-8000-000000000001", "L01", "Sala de Estar",    0, 1, MOD_LIGHTS, 1, -1 },
  { "b3000000-0000-4000-8000-000000000002", "L02", "Sala de TV",       0, 2, MOD_LIGHTS, 2, -1 },
  { "b3000000-0000-4000-8000-000000000003", "L03", "Cozinha",          0, 3, MOD_LIGHTS, 3,  0 },
  { "b3000000-0000-4000-8000-000000000004", "L04", "Quarto Principal", 0, 4, MOD_LIGHTS, 4, -1 },
  { "b3000000-0000-4000-8000-000000000005", "L05", "Quarto 2",         0, 5, MOD_LIGHTS, 5, -1 },
  { "b3000000-0000-4000-8000-000000000006", "L06", "Quarto 3",         0, 6, MOD_LIGHTS, 6, -1 },
  { "b3000000-0000-4000-8000-000000000007", "L07", "Banheiro 1",       0, 7, MOD_LIGHTS, 7, -1 },
  { "b3000000-0000-4000-8000-000000000008", "L08", "Banheiro 2",       0, 8, MOD_LIGHTS, 8, -1 },
  { "b3000000-0000-4000-8000-000000000009", "L09", "Lavanderia",       1, 1, MOD_AUX,    1,  1 },
  { "b3000000-0000-4000-8000-000000000010", "L10", "Área Externa",     1, 2, MOD_AUX,    2, -1 },
};
const int LIGHT_COUNT = sizeof(LIGHTS) / sizeof(LIGHTS[0]);

// Sensores por cômodo (b3…21–30): md = XY-MD02 (0 = não tem) · pres = 92/DIn (0 = não tem) ·
// smoke = detector 0..5 em 93/DI1..6 (-1 = não tem) · heat = termovelocimétrico ·
// door = 93/DIn (0 = não tem) · fan = exaustor 0..1 (-1 = não tem)
struct Room { const char* uuid; const char* name; uint8_t md; uint8_t pres; int8_t smoke; bool heat; uint8_t door; int8_t fan; };
const Room ROOMS[] = {
  { "b3000000-0000-4000-8000-000000000021", "Sala de Estar",    80, 1,  0, false, SAFETY_DI_FRONT,   -1 },
  { "b3000000-0000-4000-8000-000000000022", "Sala de TV",       81, 2,  1, false, 0,                 -1 },
  { "b3000000-0000-4000-8000-000000000023", "Cozinha",           0, 3,  2, true,  SAFETY_DI_SERVICE, -1 },
  { "b3000000-0000-4000-8000-000000000024", "Quarto Principal", 82, 4,  3, false, 0,                 -1 },
  { "b3000000-0000-4000-8000-000000000025", "Quarto 2",         83, 5,  4, false, 0,                 -1 },
  { "b3000000-0000-4000-8000-000000000026", "Quarto 3",         84, 6,  5, false, 0,                 -1 },
  { "b3000000-0000-4000-8000-000000000027", "Banheiro 1",       85, 0, -1, false, 0,                  0 },
  { "b3000000-0000-4000-8000-000000000028", "Banheiro 2",       86, 0, -1, false, 0,                  1 },
  { "b3000000-0000-4000-8000-000000000029", "Lavanderia",       87, 7, -1, false, 0,                 -1 },
  { "b3000000-0000-4000-8000-000000000030", "Área Externa",      0, 8, -1, false, 0,                 -1 },
};
const int ROOM_COUNT = sizeof(ROOMS) / sizeof(ROOMS[0]);
const char* const SMOKE_NAMES[UI_SMOKE] = { "Sala de Estar", "Sala de TV", "Cozinha (térmico)", "Quarto Principal", "Quarto 2", "Quarto 3" };

struct GasTx { const char* uuid; const char* name; uint8_t slave; };
const GasTx GAS[] = {
  { "b3000000-0000-4000-8000-000000000031", "Cozinha",    ADDR_GAS_KITCHEN },
  { "b3000000-0000-4000-8000-000000000032", "Lavanderia", ADDR_GAS_LAUNDRY },
};
const int GAS_COUNT = sizeof(GAS) / sizeof(GAS[0]);

struct Fan { const char* uuid; const char* name; uint8_t ch; uint8_t room; };
const Fan FANS[] = {
  { "b3000000-0000-4000-8000-000000000041", "Banheiro 1", AUX_CH_FAN1, 6 },
  { "b3000000-0000-4000-8000-000000000042", "Banheiro 2", AUX_CH_FAN2, 7 },
};
const int FAN_COUNT = sizeof(FANS) / sizeof(FANS[0]);

const char* DEVICE_VALVE = "b3000000-0000-4000-8000-000000000033";   // Válvula de gás (valve)
const char* DEVICE_ALARM = "b3000000-0000-4000-8000-000000000050";   // Alarme da casa (alarm)

const GasCfg   GCFG = { GAS_WARN_LEL, GAS_WARN_OFF_LEL, GAS_CUT_LEL };
const FanCfg   FCFG = { FAN_ON_HUM, FAN_OFF_HUM, FAN_MIN_MS, FAN_MAX_MS, FAN_MANUAL_MS };
const AlarmCfg ACFG = { ALARM_EXIT_MS, ALARM_ENTRY_MS };
const char* const ARM_NAMES[] = { "off", "home", "away" };
const char* const ARM_LABELS[] = { "Desarmado", "Em casa", "Ausente" };

// ============================================================
// Modbus RTU mínimo (mestre) — mesmo núcleo do firmware de energia
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
  while (RS485.available()) RS485.read();
  if (RS485_DE_PIN >= 0) digitalWrite(RS485_DE_PIN, HIGH);
  RS485.write(frame, lenNoCrc + 2);
  RS485.flush();
  if (RS485_DE_PIN >= 0) digitalWrite(RS485_DE_PIN, LOW);
  delay(2);   // silêncio mínimo entre quadros (3,5 caracteres ≈ 4 ms a 9600, somado ao tempo de resposta)
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
  if (n < 5 || resp[0] != slave) return -1;
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

// Funções 01 (bobinas) e 02 (entradas discretas): até 32 bits; bit0 de `bits` = endereço addr.
bool mbReadBits(uint8_t slave, uint8_t func, uint16_t addr, uint8_t count, uint32_t& bits, int retries = MB_RETRIES) {
  uint8_t req[8] = { slave, func, (uint8_t)(addr >> 8), (uint8_t)addr, 0x00, count };
  uint8_t resp[5 + 4];
  uint8_t nbytes = (count + 7) / 8;
  if (count == 0 || count > 32) return false;
  for (int attempt = 0; attempt <= retries; attempt++) {
    mbSend(req, 6);
    if (mbReceive(resp, 5 + nbytes, slave, func) > 0 && resp[2] == nbytes) {
      bits = 0;
      for (uint8_t i = 0; i < nbytes; i++) bits |= (uint32_t)resp[3 + i] << (8 * i);
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

// Função 0F: escreve `count` bobinas (até 32) de uma vez; bit0 do bits = bobina addr.
// Se o módulo recusar, cai para um 0x05 por canal.
bool mbWriteCoils(uint8_t slave, uint16_t addr, uint8_t count, uint32_t bits) {
  uint8_t nbytes = (count + 7) / 8;
  uint8_t req[7 + 4 + 2] = { slave, 0x0F, (uint8_t)(addr >> 8), (uint8_t)addr, 0x00, count, nbytes };
  for (uint8_t i = 0; i < nbytes; i++) req[7 + i] = (bits >> (8 * i)) & 0xFF;
  uint8_t resp[8];
  for (int attempt = 0; attempt <= MB_RETRIES; attempt++) {
    mbSend(req, 7 + nbytes);
    if (mbReceive(resp, 8, slave, 0x0F) > 0) return true;
    delay(20);
  }
  bool ok = true;
  for (uint8_t i = 0; i < count; i++) ok &= mbWriteCoil(slave, addr + i, (bits >> i) & 1);
  return ok;
}

bool rs485Swapped = false;
void rs485Begin() {
  int rx = rs485Swapped ? RS485_PIN_B : RS485_PIN_A;
  int tx = rs485Swapped ? RS485_PIN_A : RS485_PIN_B;
  RS485.end();
  RS485.begin(RS485_BAUD, SERIAL_8N1, rx, tx);
  Serial.printf("[rs485] UART RX=GPIO%d TX=GPIO%d\n", rx, tx);
}
// Responde (mesmo com exceção)? Funções 01/02 devolvem 6 bytes; 03/04, 7.
bool mbPing(uint8_t slave, uint8_t func) {
  uint8_t req[8] = { slave, func, 0x00, 0x00, 0x00, 0x01 };
  uint8_t resp[8];
  mbSend(req, 6);
  int r = mbReceive(resp, func <= 0x02 ? 6 : 7, slave, func);
  return r > 0 || r == -2;
}
bool anySlaveAnswers() {
  for (int m = 0; m < DI_MODULES; m++) if (mbPing(DIMOD[m].slave, DIMOD[m].func)) return true;
  for (int k = 0; k < 3; k++) if (mbPing(ADDR_MD_FIRST + k, MD_FUNC)) return true;
  return false;
}
void rs485AutoDetect() {
  if (!RS485_AUTO_SWAP || anySlaveAnswers()) return;
  rs485Swapped = !rs485Swapped;
  rs485Begin();
  if (!anySlaveAnswers()) { rs485Swapped = !rs485Swapped; rs485Begin(); }
}

// ============================================================
// Estado
// ============================================================
Preferences prefs;
portMUX_TYPE stateMux = portMUX_INITIALIZER_UNLOCKED;   // telemetria e tela leem o retrato no outro núcleo

// entradas digitais (filtradas: 2 leituras iguais)
uint8_t diStable[DI_MODULES], diPrevRaw[DI_MODULES], diFails[DI_MODULES];
bool diOk[DI_MODULES], diAlerted[DI_MODULES];
unsigned long diReadAt[DI_MODULES], diRetryAt[DI_MODULES], diDownSince[DI_MODULES];
static inline bool diBit(int m, int n /* 1..8 */) { return n >= 1 && n <= 8 && ((diStable[m] >> (n - 1)) & 1); }
static inline bool doorIsOpen(int di) { bool v = diBit(MOD_SAFETY, di); return DOOR_CONTACT_NC ? !v : v; }

// relés
bool boardOk[2], boardDirty[2];
unsigned long lastRelayRefresh = 0;
bool coilPos[LIGHT_COUNT];            // posição de cada canal das luzes (persiste: o three-way depende dela)
LightConfirm lconf[LIGHT_COUNT];

// gás
float gasLel[GAS_COUNT];
bool gasOk[GAS_COUNT], gasAl1[GAS_COUNT], gasAl2[GAS_COUNT], gasDownAlerted[GAS_COUNT];
uint8_t gasFails[GAS_COUNT];
unsigned long gasNextAt[GAS_COUNT], gasDownSince[GAS_COUNT];
GasTxState gasSt[GAS_COUNT];
bool gasLatched = false;              // alarme de gás travado (persiste até o rearme)
bool valveCmdClosed = false;          // válvula fechada pelo app/tela (persiste)

// XY-MD02
float mdTemp[MD_COUNT], mdHum[MD_COUNT];
bool mdOk[MD_COUNT];
uint8_t mdFails[MD_COUNT];
unsigned long mdNextAt[MD_COUNT];
int mdTurn = 0;
static inline int mdIndex(uint8_t addr) { return (addr >= ADDR_MD_FIRST && addr < ADDR_MD_FIRST + MD_COUNT) ? addr - ADDR_MD_FIRST : -1; }

// exaustores, alarme e sirenes
FanState fanSt[FAN_COUNT];
AlarmState houseAlarm;
enum SirenReason { SR_GAS = 0, SR_SMOKE, SR_PANIC, SR_INTRUSION, SR_COUNT };
const char* const SIREN_WHY[SR_COUNT] = { "gás", "fumaça/calor", "pânico", "intrusão" };
bool sirenOn[SR_COUNT];
unsigned long sirenAt[SR_COUNT];
bool sirenOut = false;

// retrato para a telemetria e a tela (o loop monta, os outros copiam)
UiState live, build;
char noticeBuf[112] = "";
uint16_t noticeSeq = 0;

// alertas pendentes para o próximo POST (o loop escreve, a telemetria envia)
#define ALERT_SLOTS 8
struct PendingAlert { char severity[10]; char message[160]; };
PendingAlert alertQ[ALERT_SLOTS];
int alertCount = 0;
volatile bool urgentPublish = false;  // alerta crítico: publica já na próxima volta da telemetria

void raiseAlert(const char* severity, const char* fmt, ...) {
  char msg[160];
  va_list ap; va_start(ap, fmt); vsnprintf(msg, sizeof(msg), fmt, ap); va_end(ap);
  Serial.printf("[alerta %s] %s\n", severity, msg);
  bool critical = !strcmp(severity, "critical");
  portENTER_CRITICAL(&stateMux);
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
    strncpy(alertQ[alertCount].severity, severity, sizeof(alertQ[0].severity) - 1);
    alertQ[alertCount].severity[sizeof(alertQ[0].severity) - 1] = 0;
    strncpy(alertQ[alertCount].message, msg, sizeof(alertQ[0].message) - 1);
    alertQ[alertCount].message[sizeof(alertQ[0].message) - 1] = 0;
    alertCount++;
  }
  portEXIT_CRITICAL(&stateMux);
  if (critical) urgentPublish = true;
}

// aviso curto na tela (e na serial) — resposta a um toque/comando
void notice(const char* fmt, ...) {
  va_list ap; va_start(ap, fmt); vsnprintf(noticeBuf, sizeof(noticeBuf), fmt, ap); va_end(ap);
  noticeSeq++;
  Serial.printf("[aviso] %s\n", noticeBuf);
}

// ---- persistência ----
void saveCoils() {
  uint16_t bits = 0;
  for (int i = 0; i < LIGHT_COUNT; i++) if (coilPos[i]) bits |= (1u << i);
  prefs.putUShort("coils", bits);
}
void saveGas() {
  prefs.putBool("gaslatch", gasLatched);
  prefs.putBool("valvecut", valveCmdClosed);
}
void loadState() {
  uint16_t bits = prefs.getUShort("coils", 0);
  for (int i = 0; i < LIGHT_COUNT; i++) coilPos[i] = bits & (1u << i);
  gasLatched = prefs.getBool("gaslatch", false);
  valveCmdClosed = prefs.getBool("valvecut", false);
  uint8_t mode = prefs.getUChar("armed", ARM_OFF);
  memset(&houseAlarm, 0, sizeof(houseAlarm));
  // armado antes do reinício: volta armado, com o atraso de saída como carência (entradas estabilizam)
  if (mode <= ARM_AWAY) alarmSetMode(houseAlarm, mode, millis(), ACFG);
}

// ============================================================
// Saídas (bobinas dos Relay (D) 90 e 91)
// ============================================================
bool gasCutWanted() { return gasLatched || valveCmdClosed; }

uint32_t boardBits(int b) {
  uint32_t bits = 0;
  for (int i = 0; i < LIGHT_COUNT; i++)
    if (LIGHTS[i].board == b && coilPos[i]) bits |= 1UL << (LIGHTS[i].ch - 1);
  if (b == 1) {
    if (fanSt[0].on) bits |= 1UL << (AUX_CH_FAN1 - 1);
    if (fanSt[1].on) bits |= 1UL << (AUX_CH_FAN2 - 1);
    if (sirenOut) bits |= (1UL << (AUX_CH_SIREN_IN - 1)) | (1UL << (AUX_CH_SIREN_OUT - 1));
    if (gasCutWanted()) bits |= 1UL << (AUX_CH_GAS_CUT - 1);
  }
  return bits;
}

void markAux() { boardDirty[1] = true; }

void applyOutputs(bool force) {
  for (int b = 0; b < BOARD_COUNT; b++) {
    if (!force && !boardDirty[b]) continue;
    bool ok = mbWriteCoils(BOARDS[b].slave, RELAYD_COIL_BASE, 8, boardBits(b));
    if (ok != boardOk[b]) Serial.printf("[relés] %s: %s\n", BOARDS[b].name, ok ? "ok" : "SEM RESPOSTA");
    boardOk[b] = ok;
    boardDirty[b] = !ok;   // falhou: tenta de novo na próxima volta
  }
}

// ============================================================
// Leitura do barramento
// ============================================================
// Entradas digitais: os 4 módulos a cada volta (prioridade). Módulo mudo: só a cada 5 s.
void readInputs() {
  for (int m = 0; m < DI_MODULES; m++) {
    if (!diOk[m] && diFails[m] >= DI_FAILS_OFF && !segReached(millis(), diRetryAt[m])) continue;
    uint32_t bits = 0;
    bool ok = mbReadBits(DIMOD[m].slave, DIMOD[m].func, DIMOD[m].base, 8, bits, 1);
    if (ok) {
      segDebounce(diStable[m], diPrevRaw[m], (uint8_t)((bits & 0xFF) ^ DIMOD[m].invert));
      if (!diOk[m]) Serial.printf("[entradas] %s: ok\n", DIMOD[m].name);
      diOk[m] = true;
      diFails[m] = 0;
      diReadAt[m] = millis();
      diDownSince[m] = 0;
      if (diAlerted[m]) { diAlerted[m] = false; raiseAlert("info", "%s voltou a responder no barramento B", DIMOD[m].name); }
    } else if (diFails[m] < 255 && ++diFails[m] >= DI_FAILS_OFF) {
      if (diOk[m]) Serial.printf("[entradas] %s: SEM RESPOSTA\n", DIMOD[m].name);
      diOk[m] = false;
      diRetryAt[m] = millis() + DI_OFFLINE_RETRY_MS;
      if (!diDownSince[m]) diDownSince[m] = millis();
    }
  }
}

void onGasCut(int g, float lel);

void readGas(int g) {
  uint16_t r = 0;
  bool ok = mbReadRegs(GAS[g].slave, GAS_FUNC, GAS_REG_LEL, 1, &r, 1);
  float lel = r * GAS_SCALE;
  bool al1 = lel >= GAS_WARN_LEL, al2 = lel >= GAS_CUT_LEL;   // sem registrador de estado: derivados da leitura
  if (ok && GAS_REG_STATUS >= 0) {
    uint16_t st = 0;
    if (mbReadRegs(GAS[g].slave, GAS_FUNC, (uint16_t)GAS_REG_STATUS, 1, &st, 1)) {
      al1 = (st & GAS_AL1_MASK) || al1;
      al2 = (st & GAS_AL2_MASK) || al2;
    }
  }
  if (ok) {
    if (!gasOk[g]) Serial.printf("[gás] transmissor %s (slave %u): ok\n", GAS[g].name, GAS[g].slave);
    gasLel[g] = lel; gasAl1[g] = al1; gasAl2[g] = al2;
    gasOk[g] = true; gasFails[g] = 0; gasDownSince[g] = 0;
    if (gasDownAlerted[g]) { gasDownAlerted[g] = false; raiseAlert("info", "Transmissor de gás — %s voltou a responder", GAS[g].name); }
  } else if (gasFails[g] < 255 && ++gasFails[g] >= GAS_FAILS_OFF) {
    if (gasOk[g]) Serial.printf("[gás] transmissor %s (slave %u): SEM RESPOSTA\n", GAS[g].name, GAS[g].slave);
    gasOk[g] = false;
    if (!gasDownSince[g]) gasDownSince[g] = millis();
  }
  GasEval ev = gasStep(gasSt[g], gasLatched, ok, lel, al1, al2, GCFG);
  if (ev.newCut) onGasCut(g, lel);
  else if (ev.newWarn)
    raiseAlert("warning", "Gás — %s: %.0f %% LEL (pré-alarme). Ventile sem acionar interruptores e procure o vazamento.",
               GAS[g].name, lel);
  if (ev.warnCleared) raiseAlert("info", "Gás — %s voltou ao normal (%.0f %% LEL)", GAS[g].name, lel);
}

void readClimate(int k) {
  uint16_t r[2] = { 0, 0 };
  uint8_t addr = ADDR_MD_FIRST + k;
#if MD_REG_HUM == MD_REG_TEMP + 1
  bool ok = mbReadRegs(addr, MD_FUNC, MD_REG_TEMP, 2, r, 1);
#else
  bool ok = mbReadRegs(addr, MD_FUNC, MD_REG_TEMP, 1, &r[0], 1) && mbReadRegs(addr, MD_FUNC, MD_REG_HUM, 1, &r[1], 1);
#endif
  if (ok) {
    if (!mdOk[k]) Serial.printf("[clima] XY-MD02 %u: ok\n", addr);
    mdTemp[k] = (int16_t)r[0] / 10.0f;
    mdHum[k] = r[1] / 10.0f;
    mdOk[k] = true;
    mdFails[k] = 0;
  } else if (mdFails[k] < 255 && ++mdFails[k] >= MD_FAILS_OFF) {
    if (mdOk[k]) Serial.printf("[clima] XY-MD02 %u: SEM RESPOSTA\n", addr);
    mdOk[k] = false;
  }
}

// Um aparelho "lento" por volta: o gás primeiro (a cada 2 s), depois um XY-MD02 (a cada 10 s).
void pollSlow() {
  unsigned long now = millis();
  for (int g = 0; g < GAS_COUNT; g++) {
    if (!segReached(now, gasNextAt[g])) continue;
    gasNextAt[g] = now + (gasOk[g] || gasFails[g] < GAS_FAILS_OFF ? GAS_POLL_MS : GAS_OFFLINE_RETRY_MS);
    readGas(g);
    return;
  }
  for (int j = 0; j < MD_COUNT; j++) {
    int k = (mdTurn + j) % MD_COUNT;
    if (!segReached(now, mdNextAt[k])) continue;
    mdNextAt[k] = now + MD_POLL_MS;
    mdTurn = k + 1;
    readClimate(k);
    return;
  }
}

// ============================================================
// Sirenes
// ============================================================
void sirenStart(int why) {
  sirenOn[why] = true;
  sirenAt[why] = millis();
}

bool sirenActive(int why) {
  if (!sirenOn[why]) return false;
  unsigned long dur = why == SR_GAS ? GAS_SIREN_MS : SIREN_MS;
  if (dur && segElapsed(millis(), sirenAt[why], dur)) { sirenOn[why] = false; return false; }
  return true;
}

void updateSirens() {
  bool want = false;
  for (int r = 0; r < SR_COUNT; r++) want |= sirenActive(r);
  if (want == sirenOut) return;
  sirenOut = want;
  markAux();
  Serial.printf("[sirenes] %s\n", want ? "LIGADAS" : "desligadas");
}

void silenceSirens(const char* origem) {
  bool any = false;
  for (int r = 0; r < SR_COUNT; r++) { any |= sirenOn[r]; sirenOn[r] = false; }
  updateSirens();
  notice(any ? "Sirenes silenciadas (%s)." : "As sirenes já estão desligadas (%s).", origem);
}

// ============================================================
// Gás e válvula
// ============================================================
void onGasCut(int g, float lel) {
  saveGas();
  markAux();             // CH7 liga (corte) já nesta volta
  sirenStart(SR_GAS);
  raiseAlert("critical", "VAZAMENTO DE GÁS — %s: %.0f %% LEL. Válvula cortada e sirenes ligadas. Saia do local sem "
             "acionar interruptores; rearme na tela T3 só depois de ventilar.", GAS[g].name, lel);
  notice("GÁS na %s: válvula cortada. Não acione interruptores nem exaustores.", GAS[g].name);
}

void gasRearm(const char* origem) {
  if (!gasLatched) { notice("Nenhum alarme de gás travado."); return; }
  if (!gasCanRearm(GAS_COUNT, gasOk, gasLel, gasAl1, gasAl2, GCFG)) {
    int g = (gasOk[0] && (gasLel[0] >= GAS_WARN_LEL || gasAl1[0] || gasAl2[0])) ? 0 : 1;
    notice("Rearme recusado: ainda há gás (%.0f %% LEL na %s). Ventile e tente de novo.", gasLel[g], GAS[g].name);
    return;
  }
  gasLatched = false;
  for (int g = 0; g < GAS_COUNT; g++) gasSt[g].tripped = false;
  sirenOn[SR_GAS] = false;
  saveGas();
  markAux();
  raiseAlert("info", "Alarme de gás rearmado (%s). A válvula tem rearme manual: reabra-a na mão.", origem);
  notice(valveCmdClosed ? "Gás rearmado. A válvula continua fechada pelo comando manual."
                        : "Gás rearmado. Reabra a válvula de gás NA MÃO (rearme mecânico).");
}

// open = false fecha (liga o corte CH7) · open = true desliga o corte (se não houver alarme travado)
void valveCommand(bool open, const char* origem) {
  if (!open) {
    if (!valveCmdClosed) { valveCmdClosed = true; saveGas(); markAux(); }
    notice("Válvula de gás fechada (%s): corte ligado.", origem);
    return;
  }
  if (gasLatched) { notice("Não dá para liberar a válvula: alarme de gás travado. Rearme primeiro."); return; }
  if (valveCmdClosed) { valveCmdClosed = false; saveGas(); markAux(); }
  notice("Corte de gás desligado (%s). Reabra a válvula NA MÃO (rearme mecânico).", origem);
}

bool gasAreaAlarm(int g) { return g >= 0 && g < GAS_COUNT && (gasSt[g].warn || gasAl2[g] || (gasLatched && gasSt[g].tripped)); }
bool lightBlocked(int i) { return GAS_BLOCK_AREA_LIGHTS && gasAreaAlarm(LIGHTS[i].gas); }

// ============================================================
// Luzes three-way
// ============================================================
void lightCommand(int i, bool on, const char* origem) {
  if (i < 0 || i >= LIGHT_COUNT) return;
  const Light& L = LIGHTS[i];
  if (lightBlocked(i)) { notice("Luz %s bloqueada: gás na área (nenhuma carga é comutada).", L.room); return; }
  if (lconf[i].active) { notice("Luz %s: aguardando a confirmação do comando anterior.", L.room); return; }
  int m = L.diMod;
  if (!diOk[m]) { notice("Luz %s: sem retorno (%s não responde). Comando ignorado.", L.room, DIMOD[m].name); return; }
  bool fb = diBit(m, L.di);
  if (!lightNeedsFlip(on, true, fb)) {
    Serial.printf("[luz %s] %s já está %s (%s)\n", L.tag, L.room, fb ? "acesa" : "apagada", origem);
    return;
  }
  bool pos = !coilPos[i];
  if (!mbWriteCoil(BOARDS[L.board].slave, RELAYD_COIL_BASE + L.ch - 1, pos)) {
    boardOk[L.board] = false;
    notice("Luz %s: o relé (slave %u) não respondeu.", L.room, BOARDS[L.board].slave);
    return;
  }
  boardOk[L.board] = true;
  coilPos[i] = pos;
  saveCoils();
  lightConfirmStart(lconf[i], on, millis(), LIGHT_CONFIRM_MS);
  Serial.printf("[luz %s] %s → %s (%s): canal %u invertido para %s\n", L.tag, L.room, on ? "acender" : "apagar",
                origem, L.ch, pos ? "NA" : "NF");
}

void checkLights() {
  for (int i = 0; i < LIGHT_COUNT; i++) {
    const Light& L = LIGHTS[i];
    int m = L.diMod;
    ConfirmResult r = lightConfirmStep(lconf[i], diOk[m], diBit(m, L.di), (uint32_t)diReadAt[m],
                                       LIGHT_CONFIRM_RETRY_MS, LIGHT_CONFIRM_TRIES);
    if (r == CR_OK) Serial.printf("[luz %s] %s confirmada %s\n", L.tag, L.room, lconf[i].expect ? "acesa" : "apagada");
    else if (r == CR_FAIL) {
      bool want = lconf[i].expect;
      raiseAlert("warning", "Luz — %s (%s) não %s: o relé inverteu, mas o retorno não mudou. Confira a lâmpada, o "
                 "disjuntor da iluminação e a fiação do three-way.", L.room, L.tag, want ? "acendeu" : "apagou");
      notice("Luz %s não %s: confira a lâmpada e o disjuntor.", L.room, want ? "acendeu" : "apagou");
    }
  }
}

// ============================================================
// Fumaça, pânico, fonte F2, válvula (bordas das entradas) e supervisão
// ============================================================
void checkSafetyInputs() {
  static uint8_t seenSafety = 0, seenAux = 0;
  if (diOk[MOD_SAFETY]) {
    uint8_t cur = diStable[MOD_SAFETY];
    uint8_t rise = cur & ~seenSafety, fall = seenSafety & ~cur;
    for (int k = 0; k < UI_SMOKE; k++) {
      if (rise & (1 << k)) {
        bool heat = k == 2;
        raiseAlert("critical", heat ? "CALOR ANORMAL — %s: detector térmico disparou. Sirenes ligadas; a iluminação fica como está."
                                    : "FUMAÇA — %s: detector disparou. Sirenes ligadas; a iluminação fica como está.",
                   SMOKE_NAMES[k]);
        sirenStart(SR_SMOKE);
      } else if (fall & (1 << k)) {
        Serial.printf("[fumaça] %s normalizou\n", SMOKE_NAMES[k]);
      }
    }
    seenSafety = cur;
  }
  if (diOk[MOD_AUX]) {
    uint8_t cur = diStable[MOD_AUX];
    uint8_t rise = cur & ~seenAux, fall = seenAux & ~cur;
    auto bit = [](int di) { return (uint8_t)(1 << (di - 1)); };
    if (rise & bit(AUX_DI_PANIC)) {
      raiseAlert("critical", "BOTÃO DE PÂNICO acionado. Sirenes ligadas.");
      sirenStart(SR_PANIC);
    }
    if (rise & bit(AUX_DI_AC_FAIL))
      raiseAlert("warning", "Fonte de segurança na bateria: a DRC-100B está sem 220 V (autonomia de ~3 h).");
    if (fall & bit(AUX_DI_AC_FAIL)) raiseAlert("info", "Fonte de segurança: 220 V de volta.");
    if (rise & bit(AUX_DI_BATT_LOW))
      raiseAlert("critical", "Bateria da fonte de segurança BAIXA: a tela T3, os sensores e a válvula de gás vão desligar.");
    if ((fall & bit(AUX_DI_VALVE)) && !gasCutWanted())
      raiseAlert("warning", "A válvula de gás fechou sem comando da automação (botoeira de emergência, AL2 do "
                 "transmissor ou falta de 24 V). Confira e reabra na mão.");
    seenAux = cur;
  }
  // supervisão: módulo de entradas ou transmissor de gás mudo
  unsigned long now = millis();
  for (int m = 0; m < DI_MODULES; m++) {
    if (diOk[m] || !diDownSince[m] || diAlerted[m] || !segElapsed(now, diDownSince[m], MODULE_ALERT_MS)) continue;
    diAlerted[m] = true;
    raiseAlert("warning", "%s sem resposta no barramento B: sem supervisão dessas entradas. Confira o cabo A/B e a alimentação.",
               DIMOD[m].name);
  }
  for (int g = 0; g < GAS_COUNT; g++) {
    if (gasOk[g] || !gasDownSince[g] || gasDownAlerted[g] || !segElapsed(now, gasDownSince[g], MODULE_ALERT_MS)) continue;
    gasDownAlerted[g] = true;
    raiseAlert("warning", "Transmissor de gás — %s (slave %u) sem resposta: sem leitura de %% LEL (o corte por fio continua).",
               GAS[g].name, GAS[g].slave);
  }
}

// ============================================================
// Alarme da casa
// ============================================================
void zoneText(uint8_t zone, char* out, size_t n) {
  if (zone == ZB_FRONT) { snprintf(out, n, "porta de entrada"); return; }
  if (zone == ZB_SERVICE) { snprintf(out, n, "porta da cozinha/serviço"); return; }
  snprintf(out, n, "presença");
  size_t len = strlen(out);
  bool first = true;
  for (int r = 0; r < ROOM_COUNT && len < n - 2; r++) {
    if (!ROOMS[r].pres || !(ALARM_PRESENCE_MASK & (1 << (ROOMS[r].pres - 1))) || !diBit(MOD_PRESENCE, ROOMS[r].pres)) continue;
    snprintf(out + len, n - len, "%s%s", first ? " em " : ", ", ROOMS[r].name);
    len = strlen(out);
    first = false;
  }
}

void setArmed(uint8_t mode, const char* origem) {
  if (mode > ARM_AWAY) return;
  if (mode == houseAlarm.mode && !houseAlarm.triggered) { Serial.printf("[alarme] já está %s (%s)\n", ARM_LABELS[mode], origem); return; }
  alarmSetMode(houseAlarm, mode, millis(), ACFG);
  prefs.putUChar("armed", mode);
  if (mode == ARM_OFF) {
    sirenOn[SR_INTRUSION] = false;
    notice("Alarme desarmado (%s).", origem);
  } else {
    notice("Alarme armado: %s (%s). %lu s para sair.", ARM_LABELS[mode], origem, (unsigned long)(ALARM_EXIT_MS / 1000));
  }
}

void checkAlarm() {
  bool front = diOk[MOD_SAFETY] && doorIsOpen(SAFETY_DI_FRONT);
  bool service = diOk[MOD_SAFETY] && doorIsOpen(SAFETY_DI_SERVICE);
  bool presence = diOk[MOD_PRESENCE] && (diStable[MOD_PRESENCE] & ALARM_PRESENCE_MASK);
  AlarmEvent ev = alarmStep(houseAlarm, front, service, presence, millis(), ACFG, sirenActive(SR_INTRUSION));
  if (ev == AE_NONE) return;
  if (ev == AE_ENTRY_STARTED) {
    notice("Porta de entrada aberta: desarme em %lu s.", (unsigned long)(ALARM_ENTRY_MS / 1000));
    return;
  }
  char zone[96];
  zoneText(houseAlarm.zone, zone, sizeof(zone));
  sirenStart(SR_INTRUSION);
  raiseAlert("critical", "%s (%s): %s. Sirenes ligadas por %lu min.", ev == AE_RETRIGGER ? "ALARME: novo disparo" : "ALARME DISPARADO",
             ARM_LABELS[houseAlarm.mode], zone, (unsigned long)(SIREN_MS / 60000));
}

// ============================================================
// Exaustores
// ============================================================
void checkFans() {
  unsigned long now = millis();
  for (int f = 0; f < FAN_COUNT; f++) {
    int k = mdIndex(ROOMS[FANS[f].room].md);
    bool humOk = k >= 0 && mdOk[k];
    float hum = humOk ? mdHum[k] : 0;
    if (fanStep(fanSt[f], humOk, hum, now, FCFG)) {
      markAux();
      Serial.printf("[exaustor] %s %s (%s, UR %s)\n", FANS[f].name, fanSt[f].on ? "LIGADO" : "desligado",
                    fanSt[f].manual ? "manual" : "automático", humOk ? String(hum, 0).c_str() : "--");
    }
  }
}

void fanCommand(int f, int value, const char* origem) {
  if (f < 0 || f >= FAN_COUNT) return;
  if (value == 2) fanAuto(fanSt[f]);
  else fanManual(fanSt[f], value == 1, millis(), FCFG);
  markAux();
  if (value == 2) notice("Exaustor %s: automático pela umidade (%s).", FANS[f].name, origem);
  else notice("Exaustor %s %s por %lu min (%s).", FANS[f].name, value == 1 ? "ligado" : "desligado",
              (unsigned long)(FAN_MANUAL_MS / 60000), origem);
}

// ============================================================
// Pedidos (tela, app e serial chegam por esta fila; o barramento só é usado pelo loop)
// ============================================================
QueueHandle_t requestQueue;
void submitRequest(const UiRequest& r) { if (requestQueue) xQueueSend(requestQueue, &r, 0); }

void processRequests() {
  UiRequest r;
  while (requestQueue && xQueueReceive(requestQueue, &r, 0) == pdTRUE) {
    const char* origem = r.remote ? "app" : "tela/serial";
    switch (r.type) {
      case UI_REQ_LIGHT:   lightCommand(r.idx, r.on, origem); break;
      case UI_REQ_ARM:     setArmed((uint8_t)r.value, origem); break;
      case UI_REQ_SILENCE: silenceSirens(origem); break;
      case UI_REQ_REARM:   gasRearm(origem); break;
      case UI_REQ_VALVE:   valveCommand(r.on, origem); break;
      case UI_REQ_FAN:     fanCommand(r.idx, r.value, origem); break;
      default: break;
    }
  }
}

// ============================================================
// Retrato (tela + telemetria)
// ============================================================
void updateSnapshot() {
  unsigned long now = millis();
  UiState& s = build;
  for (int i = 0; i < LIGHT_COUNT && i < UI_LIGHTS; i++) {
    int m = LIGHTS[i].diMod;
    s.lightOn[i] = diBit(m, LIGHTS[i].di);
    s.lightKnown[i] = diOk[m];
    s.lightPending[i] = lconf[i].active;
    s.lightBlocked[i] = lightBlocked(i);
  }
  for (int r = 0; r < ROOM_COUNT && r < UI_ROOMS; r++) {
    const Room& R = ROOMS[r];
    int k = mdIndex(R.md);
    s.climateOk[r] = k >= 0 && mdOk[k];
    s.temp[r] = s.climateOk[r] ? mdTemp[k] : 0;
    s.hum[r] = s.climateOk[r] ? mdHum[k] : 0;
    s.presence[r] = R.pres && diBit(MOD_PRESENCE, R.pres);
    s.smoke[r] = R.smoke >= 0 && diBit(MOD_SAFETY, R.smoke + 1);
    s.doorOpen[r] = R.door && diOk[MOD_SAFETY] && doorIsOpen(R.door);
  }
  s.presenceOk = diOk[MOD_PRESENCE];
  s.safetyOk = diOk[MOD_SAFETY];
  for (int g = 0; g < GAS_COUNT && g < UI_GAS; g++) {
    s.gasLel[g] = gasLel[g]; s.gasOk[g] = gasOk[g]; s.gasAl1[g] = gasAl1[g]; s.gasAl2[g] = gasAl2[g];
    s.gasWarn[g] = gasSt[g].warn; s.gasTripped[g] = gasLatched && gasSt[g].tripped;
  }
  s.valveOpen = diBit(MOD_AUX, AUX_DI_VALVE);
  s.valveKnown = diOk[MOD_AUX];
  s.gasCut = gasCutWanted();
  s.gasLatched = gasLatched;
  s.valveCmdClosed = valveCmdClosed;
  for (int f = 0; f < FAN_COUNT && f < UI_FANS; f++) {
    s.fanOn[f] = fanSt[f].on;
    s.fanAuto[f] = !fanSt[f].manual;
    s.fanManualLeftS[f] = fanSt[f].manual ? (uint16_t)segLeftS(now, fanSt[f].manualUntil) : 0;
  }
  s.armed = houseAlarm.mode;
  s.triggered = houseAlarm.triggered;
  s.trigZone = houseAlarm.triggered ? houseAlarm.zone : 0;
  s.exitLeftS = houseAlarm.exitActive ? (uint16_t)segLeftS(now, houseAlarm.exitUntil) : 0;
  s.entryLeftS = houseAlarm.entryActive ? (uint16_t)segLeftS(now, houseAlarm.entryUntil) : 0;
  s.sirens = sirenOut;
  s.auxOk = diOk[MOD_AUX];
  s.panic = diBit(MOD_AUX, AUX_DI_PANIC);
  s.acFail = diBit(MOD_AUX, AUX_DI_AC_FAIL);
  s.battLow = diBit(MOD_AUX, AUX_DI_BATT_LOW);
  int ok = 0;
  for (int m = 0; m < DI_MODULES; m++) ok += diOk[m];
  for (int g = 0; g < GAS_COUNT; g++) ok += gasOk[g];
  for (int k = 0; k < MD_COUNT; k++) ok += mdOk[k];
  s.modulesOk = ok;
  s.modulesTotal = DI_MODULES + GAS_COUNT + MD_COUNT;
  s.wifiOk = WiFi.status() == WL_CONNECTED;
  memcpy(s.notice, noticeBuf, sizeof(s.notice));
  s.noticeSeq = noticeSeq;
  portENTER_CRITICAL(&stateMux);
  memcpy(&live, &build, sizeof(UiState));
  portEXIT_CRITICAL(&stateMux);
}

// ============================================================
// Telemetria (tarefa no núcleo 0 — HTTP lento não atrasa a segurança)
// ============================================================
int httpPost(const String& body, String& resp) {
  if (WiFi.status() != WL_CONNECTED) return -1;
  HTTPClient http;
  http.begin(GATEWAY_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-key", DEVICE_SECRET);
  http.setTimeout(8000);
  int code = http.POST(body);
  resp = code > 0 ? http.getString().substring(0, 400) : String();
  if (code != 200) Serial.printf("[iot] lote → HTTP %d %s\n", code, resp.c_str());
  http.end();
  return code;
}

static void appendBool(String& s, const char* key, bool v) { s += ",\""; s += key; s += v ? "\":true" : "\":false"; }
static void appendNum(String& s, const char* key, float v, int dec) { s += ",\""; s += key; s += "\":"; s += String(v, dec); }

static void appendJsonText(String& s, const char* txt) {
  s += '"';
  for (const char* p = txt; *p; p++) {
    if (*p == '"' || *p == '\\') s += '\\';
    if ((uint8_t)*p >= 0x20) s += *p;
  }
  s += '"';
}

// item só com status: {"device_id":"…","status":{ … }} — `fields` começa com vírgula (appendBool/appendNum)
static void addStatus(String& body, bool& first, const char* uuid, const String& fields) {
  if (!first) body += ',';
  first = false;
  body += "{\"device_id\":\""; body += uuid; body += "\",\"status\":{";
  body += fields.length() ? fields.substring(1) : String();
  body += "}}";
}

// item só de histórico (separado do status: uma métrica recusada não derruba o painel ao vivo)
static void addMetric(String& body, bool& first, const char* uuid, const char* metric, float v, int dec) {
  if (!first) body += ',';
  first = false;
  body += "{\"device_id\":\""; body += uuid; body += "\",\"metric_type\":\""; body += metric;
  body += "\",\"value\":"; body += String(v, dec); body += '}';
}

void publishBatch() {
  static UiState snap;                                    // fora da pilha da tarefa
  static unsigned long climateLoggedAt[UI_ROOMS], gasLoggedAt[UI_GAS], gasHistOffUntil = 0;
  PendingAlert alerts[ALERT_SLOTS]; int nAlerts;
  portENTER_CRITICAL(&stateMux);
  memcpy(&snap, &live, sizeof(UiState));
  nAlerts = alertCount;
  memcpy(alerts, alertQ, sizeof(PendingAlert) * nAlerts);
  portEXIT_CRITICAL(&stateMux);
  urgentPublish = false;

  unsigned long now = millis();
  bool loggedClimate[UI_ROOMS] = { false }, loggedGas[UI_GAS] = { false };
  bool gasHist = !gasHistOffUntil || segReached(now, gasHistOffUntil);
  String body, f;
  body.reserve(8000);
  body = "{\"source\":\"seguranca\",\"readings\":[";
  bool first = true;

  // luzes: {on} = estado REAL (retorno)
  for (int i = 0; i < LIGHT_COUNT; i++) {
    f = "";
    if (snap.lightKnown[i]) appendBool(f, "on", snap.lightOn[i]);
    appendBool(f, "hw_ok", snap.lightKnown[i]);
    if (snap.lightBlocked[i]) appendBool(f, "blocked", true);
    addStatus(body, first, LIGHTS[i].uuid, f);
  }
  // sensores por cômodo
  for (int r = 0; r < ROOM_COUNT; r++) {
    const Room& R = ROOMS[r];
    bool ok = true;
    f = "";
    if (R.md) {
      if (snap.climateOk[r]) { appendNum(f, "temp", snap.temp[r], 1); appendNum(f, "hum", snap.hum[r], 1); }
      else { f += ",\"temp\":null,\"hum\":null"; ok = false; }
    }
    if (R.pres) { if (snap.presenceOk) appendBool(f, "presence", snap.presence[r]); else ok = false; }
    if (R.smoke >= 0) { if (snap.safetyOk) appendBool(f, R.heat ? "heat" : "smoke", snap.smoke[r]); else ok = false; }
    if (R.door) { if (snap.safetyOk) appendBool(f, "door", snap.doorOpen[r]); else ok = false; }   // door: true = aberta
    appendBool(f, "sensors_ok", ok);
    addStatus(body, first, R.uuid, f);
    if (snap.climateOk[r] && (!climateLoggedAt[r] || segElapsed(now, climateLoggedAt[r], CLIMATE_LOG_MS))) {
      addMetric(body, first, R.uuid, "temperature", snap.temp[r], 1);
      addMetric(body, first, R.uuid, "humidity", snap.hum[r], 1);
      loggedClimate[r] = true;
    }
  }
  // gás
  for (int g = 0; g < GAS_COUNT; g++) {
    f = "";
    if (snap.gasOk[g]) {
      appendNum(f, "gas_lel", snap.gasLel[g], 1);
      appendBool(f, "gas_al1", snap.gasAl1[g]);
      appendBool(f, "gas_al2", snap.gasAl2[g]);
    }
    appendBool(f, "gas", snap.gasAl2[g] || snap.gasTripped[g]);
    appendBool(f, "hw_ok", snap.gasOk[g]);
    addStatus(body, first, GAS[g].uuid, f);
    if (gasHist && snap.gasOk[g] && (!gasLoggedAt[g] || segElapsed(now, gasLoggedAt[g], GAS_LOG_MS))) {
      addMetric(body, first, GAS[g].uuid, "gas_lel", snap.gasLel[g], 1);
      loggedGas[g] = true;
    }
  }
  // válvula de gás: {open} = estado REAL (91/DI3)
  f = "";
  if (snap.valveKnown) appendBool(f, "open", snap.valveOpen);
  appendBool(f, "cut", snap.gasCut);
  appendBool(f, "latched", snap.gasLatched);
  appendBool(f, "manual_reset", true);
  addStatus(body, first, DEVICE_VALVE, f);
  // exaustores
  for (int k = 0; k < FAN_COUNT; k++) {
    f = "";
    appendBool(f, "on", snap.fanOn[k]);
    appendBool(f, "auto", snap.fanAuto[k]);
    addStatus(body, first, FANS[k].uuid, f);
  }
  // alarme
  f = ",\"armed\":\"";
  f += ARM_NAMES[snap.armed <= ARM_AWAY ? snap.armed : 0];
  f += '"';
  appendBool(f, "triggered", snap.triggered);
  appendBool(f, "sirens", snap.sirens);
  addStatus(body, first, DEVICE_ALARM, f);
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

  String resp;
  int code = httpPost(body, resp);
  bool anyGasLog = loggedGas[0] || loggedGas[1];
  if (anyGasLog && (code == 207 || code >= 400) && resp.indexOf("gas_lel") >= 0) {
    // servidor sem a migração 025: para o histórico de gás por 1 h (o status continua)
    gasHistOffUntil = now + 3600000UL;
    if (!gasHistOffUntil) gasHistOffUntil = 1;
    for (int g = 0; g < GAS_COUNT; g++) loggedGas[g] = false;
    Serial.println("[iot] histórico gas_lel recusado — execute a migração 025 no Supabase (tento de novo em 1 h)");
  }
  if (code == 200 || code == 207) {
    portENTER_CRITICAL(&stateMux);
    // remove só os alertas enviados (o loop pode ter acrescentado outros nesse meio-tempo)
    int rest = alertCount - nAlerts;
    if (rest > 0) memmove(alertQ, alertQ + nAlerts, sizeof(PendingAlert) * rest);
    alertCount = rest > 0 ? rest : 0;
    portEXIT_CRITICAL(&stateMux);
    for (int r = 0; r < ROOM_COUNT; r++) if (loggedClimate[r]) climateLoggedAt[r] = now ? now : 1;
    for (int g = 0; g < GAS_COUNT; g++) if (loggedGas[g]) gasLoggedAt[g] = now ? now : 1;
  }
}

// GET /iot-gateway/commands?devices=… → {"commands":[{"id":"…","device_id":"…","command":{"on":false}}]}
// command: {"on":bool} (luzes, exaustores) · {"open":bool} (válvula) · {"armed":"off|home|away"} (alarme)
void pollCommands() {
  if (WiFi.status() != WL_CONNECTED) return;
  String url = String(GATEWAY_URL) + "/commands?devices=";
  for (int i = 0; i < LIGHT_COUNT; i++) { url += LIGHTS[i].uuid; url += ','; }
  for (int k = 0; k < FAN_COUNT; k++) { url += FANS[k].uuid; url += ','; }
  url += DEVICE_VALVE; url += ','; url += DEVICE_ALARM;
  HTTPClient http;
  http.begin(url);
  http.addHeader("x-device-key", DEVICE_SECRET);
  http.setTimeout(6000);
  int code = http.GET();
  if (code != 200) {
    if (code > 0) Serial.printf("[cmd] HTTP %d %s\n", code, http.getString().substring(0, 200).c_str());
    http.end();
    return;
  }
  String body = http.getString();
  http.end();
  int pos = 0;
  while ((pos = body.indexOf("\"device_id\":\"", pos)) >= 0) {
    pos += 13;
    String id = body.substring(pos, pos + 36);
    int next = body.indexOf("\"device_id\":\"", pos);
    String seg = body.substring(pos, next < 0 ? body.length() : next);
    int kOn = seg.indexOf("\"on\":"), kOpen = seg.indexOf("\"open\":"), kArmed = seg.indexOf("\"armed\":\"");
    bool on = kOn >= 0 && seg.startsWith("true", kOn + 5);
    bool open = kOpen >= 0 && seg.startsWith("true", kOpen + 7);
    for (int i = 0; i < LIGHT_COUNT; i++) {
      if (kOn < 0 || id != LIGHTS[i].uuid) continue;
      Serial.printf("[cmd] app: luz %s → %s\n", LIGHTS[i].room, on ? "acender" : "apagar");
      submitRequest(UiRequest{ UI_REQ_LIGHT, (int16_t)i, on, 0, true });
    }
    for (int k = 0; k < FAN_COUNT; k++) {
      if (kOn < 0 || id != FANS[k].uuid) continue;
      Serial.printf("[cmd] app: exaustor %s → %s\n", FANS[k].name, on ? "ligar" : "desligar");
      submitRequest(UiRequest{ UI_REQ_FAN, (int16_t)k, on, (int8_t)(on ? 1 : 0), true });
    }
    if (kOpen >= 0 && id == DEVICE_VALVE) {
      Serial.printf("[cmd] app: válvula de gás → %s\n", open ? "liberar" : "fechar");
      submitRequest(UiRequest{ UI_REQ_VALVE, 0, open, 0, true });
    }
    if (kArmed >= 0 && id == DEVICE_ALARM) {
      int8_t mode = -1;
      if (seg.startsWith("off\"", kArmed + 9)) mode = ARM_OFF;
      else if (seg.startsWith("home\"", kArmed + 9)) mode = ARM_HOME;
      else if (seg.startsWith("away\"", kArmed + 9)) mode = ARM_AWAY;
      if (mode >= 0) {
        Serial.printf("[cmd] app: alarme → %s\n", ARM_NAMES[mode]);
        submitRequest(UiRequest{ UI_REQ_ARM, 0, false, mode, true });
      }
    }
  }
}

void telemetryTask(void*) {
  unsigned long lastPublish = 0;
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(COMMAND_POLL_MS));
    if (WiFi.status() != WL_CONNECTED) continue;
    pollCommands();
    if (millis() - lastPublish < PUBLISH_INTERVAL_MS && !urgentPublish) continue;
    lastPublish = millis();
    vTaskDelay(pdMS_TO_TICKS(400));   // o loop aplica os comandos recém-chegados antes do retrato
    publishBatch();
  }
}

// ============================================================
// Bancada (serial 115200)
// ============================================================
void printStatus() {
  unsigned long now = millis();
  Serial.printf("RS485 %s · Wi-Fi %s · alarme %s%s · gás %s · sirenes %s\n", rs485Swapped ? "invertido" : "normal",
                WiFi.status() == WL_CONNECTED ? "ok" : "fora", ARM_LABELS[houseAlarm.mode], houseAlarm.triggered ? " (DISPARADO)" : "",
                gasLatched ? "TRAVADO" : "normal", sirenOut ? "LIGADAS" : "desligadas");
  for (int m = 0; m < DI_MODULES; m++)
    Serial.printf("  %-52s %s  DI8..1 = " BYTE_FMT "\n", DIMOD[m].name, diOk[m] ? "ok          " : "SEM RESPOSTA", BYTE_ARGS(diStable[m]));
  for (int b = 0; b < BOARD_COUNT; b++)
    Serial.printf("  bobinas %-44s %s  CH8..1 = " BYTE_FMT "\n", BOARDS[b].name, boardOk[b] ? "ok          " : "SEM RESPOSTA", BYTE_ARGS(boardBits(b)));
  for (int i = 0; i < LIGHT_COUNT; i++) {
    int m = LIGHTS[i].diMod;
    Serial.printf("  %s %-18s %s · canal %s%s%s\n", LIGHTS[i].tag, LIGHTS[i].room,
                  diOk[m] ? (diBit(m, LIGHTS[i].di) ? "ACESA  " : "apagada") : "??     ", coilPos[i] ? "NA" : "NF",
                  lconf[i].active ? " (confirmando)" : "", lightBlocked(i) ? " (BLOQUEADA: gás)" : "");
  }
  for (int g = 0; g < GAS_COUNT; g++)
    Serial.printf("  gás %-10s slave %u: %s %.1f %% LEL%s%s%s\n", GAS[g].name, GAS[g].slave, gasOk[g] ? "ok" : "SEM RESPOSTA",
                  gasLel[g], gasAl1[g] ? " AL1" : "", gasAl2[g] ? " AL2" : "", gasSt[g].warn ? " (pré-alarme)" : "");
  Serial.printf("  válvula: %s · corte CH7 %s%s\n", diOk[MOD_AUX] ? (diBit(MOD_AUX, AUX_DI_VALVE) ? "ABERTA" : "FECHADA") : "??",
                gasCutWanted() ? "LIGADO" : "desligado", valveCmdClosed ? " (comando manual)" : "");
  for (int k = 0; k < MD_COUNT; k++)
    if (mdOk[k]) Serial.printf("  XY-MD02 %u: %.1f °C  %.1f %%\n", ADDR_MD_FIRST + k, mdTemp[k], mdHum[k]);
    else Serial.printf("  XY-MD02 %u: SEM RESPOSTA\n", ADDR_MD_FIRST + k);
  for (int f = 0; f < FAN_COUNT; f++)
    Serial.printf("  exaustor %s: %s (%s)\n", FANS[f].name, fanSt[f].on ? "LIGADO" : "desligado",
                  fanSt[f].manual ? "manual" : "automático");
  if (houseAlarm.exitActive) Serial.printf("  alarme: atraso de saída, %lu s\n", (unsigned long)segLeftS(now, houseAlarm.exitUntil));
  if (houseAlarm.entryActive) Serial.printf("  alarme: atraso de ENTRADA, %lu s\n", (unsigned long)segLeftS(now, houseAlarm.entryUntil));
}

void scanBus() {
  Serial.println("[scan] endereços 1..100 (03 holding, 04 input, 02 entradas):");
  for (uint8_t a = 1; a <= 100; a++) {
    const char* how = nullptr;
    if (mbPing(a, 0x03)) how = "[03]";
    else if (mbPing(a, 0x04)) how = "[04]";
    else if (mbPing(a, 0x02)) how = "[02]";
    if (how) Serial.printf("  slave %u responde %s\n", a, how);
  }
  Serial.println("[scan] fim");
}

void mbDump(uint8_t slave) {
  for (uint8_t func = 3; func <= 4; func++) {
    uint16_t r[10];
    if (!mbReadRegs(slave, func, 0, 10, r)) { Serial.printf("slave %u · função %02X: sem resposta\n", slave, func); continue; }
    Serial.printf("slave %u · função %02X:", slave, func);
    for (int i = 0; i < 10; i++) Serial.printf(" %u", r[i]);
    Serial.println();
  }
  for (uint8_t func = 1; func <= 2; func++) {
    uint32_t bits = 0;
    if (mbReadBits(slave, func, 0, 8, bits)) Serial.printf("slave %u · função %02X (bit8..1): " BYTE_FMT "\n", slave, func, BYTE_ARGS(bits));
    else Serial.printf("slave %u · função %02X: sem resposta\n", slave, func);
  }
}

// Grava o endereço de um XY-MD02 (holding 0x0101) — de fábrica costuma ser 1
void mdSetAddress(uint8_t slave, uint8_t addr) {
  if (addr < 1 || addr > 247) { Serial.println("endereço deve ser 1..247"); return; }
  bool ok = mbWriteReg(slave, MD_ADDR_REG, addr);
  Serial.printf("[xy-md02] %u → %u: %s\n", slave, addr, ok ? "gravado — desligue e religue o sensor e confira com 'scan'" : "sem resposta");
}

// Grava o endereço de um módulo Waveshare (Relay (D) / IO 8CH: holding 0x4000 — CONFIRMAR no IO 8CH)
void relaySetAddress(uint8_t slave, uint8_t addr) {
  if (addr < 1 || addr > 247) { Serial.println("endereço deve ser 1..247"); return; }
  bool ok = mbWriteReg(slave, RELAY_ADDR_REG, addr);
  Serial.printf("[waveshare] %u → %u: %s\n", slave, addr, ok ? "gravado — confira com 'scan'" : "sem resposta");
}

void handleSerial() {
  static String line;
  while (Serial.available()) {
    char c = Serial.read();
    if (c != '\n' && c != '\r') { line += c; continue; }
    line.trim(); line.toLowerCase();
    int sp = line.indexOf(' ');
    String arg = sp > 0 ? line.substring(sp + 1) : String();
    arg.trim();
    int sp2 = arg.indexOf(' ');
    if (line == "status") printStatus();
    else if (line == "scan") scanBus();
    else if (line == "rearmar") submitRequest(UiRequest{ UI_REQ_REARM, 0, false, 0, false });
    else if (line == "sirene off" || line == "sirenes off") submitRequest(UiRequest{ UI_REQ_SILENCE, 0, false, 0, false });
    else if (line.startsWith("dump ")) mbDump((uint8_t)arg.toInt());
    else if (line.startsWith("luz ") && sp2 > 0) {
      String v = arg.substring(sp2 + 1); v.trim();
      submitRequest(UiRequest{ UI_REQ_LIGHT, (int16_t)(arg.toInt() - 1), v == "on", 0, false });
    }
    else if (line.startsWith("mdaddr ") && sp2 > 0) mdSetAddress((uint8_t)arg.toInt(), (uint8_t)arg.substring(sp2 + 1).toInt());
    else if (line.startsWith("reladdr ") && sp2 > 0) relaySetAddress((uint8_t)arg.toInt(), (uint8_t)arg.substring(sp2 + 1).toInt());
    else if (line.startsWith("alarme ")) {
      int8_t mode = arg == "off" ? ARM_OFF : arg == "home" ? ARM_HOME : arg == "away" ? ARM_AWAY : -1;
      if (mode >= 0) submitRequest(UiRequest{ UI_REQ_ARM, 0, false, mode, false });
    }
    else if (line.startsWith("valvula ")) submitRequest(UiRequest{ UI_REQ_VALVE, 0, arg == "liberar", 0, false });
    else if (line.startsWith("exaustor ") && sp2 > 0) {
      String v = arg.substring(sp2 + 1); v.trim();
      submitRequest(UiRequest{ UI_REQ_FAN, (int16_t)(arg.toInt() - 1), v == "on", (int8_t)(v == "auto" ? 2 : v == "on" ? 1 : 0), false });
    }
    else if (line.length())
      Serial.println("comandos: status | scan | dump S | rearmar | luz N on|off | sirene off | mdaddr S NOVO | reladdr S NOVO |"
                     " alarme off|home|away | valvula fechar|liberar | exaustor N on|off|auto");
    line = "";
  }
}

// ============================================================
// Tela
// ============================================================
#if USE_DISPLAY
UiLight uiLights[UI_LIGHTS];
UiRoom uiRooms[UI_ROOMS];
UiState uiState;   // global: fora da pilha do loop

void refreshScreen() {
  static unsigned long last = 0;
  if (millis() - last < 300) return;
  last = millis();
  portENTER_CRITICAL(&stateMux);
  memcpy(&uiState, &live, sizeof(UiState));
  portEXIT_CRITICAL(&stateMux);
  ui_update(uiState);
}
#endif

// ============================================================
// Setup / Loop
// ============================================================
void setup() {
  Serial.begin(115200);
  requestQueue = xQueueCreate(32, sizeof(UiRequest));
  memset(&live, 0, sizeof(live));
  memset(&build, 0, sizeof(build));
#if USE_DISPLAY
  for (int i = 0; i < LIGHT_COUNT && i < UI_LIGHTS; i++) uiLights[i] = UiLight{ LIGHTS[i].room, LIGHTS[i].tag };
  for (int r = 0; r < ROOM_COUNT && r < UI_ROOMS; r++)
    uiRooms[r] = UiRoom{ ROOMS[r].name, ROOMS[r].md != 0, ROOMS[r].pres != 0, ROOMS[r].smoke, ROOMS[r].heat, ROOMS[r].door != 0, ROOMS[r].fan };
  UiConfig cfg;
  cfg.lights = uiLights;
  cfg.rooms = uiRooms;
  for (int g = 0; g < UI_GAS; g++) cfg.gasNames[g] = GAS[g].name;
  for (int k = 0; k < UI_SMOKE; k++) cfg.smokeNames[k] = SMOKE_NAMES[k];
  cfg.gasWarn = GAS_WARN_LEL;
  cfg.gasCut = GAS_CUT_LEL;
  cfg.exitDelayS = ALARM_EXIT_MS / 1000;
  cfg.entryDelayS = ALARM_ENTRY_MS / 1000;
  if (!ui_begin(cfg, submitRequest))
    Serial.println("[tela] falha ao iniciar o display — a segurança continua sem tela");
#endif
  prefs.begin("seguranca", false);
  loadState();
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);   // não bloqueia: a segurança roda sem Wi-Fi
  if (RS485_DE_PIN >= 0) { pinMode(RS485_DE_PIN, OUTPUT); digitalWrite(RS485_DE_PIN, LOW); }
  rs485Begin();
  delay(800);                 // escravos terminam o boot
  rs485AutoDetect();
  applyOutputs(true);         // devolve as posições dos three-way e o corte de gás travado
  lastRelayRefresh = millis();
  xTaskCreatePinnedToCore(telemetryTask, "telemetria", 12288, nullptr, 1, nullptr, 0);
  Serial.printf("[boot] segurança: %d luzes, %d cômodos, %d transmissores de gás · alarme %s%s — digite 'status'\n",
                LIGHT_COUNT, ROOM_COUNT, GAS_COUNT, ARM_LABELS[houseAlarm.mode], gasLatched ? " · GÁS TRAVADO" : "");
}

void loop() {
  handleSerial();
  processRequests();           // comandos antes da leitura: resposta rápida
  applyOutputs(false);
  if (millis() - lastRelayRefresh >= RELAY_REFRESH_MS) { lastRelayRefresh = millis(); applyOutputs(true); }
  readInputs();                // os 4 módulos de entradas a cada volta (~40 ms cada)
  pollSlow();                  // um transmissor de gás ou um XY-MD02
  checkLights();
  checkSafetyInputs();
  checkAlarm();
  checkFans();
  updateSirens();
  applyOutputs(false);         // aplica já o que a lógica decidiu (sirenes, corte, exaustores)
  updateSnapshot();
#if USE_DISPLAY
  refreshScreen();
#endif

  // barramento mudo há 20 s (nenhum módulo de entradas responde): tenta a outra ordem RX/TX
  static unsigned long silentSince = 0;
  bool anyOk = false;
  for (int m = 0; m < DI_MODULES; m++) anyOk |= diOk[m];
  if (anyOk) silentSince = 0;
  else if (!silentSince) silentSince = millis();
  else if (millis() - silentSince >= 20000) { silentSince = 0; rs485AutoDetect(); }
}
