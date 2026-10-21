// ============================================================
// NexusHome OS — Nobreak: lógica pura (sem Arduino, sem Modbus, sem relógio próprio)
// ------------------------------------------------------------
// Tudo o que decide "a rede caiu?", "quanto resta na bateria?" e "quantas horas
// aguenta?" fica aqui, em funções que só recebem números e o tempo (ms). Assim dá
// para testar no PC com g++ (simular 1 h de descarga em milissegundos) e o .ino só
// lê os medidores e chama estas funções.
//
// Os tempos são em ms no formato do millis() (uint32_t). As comparações usam
// subtração sem sinal (now - since), que continua certa quando o millis() dá a volta
// (~49 dias).
// ============================================================
#pragma once
#include <stdint.h>
#include <math.h>

namespace nb {

// ============================================================
// 1) Falta de energia (rede < minV por failMs; volta com rede ≥ minV por returnMs)
// ============================================================
struct GridParams {
  float    minV;       // abaixo disto não há rede (180 V)
  uint32_t failMs;     // tempo contínuo sem rede para declarar falta (5 s)
  uint32_t returnMs;   // tempo contínuo com rede para declarar a volta (evita alerta duplicado em oscilação)
};

struct GridDetector {
  bool     fail;        // falta de energia confirmada
  bool     badTiming;   // contando o tempo sem rede
  uint32_t badSince;
  bool     goodTiming;  // (em falta) contando o tempo com rede de volta
  uint32_t goodSince;
  uint32_t failedAt;    // quando a falta foi declarada (para dizer quanto durou)
};

enum GridEvent : uint8_t { GRID_NONE = 0, GRID_FAIL = 1, GRID_RETURN = 2 };

// startFailed = estado salvo antes de reiniciar (a tela reiniciou no meio de uma falta:
// não repete o alerta crítico; quando a rede voltar, avisa a volta).
inline void gridInit(GridDetector &g, bool startFailed, uint32_t now) {
  g.fail = startFailed;
  g.badTiming = g.goodTiming = false;
  g.badSince = g.goodSince = 0;
  g.failedAt = now;
}

// Uma amostra da entrada da rede. O PZEM-016 é alimentado pela própria tensão que mede:
// sem rede ele NÃO responde — por isso "medidor sem resposta" conta como rede ausente.
inline bool gridSamplePresent(bool meterAnswered, float volts, float minV) {
  return meterAnswered && volts >= minV;
}

// Avança o detector com uma amostra; devolve o evento (no máximo um por episódio).
inline GridEvent gridStep(GridDetector &g, bool present, uint32_t now, const GridParams &p) {
  if (!g.fail) {
    g.goodTiming = false;
    if (present) { g.badTiming = false; return GRID_NONE; }
    if (!g.badTiming) { g.badTiming = true; g.badSince = now; }
    if (now - g.badSince >= p.failMs) {
      g.fail = true;
      g.badTiming = false;
      g.failedAt = now;
      return GRID_FAIL;
    }
    return GRID_NONE;
  }
  g.badTiming = false;
  if (!present) { g.goodTiming = false; return GRID_NONE; }
  if (!g.goodTiming) { g.goodTiming = true; g.goodSince = now; }
  if (now - g.goodSince >= p.returnMs) {
    g.fail = false;
    g.goodTiming = false;
    return GRID_RETURN;
  }
  return GRID_NONE;
}

// ============================================================
// 2) Sentido da corrente do banco
// ------------------------------------------------------------
// O PZEM-017 mede a corrente SEM sinal (shunt unidirecional): é o firmware que decide se
// ela está entrando (carga) ou saindo (descarga).
//   · balance = false (padrão do §12): sem rede = descarga; com rede = carga.
//     Certo com o inversor em prioridade SUB/UPS (rede primeiro), o caso sem painéis FV.
//   · balance = true: além disso, com rede presente, se a entrada da rede for MENOR que a
//     saída do inversor (menos a margem), quem completa é a bateria → descarga.
//     Use com prioridade SBU (o inversor usa a bateria mesmo com rede). Não use com
//     painéis FV: a energia solar também deixa a entrada menor que a saída.
// ============================================================
inline bool batteryDischarging(bool gridPresent, bool balance, bool powersOk,
                               float gridW, float outW, float marginW) {
  if (!gridPresent) return true;
  if (balance && powersOk && gridW + marginW < outW) return true;
  return false;
}

// Sentido a usar NESTA volta, separando "sem rede" de "sem leitura":
//   · o PZEM da rede respondeu agora  → decide pela leitura (gridSamplePresent + batteryDischarging);
//   · não respondeu e a falta já foi CONFIRMADA pelo filtro (gridFail, 5 s) → descarga;
//   · não respondeu e a falta não está confirmada → DIR_UNKNOWN: uma falha Modbus isolada com a
//     rede presente NÃO pode virar "descarga" (inverteria o sinal da corrente de carga e derivaria
//     o SoC). Quem chama não integra a corrente nesta volta (o tempo fica para a próxima).
enum BattDir : int8_t { DIR_UNKNOWN = -1, DIR_CHARGE = 0, DIR_DISCHARGE = 1 };
inline int8_t batteryDirection(bool gridAnswered, float gridV, bool gridFail, float minV, bool balance,
                               bool powersOk, float gridW, float outW, float marginW) {
  if (gridAnswered)
    return batteryDischarging(gridSamplePresent(true, gridV, minV), balance, powersOk, gridW, outW, marginW)
               ? DIR_DISCHARGE : DIR_CHARGE;
  return gridFail ? DIR_DISCHARGE : DIR_UNKNOWN;
}

// ============================================================
// 3) Estado de carga (SoC) por contagem de Ah, com recalibração
// ============================================================
struct SocParams {
  float    bankAh;      // capacidade nominal (200 Ah)
  float    chargeEff;   // eficiência coulômbica na carga (LiFePO4 ≈ 0,99)
  float    fullV;       // recalibra para 100 % com tensão ≥ fullV...
  float    fullA;       // ...e corrente < fullA...
  uint32_t fullMs;      // ...por fullMs (10 min) seguidos
  float    emptyV;      // recalibra para emptySoc com tensão ≤ emptyV...
  uint32_t emptyMs;     // ...por emptyMs seguidos (filtra o afundamento na partida de um motor)
  float    emptySoc;    // (10 %)
  uint32_t maxDtMs;     // intervalo máximo integrado de uma vez (medidor parado, comando longo na serial)
};

struct SocState {
  float    soc;         // 0..100 %
  bool     fullTiming;
  uint32_t fullSince;
  bool     emptyTiming;
  uint32_t emptySince;
};

enum SocCal : uint8_t { CAL_NONE = 0, CAL_FULL = 1, CAL_EMPTY = 2 };

inline float clampSoc(float s) { return s < 0 ? 0 : (s > 100 ? 100 : s); }

inline void socInit(SocState &s, float soc) {
  s.soc = clampSoc(soc);
  s.fullTiming = s.emptyTiming = false;
  s.fullSince = s.emptySince = 0;
}

// Integra uma leitura do banco: battA (sempre ≥ 0) durante dtMs, no sentido `discharging`.
// Devolve CAL_FULL/CAL_EMPTY quando a recalibração MUDA o SoC.
inline SocCal socStep(SocState &s, const SocParams &p, float battV, float battA,
                      bool discharging, uint32_t dtMs, uint32_t now) {
  if (dtMs > p.maxDtMs) dtMs = p.maxDtMs;
  float a = fabsf(battA);
  float dAh = a * (float)dtMs / 3600000.0f;
  float dPct = p.bankAh > 0 ? dAh / p.bankAh * 100.0f : 0;
  s.soc = clampSoc(s.soc + (discharging ? -dPct : dPct * p.chargeEff));

  SocCal cal = CAL_NONE;
  // 100 %: tensão de flutuação com a corrente de carga já caindo
  if (battV >= p.fullV && a < p.fullA) {
    if (!s.fullTiming) { s.fullTiming = true; s.fullSince = now; }
    else if (now - s.fullSince >= p.fullMs) {
      if (s.soc < 99.95f) cal = CAL_FULL;
      s.soc = 100.0f;
    }
  } else {
    s.fullTiming = false;
  }
  // 10 %: tensão de corte (só baixa o SoC; se a contagem já está abaixo, mantém)
  if (battV > 1.0f && battV <= p.emptyV) {
    if (!s.emptyTiming) { s.emptyTiming = true; s.emptySince = now; }
    else if (now - s.emptySince >= p.emptyMs && s.soc > p.emptySoc) {
      s.soc = p.emptySoc;
      cal = CAL_EMPTY;
    }
  } else {
    s.emptyTiming = false;
  }
  return cal;
}

// ============================================================
// 4) Autonomia
// ------------------------------------------------------------
// energia útil (Wh) = (SoC − reserva) × Ah × V nominal × eficiência
//   · reserva 10 % = o inversor corta em 24,0 V, que é o "10 %" da recalibração;
//   · eficiência 0,92 = inversor (a potência de saída é CA).
// Com o banco cheio: 0,9 × 200 Ah × 25,6 V × 0,92 ≈ 4,24 kWh (o "≈ 4,2 kWh" do §4.1).
// (reserva 0 e eficiência 0,9 reproduzem a conta "SoC × Ah × 25,6 V × 0,9".)
// ============================================================
inline float usableWh(float soc, float bankAh, float nominalV, float floorSoc, float eff) {
  float pct = clampSoc(soc) - floorSoc;
  if (pct < 0) pct = 0;
  return pct / 100.0f * bankAh * nominalV * eff;
}

// horas; -1 = sem estimativa (carga média desconhecida ou desprezível). Limite: 999 h.
inline float autonomyHours(float soc, float avgW, float bankAh, float nominalV,
                           float floorSoc, float eff, float minW = 5.0f) {
  if (!(avgW >= minW)) return -1.0f;
  float h = usableWh(soc, bankAh, nominalV, floorSoc, eff) / avgW;
  return h > 999.0f ? 999.0f : h;
}

// Média móvel por janelas: SLOTS fatias de slotMs (60 × 10 s = 10 min).
template <int SLOTS>
struct MovingAvg {
  float    sum[SLOTS];
  uint32_t cnt[SLOTS];
  int      head;
  bool     started;
  uint32_t slotStart;
  uint32_t slotMs;

  void reset(uint32_t slot_ms) {
    for (int i = 0; i < SLOTS; i++) { sum[i] = 0; cnt[i] = 0; }
    head = 0; started = false; slotStart = 0; slotMs = slot_ms;
  }
  void add(float v, uint32_t now) {
    if (!started) { started = true; slotStart = now; head = 0; }
    uint32_t gap = now - slotStart;
    if (gap >= (uint32_t)SLOTS * slotMs) {          // parado mais que a janela inteira: recomeça
      for (int i = 0; i < SLOTS; i++) { sum[i] = 0; cnt[i] = 0; }
      head = 0; slotStart = now;
    } else {
      while (now - slotStart >= slotMs) {
        head = (head + 1) % SLOTS;
        sum[head] = 0; cnt[head] = 0;
        slotStart += slotMs;
      }
    }
    sum[head] += v;
    cnt[head]++;
  }
  // média das amostras na janela; -1 sem amostras
  float mean() const {
    double s = 0; uint32_t n = 0;
    for (int i = 0; i < SLOTS; i++) { s += sum[i]; n += cnt[i]; }
    return n ? (float)(s / n) : -1.0f;
  }
};

// ============================================================
// 5) Alertas com histerese
// ============================================================
// Nível da bateria: 0 normal · 1 baixa (≤ warn) · 2 crítica (≤ crit).
// Só desce de nível com o SoC `hyst` acima do limite (≤ 10 % → crítico; volta a "baixa"
// acima de 15 %; volta ao normal acima de 25 %). O alerta sai quando o nível SOBE.
inline uint8_t socAlarmLevel(uint8_t prev, float soc, float warn, float crit, float hyst) {
  if (soc <= crit) return 2;
  if (prev >= 2 && soc <= crit + hyst) return 2;
  if (soc <= warn) return 1;
  if (prev >= 1 && soc <= warn + hyst) return 1;
  return 0;
}

// Alarme de valor baixo: dispara com valor ≤ limit por holdMs; rearma com valor > rearm.
struct LowAlarm {
  bool     active;
  bool     timing;
  uint32_t since;
};
// +1 = disparou agora · -1 = normalizou agora · 0 = sem mudança
inline int lowAlarmStep(LowAlarm &a, float value, float limit, float rearm, uint32_t holdMs, uint32_t now) {
  if (!a.active) {
    if (value <= limit) {
      if (!a.timing) { a.timing = true; a.since = now; }
      if (now - a.since >= holdMs) { a.active = true; a.timing = false; return 1; }
    } else {
      a.timing = false;
    }
    return 0;
  }
  if (value > rearm) { a.active = false; a.timing = false; return -1; }
  return 0;
}

}  // namespace nb
