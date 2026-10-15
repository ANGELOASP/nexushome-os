import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FIXTURE_TYPES, SWITCH_KINDS, QUADRO_POINTS, quadroPoint, controlModeFor, normalizeLighting, circuitFixtures,
  ensureLighting, syncPrimary, lightingWarnings, lightingSummary, commandLetter, wiringSegments, lightingPointAt,
} from '../js/lighting.js';

const L03 = 'b3000000-0000-4000-8000-000000000003';

test('catálogo: luminárias da biblioteca e pontos de comando com símbolo', () => {
  assert.ok(FIXTURE_TYPES.some((c) => c.model === 'spot') && FIXTURE_TYPES.every((c) => c.type === 'light'));
  assert.deepEqual(SWITCH_KINDS.map((s) => s.sym), ['S', 'S3w', 'S4w', 'P', 'Sd', 'SP']);
});

test('pontos do quadro L01–L10: relé 90 canais 1–8, relé 91 canais 1–2', () => {
  assert.equal(QUADRO_POINTS.length, 10);
  assert.deepEqual(quadroPoint(L03), { id: L03, ponto: 'L03', rele: 90, canal: 3, kr: 'KR3' });
  assert.equal(quadroPoint('b3000000-0000-4000-8000-000000000010').rele, 91);
  assert.equal(quadroPoint('b3000000-0000-4000-8000-000000000010').canal, 2);
  assert.equal(quadroPoint('x'), null);
});

test('modo de acionamento: gravado, senão quadro para L01–L10 com hw, senão inteligente', () => {
  assert.equal(controlModeFor({ id: L03, hw: 'esp32-seguranca' }), 'quadro');
  assert.equal(controlModeFor({ id: L03 }), 'inteligente');
  assert.equal(controlModeFor({ id: 'n1', lighting: { control: { mode: 'parede' } } }), 'parede');
  assert.equal(controlModeFor({ id: 'n1', lighting: { control: { mode: 'xyz' } } }), 'inteligente');
});

test('normalizeLighting descarta pontos sem coordenada e tipos desconhecidos', () => {
  const l = normalizeLighting({
    fixtures: [{ model: 'spot', x: '1.23456', z: 2, floor: 0 }, { model: 'geladeira', x: 1, z: 1 }, { model: 'spot', x: null, z: 1 }],
    switches: [{ kind: 'paralelo', x: 0, z: 0, rot: -90 }, { kind: 'xx', x: 0, z: 0 }],
    control: { mode: 'parede' },
  });
  assert.deepEqual(l.fixtures, [{ model: 'spot', x: 1.235, z: 2, floor: 0, y: null, rot: null }]);
  assert.deepEqual(l.switches.map((s) => [s.kind, s.rot]), [['paralelo', 270]]);
  assert.equal(l.control.mode, 'parede');
});

test('circuito antigo (sem lighting): a posição do dispositivo é a única luminária', () => {
  const d = { id: 'x', type: 'light', model: 'pendant', pos_x: 1, pos_z: 2, pos_floor: 0, pos_y: 2.5, pos_rot: null };
  assert.deepEqual(circuitFixtures(d), [{ model: 'pendant', x: 1, z: 2, floor: 0, y: 2.5, rot: null }]);
  assert.deepEqual(circuitFixtures({ ...d, model: 'split' })[0].model, 'plafon');
  assert.deepEqual(circuitFixtures({ id: 'y' }), []);
  // ensureLighting cria o campo a partir da posição; syncPrimary devolve a 1ª luminária ao dispositivo
  ensureLighting(d);
  d.lighting.fixtures.unshift({ model: 'spot', x: 3, z: 4, floor: 1, y: 2.5, rot: null });
  syncPrimary(d);
  assert.deepEqual([d.pos_x, d.pos_z, d.pos_floor, d.model], [3, 4, 1, 'spot']);
  d.lighting.fixtures = [];
  syncPrimary(d);
  assert.equal(d.pos_x, null);
});

test('avisos de ligação: three-way com relé, paralelo sem par, circuito sem comando', () => {
  const quadro = (switches) => ({ id: L03, hw: 'esp32-seguranca', lighting: { fixtures: [{ model: 'spot', x: 0, z: 0 }], switches, control: { mode: 'quadro' } } });
  assert.deepEqual(lightingWarnings(quadro([{ kind: 'paralelo', x: 1, z: 0 }, { kind: 'intermediario', x: 2, z: 0 }])), []);
  assert.match(lightingWarnings(quadro([{ kind: 'simples', x: 1, z: 0 }])).join(), /paralelo \(three-way\), não simples/);
  assert.match(lightingWarnings(quadro([{ kind: 'paralelo', x: 1, z: 0 }, { kind: 'paralelo', x: 2, z: 0 }])).join(), /1 paralelo na parede/);
  assert.match(lightingWarnings({ id: 'novo', lighting: { fixtures: [{ model: 'spot', x: 0, z: 0 }], switches: [], control: { mode: 'quadro' } } }).join(), /L01–L10/);
  const parede = (switches) => ({ id: 'n', lighting: { fixtures: [{ model: 'plafon', x: 0, z: 0 }], switches, control: { mode: 'parede' } } });
  assert.match(lightingWarnings(parede([])).join(), /não tem como acender/);
  assert.match(lightingWarnings(parede([{ kind: 'paralelo', x: 1, z: 0 }])).join(), /segundo paralelo/);
  assert.deepEqual(lightingWarnings(parede([{ kind: 'paralelo', x: 1, z: 0 }, { kind: 'paralelo', x: 5, z: 0 }])), []);
  assert.match(lightingWarnings({ id: 'n', lighting: { fixtures: [], switches: [], control: { mode: 'inteligente' } } }).join(), /Nenhuma luminária/);
});

test('resumo, letra de comando e traçado da fiação', () => {
  const d = { id: L03, hw: 'esp32-seguranca', room: 'Cozinha', type: 'light', name: 'Luz — Cozinha', lighting: {
    fixtures: [{ model: 'spot', x: 0, z: 0 }, { model: 'spot', x: 2, z: 0 }, { model: 'spot', x: 1, z: 0 }],
    switches: [{ kind: 'paralelo', x: 2.2, z: 1 }], control: { mode: 'quadro' } } };
  assert.equal(lightingSummary(d), '3 luminárias (spot) · 1 ponto de comando · Quadro L03 (relé 90/3)');
  const devs = [d, { id: 'z', type: 'light', room: 'Cozinha', name: 'Luz — Bancada' }, { id: 'q', type: 'light', room: 'Sala', name: 'A' }];
  assert.equal(commandLetter(devs, d), 'b');
  assert.equal(commandLetter(devs, devs[1]), 'a');
  const seg = wiringSegments(d, 0);
  // cadeia pelo vizinho mais próximo: 0 → 1 → 2, e o comando liga na luminária mais próxima (x=2)
  assert.deepEqual(seg.filter((s) => s.kind === 'luz').map((s) => [s.x1, s.x2]), [[0, 1], [1, 2]]);
  assert.deepEqual(seg.filter((s) => s.kind === 'comando').map((s) => [s.x1, s.z1, s.x2]), [[2.2, 1, 2]]);
  assert.deepEqual(wiringSegments(d, 1), []);
  assert.deepEqual(lightingPointAt(d, 1.05, 0.02), { kind: 'fixture', index: 2 });
  assert.deepEqual(lightingPointAt(d, 2.2, 0.95), { kind: 'switch', index: 0 });
  assert.equal(lightingPointAt(d, 5, 5), null);
});
