// Firmware da tela T1 Água (firmware/esp32s3_hidraulica): a lógica pura de hid_logic.h é compilada
// com g++ no PC e roda (pulado sem g++); o .ino é conferido por leitura de texto (ordem do setup,
// reenvio dos relés, serial pela fila, chip de falha visível em alarme).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirFw = new URL('../firmware/esp32s3_hidraulica/', import.meta.url);
const ino = readFileSync(new URL('esp32s3_hidraulica.ino', dirFw), 'utf8');
const ui = readFileSync(new URL('ui.cpp', dirFw), 'utf8');
const gpp = spawnSync('g++', ['--version']).status === 0;

const CPP = String.raw`
#include <cstdio>
#include <cstdlib>
#include <cmath>
#include "hid_logic.h"
static int fails = 0;
#define CHECK(c) do { if (!(c)) { std::printf("FALHOU linha %d: %s\n", __LINE__, #c); fails++; } } while (0)
static const int GERAL = 6, EXTERNA = 7;

static void persistencia() {
  bool open[8]; bool b, e, p;
  hidUnpackState(HID_STATE_DEFAULT, open, b, e, p, GERAL, EXTERNA);
  for (int i = 0; i < 8; i++) CHECK(open[i]);
  CHECK(!b && !e && !p);
  // rompimento + ramal 2 fechado à mão: volta igual
  bool o2[8] = { true, false, true, true, true, true, false, true };
  uint16_t v = hidPackState(o2, true, false, false);
  hidUnpackState(v, open, b, e, p, GERAL, EXTERNA);
  CHECK(b && !e && !p); CHECK(!open[1] && !open[6] && open[0] && open[7]);
  // gravado com a geral "aberta" mas rompimento ativo: a trava fecha a geral
  bool todas[8] = { true, true, true, true, true, true, true, true };
  hidUnpackState(hidPackState(todas, true, true, false), open, b, e, p, GERAL, EXTERNA);
  CHECK(!open[GERAL] && !open[EXTERNA] && open[0]);
  // pânico: tudo fechado, mesmo com bits de aberta
  hidUnpackState(hidPackState(todas, false, false, true), open, b, e, p, GERAL, EXTERNA);
  CHECK(p); for (int i = 0; i < 8; i++) CHECK(!open[i]);
  CHECK(hidPackState(todas, false, false, false) == HID_STATE_DEFAULT);
  CHECK(hidPackState(todas, true, true, true) != 0xFFFF);   // 0xFFFF é o "nada gravado" do .ino
  std::printf("OK persistência\n");
}

static void reles() {
  bool open[8] = { true, true, true, true, true, true, true, true };
  CHECK(hidRelayBits(open, true) == 0x00);          // tudo aberto = relés desligados (X7: NF = ABRE)
  open[GERAL] = false;
  CHECK(hidRelayBits(open, true) == 0x40);          // geral fechada = relé 7 energizado
  CHECK(hidRelayBits(open, false) == 0xBF);
  RelayWatch w = { 0, false, false };
  CHECK(hidRelayStep(w, false, true, 3) == RW_NONE);
  CHECK(hidRelayStep(w, false, true, 3) == RW_NONE);
  CHECK(hidRelayStep(w, false, true, 3) == RW_CRITICAL);   // 3ª falha seguida com válvula fechada
  CHECK(hidRelayStep(w, false, true, 3) == RW_NONE);       // não repete
  CHECK(hidRelayStep(w, true, true, 3) == RW_RECOVERED);
  CHECK(hidRelayStep(w, true, true, 3) == RW_NONE);
  // tudo aberto: aviso; depois alguém fecha uma válvula com a placa ainda muda → sobe para crítico
  for (int i = 0; i < 2; i++) CHECK(hidRelayStep(w, false, false, 3) == RW_NONE);
  CHECK(hidRelayStep(w, false, false, 3) == RW_WARN);
  CHECK(hidRelayStep(w, false, false, 3) == RW_NONE);
  CHECK(hidRelayStep(w, false, true, 3) == RW_CRITICAL);
  // uma falha isolada no meio de confirmações não alerta
  RelayWatch w2 = { 0, false, false };
  for (int i = 0; i < 10; i++) CHECK(hidRelayStep(w2, i % 2 == 0, true, 3) == RW_NONE);
  std::printf("OK relés\n");
}

static void vazao() {
  // ramal 7: 12 pulsos/L; 100 L/h = 1 pulso a cada 3 s. Leitura a cada 1 s.
  static FlowWindow w; hidFlowReset(w);
  uint32_t cum[HID_CH] = { 0 };
  uint32_t t0 = 0xFFFFFFFFu - 20000u;               // passa pela virada do millis no meio
  int zeros = 0;
  for (int s = 0; s <= 180; s++) {
    if (s > 0 && s % 3 == 0) cum[6]++;
    hidFlowPush(w, t0 + s * 1000u, cum);
    if (s >= 60) {
      float f = hidFlowLph(w, 6, 60000, 12.0f);
      if (f < 1.0f) zeros++;
      CHECK(std::fabs(f - 100.0f) < 6.0f);
    }
  }
  CHECK(zeros == 0);                                 // janela de 1 s dava 0 em 2 de cada 3 leituras
  // 30 s sem leitura (Modbus): a próxima diferença cobre o buraco, a média continua ~100 L/h
  uint32_t t = t0 + 180000u + 30000u;
  cum[6] += 10;
  hidFlowPush(w, t, cum);
  CHECK(std::fabs(hidFlowLph(w, 6, 60000, 12.0f) - 100.0f) < 8.0f);
  // canal parado
  CHECK(hidFlowLph(w, 0, 60000, 4.5f) == 0.0f);
  // só uma amostra: sem vazão
  static FlowWindow w1; hidFlowReset(w1); hidFlowPush(w1, 5, cum);
  CHECK(hidFlowLph(w1, 6, 60000, 12.0f) == 0.0f);
  std::printf("OK vazão janela 60 s\n");
}

// simula "seconds" segundos com leitura a cada 1 s; pulso a cada "every" s; falha Modbus a cada "failEvery"
static uint32_t extSim(ExtFlow &s, uint32_t &now, int seconds, int every, int failEvery) {
  uint32_t acc = 0;
  for (int k = 1; k <= seconds; k++) {
    now += 1000;
    bool ok = !(failEvery && k % failEvery == 0);
    uint32_t pulses = (every && k % every == 0) ? 1 : 0;
    acc = hidExtStep(s, ok, ok ? pulses : 0, now, 60000);
  }
  return acc;
}

static void externo() {
  const uint32_t H = 3600000u;
  // 100 L/h (pulso a cada 3 s) com falha Modbus a cada 10 leituras: as falhas só pausam (10 % do
  // tempo não conta), então 61 min de relógio ainda não bastam e 68 min (≈ 61 min contados) passam
  ExtFlow s = {}; uint32_t now = 0xFFFFFFFFu - 100000u;
  CHECK(extSim(s, now, 61 * 60, 3, 10) < H);
  CHECK(extSim(s, now, 7 * 60, 3, 10) >= H);
  // vazamento lento: um pulso a cada 50 s (nenhum minuto sem pulso) também conta
  ExtFlow s2 = {}; uint32_t n2 = 1000;
  CHECK(extSim(s2, n2, 61 * 60, 50, 0) >= H);
  // pulso a cada 70 s = há minutos sem pulso → nunca chega a 60 min
  ExtFlow s3 = {}; uint32_t n3 = 1000;
  CHECK(extSim(s3, n3, 120 * 60, 70, 0) < 2 * 60000u);
  // falha longa (5 min) no meio: pausa — não zera nem soma o buraco
  ExtFlow s4 = {}; uint32_t n4 = 1000;
  uint32_t a = extSim(s4, n4, 10 * 60, 3, 0);
  uint32_t b = extSim(s4, n4, 5 * 60, 0, 1);         // todas as leituras falham
  CHECK(b == a);
  uint32_t c = extSim(s4, n4, 60, 3, 0);
  CHECK(c >= a + 55000u && c <= a + 61000u);
  // parou de verdade (leituras boas sem pulso por > 1 min): zera
  CHECK(extSim(s4, n4, 61, 0, 0) == 0);
  std::printf("OK fluxo contínuo externo\n");
}

static void rompimento() {
  TankSample t[19] = {};
  uint32_t now = 0xFFFFFFFFu - 5000u;               // amostras de antes da virada
  // amostra velha (10 min) com o reservatório cheio: não vale mais
  t[0] = TankSample{ 900.0f, 50.0f, now - 600000u, true };
  BurstEval e = hidBurstEval(t, 19, now, 180000, 700.0f, 50.0f);
  CHECK(!e.any);
  CHECK(hidBurstVerdict(e, true, 1000.0f, 0.10f, 0.30f) == BV_NONE);
  // dentro da janela (2 min antes, atravessando a virada): queda de 200 L sem consumo → alarme
  t[1] = TankSample{ 900.0f, 50.0f, now - 120000u, true };
  uint32_t later = now + 10000u;                     // já depois da virada
  e = hidBurstEval(t, 19, later, 180000, 700.0f, 55.0f);
  CHECK(e.any && std::fabs(e.drop - 200.0f) < 0.01f && std::fabs(e.metered - 5.0f) < 0.01f);
  CHECK(hidBurstVerdict(e, true, 1000.0f, 0.10f, 0.30f) == BV_ALARM);
  CHECK(hidBurstVerdict(e, false, 1000.0f, 0.10f, 0.30f) == BV_SUSPENDED);
  // a mesma queda, mas medida nos ramais (consumo): normal
  e = hidBurstEval(t, 19, later, 180000, 700.0f, 150.0f);
  CHECK(hidBurstVerdict(e, true, 1000.0f, 0.10f, 0.30f) == BV_NONE);
  // queda pequena (< 10 %): normal
  e = hidBurstEval(t, 19, later, 180000, 850.0f, 50.0f);
  CHECK(hidBurstVerdict(e, true, 1000.0f, 0.10f, 0.30f) == BV_NONE);
  std::printf("OK rompimento janela 180 s\n");
}

int main() {
  persistencia(); reles(); vazao(); externo(); rompimento();
  if (fails) { std::printf("%d falha(s)\n", fails); return 1; }
  std::printf("OK lógica da hidráulica\n");
  return 0;
}
`;

test('T1 Água: lógica pura (hid_logic.h) compila com g++ e passa', { skip: !gpp && 'sem g++' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'hidraulica-'));
  const src = join(dir, 'teste.cpp');
  writeFileSync(src, CPP);
  const bin = join(dir, 'teste');
  execFileSync('g++', ['-std=c++17', '-Wall', '-Wextra', '-Werror', `-I${dirFw.pathname}`, '-o', bin, src]);
  const r = spawnSync(bin);
  const out = r.stdout.toString();
  assert.equal(r.status, 0, out);
  for (const ok of ['persistência', 'relés', 'vazão janela 60 s', 'fluxo contínuo externo', 'rompimento janela 180 s', 'lógica da hidráulica'])
    assert.match(out, new RegExp(`OK ${ok}`));
});

test('T1 Água: estado travado volta da NVS antes do primeiro comando aos relés', () => {
  assert.match(ino, /#include <Preferences\.h>/);
  const setup = ino.slice(ino.indexOf('void setup()'), ino.indexOf('void loop()'));
  const iBegin = setup.indexOf('prefs.begin("hidraulica"');
  const iLoad = setup.indexOf('loadState();');
  const iApply = setup.indexOf('applyValves();');
  assert.ok(iBegin >= 0 && iLoad > iBegin && iApply > iLoad, 'prefs.begin → loadState → applyValves');
  assert.doesNotMatch(setup, /valveOpen\[i\]\s*=\s*true/, 'o setup não pode reabrir as válvulas por conta própria');
  // grava só na borda e o rearme limpa
  assert.match(ino, /if \(v == savedState\) return;/);
  const reset = ino.slice(ino.indexOf('void resetAll()'), ino.indexOf('bool valveBlocked('));
  assert.match(reset, /saveState\(\);/);
  for (const fn of ['void setValve(', 'void panicCloseAll()']) {
    const body = ino.slice(ino.indexOf(fn), ino.indexOf('\n}\n', ino.indexOf(fn)));
    assert.ok(body.indexOf('saveState();') >= 0 && body.indexOf('saveState();') < body.indexOf('applyValves()'), `${fn} grava antes de comandar`);
  }
});

test('T1 Água: relés reenviados a cada 30 s e após falha, conferidos pela função 01, alerta crítico', () => {
  assert.match(ino, /#define RELAY_REFRESH_MS\s+30000/);
  assert.match(ino, /if \(relayDirty \|\| hidElapsed\(now, lastRelayWrite, RELAY_REFRESH_MS\)\) applyValves\(\);/);
  assert.match(ino, /relayDirty = !ok;/);
  assert.match(ino, /bool mbReadCoils8\(/);
  assert.match(ino, /slave, 0x01,/);
  assert.match(ino, /raiseAlert\("critical", "Água: válvula não confirmou fechamento/);
  assert.match(ino, /flushAlerts\(\);/);
});

test('T1 Água: serial "abrir N" respeita a trava (vai pela fila)', () => {
  const serial = ino.slice(ino.indexOf('void handleSerial()'), ino.indexOf('void checkPanicButton()'));
  assert.doesNotMatch(serial, /setValve\(/);
  assert.match(serial, /submitRequest\(UiRequest\{ UI_REQ_SET_VALVE/);
});

test('T1 Água: sem comparações absolutas de millis() e janelas com carimbo', () => {
  assert.doesNotMatch(ino, /millis\(\)\s*(>=|<=|>|<)\s*[a-zA-Z_]+(At|Until|Deadline)\b/);
  assert.doesNotMatch(ino, /extFlowSince|EXT_FLOW_MIN_LPH|lastCountAt/);
  assert.match(ino, /hidFlowLph\(flowWin, i, FLOW_WINDOW_MS/);
  assert.match(ino, /TankSample\{ volumeL, meteredTotal\(\), \(uint32_t\)now, true \}/);
});

test('T1 Água: em alarme a tela mantém a falha do barramento visível', () => {
  const upd = ui.slice(ui.indexOf('void ui_update('));
  assert.match(upd, /bool showBus = !alarm \|\| !busOk;/);
  assert.match(upd, /"Relés: falha"/);
});
