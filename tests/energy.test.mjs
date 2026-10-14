import test from 'node:test';
import assert from 'node:assert/strict';
import { houseWatts, energyBands, energyBand, DEFAULT_BANDS, ENERGY_STALE_MS } from '../js/energy.js';

const now = Date.parse('2026-10-14T12:00:00Z');
const devices = {
  total: { id: 'total', type: 'meter', status: { in_total: false, limit_w: 12000 } },
  chuveiro: { id: 'chuveiro', type: 'meter', status: { in_total: true } },
  tomadas: { id: 'tomadas', type: 'meter', status: { in_total: true } },
  antigo: { id: 'antigo', type: 'meter', status: { watts: 0 } },   // medidor sem a marca (demo / firmware antigo)
};
const get = (id) => devices[id];

test('houseWatts: um medidor só = a leitura dele', () => {
  assert.equal(houseWatts(new Map([['antigo', { w: 850, t: now }]]), get, now), 850);
});

test('houseWatts: circuitos somam enquanto o total do quadro não reporta', () => {
  const latest = new Map([['chuveiro', { w: 7600, t: now }], ['tomadas', { w: 300, t: now - 1000 }]]);
  assert.equal(houseWatts(latest, get, now), 7900);
});

test('houseWatts: com o total do quadro, os circuitos não contam de novo', () => {
  const latest = new Map([
    ['chuveiro', { w: 7600, t: now }], ['tomadas', { w: 300, t: now }],
    ['total', { w: 7900, t: now }], ['antigo', { w: 100, t: now }],
  ]);
  assert.equal(houseWatts(latest, get, now), 8000);
});

test('houseWatts: leitura velha não conta (e o total velho não esconde os circuitos)', () => {
  const latest = new Map([
    ['total', { w: 7900, t: now - ENERGY_STALE_MS - 1 }],
    ['chuveiro', { w: 50, t: now }],
    ['tomadas', { w: NaN, t: now }],
  ]);
  assert.equal(houseWatts(latest, get, now), 50);
});

test('energyBands: padrão sem quadro; 85%/100% do limite; sem limite → sem alerta', () => {
  assert.deepEqual(energyBands([devices.antigo]), DEFAULT_BANDS);
  assert.deepEqual(energyBands(Object.values(devices)), { warning: 10200, critical: 12000 });
  assert.equal(energyBands([{ type: 'meter', status: { in_total: false, limit_w: 0 } }]), null);
});

test('energyBand', () => {
  assert.equal(energyBand(3500, DEFAULT_BANDS), 'warn');
  assert.equal(energyBand(5000, DEFAULT_BANDS), 'crit');
  assert.equal(energyBand(100, DEFAULT_BANDS), 'ok');
  assert.equal(energyBand(99999, null), 'ok');
});
