// ============================================================
// NexusHome OS — Lógica de decisão da tela de Segurança (barramento B), SEM Arduino
// ------------------------------------------------------------
// Funções puras (só <stdint.h>): o .ino lê o barramento, chama estas funções e executa
// o que elas decidem. Assim dá para testar a lógica no PC com g++ (sem placa):
//   · three-way com retorno (precisa inverter? confirmou?)
//   · gás: pré-alarme com histerese e corte travado (latch) até o rearme
//   · exaustor por umidade (liga > 75 %, desliga < 60 %, mín. 5 min, máx. 60 min, manual 30 min),
//     congelado enquanto houver gás (pré-alarme ou travamento, qualquer área)
//   · alarme da casa (em casa / ausente, atraso de saída e de entrada, sabotagem = módulo mudo)
//   · filtro das entradas digitais (2 leituras iguais)
// Tempos em ms com uint32_t (millis()); as comparações aguentam a virada do contador (~49 dias).
// ============================================================
#pragma once
#include <stdint.h>

static inline bool segElapsed(uint32_t now, uint32_t since, uint32_t ms) { return (uint32_t)(now - since) >= ms; }
static inline bool segReached(uint32_t now, uint32_t deadline) { return (int32_t)(now - deadline) >= 0; }

// ---------------- Entradas digitais: filtro de 2 leituras ----------------
// Um bit só muda no valor "estável" quando duas leituras seguidas concordam (≈ 2 voltas do loop).
static inline uint8_t segDebounce(uint8_t &stable, uint8_t &prevRaw, uint8_t raw) {
  uint8_t agree = (uint8_t)~(raw ^ prevRaw);
  stable = (uint8_t)((stable & ~agree) | (raw & agree));
  prevRaw = raw;
  return stable;
}

// ---------------- Luzes three-way ----------------
// O estado REAL é o retorno (relé KRn na entrada digital). Só inverte o canal quando o pedido
// difere do retorno; sem retorno válido (módulo mudo) não mexe — não dá para saber o que fazer.
static inline bool lightNeedsFlip(bool want, bool fbValid, bool fbOn) { return fbValid && want != fbOn; }

struct LightConfirm {
  bool active;      // esperando o retorno mudar
  bool expect;      // estado pedido
  uint32_t at;      // quando conferir
  uint8_t tries;
};
enum ConfirmResult : uint8_t { CR_IDLE = 0, CR_WAIT, CR_OK, CR_FAIL };

static inline void lightConfirmStart(LightConfirm &c, bool expect, uint32_t now, uint32_t delayMs) {
  c.active = true; c.expect = expect; c.at = now + delayMs; c.tries = 0;
}

// readAt = instante da leitura do retorno (tem de ser DEPOIS do prazo para valer).
// Não mudou no prazo: confere de novo após retryMs, até maxTries; depois disso, CR_FAIL.
static inline ConfirmResult lightConfirmStep(LightConfirm &c, bool fbValid, bool fbOn, uint32_t readAt,
                                             uint32_t retryMs, uint8_t maxTries) {
  if (!c.active) return CR_IDLE;
  if (!segReached(readAt, c.at)) return CR_WAIT;
  if (fbValid && fbOn == c.expect) { c.active = false; return CR_OK; }
  if (++c.tries >= maxTries) { c.active = false; return CR_FAIL; }
  c.at = readAt + retryMs;
  return CR_WAIT;
}

// ---------------- Gás ----------------
struct GasCfg {
  float warnOn;     // ≥ 10 % LEL: pré-alarme (warning)
  float warnOff;    // < 5 % LEL: pré-alarme termina (histerese)
  float cutOn;      // ≥ 20 % LEL: corte (critical), travado até o rearme
};
struct GasTxState {
  bool warn;        // pré-alarme ativo (com histerese)
  bool tripped;     // este transmissor causou o travamento atual
};
struct GasEval { bool newWarn, warnCleared, newCut; };

// Um passo por leitura do transmissor. readOk = respondeu agora. al1/al2 = saídas do próprio
// transmissor (ou derivadas da leitura quando o registrador de estado não existe).
// latched = alarme de gás travado (global, compartilhado entre os transmissores).
static inline GasEval gasStep(GasTxState &g, bool &latched, bool readOk, float lel, bool al1, bool al2,
                              const GasCfg &cfg) {
  GasEval ev = { false, false, false };
  if (!readOk) return ev;                       // sem leitura não decide nada (o AL2 por fio continua)
  bool warnNow = lel >= cfg.warnOn || al1 || al2;
  bool cutNow = lel >= cfg.cutOn || al2;
  if (!g.warn && warnNow) { g.warn = true; ev.newWarn = true; }
  else if (g.warn && lel < cfg.warnOff && !al1 && !al2) { g.warn = false; ev.warnCleared = true; }
  if (cutNow && !latched) { latched = true; g.tripped = true; ev.newCut = true; }
  else if (cutNow) g.tripped = true;
  return ev;
}

// Rearme: só sem gás presente (nenhum transmissor que responde em ≥ pré-alarme ou com AL1/AL2).
// Transmissor mudo não impede (o AL2 por fio continua na cadeia da válvula).
// Gás na casa (qualquer área): algum transmissor em pré-alarme/AL2 ou o corte travado.
// Enquanto for verdade, os EXAUSTORES não são comutados (nem ligam nem desligam): o relé de
// interface KE1/KE2 comutando a fase do motor é fonte de ignição. (As luzes são bloqueadas só
// na área do vazamento — isso fica no .ino, GAS_BLOCK_AREA_LIGHTS.)
static inline bool gasBlocksFans(int n, const GasTxState *g, const bool *al2, bool latched) {
  if (latched) return true;
  for (int i = 0; i < n; i++)
    if (g[i].warn || al2[i]) return true;
  return false;
}

static inline bool gasCanRearm(int n, const bool *readOk, const float *lel, const bool *al1, const bool *al2,
                               const GasCfg &cfg) {
  for (int i = 0; i < n; i++)
    if (readOk[i] && (lel[i] >= cfg.warnOn || al1[i] || al2[i])) return false;
  return true;
}

// ---------------- Exaustor por umidade ----------------
struct FanCfg {
  float onAbove;      // UR > 75 % liga
  float offBelow;     // UR < 60 % desliga
  uint32_t minMs;     // mínimo ligado (5 min)
  uint32_t maxMs;     // máximo ligado (60 min)
  uint32_t manualMs;  // comando manual vale por 30 min
};
struct FanState {
  bool on;
  bool needDry;          // parou pelo tempo máximo: só volta no automático depois de UR < 60 %
  bool manual;           // comando manual em vigor
  bool manualOn;
  uint32_t onSince;
  uint32_t manualUntil;
};

static inline void fanSetOn(FanState &f, bool on, uint32_t now) {
  if (on && !f.on) f.onSince = now;
  f.on = on;
}

// Comando manual (app/tela): vale por manualMs; depois o automático retoma.
static inline void fanManual(FanState &f, bool on, uint32_t now, const FanCfg &cfg) {
  f.manual = true; f.manualOn = on; f.manualUntil = now + cfg.manualMs;
  fanSetOn(f, on, now);
  if (!on) f.needDry = false;
}
static inline void fanAuto(FanState &f) { f.manual = false; }

// Um passo do automático; devolve true se o exaustor mudou.
// gasBlock = gás na casa (gasBlocksFans): o exaustor fica EXATAMENTE como está — não liga nem
// desliga. O prazo do manual continua correndo; quando o gás sai, o automático decide de novo
// (e, se já passou do tempo máximo, desliga).
static inline bool fanStep(FanState &f, bool humOk, float hum, uint32_t now, const FanCfg &cfg, bool gasBlock) {
  bool was = f.on;
  if (f.manual && segReached(now, f.manualUntil)) f.manual = false;
  if (gasBlock) return false;
  if (f.manual) {
    fanSetOn(f, f.manualOn, now);
    return f.on != was;
  }
  if (humOk && hum < cfg.offBelow) f.needDry = false;
  if (f.on) {
    if (segElapsed(now, f.onSince, cfg.maxMs)) { f.on = false; f.needDry = humOk && hum >= cfg.offBelow; }
    else if (segElapsed(now, f.onSince, cfg.minMs) && (!humOk || hum < cfg.offBelow)) f.on = false;
  } else if (humOk && hum > cfg.onAbove && !f.needDry) {
    fanSetOn(f, true, now);
  }
  return f.on != was;
}

// ---------------- Alarme da casa ----------------
enum ArmMode : uint8_t { ARM_OFF = 0, ARM_HOME = 1, ARM_AWAY = 2 };
enum AlarmZoneBit : uint8_t { ZB_FRONT = 1, ZB_SERVICE = 2, ZB_PRESENCE = 4, ZB_TAMPER = 8 };
enum AlarmEvent : uint8_t { AE_NONE = 0, AE_ENTRY_STARTED, AE_TRIGGERED, AE_RETRIGGER };

struct AlarmCfg { uint32_t exitMs, entryMs; };
struct AlarmState {
  uint8_t mode;          // ArmMode
  bool triggered;        // disparou (fica até desarmar)
  bool exitActive;       // atraso de saída correndo (nada dispara)
  uint32_t exitUntil;
  bool entryActive;      // porta de entrada abriu: atraso para desarmar
  uint32_t entryUntil;
  uint8_t zone;          // zona que disparou (AlarmZoneBit)
  uint8_t prevMask;      // zonas violadas na volta anterior (novo disparo só numa nova violação)
};

// Armar/desarmar. Armar (ou trocar de modo) começa o atraso de saída.
static inline void alarmSetMode(AlarmState &a, uint8_t mode, uint32_t now, const AlarmCfg &cfg) {
  if (mode > ARM_AWAY) return;
  a.mode = mode;
  a.triggered = false;
  a.entryActive = false;
  a.zone = 0;
  a.prevMask = 0;
  a.exitActive = mode != ARM_OFF && cfg.exitMs > 0;
  a.exitUntil = now + cfg.exitMs;
}

// Supervisão (sabotagem): armado, módulo de entradas mudo NÃO é "porta fechada / sem presença".
//   safetyLost   = módulo das portas (IO 8CH 93) sem resposta há mais que o limite do .ino
//   presenceLost = idem para o módulo de presença (IO 8CH 92) — só conta no "ausente"
// Cortar o cabo do HUB-B ou a alimentação do IO 8CH vira disparo (ZB_TAMPER), não silêncio.
static inline uint8_t alarmMask(const AlarmState &a, bool frontOpen, bool serviceOpen, bool presence,
                                bool safetyLost, bool presenceLost) {
  if (a.mode == ARM_OFF) return 0;
  uint8_t m = 0;
  if (frontOpen) m |= ZB_FRONT;
  if (serviceOpen) m |= ZB_SERVICE;
  if (a.mode == ARM_AWAY && presence) m |= ZB_PRESENCE;
  if (safetyLost || (a.mode == ARM_AWAY && presenceLost)) m |= ZB_TAMPER;
  return m;
}

// Um passo do alarme. sirensActive = as sirenes do alarme ainda tocam (sem novo disparo enquanto tocam).
//   em casa: portas · ausente: portas + presença
//   porta de entrada → atraso de entrada (presença ignorada durante ele: é quem chegou andando)
//   porta de serviço ou presença (fora do atraso) → disparo imediato
//   sabotagem (módulo mudo, ver alarmMask) → disparo imediato, mesmo durante o atraso de entrada
static inline AlarmEvent alarmStep(AlarmState &a, bool frontOpen, bool serviceOpen, bool presence,
                                   bool safetyLost, bool presenceLost, uint32_t now,
                                   const AlarmCfg &cfg, bool sirensActive) {
  if (a.mode == ARM_OFF) { a.triggered = false; a.entryActive = false; a.exitActive = false; return AE_NONE; }
  if (a.exitActive) {
    if (!segReached(now, a.exitUntil)) return AE_NONE;
    a.exitActive = false;
    a.prevMask = 0;
  }
  uint8_t mask = alarmMask(a, frontOpen, serviceOpen, presence, safetyLost, presenceLost);
  AlarmEvent ev = AE_NONE;
  if (!a.triggered) {
    if (a.entryActive) {
      if (mask & ZB_SERVICE) { a.triggered = true; a.zone = ZB_SERVICE; a.entryActive = false; ev = AE_TRIGGERED; }
      else if (mask & ZB_TAMPER) { a.triggered = true; a.zone = ZB_TAMPER; a.entryActive = false; ev = AE_TRIGGERED; }
      else if (segReached(now, a.entryUntil)) { a.triggered = true; a.zone = ZB_FRONT; a.entryActive = false; ev = AE_TRIGGERED; }
    } else if (mask & ZB_SERVICE) { a.triggered = true; a.zone = ZB_SERVICE; ev = AE_TRIGGERED; }
    else if (mask & ZB_TAMPER) { a.triggered = true; a.zone = ZB_TAMPER; ev = AE_TRIGGERED; }
    else if (mask & ZB_PRESENCE) { a.triggered = true; a.zone = ZB_PRESENCE; ev = AE_TRIGGERED; }
    else if (mask & ZB_FRONT) {
      a.entryActive = true; a.entryUntil = now + cfg.entryMs; ev = AE_ENTRY_STARTED;
      if (cfg.entryMs == 0) { a.triggered = true; a.zone = ZB_FRONT; a.entryActive = false; ev = AE_TRIGGERED; }
    }
  } else {
    uint8_t fresh = (uint8_t)(mask & ~a.prevMask);
    if (fresh && !sirensActive) {
      a.zone = (fresh & ZB_SERVICE) ? ZB_SERVICE : (fresh & ZB_TAMPER) ? ZB_TAMPER : (fresh & ZB_FRONT) ? ZB_FRONT : ZB_PRESENCE;
      ev = AE_RETRIGGER;
    }
  }
  a.prevMask = mask;
  return ev;
}

// Módulo sem resposta há pelo menos `ms` (downSince = quando ficou offline; 0 = não está).
static inline bool segLostFor(bool ok, uint32_t downSince, uint32_t now, uint32_t ms) {
  return !ok && downSince != 0 && segElapsed(now, downSince, ms);
}

static inline uint32_t segLeftS(uint32_t now, uint32_t deadline) {
  int32_t d = (int32_t)(deadline - now);
  return d > 0 ? ((uint32_t)d + 999) / 1000 : 0;
}
