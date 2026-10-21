// Testes da lógica pura das telas do quadro (sem Arduino): seg_logic.h (T3 segurança) e
// nobreak_logic.h (T4 nobreak). Compilado e rodado por tests/quadro-firmware.test.mjs:
//   g++ -std=c++17 -Wall -Wextra -Werror -I firmware/esp32s3_seguranca -I firmware/esp32s3_nobreak
//       tests/quadro-logica.cpp -o /tmp/quadro   (e rode /tmp/quadro)
#include <cstdio>
#include <cmath>
#include "seg_logic.h"
#include "nobreak_logic.h"

static int fails = 0, checks = 0;
#define CHECK(cond)                                                                 \
  do {                                                                              \
    checks++;                                                                       \
    if (!(cond)) { fails++; std::printf("FALHOU %s:%d  %s\n", __FILE__, __LINE__, #cond); } \
  } while (0)

static const FanCfg FC = { 75.0f, 60.0f, 300000u, 3600000u, 1800000u };
static const AlarmCfg AC = { 60000u, 30000u };

// ---------------- tempo com virada do millis() ----------------
static void testTempo() {
  CHECK(segReached(100, 100));
  CHECK(!segReached(99, 100));
  CHECK(segReached(0x00000010u, 0xFFFFFFF0u));            // prazo antes da virada, agora depois
  CHECK(!segReached(0xFFFFFFF0u, 0x00000010u));           // prazo depois da virada, agora antes
  CHECK(segElapsed(0x00002000u, 0xFFFFF000u, 0x3000u));
  // supervisão: módulo mudo há >= ms
  CHECK(!segLostFor(true, 1000, 50000, 10000));           // respondendo
  CHECK(!segLostFor(false, 0, 50000, 10000));             // ainda não declarado offline
  CHECK(!segLostFor(false, 45000, 50000, 10000));         // mudo há 5 s
  CHECK(segLostFor(false, 40000, 50000, 10000));          // mudo há 10 s
  CHECK(segLostFor(false, 0xFFFFF000u, 0x00002000u, 10000));   // atravessando a virada (12,3 s)
}

// ---------------- gás → exaustores congelados ----------------
static void testGasExaustores() {
  GasTxState g[2] = {};
  bool al2[2] = { false, false };
  CHECK(!gasBlocksFans(2, g, al2, false));
  g[1].warn = true;
  CHECK(gasBlocksFans(2, g, al2, false));                 // pré-alarme na lavanderia bloqueia os dois banheiros
  g[1].warn = false; al2[0] = true;
  CHECK(gasBlocksFans(2, g, al2, false));                 // AL2
  al2[0] = false;
  CHECK(gasBlocksFans(2, g, al2, true));                  // corte travado (mesmo sem gás agora)

  // desligado + UR alta + gás: NÃO liga
  FanState f = {};
  CHECK(!fanStep(f, true, 90.0f, 1000, FC, true));
  CHECK(!f.on);
  // sem gás: o automático liga normalmente
  CHECK(fanStep(f, true, 90.0f, 2000, FC, false));
  CHECK(f.on);
  // ligado + UR baixa depois do mínimo + gás: NÃO desliga
  CHECK(!fanStep(f, true, 30.0f, 2000 + FC.minMs + 1, FC, true));
  CHECK(f.on);
  // gás saiu: o automático desliga
  CHECK(fanStep(f, true, 30.0f, 2000 + FC.minMs + 2, FC, false));
  CHECK(!f.on);

  // manual ligado, gás chega, o prazo do manual vence durante o gás: continua ligado (não comuta)
  FanState m = {};
  fanManual(m, true, 0, FC);
  CHECK(m.on && m.manual);
  CHECK(!fanStep(m, true, 30.0f, FC.manualMs + 10, FC, true));
  CHECK(m.on);
  CHECK(!m.manual);                                       // o prazo do manual correu
  // gás saiu: automático com UR baixa e mínimo cumprido → desliga
  CHECK(fanStep(m, true, 30.0f, FC.manualMs + 20, FC, false));
  CHECK(!m.on);

  // gasStep + gasBlocksFans juntos: 12 % LEL na cozinha = pré-alarme → bloqueia
  GasCfg gc = { 10.0f, 5.0f, 20.0f };
  GasTxState gs[2] = {};
  bool latched = false, a2[2] = { false, false };
  GasEval ev = gasStep(gs[0], latched, true, 12.0f, false, false, gc);
  CHECK(ev.newWarn && !ev.newCut);
  CHECK(gasBlocksFans(2, gs, a2, latched));
  ev = gasStep(gs[0], latched, true, 3.0f, false, false, gc);
  CHECK(ev.warnCleared);
  CHECK(!gasBlocksFans(2, gs, a2, latched));
}

// ---------------- alarme: sabotagem (módulo de entradas mudo) ----------------
static AlarmState armado(uint8_t mode) {
  AlarmState a = {};
  alarmSetMode(a, mode, 0, AC);
  return a;
}

static void testSabotagem() {
  const uint32_t T = AC.exitMs + 1;   // depois do atraso de saída

  // em casa: 93 (portas) mudo → disparo por sabotagem
  AlarmState a = armado(ARM_HOME);
  CHECK(alarmStep(a, false, false, false, true, false, T, AC, false) == AE_TRIGGERED);
  CHECK(a.triggered && a.zone == ZB_TAMPER);
  // continua mudo, sirene tocando ou não: não repete o disparo
  CHECK(alarmStep(a, false, false, false, true, false, T + 1000, AC, false) == AE_NONE);

  // em casa: só a presença (92) muda → não dispara (presença não conta em casa)
  a = armado(ARM_HOME);
  CHECK(alarmStep(a, false, false, false, false, true, T, AC, false) == AE_NONE);
  CHECK(!a.triggered);

  // ausente: 92 mudo → dispara
  a = armado(ARM_AWAY);
  CHECK(alarmStep(a, false, false, false, false, true, T, AC, false) == AE_TRIGGERED);
  CHECK(a.zone == ZB_TAMPER);

  // desarmado: nada (só o aviso de módulo sem resposta, no .ino)
  a = armado(ARM_OFF);
  CHECK(alarmStep(a, false, false, false, true, true, T, AC, false) == AE_NONE);

  // durante o atraso de saída: não dispara; depois dele, dispara
  a = armado(ARM_AWAY);
  CHECK(alarmStep(a, false, false, false, true, false, 1000, AC, false) == AE_NONE);
  CHECK(alarmStep(a, false, false, false, true, false, T, AC, false) == AE_TRIGGERED);

  // durante o atraso de entrada: sabotagem dispara na hora (não espera os 30 s)
  a = armado(ARM_HOME);
  CHECK(alarmStep(a, true, false, false, false, false, T, AC, false) == AE_ENTRY_STARTED);
  CHECK(alarmStep(a, false, false, false, true, false, T + 2000, AC, false) == AE_TRIGGERED);
  CHECK(a.zone == ZB_TAMPER);

  // disparado por porta; depois o 93 cai (sirene parada) → novo disparo por sabotagem
  a = armado(ARM_HOME);
  CHECK(alarmStep(a, false, true, false, false, false, T, AC, false) == AE_TRIGGERED);
  CHECK(a.zone == ZB_SERVICE);
  CHECK(alarmStep(a, false, false, false, false, false, T + 1000, AC, false) == AE_NONE);
  CHECK(alarmStep(a, false, false, false, true, false, T + 2000, AC, false) == AE_RETRIGGER);
  CHECK(a.zone == ZB_TAMPER);

  // máscara: sabotagem só conta armado
  AlarmState off = {};
  CHECK(alarmMask(off, true, true, true, true, true) == 0);
  AlarmState home = {}; home.mode = ARM_HOME;
  CHECK(alarmMask(home, false, false, true, false, true) == 0);
  CHECK(alarmMask(home, false, false, false, true, false) == ZB_TAMPER);
}

// ---------------- nobreak: sentido da corrente com falha Modbus isolada ----------------
static void testSentido() {
  using namespace nb;
  CHECK(batteryDirection(true, 220.0f, false, 180.0f, false, false, 0, 0, 0) == DIR_CHARGE);
  CHECK(batteryDirection(true, 0.0f, false, 180.0f, false, false, 0, 0, 0) == DIR_DISCHARGE);     // respondeu sem tensão
  CHECK(batteryDirection(false, 0.0f, false, 180.0f, false, false, 0, 0, 0) == DIR_UNKNOWN);      // falha isolada
  CHECK(batteryDirection(false, 0.0f, true, 180.0f, false, false, 0, 0, 0) == DIR_DISCHARGE);     // falta confirmada
  CHECK(batteryDirection(true, 220.0f, false, 180.0f, true, true, 300, 800, 50) == DIR_DISCHARGE); // SBU: bateria completa
}

// Simula o endOfCycle do .ino (1 volta por segundo): o banco carrega a 20 A; `answered(t)` diz se o
// PZEM da rede respondeu na volta t. Devolve o SoC final.
template <typename F>
static float simulaCarga(int segundos, bool redePresente, F answered) {
  using namespace nb;
  const SocParams sp = { 200.0f, 1.0f, 99.0f, 0.0f, 600000u, 1.0f, 5000u, 10.0f, 30000u };
  const GridParams gp = { 180.0f, 5000u, 10000u };
  SocState soc; socInit(soc, 50.0f);
  GridDetector grid; gridInit(grid, false, 0);
  bool timed = true; uint32_t lastAt = 0;           // como no .ino: o banco já vinha sendo integrado
  for (int t = 1; t <= segundos; t++) {
    uint32_t now = (uint32_t)t * 1000u;
    bool ans = redePresente && answered(t);
    float v = ans ? 220.0f : 0.0f;
    gridStep(grid, gridSamplePresent(ans, v, gp.minV), now, gp);
    int8_t dir = batteryDirection(ans, v, grid.fail, gp.minV, false, false, 0, 0, 0);
    if (dir == DIR_UNKNOWN) continue;                 // não integra: o tempo fica para a próxima volta
    uint32_t dt = timed ? now - lastAt : 0;
    timed = true; lastAt = now;
    socStep(soc, sp, 26.0f, 20.0f, dir == DIR_DISCHARGE, dt, now);
  }
  return soc.soc;
}

static void testSocSemDeriva() {
  float limpo = simulaCarga(120, true, [](int) { return true; });
  // uma falha Modbus a cada 10 s (rede presente o tempo todo): o SoC não pode cair
  float comFalhas = simulaCarga(120, true, [](int t) { return t % 10 != 5; });
  CHECK(limpo > 50.0f);
  CHECK(std::fabs(limpo - comFalhas) < 1e-3f);
  // falta de verdade (o PZEM da rede para de responder): descarga desde o 1º segundo, sem perder os
  // 5 s do filtro — 120 s a 20 A = 0,6667 Ah = 0,333 % de 200 Ah (os 5 s entram na 1ª volta confirmada)
  float falta = simulaCarga(120, false, [](int) { return false; });
  CHECK(std::fabs((50.0f - falta) - (20.0f * 120.0f / 3600.0f / 200.0f * 100.0f)) < 1e-3f);
}

int main() {
  testTempo();
  testGasExaustores();
  testSabotagem();
  testSentido();
  testSocSemDeriva();
  if (fails) { std::printf("%d de %d verificações falharam\n", fails, checks); return 1; }
  std::printf("OK lógica do quadro: %d verificações\n", checks);
  return 0;
}
