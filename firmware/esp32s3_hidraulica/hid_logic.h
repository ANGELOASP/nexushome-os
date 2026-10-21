// ============================================================
// NexusHome OS — Lógica de decisão da tela T1 Água (barramento C), SEM Arduino
// ------------------------------------------------------------
// Funções puras (só <stdint.h>): o .ino lê o barramento, chama estas funções e executa o
// que elas decidem. Assim dá para testar a lógica no PC com g++ (tests/hidraulica-firmware.test.mjs):
//   · estado travado (válvulas + alarmes) num único valor de 16 bits para a NVS
//   · bits das bobinas da placa de relés e a vigilância da confirmação (leitura de volta)
//   · vazão em janela deslizante de 60 s (pulsos acumulados)
//   · "fluxo contínuo por 60 min" na área externa = nenhum minuto sem pulso
//   · rompimento: janela de 180 s com carimbo de tempo por amostra
// Tempos em ms com uint32_t (millis()); as comparações aguentam a virada do contador (~49 dias).
// ============================================================
#pragma once
#include <stdint.h>

static inline bool hidElapsed(uint32_t now, uint32_t since, uint32_t ms) { return (uint32_t)(now - since) >= ms; }

// ---------------- Persistência (NVS) ----------------
// Um único valor de 16 bits (uma gravação = estado sempre coerente, mesmo se faltar energia no meio):
//   bits 0–7 = válvula n ABERTA · bit 8 = rompimento · bit 9 = vazamento externo · bit 10 = pânico.
// NVS vazia (primeiro boot) = HID_STATE_DEFAULT: tudo aberto, sem alarme.
#define HID_STATE_DEFAULT  0x00FFu
#define HID_ST_BURST       (1u << 8)
#define HID_ST_EXTERNAL    (1u << 9)
#define HID_ST_PANIC       (1u << 10)
#define HID_ST_MASK        0x07FFu

static inline uint16_t hidPackState(const bool open[8], bool burst, bool external, bool panic) {
  uint16_t v = 0;
  for (int i = 0; i < 8; i++) if (open[i]) v |= (uint16_t)(1u << i);
  if (burst) v |= HID_ST_BURST;
  if (external) v |= HID_ST_EXTERNAL;
  if (panic) v |= HID_ST_PANIC;
  return v;
}

// Alarme travado manda mais que a válvula gravada: pânico = tudo fechado, rompimento = geral
// fechada, vazamento externo = válvula da área externa fechada.
static inline void hidEnforceLocks(bool open[8], bool burst, bool external, bool panic, int geral, int externa) {
  if (panic) for (int i = 0; i < 8; i++) open[i] = false;
  if (burst && geral >= 0 && geral < 8) open[geral] = false;
  if (external && externa >= 0 && externa < 8) open[externa] = false;
}

static inline void hidUnpackState(uint16_t v, bool open[8], bool &burst, bool &external, bool &panic,
                                  int geral, int externa) {
  v &= HID_ST_MASK;
  for (int i = 0; i < 8; i++) open[i] = (v >> i) & 1u;
  burst = v & HID_ST_BURST;
  external = v & HID_ST_EXTERNAL;
  panic = v & HID_ST_PANIC;
  hidEnforceLocks(open, burst, external, panic, geral, externa);
}

// ---------------- Relés das válvulas ----------------
// bit n = bobina do relé n+1. Fiação X7 (projeto-unificado §X7): vermelho/ABRE no NF, azul/FECHA no NA →
// relé ENERGIZADO = válvula FECHADA (energizedCloses = true); relé desligado = válvula ABERTA.
static inline uint8_t hidRelayBits(const bool open[8], bool energizedCloses) {
  uint8_t bits = 0;
  for (int i = 0; i < 8; i++) {
    bool energize = energizedCloses ? !open[i] : open[i];
    if (energize) bits |= (uint8_t)(1u << i);
  }
  return bits;
}

static inline bool hidAnyClosed(const bool open[8]) {
  for (int i = 0; i < 8; i++) if (!open[i]) return true;
  return false;
}

// Vigia a confirmação de cada escrita (escrita aceita E bobinas lidas de volta iguais ao pedido).
// maxFails falhas seguidas → avisa uma vez: crítico se alguma válvula deveria estar FECHADA (sem o
// relé ela reabre pela fiação), aviso se todas deveriam estar abertas. Se depois disso alguma
// válvula passar a ser pedida fechada, sobe para crítico. Ao confirmar de novo → "voltou".
struct RelayWatch { uint8_t streak; bool warned; bool critical; };
enum RelayEvent : uint8_t { RW_NONE = 0, RW_WARN, RW_CRITICAL, RW_RECOVERED };

static inline RelayEvent hidRelayStep(RelayWatch &w, bool confirmed, bool anyClosed, uint8_t maxFails) {
  if (confirmed) {
    w.streak = 0;
    if (w.warned || w.critical) { w.warned = w.critical = false; return RW_RECOVERED; }
    return RW_NONE;
  }
  if (w.streak < 255) w.streak++;
  if (w.streak < maxFails) return RW_NONE;
  if (anyClosed && !w.critical) { w.critical = true; w.warned = true; return RW_CRITICAL; }
  if (!w.warned) { w.warned = true; return RW_WARN; }
  return RW_NONE;
}

// ---------------- Vazão em janela deslizante ----------------
// A cada leitura boa das contadoras o .ino empilha o total ACUMULADO de pulsos de cada ramal
// (contagem própria, imune a contadora zerada). A vazão é (pulsos no fim − pulsos no começo da
// janela) ÷ tempo: um ramal de 12 pulsos/L a 100 L/h dá ~0,33 pulso/s — numa janela de 1 s ele
// alternava 0 e 300 L/h; em 60 s mede ~100 L/h. Sem leitura (falha Modbus) nada é empilhado: a
// diferença da próxima leitura cobre o buraco, e a vazão continua sendo a média correta.
#define HID_CH          7
#define HID_FLOW_SLOTS  72      // ≥ 60 s com uma leitura por segundo (folga para leituras mais rápidas)

struct FlowWindow {
  uint32_t at[HID_FLOW_SLOTS];
  uint32_t cum[HID_FLOW_SLOTS][HID_CH];
  uint8_t head;    // próxima posição a escrever
  uint8_t count;
};

static inline void hidFlowReset(FlowWindow &w) { w.head = 0; w.count = 0; }

static inline void hidFlowPush(FlowWindow &w, uint32_t now, const uint32_t cum[HID_CH]) {
  w.at[w.head] = now;
  for (int c = 0; c < HID_CH; c++) w.cum[w.head][c] = cum[c];
  w.head = (uint8_t)((w.head + 1) % HID_FLOW_SLOTS);
  if (w.count < HID_FLOW_SLOTS) w.count++;
}

// Vazão (L/h) do canal `ch`, medida da amostra mais antiga ainda dentro de `windowMs` até a última.
// Se só a última está na janela (leituras paradas por mais que a janela), usa a anterior a ela.
static inline float hidFlowLph(const FlowWindow &w, int ch, uint32_t windowMs, float pulsesPerLiter) {
  if (w.count < 2 || ch < 0 || ch >= HID_CH || pulsesPerLiter <= 0) return 0;
  int last = (w.head + HID_FLOW_SLOTS - 1) % HID_FLOW_SLOTS;
  int first = (w.head + HID_FLOW_SLOTS - w.count) % HID_FLOW_SLOTS;
  int ref = -1;
  for (int k = 0; k < w.count - 1; k++) {
    int i = (first + k) % HID_FLOW_SLOTS;
    if ((uint32_t)(w.at[last] - w.at[i]) <= windowMs) { ref = i; break; }
  }
  if (ref < 0) ref = (last + HID_FLOW_SLOTS - 1) % HID_FLOW_SLOTS;
  uint32_t spanMs = w.at[last] - w.at[ref];
  if (!spanMs) return 0;
  uint32_t pulses = w.cum[last][ch] - w.cum[ref][ch];
  return (pulses / pulsesPerLiter) * (3600000.0f / (float)spanMs);
}

// ---------------- Fluxo contínuo na área externa (item 3.2.2) ----------------
// "Fluxo contínuo" = nenhum intervalo de `quietMs` (1 min) sem pulso. Conta o tempo só entre leituras
// boas; uma leitura que falha (Modbus) PAUSA a contagem — não soma tempo e também empurra o relógio do
// "minuto sem pulso", para o buraco não virar "parou". Devolve há quanto tempo (ms) o fluxo é contínuo.
struct ExtFlow { bool started, active; uint32_t lastAt, lastPulseAt, accMs; };

static inline uint32_t hidExtStep(ExtFlow &s, bool readOk, uint32_t pulses, uint32_t now, uint32_t quietMs) {
  uint32_t dt = s.started ? (uint32_t)(now - s.lastAt) : 0;
  s.lastAt = now;
  s.started = true;
  if (!readOk) {
    if (s.active) s.lastPulseAt += dt;     // pausa: o buraco não conta como fluxo nem como silêncio
    return s.active ? s.accMs : 0;
  }
  if (pulses > 0) {
    if (!s.active) { s.active = true; s.accMs = 0; }
    else s.accMs += dt;
    s.lastPulseAt = now;
  } else if (s.active) {
    if (hidElapsed(now, s.lastPulseAt, quietMs)) { s.active = false; s.accMs = 0; }
    else s.accMs += dt;
  }
  return s.active ? s.accMs : 0;
}

// ---------------- Rompimento de adutora (item 3.2.1) ----------------
// Amostras do reservatório com o instante (millis) em que foram tiradas; só as dentro de `windowMs`
// valem. Assim, depois de minutos sem sonda, uma amostra velha não vira "pico" da janela.
struct TankSample { float vol; float metered; uint32_t at; bool valid; };
struct BurstEval { bool any; float drop; float metered; };
enum BurstVerdict : uint8_t { BV_NONE = 0, BV_SUSPENDED, BV_ALARM };

static inline BurstEval hidBurstEval(const TankSample *s, int n, uint32_t now, uint32_t windowMs,
                                     float volNow, float meteredNow) {
  float peak = volNow, metAtPeak = meteredNow;
  bool any = false;
  for (int i = 0; i < n; i++) {
    if (!s[i].valid || (uint32_t)(now - s[i].at) > windowMs) continue;
    any = true;
    if (s[i].vol > peak) { peak = s[i].vol; metAtPeak = s[i].metered; }
  }
  BurstEval e = { any, peak - volNow, meteredNow - metAtPeak };
  return e;
}

// Queda > dropFrac da capacidade com menos de meteredRatio da queda medida nos ramais = rompimento.
// Sem as contadoras não dá para separar consumo de rompimento: suspende (avisa, não corta).
static inline BurstVerdict hidBurstVerdict(const BurstEval &e, bool countersOk, float capacityL,
                                           float dropFrac, float meteredRatio) {
  if (!e.any || !(e.drop > dropFrac * capacityL)) return BV_NONE;
  if (!countersOk) return BV_SUSPENDED;
  return e.metered < meteredRatio * e.drop ? BV_ALARM : BV_NONE;
}
