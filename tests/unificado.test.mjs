import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sensorReadings, batteryView } from '../js/sensor-readings.js';
import { houseWaterFlow, WATER_TOTAL_ID } from '../js/energy.js';
import { ALLOWED_METRICS, METRICS_025, alertSource, parseAlerts } from '../supabase/functions/iot-gateway/batch.ts';

test('sensor por cômodo: temperatura, umidade, presença e fumaça', () => {
  const r = sensorReadings({ temp: 24.36, hum: 61, presence: true, smoke: false });
  assert.deepEqual(r.map((x) => [x.label, x.value, x.alarm]), [
    ['Temperatura', '24,4°C', false], ['Umidade', '61%', false], ['Presença', 'alguém', false], ['Fumaça', 'normal', false],
  ]);
  assert.equal(sensorReadings({ smoke: true }).find((x) => x.key === 'smoke').alarm, true);
  // sensor ainda sem leitura (seed): mostra "—"
  assert.deepEqual(sensorReadings({ temp: null, hum: null }).map((x) => x.value), ['—', '—']);
  assert.deepEqual(sensorReadings({}), []);
});

test('gás e reservatório', () => {
  const g = sensorReadings({ gas_lel: 22, gas_al1: true, gas_al2: true });
  assert.equal(g[0].value, '22% LEL'); assert.equal(g[0].alarm, true);
  assert.equal(sensorReadings({ gas_lel: 0 })[0].alarm, false);
  const lv = sensorReadings({ level_pct: 15, volume_l: 150 });
  assert.equal(lv[0].alarm, true); assert.equal(lv[1].value, '150 L');
  assert.equal(sensorReadings({ door: true })[0].value, 'aberta');     // firmware: true = aberta
  assert.equal(sensorReadings({ door: false })[0].value, 'fechada');
});

test('nobreak: % do banco, falta de energia e autonomia', () => {
  assert.equal(batteryView({}), null);
  const ok = batteryView({ soc: 87.4, batt_v: 26.62, batt_a: 3.1, grid_v: 221 });
  assert.equal(ok.soc, 87); assert.equal(ok.level, 'ok'); assert.equal(ok.onBattery, false);
  assert.deepEqual(ok.lines, ['26,6 V · 3,1 A', 'rede 221 V']);
  const falta = batteryView({ soc: 18, batt_v: 25.4, grid_fail: true, out_w: 430, autonomy_h: 3.26 });
  assert.equal(falta.level, 'warn'); assert.equal(falta.onBattery, true);
  assert.deepEqual(falta.lines.slice(1), ['sem rede — casa no inversor (430 W)', 'autonomia ≈ 3,3 h']);
  assert.equal(batteryView({ soc: 8 }).level, 'crit');
  assert.equal(batteryView({ soc: 130 }).soc, 100);
});

test('água: a válvula geral é o total; sem ela soma os ramais', () => {
  const now = 1e9;
  const m = new Map([['r1', { v: 120, t: now }], ['r2', { v: 30, t: now }]]);
  assert.equal(houseWaterFlow(m, now), 150);
  m.set(WATER_TOTAL_ID, { v: 150, t: now });
  assert.equal(houseWaterFlow(m, now), 150);          // não conta duas vezes
  m.set(WATER_TOTAL_ID, { v: 150, t: now - 11 * 60 * 1000 });
  assert.equal(houseWaterFlow(m, now), 150);          // geral velha: volta a somar os ramais
  assert.equal(houseWaterFlow(new Map(), now), 0);
});

test('gateway: métricas da 025 e módulo do alerta por tela', () => {
  for (const m of METRICS_025) assert.ok(ALLOWED_METRICS.has(m), m);
  const sql = readFileSync(new URL('../supabase/migrations/025_quadro_unificado.sql', import.meta.url), 'utf8');
  for (const m of ALLOWED_METRICS) assert.ok(sql.includes(`'${m}'`), `025 sem ${m}`);
  assert.equal(alertSource('seguranca'), 'seguranca');
  assert.equal(alertSource('NOBREAK'), 'nobreak');
  assert.equal(alertSource('hacker'), 'eletrica');
  assert.equal(alertSource(undefined), 'eletrica');
  assert.equal(parseAlerts([{ severity: 'critical', message: 'Gás' }], alertSource('seguranca'))[0].source_module, 'seguranca');
});

test('seed unificado: UUIDs do projeto, sem duplicata, cômodos da planta', () => {
  const seed = readFileSync(new URL('../supabase/seeds/unificado.sql', import.meta.url), 'utf8');
  const ids = [...seed.matchAll(/\('(b[34]000000-0000-4000-8000-0000000000\d\d)'/g)].map((m) => m[1]);
  assert.equal(ids.length, 27);
  assert.equal(new Set(ids).size, ids.length);
  const planta = readFileSync(new URL('../supabase/seeds/residencia.sql', import.meta.url), 'utf8');
  const rooms = [...seed.matchAll(/'(?:light|sensor|valve|fan|alarm)', '[a-z_]+', '([^']+)'/g)].map((m) => m[1]);
  for (const r of new Set(rooms)) assert.ok(planta.includes(`'${r}'`), `cômodo fora da planta: ${r}`);
});
