import test from 'node:test';
import assert from 'node:assert/strict';
import { mountDevice } from '../js/device-mount.js';
import { CATALOG_BY_MODEL } from '../js/device-catalog.js';

// Clique além da ponta da parede (porta/janela junto ao canto): antes lançava TypeError
// ("reading 'th'" / "reading 'wl'") porque nearestWall exige t em [0, len].
const wall = { id: 'w1', x1: 0, z1: 0, x2: 4, z2: 0, th: 0.15, height: 2.6 };
const openings = [
  { id: 'd1', wall_id: 'w1', kind: 'door', offset_m: 0.9, width: 0.8, sill: 0, height: 2.1, hinge: 'start' },   // porta a 0,5 m do início
  { id: 'j1', wall_id: 'w1', kind: 'window', offset_m: 3.4, width: 0.8, sill: 1.1, height: 1.0 },               // janela no fim
];
const ctx = { walls: [wall], openings, furniture: [] };

test('fechadura e sensor de porta: clique antes do início da parede', () => {
  for (const model of ['lock', 'door_sensor']) {
    const m = mountDevice(CATALOG_BY_MODEL[model], -0.2, 0.3, ctx);
    assert.equal(m.ok, true, model);
    assert.ok(Number.isFinite(m.x) && Number.isFinite(m.z), model);
    assert.equal(m.z, 0.075, model);        // face da parede do lado clicado (+z)
    assert.equal(m.rot, 0, model);
  }
  const lock = mountDevice(CATALOG_BY_MODEL.lock, -0.2, -0.3, ctx);
  assert.equal(lock.z, -0.075);             // outro lado
  assert.equal(lock.rot, 180);
  assert.ok(Math.abs(lock.x - 1.2) < 1e-9); // dobradiça no início → maçaneta em b - 0,1
});

test('cortina: clique além do fim da parede', () => {
  const c = mountDevice(CATALOG_BY_MODEL.curtain, 4.3, 0.4, ctx);
  assert.equal(c.ok, true);
  assert.equal(c.note, 'sobre a janela');
  assert.equal(c.x, 3.4);
  assert.equal(c.z, 0.075);
  assert.equal(c.rot, 0);
});

test('parede de comprimento zero não lança', () => {
  const w0 = { id: 'w0', x1: 1, z1: 1, x2: 1, z2: 1, th: 0.15, height: 2.6 };
  assert.doesNotThrow(() => mountDevice(CATALOG_BY_MODEL.lock, 1, 1, { walls: [w0], openings: [{ id: 'x', wall_id: 'w0', kind: 'door', offset_m: 0, width: 0.8 }] }));
});
