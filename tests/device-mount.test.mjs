import test from 'node:test';
import assert from 'node:assert/strict';
import { mountDevice, nearestWall, rotFacing } from '../js/device-mount.js';
import { CATALOG_BY_MODEL, catalogFor, DEVICE_TYPES } from '../js/device-catalog.js';

// parede horizontal em z = 0 (de x 0 a 4), espessura 0,15; janela no meio (x 1,5–2,5; peitoril 1,1; altura 1,0)
const wall = { id: 'w1', x1: 0, z1: 0, x2: 4, z2: 0, th: 0.15, height: 2.6 };
const openings = [
  { id: 'o1', wall_id: 'w1', kind: 'window', offset_m: 2, width: 1, sill: 1.1, height: 1.0 },
  { id: 'o2', wall_id: 'w1', kind: 'door', offset_m: 3.4, width: 0.8, sill: 0, height: 2.1, hinge: 'start' },
];
const ctx = { walls: [wall], openings, furniture: [{ id: 'f1', kind: 'painel_tv', x: 1, z: 3, rot: 180 }, { id: 'f2', kind: 'rack_tv', x: 3, z: 3, rot: 0 }] };

test('rotFacing: frente = (-sin, cos)', () => {
  assert.equal(rotFacing(0, 1), 0);
  assert.equal(rotFacing(0, -1), 180);
  assert.equal(rotFacing(-1, 0), 90);
});

test('nearestWall: lado do clique define a normal', () => {
  const h = nearestWall([wall], 1, 0.4);
  assert.equal(h.nz, 1);
  assert.equal(nearestWall([wall], 1, -0.4).nz, -1);
  assert.equal(nearestWall([wall], 1, 3), null);
});

test('split: na face da parede, virado para dentro e acima da janela', () => {
  const m = mountDevice(CATALOG_BY_MODEL.split, 2.2, 0.5, ctx);
  assert.equal(m.note, 'na parede, acima da janela');
  assert.equal(m.x, 2);                 // centralizado na janela
  assert.equal(m.z, 0.075);             // face da parede (th/2)
  assert.equal(m.rot, 0);               // virado para +z (o lado clicado)
  assert.ok(Math.abs(m.y - 2.22) < 1e-9);
});

test('split longe da janela fica na altura padrão; longe de parede avisa', () => {
  const m = mountDevice(CATALOG_BY_MODEL.split, 0.5, -0.3, ctx);
  assert.equal(m.note, 'na parede');
  assert.equal(m.rot, 180);
  assert.equal(m.y, 2.1);
  assert.equal(mountDevice(CATALOG_BY_MODEL.split, 2, 3, ctx).ok, false);
});

test('Smart TV: no painel e sobre o rack', () => {
  const p = mountDevice(CATALOG_BY_MODEL.smart_tv, 1.1, 3.1, ctx);
  assert.equal(p.note, 'fixada no painel');
  assert.equal(p.rot, 180);
  assert.equal(p.y, 0.85);
  const r = mountDevice(CATALOG_BY_MODEL.smart_tv, 3, 3, ctx);
  assert.match(r.note, /sobre rack/);
  assert.equal(r.y, 1.4);
});

test('fechadura: lado oposto à dobradiça; cortina: sobre a janela', () => {
  const l = mountDevice(CATALOG_BY_MODEL.lock, 3.4, 0.3, ctx);
  assert.equal(l.note, 'na porta, lado da maçaneta');
  assert.ok(Math.abs(l.x - 3.7) < 1e-9);
  const c = mountDevice(CATALOG_BY_MODEL.curtain, 2, 0.4, ctx);
  assert.equal(c.note, 'sobre a janela');
  assert.equal(c.x, 2);
  assert.ok(Math.abs(c.y - 2.15) < 1e-9);
});

test('catálogo: integrados e tipos', () => {
  assert.equal(catalogFor({ type: 'sensor', model: 'leak' }).model, 'leak');
  assert.equal(catalogFor({ type: 'tv' }).model, 'smart_tv');
  assert.equal(catalogFor({ type: 'ac', model: 'ac' }).model, 'split');
  ['tv', 'ac', 'light', 'valve', 'lock', 'curtain'].forEach((t) => assert.ok(DEVICE_TYPES.includes(t), t));
});
