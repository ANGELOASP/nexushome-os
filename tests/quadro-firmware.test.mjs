// Firmwares das telas do quadro (T2 elétrica, T3 segurança, T4 nobreak).
// 1) A lógica pura (seg_logic.h, nobreak_logic.h) compilada com g++ e rodada no PC
//    (tests/quadro-logica.cpp) — pulado sem g++.
// 2) Verificações de texto nos .ino: regras de segurança que não podem voltar atrás.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../', import.meta.url).pathname;
const src = (p) => readFileSync(join(root, p), 'utf8');
const gpp = spawnSync('g++', ['--version']).status === 0;
const FW = ['esp32s3_eletrica', 'esp32s3_seguranca', 'esp32s3_nobreak'];

test('lógica do quadro (gás × exaustores, sabotagem do alarme, sentido da corrente do nobreak) no g++',
  { skip: !gpp && 'sem g++' }, () => {
    const bin = join(mkdtempSync(join(tmpdir(), 'quadro-')), 'quadro');
    execFileSync('g++', ['-std=c++17', '-Wall', '-Wextra', '-Werror',
      `-I${join(root, 'firmware/esp32s3_seguranca')}`, `-I${join(root, 'firmware/esp32s3_nobreak')}`,
      '-o', bin, join(root, 'tests/quadro-logica.cpp')]);
    assert.match(execFileSync(bin).toString(), /OK lógica do quadro/);
  });

test('T3: exaustores bloqueados com gás (automático, app/tela e reescrita das bobinas)', () => {
  const s = src('firmware/esp32s3_seguranca/esp32s3_seguranca.ino');
  assert.match(s, /fanStep\(fanSt\[f\], humOk, hum, now, FCFG, fansGasBlocked\(\)\)/);
  assert.match(s, /void fanCommand\([^)]*\) \{\s*if \(f < 0 \|\| f >= FAN_COUNT\) return;\s*if \(fansGasBlocked\(\)\)/);
  assert.match(s, /if \(b == 1\) bits = auxBitsGasSafe\(bits\);/);
  // o bloqueio de luz continua só por área
  assert.match(s, /#define GAS_BLOCK_AREA_LIGHTS 1/);
  assert.match(s, /bool lightBlocked\(int i\) \{ return GAS_BLOCK_AREA_LIGHTS && gasAreaAlarm\(LIGHTS\[i\]\.gas\); \}/);
});

test('T3: alarme armado trata módulo de portas/presença mudo como sabotagem', () => {
  const s = src('firmware/esp32s3_seguranca/esp32s3_seguranca.ino');
  assert.match(s, /#define ALARM_TAMPER_MS\s+\d+UL/);
  assert.match(s, /segLostFor\(diOk\[MOD_SAFETY\], diDownSince\[MOD_SAFETY\], now, ALARM_TAMPER_MS\)/);
  assert.match(s, /segLostFor\(diOk\[MOD_PRESENCE\], diDownSince\[MOD_PRESENCE\], now, ALARM_TAMPER_MS\)/);
  assert.match(src('firmware/esp32s3_seguranca/ui.cpp'), /z == 8 \? "sabotagem/);
});

test('T2/T3/T4: alerta crítico não é descartado com a fila cheia', () => {
  for (const fw of FW) {
    const s = src(`firmware/${fw}/${fw}.ino`);
    assert.match(s, /if \(alertCount >= ALERT_SLOTS && critical\)/, fw);
    assert.match(s, /if \(a < alertInFlight\) alertInFlight--;/, fw);
    assert.match(s, /int sent = alertInFlight;/, fw);
  }
});

test('T2/T3/T4: nenhum prazo comparado com millis() absoluto (virada de ~49 dias)', () => {
  for (const fw of FW) {
    const s = src(`firmware/${fw}/${fw}.ino`);
    assert.doesNotMatch(s, /millis\(\)\s*(<|<=|>|>=)\s*[A-Za-z_]/, fw);
    assert.doesNotMatch(s, /[A-Za-z_]\s*(<|<=|>|>=)\s*millis\(\)/, fw);
  }
  assert.match(src('firmware/esp32s3_nobreak/esp32s3_nobreak.ino'), /if \(first && now < 8000\) continue;/);
});

test('T4: falha Modbus isolada do PZEM da rede não vira descarga', () => {
  const s = src('firmware/esp32s3_nobreak/esp32s3_nobreak.ino');
  assert.match(s, /nb::batteryDirection\(gridM\.answered, gridM\.v, grid\.fail,/);
  assert.match(s, /if \(bank\.answered && dir != nb::DIR_UNKNOWN\)/);
});

test('firmware legado esp32_nexushome (sensores simulados nos UUIDs reais) removido', () => {
  assert.equal(existsSync(join(root, 'firmware/esp32_nexushome')), false);
});
