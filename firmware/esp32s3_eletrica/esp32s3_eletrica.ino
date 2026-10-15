// ============================================================
// NexusHome OS — Firmware ESP32-S3 · Automação Elétrica (Modbus RTU)
// ------------------------------------------------------------
// Implementa o "Memorial Descritivo & Projeto de Automação — Sistema de
// Monitoramento Energético e Controle Residencial via Modbus RTU". O ESP32-S3
// (SpotPear / Waveshare ESP32-S3-Touch-LCD-4.3B) é o MESTRE Modbus RTU do
// barramento RS-485 dos 3 subquadros e:
//
//   · lê 33 medidores Peacefair PZEM-016 (tensão, corrente, potência, kWh, FP, Hz)
//   · comanda 3 placas Waveshare Modbus RTU Relay (32 + 16 + 32 canais)
//   · protege os circuitos: corte por sobrecarga sustentada (antes do disjuntor)
//     e gestão de demanda (desliga cargas não essenciais acima do limite da entrada)
//   · publica tudo no NexusHome (Edge Function iot-gateway) num POST em lote a cada 15 s
//   · recebe os liga/desliga do app (GET /iot-gateway/commands)
//
// Linguagem: C++ (framework Arduino para ESP32, core 3.x). Placa: "ESP32S3 Dev Module".
// Modbus RTU (CRC16, funções 01/03/04/05/06/0F) implementado aqui, sem biblioteca; a tela usa
// ESP32_Display_Panel 1.0.4 + lvgl 8.4.0 (as mesmas da tela da caixa d'água).
// Tela touch (v2.12): ui.cpp mostra o consumo da casa, os subquadros e cada circuito, com
// ligar/desligar/rearmar pelo toque (USE_DISPLAY 1). Sem tela: USE_DISPLAY 0.
//
// ⚠️ ANTES DE LIGAR, leia docs/automacao-eletrica.md — o memorial tem erros que mudam
//    a montagem (alimentação do PZEM-016, contatoras dos chuveiros, quantidade de nós no
//    barramento, falta de comando manual das luzes). Resumo do que este firmware assume:
//    1) relé ENERGIZADO = carga CORTADA (bobina da contatora no contato NC do relé):
//       com o ESP32/fonte/barramento em falha, a casa continua com energia.
//    2) endereços: 5 = relés Íntimo · 6 = relés Social · 22 = relés Serviços;
//       PZEM 7–16 Íntimo · 17–21 Social · 23–40 Serviços (1–4 ficam para a hidráulica).
//    3) a tabela CIRCUITS é PROVISÓRIA — o memorial não traz o quadro de cargas.
// ============================================================

#include <WiFi.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <math.h>
#include "ui.h"

// ---------------- Tela touch (SpotPear/Waveshare ESP32-S3-Touch-LCD-4.3B) ----------------
// 1 = mostra a interface do quadro elétrico (ui.cpp). 0 = sem tela (outra placa ESP32-S3).
// Bibliotecas (Library Manager): ESP32_Display_Panel 1.0.4 e lvgl 8.4.0 — o script
// scripts/instalar-arduino.ps1 instala as duas.
#define USE_DISPLAY 1

// ---------------- Wi-Fi e NexusHome ----------------
#define WIFI_SSID        "SUA_REDE_WIFI"          // só 2.4 GHz
#define WIFI_PASSWORD    "SUA_SENHA_WIFI"
#define GATEWAY_URL      "https://gfjxcsvxhaojbtuixpjh.supabase.co/functions/v1/iot-gateway"
#define DEVICE_SECRET    "SUA_IOT_DEVICE_SECRET"   // = IOT_DEVICE_SECRET do Supabase

// "Quadro elétrico — consumo total" (supabase/seeds/eletrica.sql). Vazio = não publica.
const char* DEVICE_TOTAL = "b2000000-0000-4000-8000-000000000000";

#define PUBLISH_INTERVAL_MS   15000     // estado ao vivo (painel/3D): todos os circuitos num POST
#define COMMAND_POLL_MS       5000      // liga/desliga pedidos pelo app
#define LOG_INTERVAL_MS       300000    // histórico de cada circuito a cada 5 min...
#define LOG_MIN_GAP_MS        60000     // ...ou antes, se o consumo mudar muito (no máx. 1 por min)
#define LOG_CHANGE_W          100.0f    //    mudança "grande": ≥ 100 W e ≥ 25%
#define LOG_CHANGE_FRAC       0.25f
#define TOTAL_LOG_MS          60000     // histórico do consumo total: 1 por minuto

// ---------------- RS-485 (mesma placa da automação hidráulica) ----------------
// ESP32-S3-Touch-LCD-4.3B: GPIO43/44 · LCD-7 e LCD-4.3 sem "B": GPIO15/16.
// O firmware troca RX/TX sozinho se ninguém responder (RS485_AUTO_SWAP).
#define RS485_PIN_A     43
#define RS485_PIN_B     44
#define RS485_AUTO_SWAP true
#define RS485_DE_PIN    -1      // só com transceptor externo de controle manual
#define RS485_BAUD      9600    // o PZEM-016 só fala 9600 8N1: todo o barramento fica em 9600
#define MB_TIMEOUT_MS   200     // o PZEM responde em ~50–100 ms

// ---------------- Meio do barramento: RS-485 direto ou pelo gateway (v2.14) ----------------
// 0 = RS-485 nativo da placa: o ESP32 fica no quadro, com o par A/B até os escravos.
// 1 = pela rede, via conversor Waveshare "RS485 TO WIFI/ETH" no modo de conversão Modbus TCP ⇄ RTU:
//     o gateway fica no quadro e é o ÚNICO mestre do RS-485; a tela pode ficar em qualquer cômodo
//     (Wi-Fi), e o PC (Modbus Poll) ou o Home Assistant também consultam pelo gateway sem colisão.
//     Sem rede, a tela não lê os medidores e a proteção por software para (os relés mantêm o
//     último estado; com a fiação NC a casa continua com energia) — ver docs/automacao-eletrica.md.
#define BUS_VIA_GATEWAY    0
#define GATEWAY_IP         "192.168.1.200"   // IP fixo do conversor (configure nele e reserve no roteador)
#define GATEWAY_PORT       502               // porta Modbus TCP configurada no conversor
#define GATEWAY_MBAP       true              // true = Modbus TCP (conversão); false = RTU dentro do TCP (modo transparente)
#define MB_TIMEOUT_TCP_MS  800               // rede + 9600 baud no RS-485 do gateway
#define GATEWAY_ALERT_MS   60000UL           // gateway fora por 1 min → alerta no app
#define MB_RETRIES      2

// ---------------- Placas de relé Waveshare (bobinas 0x0000.., funções 01/05/0F) ----------------
struct RelayBoard { uint8_t slave; uint8_t channels; const char* name; };
RelayBoard BOARDS[] = {
  {  5, 32, "Subquadro 1 (Íntimo)" },
  {  6, 16, "Subquadro 2 (Social)" },
  { 22, 32, "Subquadro 3 (Serviços/Oficina)" },
};
const int BOARD_COUNT = sizeof(BOARDS) / sizeof(BOARDS[0]);
#define RELAY_COIL_BASE         0x0000
#define RELAY_ADDR_REG          0x4000   // endereço da placa (holding, função 06); de fábrica = 1
#define RELAY_ENERGIZED_CUTS    true     // relé energizado = carga cortada (fiação no NC — ver doc)
#define RELAY_REFRESH_MS        30000    // reenvia o estado (placa reiniciada volta com tudo desligado)

// ---------------- Medidores PZEM-016 ----------------
// Entradas (função 04), 10 registradores a partir de 0x0000; 32 bits = palavra BAIXA primeiro.
//   0 tensão 0,1 V · 1–2 corrente 0,001 A · 3–4 potência 0,1 W · 5–6 energia 1 Wh
//   7 frequência 0,1 Hz · 8 fator de potência 0,01 · 9 alarme
// Holding (03/06): 0x0001 limiar de alarme de potência · 0x0002 endereço (1–247).
// 0xF8 = endereço "geral" (responde qualquer PZEM — use com UM só no barramento).
#define PZEM_REGS        10
#define PZEM_ADDR_REG    0x0002
#define PZEM_GENERAL     0xF8
#define METER_FAILS_OFF  3       // leituras seguidas sem resposta → medidor "offline"

// ---------------- Proteção ----------------
#define OVERLOAD_RATIO      0.95f     // corrente ≥ 95% do disjuntor...
#define OVERLOAD_MS         30000UL   // ...por 30 s seguidos → corta (se o circuito tiver relé)
#define TRIP_REARM_MS       300000UL  // o app só religa um circuito desarmado depois de 5 min
// Gestão de demanda: soma dos circuitos acima do limite → corta os de menor prioridade.
// 0 = desligada. Ex.: entrada bifásica 220 V com disjuntor geral de 63 A ≈ 13 kW → use ~12000.
#define DEMAND_LIMIT_W      0.0f
#define DEMAND_SHED_MS      10000UL   // acima do limite por 10 s → corta o próximo da fila
#define DEMAND_MARGIN_W     1000.0f   // só religa se couber com esta folga
#define DEMAND_RESTORE_MS   120000UL  // folga estável por 2 min → religa um (o último cortado)

// ---------------- Circuitos (PROVISÓRIO — ajuste ao quadro de cargas real) ----------------
// uuid  = devices.id no Supabase (supabase/seeds/eletrica.sql; vazio = não publica)
// meter = endereço do PZEM-016 · board = índice em BOARDS (-1 = sem relé) · ch = canal 1..N
// breakerA = disjuntor do circuito · shed = prioridade no corte de demanda (0 = nunca corta;
// 1 corta primeiro, 2 depois, 3 por último)
// group = subquadro (índice em GROUP_NAMES) — vira uma aba na tela
const char* const GROUP_NAMES[] = { "Íntimo", "Social", "Serviços" };
const int GROUP_COUNT = sizeof(GROUP_NAMES) / sizeof(GROUP_NAMES[0]);
struct Circuit { const char* uuid; const char* name; uint8_t meter; int8_t board; uint8_t ch; float breakerA; uint8_t shed; uint8_t group; };
// v2.16 (projeto unificado, docs/projeto-unificado.md): a iluminação (25 e 32) saiu deste
// barramento — o liga/desliga das luzes é three-way no barramento B (tela Segurança);
// tomadas de 20 A ficam em disjuntor de 20 A (tomada NBR 14136 de 20 A com disjuntor de
// 25 A ficava sem proteção contra sobrecarga).
Circuit CIRCUITS[] = {
  // ---- Subquadro 1 (Íntimo) · relés slave 5 · PZEM 7–16 ----
  { "b2000000-0000-4000-8000-000000000001", "Chuveiro — Banheiro 1",            7, 0,  1, 40, 3, 0 },
  { "b2000000-0000-4000-8000-000000000002", "Chuveiro — Banheiro 2",            8, 0,  2, 40, 3, 0 },
  { "b2000000-0000-4000-8000-000000000003", "Ar-condicionado — Quarto Principal", 9, 0,  3, 16, 2, 0 },
  { "b2000000-0000-4000-8000-000000000004", "Ar-condicionado — Quarto 2",      10, 0,  4, 16, 2, 0 },
  { "b2000000-0000-4000-8000-000000000005", "Ar-condicionado — Quarto 3 (Home Office)", 11, 0, 5, 16, 2, 0 },
  { "b2000000-0000-4000-8000-000000000006", "Tomadas 10 A — Quarto Principal", 12, 0,  6, 16, 0, 0 },
  { "b2000000-0000-4000-8000-000000000007", "Tomadas 10 A — Quartos 2 e 3",    13, 0,  7, 16, 0, 0 },
  { "b2000000-0000-4000-8000-000000000008", "Tomadas 10 A — Banheiros",        14, 0,  8, 16, 0, 0 },
  { "b2000000-0000-4000-8000-000000000009", "Iluminação — Quartos",            15, -1, 0, 10, 0, 0 },
  { "b2000000-0000-4000-8000-000000000010", "Iluminação — Banheiros e Corredor", 16, -1, 0, 10, 0, 0 },
  // ---- Subquadro 2 (Social) · relés slave 6 · PZEM 17–21 ----
  { "b2000000-0000-4000-8000-000000000011", "Tomadas 10 A — Sala de Estar",    17, 1,  1, 16, 0, 1 },
  { "b2000000-0000-4000-8000-000000000012", "Tomadas 10 A — Sala de TV",       18, 1,  2, 16, 0, 1 },
  { "b2000000-0000-4000-8000-000000000013", "Tomadas 10 A — Copa",             19, 1,  3, 16, 0, 1 },
  { "b2000000-0000-4000-8000-000000000014", "Iluminação — Salas",              20, -1, 0, 10, 0, 1 },
  { "b2000000-0000-4000-8000-000000000015", "Iluminação — Copa e Corredor Social", 21, -1, 0, 10, 0, 1 },
  // ---- Subquadro 3 (Serviços/Oficina) · relés slave 22 · PZEM 23–40 ----
  { "b2000000-0000-4000-8000-000000000016", "Tomadas 20 A — Cozinha (forno/micro-ondas)", 23, 2, 1, 20, 1, 2 },
  { "b2000000-0000-4000-8000-000000000017", "Tomadas 10 A — Cozinha (bancada)", 24, 2,  2, 16, 0, 2 },
  { "b2000000-0000-4000-8000-000000000018", "Geladeira",                       25, -1, 0, 16, 0, 2 },
  { "b2000000-0000-4000-8000-000000000019", "Lava-louças",                     26, 2,  3, 16, 1, 2 },
  { "b2000000-0000-4000-8000-000000000020", "Iluminação — Cozinha",            27, -1, 0, 10, 0, 2 },
  { "b2000000-0000-4000-8000-000000000021", "Máquina de lavar — Lavanderia",   28, 2,  4, 16, 1, 2 },
  { "b2000000-0000-4000-8000-000000000022", "Tomadas 10 A — Lavanderia",       29, 2,  5, 16, 0, 2 },
  { "b2000000-0000-4000-8000-000000000023", "Iluminação — Lavanderia",         30, -1, 0, 10, 0, 2 },
  { "b2000000-0000-4000-8000-000000000024", "Tomadas — Área Externa",          31, 2,  6, 16, 0, 2 },
  { "b2000000-0000-4000-8000-000000000025", "Iluminação — Área Externa",       32, -1, 0, 10, 0, 2 },
  { "b2000000-0000-4000-8000-000000000026", "Portão eletrônico",               33, -1, 0, 10, 0, 2 },
  { "b2000000-0000-4000-8000-000000000027", "Bomba / pressurizador",           34, 2,  8, 16, 1, 2 },
  { "b2000000-0000-4000-8000-000000000028", "Tomadas 20 A — Oficina (bancada 1)", 35, 2, 9, 20, 1, 2 },
  { "b2000000-0000-4000-8000-000000000029", "Tomadas 20 A — Oficina (bancada 2)", 36, 2, 10, 20, 1, 2 },
  { "b2000000-0000-4000-8000-000000000030", "Compressor — Oficina",            37, 2, 11, 25, 1, 2 },
  { "b2000000-0000-4000-8000-000000000031", "Tomadas 10 A — Oficina",          38, 2, 12, 16, 0, 2 },
  { "b2000000-0000-4000-8000-000000000032", "Iluminação — Oficina",            39, -1, 0, 10, 0, 2 },
  { "b2000000-0000-4000-8000-000000000033", "Circuito reserva — Subquadro 3",  40, -1, 0, 16, 0, 2 },
};
const int CIRCUIT_COUNT = sizeof(CIRCUITS) / sizeof(CIRCUITS[0]);
#define MAX_CIRCUITS 64

// ============================================================
// Modbus RTU mínimo (mestre) — mesmo núcleo do firmware hidráulico
// ============================================================
HardwareSerial RS485(1);
#if BUS_VIA_GATEWAY
WiFiClient gw;
uint16_t mbTid = 0;              // número da transação Modbus TCP (confere a resposta certa)
unsigned long gwRetryAt = 0, gwDownSince = 0;
bool gwAlerted = false;

// Conecta (ou reconecta) ao gateway; sem Wi-Fi ou logo após uma falha, não insiste.
bool gwConnect() {
  if (gw.connected()) return true;
  if (WiFi.status() != WL_CONNECTED || millis() < gwRetryAt) return false;
  gw.stop();
  if (gw.connect(GATEWAY_IP, GATEWAY_PORT, 1500)) {
    gw.setNoDelay(true);
    Serial.printf("[gateway] conectado a %s:%d (%s)\n", GATEWAY_IP, GATEWAY_PORT, GATEWAY_MBAP ? "Modbus TCP" : "RTU sobre TCP");
    return true;
  }
  gwRetryAt = millis() + 3000;
  Serial.printf("[gateway] sem conexão com %s:%d\n", GATEWAY_IP, GATEWAY_PORT);
  return false;
}

// Lê exatamente n bytes do gateway até o prazo; false se acabar o tempo ou cair a conexão.
bool gwReadExact(uint8_t* buf, size_t n, unsigned long deadline) {
  size_t got = 0;
  while (got < n) {
    if (!gw.connected()) return false;
    int a = gw.available();
    if (a > 0) got += gw.read(buf + got, n - got);
    else if ((long)(millis() - deadline) >= 0) return false;
    else delay(1);
  }
  return true;
}
#endif

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
#if BUS_VIA_GATEWAY
  if (!gwConnect()) return;
  while (gw.available()) gw.read();                    // descarta resposta atrasada de um pedido anterior
  if (GATEWAY_MBAP) {
    // Modbus TCP: cabeçalho MBAP (transação, protocolo 0, tamanho) + unidade + PDU, sem CRC
    uint8_t out[7 + 256];
    mbTid++;
    out[0] = mbTid >> 8; out[1] = mbTid & 0xFF; out[2] = 0; out[3] = 0;
    out[4] = lenNoCrc >> 8; out[5] = lenNoCrc & 0xFF;
    memcpy(out + 6, frame, lenNoCrc);
    gw.write(out, 6 + lenNoCrc);
  } else {
    gw.write(frame, lenNoCrc + 2);                     // modo transparente: o quadro RTU inteiro
  }
  return;
#endif
  while (RS485.available()) RS485.read();
  if (RS485_DE_PIN >= 0) digitalWrite(RS485_DE_PIN, HIGH);
  RS485.write(frame, lenNoCrc + 2);
  RS485.flush();
  if (RS485_DE_PIN >= 0) digitalWrite(RS485_DE_PIN, LOW);
  delay(2);   // silêncio mínimo entre quadros (3,5 caracteres ≈ 4 ms a 9600, somado ao tempo de resposta)
}

// Lê `expect` bytes (ou a exceção, 5 bytes). >0 = ok · -1 sem resposta · -2 exceção · -3 CRC
int mbReceive(uint8_t* resp, size_t expect, uint8_t slave, uint8_t func) {
#if BUS_VIA_GATEWAY
  if (!gw.connected()) return -1;
  unsigned long deadline = millis() + MB_TIMEOUT_TCP_MS;
  (void)deadline;
  if (GATEWAY_MBAP) {
    uint8_t h[6], pdu[260];
    if (!gwReadExact(h, 6, deadline)) { gw.stop(); return -1; }
    size_t len = ((size_t)h[4] << 8) | h[5];          // unidade + PDU
    if (len < 3 || len > sizeof(pdu)) { gw.stop(); return -1; }
    if (!gwReadExact(pdu, len, deadline)) { gw.stop(); return -1; }
    if ((((uint16_t)h[0] << 8) | h[1]) != mbTid) return -1;            // resposta de outro pedido
    if (slave != PZEM_GENERAL && pdu[0] != slave) return -1;
    if (pdu[1] == (func | 0x80)) {
      // 0x0A/0x0B: o próprio gateway avisa que o escravo não respondeu — é "sem resposta", não exceção
      return (pdu[2] == 0x0A || pdu[2] == 0x0B) ? -1 : -2;
    }
    if (len != expect - 2) return -1;
    memcpy(resp, pdu, len);                           // devolve no formato RTU (com CRC) para o resto do código
    uint16_t crc = mbCrc(resp, len);
    resp[len] = crc & 0xFF; resp[len + 1] = crc >> 8;
    return (int)expect;
  }
#endif
  size_t n = 0;
  unsigned long t0 = millis();
#if BUS_VIA_GATEWAY
  Stream& bus = gw;                                    // RTU dentro do TCP (modo transparente)
  const unsigned long tmo = MB_TIMEOUT_TCP_MS;
#else
  Stream& bus = RS485;
  const unsigned long tmo = MB_TIMEOUT_MS;
#endif
  while (millis() - t0 < tmo && n < expect) {
    if (bus.available()) {
      resp[n++] = bus.read();
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
// Se a placa recusar, cai para um 0x05 por canal.
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
  if (BUS_VIA_GATEWAY) return;                         // pela rede: a UART da placa não é usada
  int rx = rs485Swapped ? RS485_PIN_B : RS485_PIN_A;
  int tx = rs485Swapped ? RS485_PIN_A : RS485_PIN_B;
  RS485.end();
  RS485.begin(RS485_BAUD, SERIAL_8N1, rx, tx);
  Serial.printf("[rs485] UART RX=GPIO%d TX=GPIO%d\n", rx, tx);
}
bool mbPing(uint8_t slave, uint8_t func = 0x03) {
  uint8_t req[8] = { slave, func, 0x00, 0x00, 0x00, 0x01 };
  uint8_t resp[8];
  mbSend(req, 6);
  int r = mbReceive(resp, 7, slave, func);
  return r > 0 || r == -2;
}
bool anySlaveAnswers() {
  for (int b = 0; b < BOARD_COUNT; b++) if (mbPing(BOARDS[b].slave)) return true;
  for (int i = 0; i < CIRCUIT_COUNT && i < 4; i++) if (mbPing(CIRCUITS[i].meter, 0x04)) return true;
  return false;
}
void rs485AutoDetect() {
  if (BUS_VIA_GATEWAY || !RS485_AUTO_SWAP || anySlaveAnswers()) return;
  rs485Swapped = !rs485Swapped;
  rs485Begin();
  if (!anySlaveAnswers()) { rs485Swapped = !rs485Swapped; rs485Begin(); }
}

// ============================================================
// Estado dos circuitos
// ============================================================
struct CircuitState {
  float volts, amps, watts, kwh, pf, hz;
  bool  meterOk;
  uint8_t fails;
  bool  wantOn;          // o que o usuário quer (app/serial) — persiste na flash
  bool  shed;            // cortado pela gestão de demanda
  bool  trip;            // cortado por sobrecarga (travado) — persiste na flash
  unsigned long tripAt;
  unsigned long overSince;   // início da sobrecarga contínua (0 = normal)
  bool  overWarned;          // circuito sem relé: já avisou desta sobrecarga
  float wattsBeforeCut;      // consumo antes do corte (para saber se cabe religar)
  unsigned long shedAt;
  // histórico
  float loggedW;
  unsigned long loggedAt;
};
CircuitState cs[MAX_CIRCUITS];
portMUX_TYPE stateMux = portMUX_INITIALIZER_UNLOCKED;   // telemetria lê cs[] no outro núcleo

bool boardOk[8];
bool boardDirty[8];
unsigned long lastRelayRefresh = 0;
int nextMeter = 0;
unsigned long lastCycleAt = 0, cycleMs = 0;
float totalW = 0, totalKwh = 0;
int metersOk = 0;
unsigned long overLimitSince = 0, underLimitSince = 0, lastDemandAction = 0;
Preferences prefs;

// alertas pendentes para o próximo POST (o loop escreve, a telemetria envia)
#define ALERT_SLOTS 8
struct PendingAlert { char severity[10]; char message[160]; };
PendingAlert alertQ[ALERT_SLOTS];
int alertCount = 0;
void raiseAlert(const char* severity, const char* fmt, ...) {
  char msg[160];
  va_list ap; va_start(ap, fmt); vsnprintf(msg, sizeof(msg), fmt, ap); va_end(ap);
  Serial.printf("[alerta %s] %s\n", severity, msg);
  portENTER_CRITICAL(&stateMux);
  if (alertCount < ALERT_SLOTS) {
    strncpy(alertQ[alertCount].severity, severity, sizeof(alertQ[0].severity) - 1);
    alertQ[alertCount].severity[sizeof(alertQ[0].severity) - 1] = 0;
    strncpy(alertQ[alertCount].message, msg, sizeof(alertQ[0].message) - 1);
    alertQ[alertCount].message[sizeof(alertQ[0].message) - 1] = 0;
    alertCount++;
  }
  portEXIT_CRITICAL(&stateMux);
}

bool hasRelay(int i) { return CIRCUITS[i].board >= 0 && CIRCUITS[i].board < BOARD_COUNT && CIRCUITS[i].ch >= 1; }
bool relayCuts(int i) { return hasRelay(i) && (!cs[i].wantOn || cs[i].shed || cs[i].trip); }

// ---- persistência (liga/desliga e desarme sobrevivem a um reinício) ----
void saveState() {
  uint64_t off = 0, trip = 0;
  for (int i = 0; i < CIRCUIT_COUNT; i++) {
    if (!cs[i].wantOn) off |= (1ULL << i);
    if (cs[i].trip) trip |= (1ULL << i);
  }
  prefs.putULong64("off", off);
  prefs.putULong64("trip", trip);
}
void loadState() {
  uint64_t off = prefs.getULong64("off", 0), trip = prefs.getULong64("trip", 0);
  for (int i = 0; i < CIRCUIT_COUNT; i++) {
    cs[i].wantOn = !(off & (1ULL << i));
    cs[i].trip = trip & (1ULL << i);
    cs[i].tripAt = 0;
  }
}

// ============================================================
// Relés
// ============================================================
void markBoard(int i) { if (hasRelay(i)) boardDirty[CIRCUITS[i].board] = true; }

void applyRelays(bool force) {
  for (int b = 0; b < BOARD_COUNT; b++) {
    if (!force && !boardDirty[b]) continue;
    uint32_t bits = 0;
    for (int i = 0; i < CIRCUIT_COUNT; i++) {
      if (!hasRelay(i) || CIRCUITS[i].board != b) continue;
      bool energize = RELAY_ENERGIZED_CUTS ? relayCuts(i) : !relayCuts(i);
      if (energize) bits |= (1UL << (CIRCUITS[i].ch - 1));
    }
    bool ok = mbWriteCoils(BOARDS[b].slave, RELAY_COIL_BASE, BOARDS[b].channels, bits);
    if (ok != boardOk[b]) Serial.printf("[relés] %s (slave %u): %s\n", BOARDS[b].name, BOARDS[b].slave, ok ? "ok" : "SEM RESPOSTA");
    boardOk[b] = ok;
    boardDirty[b] = !ok;   // falhou: tenta de novo na próxima volta
  }
}

void setWanted(int i, bool on, const char* why) {
  if (i < 0 || i >= CIRCUIT_COUNT) return;
  if (cs[i].wantOn == on) return;
  if (!on) cs[i].wattsBeforeCut = cs[i].watts;
  cs[i].wantOn = on;
  markBoard(i);
  saveState();
  Serial.printf("[circuito %d] %s → %s (%s)%s\n", i + 1, CIRCUITS[i].name, on ? "LIGADO" : "DESLIGADO", why,
                hasRelay(i) ? "" : " — sem relé: só registra");
}

void rearm(int i, const char* why) {
  if (i < 0 || i >= CIRCUIT_COUNT || !cs[i].trip) return;
  cs[i].trip = false;
  cs[i].overSince = 0;
  markBoard(i);
  saveState();
  Serial.printf("[circuito %d] %s rearmado (%s)\n", i + 1, CIRCUITS[i].name, why);
}

// Pedidos do app e da serial chegam por esta fila e são executados no loop
// (o barramento Modbus só é usado por uma tarefa).
QueueHandle_t requestQueue;
void submitRequest(const UiRequest& r) { if (requestQueue) xQueueSend(requestQueue, &r, 0); }

void processRequests() {
  UiRequest r;
  while (requestQueue && xQueueReceive(requestQueue, &r, 0) == pdTRUE) {
    int i = r.idx;
    if (i < 0 || i >= CIRCUIT_COUNT) continue;
    const char* origem = r.remote ? "app" : "tela/serial";
    if (r.type == UI_REQ_REARM) { rearm(i, origem); continue; }
    if (r.on && cs[i].trip) {
      // desarmado por sobrecarga: o app só religa depois do tempo de espera (tela e serial religam já)
      if (r.remote && cs[i].tripAt && millis() - cs[i].tripAt < TRIP_REARM_MS) {
        Serial.printf("[circuito %d] religar pelo app recusado: desarmou há %lus (espera %lus)\n", i + 1,
                      (millis() - cs[i].tripAt) / 1000, TRIP_REARM_MS / 1000);
        continue;
      }
      rearm(i, origem);
    }
    setWanted(i, r.on, r.remote ? "comando do app" : "tela/serial");
  }
}

// ============================================================
// Medidores
// ============================================================
static inline uint32_t lo_hi(uint16_t lo, uint16_t hi) { return ((uint32_t)hi << 16) | lo; }

bool readPzem(uint8_t slave, float& v, float& a, float& w, float& kwh, float& pf, float& hz) {
  uint16_t r[PZEM_REGS];
  if (!mbReadRegs(slave, 0x04, 0x0000, PZEM_REGS, r, 1)) return false;
  v   = r[0] / 10.0f;
  a   = lo_hi(r[1], r[2]) / 1000.0f;
  w   = lo_hi(r[3], r[4]) / 10.0f;
  kwh = lo_hi(r[5], r[6]) / 1000.0f;
  hz  = r[7] / 10.0f;
  pf  = r[8] / 100.0f;
  return true;
}

void pollOneMeter() {
  int i = nextMeter;
  nextMeter = (nextMeter + 1) % CIRCUIT_COUNT;
  if (!CIRCUITS[i].meter) return;
  float v, a, w, kwh, pf, hz;
  bool ok = readPzem(CIRCUITS[i].meter, v, a, w, kwh, pf, hz);
  portENTER_CRITICAL(&stateMux);
  if (ok) {
    cs[i].volts = v; cs[i].amps = a; cs[i].watts = w; cs[i].kwh = kwh; cs[i].pf = pf; cs[i].hz = hz;
    cs[i].fails = 0;
    cs[i].meterOk = true;
  } else if (++cs[i].fails >= METER_FAILS_OFF) {
    cs[i].meterOk = false;
    cs[i].watts = cs[i].amps = 0;
  }
  portEXIT_CRITICAL(&stateMux);
  if (ok) checkOverload(i);
  if (nextMeter == 0) endOfCycle();
}

// ============================================================
// Proteção
// ============================================================
// Sobrecarga sustentada: corta ANTES do disjuntor desarmar (o disjuntor e o DR continuam
// sendo a proteção de verdade — isto só evita ficar sem o circuito todo).
void checkOverload(int i) {
  float limit = OVERLOAD_RATIO * CIRCUITS[i].breakerA;
  if (cs[i].trip || limit <= 0 || cs[i].amps < limit) { cs[i].overSince = 0; cs[i].overWarned = false; return; }
  if (!cs[i].overSince) { cs[i].overSince = millis(); return; }
  if (millis() - cs[i].overSince < OVERLOAD_MS || cs[i].overWarned) return;
  cs[i].overSince = 0;
  if (!hasRelay(i)) {
    cs[i].overWarned = true;   // um aviso por episódio (volta a avisar depois que a corrente cair)
    raiseAlert("warning", "%s: %.1f A por mais de %lus (disjuntor de %.0f A) — circuito sem relé, verifique",
               CIRCUITS[i].name, cs[i].amps, OVERLOAD_MS / 1000, CIRCUITS[i].breakerA);
    return;
  }
  cs[i].trip = true;
  cs[i].tripAt = millis();
  cs[i].wattsBeforeCut = cs[i].watts;
  markBoard(i);
  saveState();
  raiseAlert("critical", "%s desligado por sobrecarga: %.1f A por %lus (disjuntor de %.0f A)",
             CIRCUITS[i].name, cs[i].amps, OVERLOAD_MS / 1000, CIRCUITS[i].breakerA);
}

// Gestão de demanda (fim de cada volta pelos medidores)
void endOfCycle() {
  unsigned long now = millis();
  cycleMs = lastCycleAt ? now - lastCycleAt : 0;
  lastCycleAt = now;
  float sumW = 0, sumKwh = 0;
  int ok = 0;
  for (int i = 0; i < CIRCUIT_COUNT; i++) {
    if (!cs[i].meterOk) continue;
    ok++;
    sumW += cs[i].watts;
    sumKwh += cs[i].kwh;
  }
  portENTER_CRITICAL(&stateMux);
  totalW = sumW; totalKwh = sumKwh; metersOk = ok;
  portEXIT_CRITICAL(&stateMux);

  if (DEMAND_LIMIT_W <= 0) return;
  if (sumW > DEMAND_LIMIT_W) {
    underLimitSince = 0;
    if (!overLimitSince) overLimitSince = now;
    if (now - overLimitSince < DEMAND_SHED_MS || now - lastDemandAction < DEMAND_SHED_MS) return;
    // corta o ligado de menor prioridade (1 antes de 2, 2 antes de 3) que está consumindo mais
    int pick = -1;
    for (int i = 0; i < CIRCUIT_COUNT; i++) {
      if (!CIRCUITS[i].shed || !hasRelay(i) || cs[i].shed || cs[i].trip || !cs[i].wantOn) continue;
      if (pick < 0 || CIRCUITS[i].shed < CIRCUITS[pick].shed ||
          (CIRCUITS[i].shed == CIRCUITS[pick].shed && cs[i].watts > cs[pick].watts)) pick = i;
    }
    if (pick < 0) return;
    cs[pick].shed = true;
    cs[pick].shedAt = now;
    cs[pick].wattsBeforeCut = cs[pick].watts;
    markBoard(pick);
    lastDemandAction = now;
    raiseAlert("warning", "Demanda de %.0f W acima do limite de %.0f W: %s desligado temporariamente",
               sumW, DEMAND_LIMIT_W, CIRCUITS[pick].name);
  } else {
    overLimitSince = 0;
    // religa o último cortado se ele couber com folga, após a folga ficar estável
    int pick = -1;
    for (int i = 0; i < CIRCUIT_COUNT; i++) if (cs[i].shed && (pick < 0 || cs[i].shedAt > cs[pick].shedAt)) pick = i;
    if (pick < 0) { underLimitSince = 0; return; }
    if (sumW + cs[pick].wattsBeforeCut > DEMAND_LIMIT_W - DEMAND_MARGIN_W) { underLimitSince = 0; return; }
    if (!underLimitSince) underLimitSince = now;
    if (now - underLimitSince < DEMAND_RESTORE_MS) return;
    cs[pick].shed = false;
    markBoard(pick);
    underLimitSince = 0;
    lastDemandAction = now;
    Serial.printf("[demanda] %s religado (%.0f W agora)\n", CIRCUITS[pick].name, sumW);
  }
}

// ============================================================
// Telemetria (tarefa no núcleo 0 — HTTP lento não atrasa a proteção)
// ============================================================
int httpPost(const String& body) {
  if (WiFi.status() != WL_CONNECTED) return -1;
  HTTPClient http;
  http.begin(GATEWAY_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-key", DEVICE_SECRET);
  http.setTimeout(8000);
  int code = http.POST(body);
  if (code != 200) Serial.printf("[iot] lote → HTTP %d %s\n", code, code > 0 ? http.getString().substring(0, 300).c_str() : "");
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

void publishBatch() {
  CircuitState snap[MAX_CIRCUITS];
  float tW, tKwh; int okN;
  PendingAlert alerts[ALERT_SLOTS]; int nAlerts;
  portENTER_CRITICAL(&stateMux);
  memcpy(snap, cs, sizeof(CircuitState) * CIRCUIT_COUNT);
  tW = totalW; tKwh = totalKwh; okN = metersOk;
  nAlerts = alertCount;
  memcpy(alerts, alertQ, sizeof(PendingAlert) * nAlerts);
  portEXIT_CRITICAL(&stateMux);

  unsigned long now = millis();
  bool logged[MAX_CIRCUITS] = { false };
  String body;
  body.reserve(9000);
  body = "{\"readings\":[";
  bool first = true;
  for (int i = 0; i < CIRCUIT_COUNT; i++) {
    const Circuit& c = CIRCUITS[i];
    const CircuitState& s = snap[i];
    if (!c.uuid || !c.uuid[0]) continue;
    if (!first) body += ',';
    first = false;
    body += "{\"device_id\":\""; body += c.uuid; body += '"';
    // histórico: a cada LOG_INTERVAL_MS, ou antes numa mudança grande
    float dW = fabsf(s.watts - s.loggedW);
    bool bigChange = dW >= LOG_CHANGE_W && dW >= LOG_CHANGE_FRAC * fmaxf(s.loggedW, 1.0f);
    if (s.meterOk && (!s.loggedAt || now - s.loggedAt >= LOG_INTERVAL_MS || (bigChange && now - s.loggedAt >= LOG_MIN_GAP_MS))) {
      body += ",\"metric_type\":\"energy_watts\",\"value\":"; body += String(s.watts, 1);
      logged[i] = true;
    }
    body += ",\"status\":{\"in_total\":true";
    appendBool(body, "meter_ok", s.meterOk);
    if (s.meterOk) {
      appendNum(body, "watts", s.watts, 1);
      appendNum(body, "volts", s.volts, 1);
      appendNum(body, "amps", s.amps, 3);
      appendNum(body, "kwh", s.kwh, 3);
      appendNum(body, "pf", s.pf, 2);
      appendNum(body, "hz", s.hz, 1);
      appendNum(body, "load_pct", c.breakerA > 0 ? s.amps / c.breakerA * 100.0f : 0, 0);
    }
    if (hasRelay(i)) {
      appendBool(body, "on", s.wantOn);
      appendBool(body, "shed", s.shed);
      appendBool(body, "trip", s.trip);
    }
    body += "}}";
  }
  static unsigned long totalLoggedAt = 0;
  bool logTotal = DEVICE_TOTAL[0] && okN > 0 && (!totalLoggedAt || now - totalLoggedAt >= TOTAL_LOG_MS);
  if (DEVICE_TOTAL[0]) {
    if (!first) body += ',';
    body += "{\"device_id\":\""; body += DEVICE_TOTAL; body += '"';
    if (logTotal) { body += ",\"metric_type\":\"energy_watts\",\"value\":"; body += String(tW, 1); }
    body += ",\"status\":{\"in_total\":false";
    appendNum(body, "watts", tW, 1);
    appendNum(body, "kwh", tKwh, 3);
    appendNum(body, "limit_w", DEMAND_LIMIT_W, 0);
    body += ",\"meters_ok\":"; body += okN;
    body += ",\"meters\":"; body += CIRCUIT_COUNT;
    int shedN = 0, tripN = 0;
    for (int i = 0; i < CIRCUIT_COUNT; i++) { shedN += snap[i].shed; tripN += snap[i].trip; }
    body += ",\"shed\":"; body += shedN;
    body += ",\"trips\":"; body += tripN;
    appendNum(body, "cycle_s", cycleMs / 1000.0f, 1);
    body += "}}";
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
  if (code == 200 || code == 207) {
    portENTER_CRITICAL(&stateMux);
    for (int i = 0; i < CIRCUIT_COUNT; i++) if (logged[i]) { cs[i].loggedW = snap[i].watts; cs[i].loggedAt = now; }
    // remove só os alertas enviados (o loop pode ter acrescentado outros nesse meio-tempo)
    int rest = alertCount - nAlerts;
    if (rest > 0) memmove(alertQ, alertQ + nAlerts, sizeof(PendingAlert) * rest);
    alertCount = rest > 0 ? rest : 0;
    portEXIT_CRITICAL(&stateMux);
    if (logTotal) totalLoggedAt = now;
  }
}

int circuitForDevice(const char* id) {
  for (int i = 0; i < CIRCUIT_COUNT; i++) if (CIRCUITS[i].uuid[0] && !strncmp(id, CIRCUITS[i].uuid, 36)) return i;
  return -1;
}

// GET /iot-gateway/commands?devices=… → {"commands":[{"id":"…","device_id":"…","command":{"on":false}}]}
void pollCommands() {
  if (WiFi.status() != WL_CONNECTED) return;
  String url = String(GATEWAY_URL) + "/commands?devices=";
  bool first = true;
  for (int i = 0; i < CIRCUIT_COUNT; i++) {
    if (!hasRelay(i) || !CIRCUITS[i].uuid[0]) continue;
    if (!first) url += ',';
    url += CIRCUITS[i].uuid;
    first = false;
  }
  if (first) return;   // nenhum circuito comandável
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
    int o = body.indexOf("\"on\":", pos);
    int next = body.indexOf("\"device_id\":\"", pos);
    if (o < 0 || (next >= 0 && o > next)) continue;
    int i = circuitForDevice(id.c_str());
    if (i < 0) continue;
    bool on = body.startsWith("true", o + 5);
    Serial.printf("[cmd] app pediu %s → %s\n", CIRCUITS[i].name, on ? "ligar" : "desligar");
    submitRequest(UiRequest{ UI_REQ_SET, (int16_t)i, on, true });
  }
}

void telemetryTask(void*) {
  unsigned long lastPublish = 0;
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(COMMAND_POLL_MS));
    if (WiFi.status() != WL_CONNECTED) continue;
    pollCommands();
    if (millis() - lastPublish < PUBLISH_INTERVAL_MS) continue;
    lastPublish = millis();
    vTaskDelay(pdMS_TO_TICKS(400));   // o loop aplica os comandos recém-chegados antes do retrato
    publishBatch();
  }
}

// ============================================================
// Bancada (serial 115200)
// ============================================================
void printStatus() {
  char bus[64];
#if BUS_VIA_GATEWAY
  snprintf(bus, sizeof(bus), "gateway %s:%d %s", GATEWAY_IP, GATEWAY_PORT, gw.connected() ? "conectado" : "SEM CONEXÃO");
#else
  snprintf(bus, sizeof(bus), "RS485 %s", rs485Swapped ? "invertido" : "normal");
#endif
  Serial.printf("%s · volta pelos medidores %.1f s · %d/%d medidores ok · total %.0f W · %.1f kWh · Wi-Fi %s\n",
                bus, cycleMs / 1000.0f, metersOk, CIRCUIT_COUNT, totalW, totalKwh,
                WiFi.status() == WL_CONNECTED ? "ok" : "fora");
  for (int b = 0; b < BOARD_COUNT; b++) Serial.printf("  relés %s (slave %u, %u canais): %s\n", BOARDS[b].name, BOARDS[b].slave, BOARDS[b].channels, boardOk[b] ? "ok" : "SEM RESPOSTA");
  for (int i = 0; i < CIRCUIT_COUNT; i++) {
    const CircuitState& s = cs[i];
    Serial.printf("  %2d %-44s pzem %2u %s %6.0f W %5.2f A %5.1f V %8.2f kWh %s%s%s\n", i + 1, CIRCUITS[i].name,
                  CIRCUITS[i].meter, s.meterOk ? "  " : "!!", s.watts, s.amps, s.volts, s.kwh,
                  hasRelay(i) ? (relayCuts(i) ? "CORTADO" : "ligado") : "sem relé",
                  s.shed ? " (demanda)" : "", s.trip ? " (SOBRECARGA)" : "");
  }
}

void scanBus() {
  Serial.println("[scan] endereços 1..60 (03 = relés/holding, 04 = PZEM):");
  for (uint8_t a = 1; a <= 60; a++) {
    bool h = mbPing(a, 0x03), in = mbPing(a, 0x04);
    if (h || in) Serial.printf("  slave %u responde%s%s\n", a, h ? " [03]" : "", in ? " [04]" : "");
  }
}

void mbDump(uint8_t slave) {
  for (uint8_t func = 3; func <= 4; func++) {
    uint16_t r[10];
    if (!mbReadRegs(slave, func, 0, 10, r)) { Serial.printf("slave %u · função %02X: sem resposta\n", slave, func); continue; }
    Serial.printf("slave %u · função %02X:", slave, func);
    for (int i = 0; i < 10; i++) Serial.printf(" %u", r[i]);
    Serial.println();
  }
}

// Grava o endereço de um PZEM-016 — LIGUE SÓ ELE no barramento (usa o endereço geral 0xF8)
void pzemSetAddress(uint8_t addr) {
  if (addr < 1 || addr > 247) { Serial.println("endereço deve ser 1..247"); return; }
  bool ok = mbWriteReg(PZEM_GENERAL, PZEM_ADDR_REG, addr);
  Serial.printf("[pzem] endereço %u: %s\n", addr, ok ? "gravado — confira com 'dump N'" : "sem resposta (só um PZEM ligado?)");
}

// Grava o endereço de uma placa de relés que ainda está com o de fábrica (1) — LIGUE SÓ ELA
void relaySetAddress(uint8_t addr) {
  if (addr < 2 || addr > 247) { Serial.println("endereço deve ser 2..247"); return; }
  bool ok = mbWriteReg(1, RELAY_ADDR_REG, addr);
  Serial.printf("[relés] slave 1 → %u: %s\n", addr, ok ? "gravado — confira com 'scan'" : "sem resposta (placa com endereço 1 ligada?)");
}

void handleSerial() {
  static String line;
  while (Serial.available()) {
    char c = Serial.read();
    if (c != '\n' && c != '\r') { line += c; continue; }
    line.trim(); line.toLowerCase();
    if (line.startsWith("ligar ")) submitRequest(UiRequest{ UI_REQ_SET, (int16_t)(line.substring(6).toInt() - 1), true, false });
    else if (line.startsWith("desligar ")) submitRequest(UiRequest{ UI_REQ_SET, (int16_t)(line.substring(9).toInt() - 1), false, false });
    else if (line.startsWith("rearmar ")) submitRequest(UiRequest{ UI_REQ_REARM, (int16_t)(line.substring(8).toInt() - 1), false, false });
    else if (line.startsWith("dump ")) mbDump((uint8_t)line.substring(5).toInt());
    else if (line.startsWith("pzemaddr ")) pzemSetAddress((uint8_t)line.substring(9).toInt());
    else if (line.startsWith("reladdr ")) relaySetAddress((uint8_t)line.substring(8).toInt());
    else if (line == "scan") scanBus();
    else if (line == "status") printStatus();
    else if (line.length()) Serial.println("comandos: status | scan | ligar N | desligar N | rearmar N | dump S | pzemaddr S | reladdr S");
    line = "";
  }
}

// ============================================================
// Tela
// ============================================================
#if USE_DISPLAY
UiCircuit uiCircuits[UI_MAX_CIRCUITS];
UiState uiState;   // global: ~1,4 KB, fora da pilha do loop

void refreshScreen() {
  static unsigned long last = 0;
  if (millis() - last < 400) return;
  last = millis();
  int n = CIRCUIT_COUNT < UI_MAX_CIRCUITS ? CIRCUIT_COUNT : UI_MAX_CIRCUITS;
  portENTER_CRITICAL(&stateMux);
  for (int i = 0; i < n; i++) {
    uiState.watts[i] = cs[i].watts; uiState.amps[i] = cs[i].amps; uiState.volts[i] = cs[i].volts;
    uiState.kwh[i] = cs[i].kwh; uiState.pf[i] = cs[i].pf; uiState.meterOk[i] = cs[i].meterOk;
    uiState.on[i] = cs[i].wantOn; uiState.shed[i] = cs[i].shed; uiState.trip[i] = cs[i].trip;
  }
  uiState.totalW = totalW; uiState.totalKwh = totalKwh; uiState.metersOk = metersOk;
  portEXIT_CRITICAL(&stateMux);
  uiState.limitW = DEMAND_LIMIT_W;
  uiState.wifiOk = WiFi.status() == WL_CONNECTED;
  bool relays = true;
  for (int b = 0; b < BOARD_COUNT; b++) relays &= boardOk[b];
  uiState.relaysOk = relays;
#if BUS_VIA_GATEWAY
  uiState.viaGateway = true;
  uiState.gatewayOk = gw.connected();
#endif
  ui_update(uiState);
}
#endif

// ============================================================
// Setup / Loop
// ============================================================
void setup() {
  Serial.begin(115200);
  if (CIRCUIT_COUNT > MAX_CIRCUITS) { Serial.println("[boot] circuitos demais (máx. 64)"); while (true) delay(1000); }
  for (int i = 0; i < CIRCUIT_COUNT; i++)   // canal fora da placa: vira circuito só de medição
    if (hasRelay(i) && CIRCUITS[i].ch > BOARDS[CIRCUITS[i].board].channels) {
      Serial.printf("[boot] circuito %d: canal %u não existe na placa %s — sem relé\n", i + 1, CIRCUITS[i].ch, BOARDS[CIRCUITS[i].board].name);
      CIRCUITS[i].board = -1;
    }
  requestQueue = xQueueCreate(32, sizeof(UiRequest));
#if USE_DISPLAY
  for (int i = 0; i < CIRCUIT_COUNT && i < UI_MAX_CIRCUITS; i++)
    uiCircuits[i] = UiCircuit{ CIRCUITS[i].name, CIRCUITS[i].group, hasRelay(i), CIRCUITS[i].breakerA };
  if (!ui_begin(uiCircuits, CIRCUIT_COUNT, GROUP_NAMES, GROUP_COUNT, submitRequest))
    Serial.println("[tela] falha ao iniciar o display — o controle continua sem tela");
#endif
  prefs.begin("eletrica", false);
  memset(cs, 0, sizeof(cs));
  loadState();
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);   // não bloqueia: com RS-485 direto, a proteção roda sem Wi-Fi
#if BUS_VIA_GATEWAY
  for (int i = 0; i < 50 && WiFi.status() != WL_CONNECTED; i++) delay(200);   // pelo gateway: espera a rede até 10 s
#endif
  if (RS485_DE_PIN >= 0) { pinMode(RS485_DE_PIN, OUTPUT); digitalWrite(RS485_DE_PIN, LOW); }
  rs485Begin();
  delay(800);                 // escravos terminam o boot
  rs485AutoDetect();
  applyRelays(true);
  lastRelayRefresh = millis();
  xTaskCreatePinnedToCore(telemetryTask, "telemetria", 12288, nullptr, 1, nullptr, 0);
  Serial.printf("[boot] automação elétrica: %d circuitos, %d placas de relé — digite 'status'\n", CIRCUIT_COUNT, BOARD_COUNT);
}

void loop() {
  handleSerial();
  processRequests();           // comandos antes da leitura: resposta rápida
  applyRelays(false);
  if (millis() - lastRelayRefresh >= RELAY_REFRESH_MS) { lastRelayRefresh = millis(); applyRelays(true); }
  pollOneMeter();              // um medidor por volta do loop (~60–100 ms cada)
#if USE_DISPLAY
  refreshScreen();
#endif

#if BUS_VIA_GATEWAY
  // gateway fora do ar: os medidores param de ser lidos e a proteção por software também — avisa
  if (gw.connected()) { gwDownSince = 0; gwAlerted = false; }
  else if (!gwDownSince) gwDownSince = millis();
  else if (!gwAlerted && millis() - gwDownSince >= GATEWAY_ALERT_MS) {
    gwAlerted = true;
    raiseAlert("warning", "Gateway RS-485 (%s) sem conexão há 1 min: o quadro elétrico está sem leitura nem proteção por software", GATEWAY_IP);
  }
#endif
  static int silent = 0;       // barramento mudo por uma volta inteira: tenta a outra ordem RX/TX
  if (nextMeter == 0) {
    silent = metersOk == 0 ? silent + 1 : 0;
    if (silent >= 2) { silent = 0; rs485AutoDetect(); }
  }
}
