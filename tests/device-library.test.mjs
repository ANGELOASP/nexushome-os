import test from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_CATALOG, CATALOG_BY_MODEL, DEVICE_TYPES, LEGACY_TYPES, TYPE_LABELS, catalogFor, defaultStatus } from '../js/device-catalog.js';
import { FURNITURE_BY_KIND } from '../js/furniture.js';
import { mountDevice } from '../js/device-mount.js';
import { actionsFor, actionPatch, actionChoices, describeAction, isActive, isSwitchable, togglePatch } from '../js/device-actions.js';
import { PIN_STYLE, deviceActive } from '../js/device-pins.js';
import { cleanPatch, captureActions, sceneMatches, normalizeScene } from '../js/scenes.js';

const MOUNTS = new Set(['wall', 'ceiling', 'floor', 'furniture', 'window', 'door']);
const NEW_TYPES = ['audio', 'projector', 'media', 'computer', 'tablet', 'network', 'appliance', 'vacuum', 'alarm', 'gate'];

test('catálogo: modelos únicos, campos válidos e móveis que existem', () => {
  assert.equal(new Set(DEVICE_CATALOG.map((c) => c.model)).size, DEVICE_CATALOG.length);
  assert.ok(DEVICE_CATALOG.length >= 90, `só ${DEVICE_CATALOG.length} modelos`);
  for (const c of DEVICE_CATALOG) {
    assert.ok(c.label && c.group, c.model);
    assert.ok(MOUNTS.has(c.mount), `${c.model}: fixação ${c.mount}`);
    assert.ok(Number.isFinite(c.y), `${c.model}: altura`);
    assert.ok(TYPE_LABELS[c.type], `${c.model}: tipo sem nome (${c.type})`);
    assert.ok(PIN_STYLE[c.type], `${c.model}: tipo sem cor de marcador (${c.type})`);
    if (c.mount === 'furniture') {
      assert.ok(c.furniture?.length, `${c.model}: sem móveis`);
      c.furniture.forEach((k) => assert.ok(FURNITURE_BY_KIND[k], `${c.model}: móvel inexistente ${k}`));
    }
  }
});

test('catálogo: tipos novos, computadores, tablets, áudio e vídeo presentes', () => {
  NEW_TYPES.forEach((t) => assert.ok(DEVICE_TYPES.includes(t), t));
  NEW_TYPES.forEach((t) => assert.ok(!LEGACY_TYPES.includes(t), t));
  ['desktop_pc', 'notebook', 'monitor', 'tablet', 'phone', 'router', 'soundbar', 'av_receiver', 'ceiling_speaker',
    'subwoofer', 'projector', 'projection_screen', 'console', 'media_player', 'fridge', 'robot_vacuum', 'alarm_panel',
    'smoke', 'gate', 'garage_door', 'ev_charger'].forEach((m) => assert.ok(CATALOG_BY_MODEL[m], m));
  assert.equal(catalogFor({ type: 'audio' }).model, 'soundbar');
  assert.equal(catalogFor({ type: 'hub', model: 'soundbar' }).model, 'soundbar');   // gravado como hub sem a 024
});

test('estado inicial por tipo', () => {
  assert.deepEqual(defaultStatus('valve'), { open: true });
  assert.equal(defaultStatus('audio').volume, 30);
  assert.equal(defaultStatus('alarm').armed, 'off');
  assert.equal(defaultStatus('gate').open, false);
  assert.deepEqual(defaultStatus('sensor'), {});
});

// cozinha: geladeira desenhada como móvel (frente para +z) e bancada
const ctx = {
  walls: [{ id: 'w', x1: 0, z1: 0, x2: 6, z2: 0, th: 0.15, height: 2.6 }],
  openings: [],
  furniture: [{ id: 'g', kind: 'geladeira', x: 1, z: 1, rot: 0 }, { id: 'b', kind: 'bancada', x: 4, z: 1, rot: 0 }],
};

test('fixação: geladeira smart vira painel na frente do móvel; sem móvel fica no piso', () => {
  const m = mountDevice(CATALOG_BY_MODEL.fridge, 1.1, 1.2, ctx);
  assert.match(m.note, /painel na frente de geladeira/);
  assert.equal(m.z, 1.35);                    // frente do móvel (d = 0,7)
  assert.ok(m.y > 1.5);
  assert.equal(m.rot, 0);
  const floor = mountDevice(CATALOG_BY_MODEL.fridge, 3, 4, ctx);
  assert.equal(floor.note, 'no piso');
  assert.equal(floor.y, 0);
  assert.ok(floor.ok);
});

test('fixação: cafeteira sobre a bancada, soundbar sem móvel avisa, caixa de teto no teto', () => {
  const c = mountDevice(CATALOG_BY_MODEL.coffee, 4.1, 1.1, ctx);
  assert.match(c.note, /sobre bancada/);
  assert.equal(c.y, 0.9);
  assert.equal(mountDevice(CATALOG_BY_MODEL.soundbar, 3, 4, ctx).ok, false);
  assert.equal(mountDevice(CATALOG_BY_MODEL.ceiling_speaker, 3, 4, ctx).note, 'no teto');
});

test('ações por tipo e patch igual ao do servidor', () => {
  assert.deepEqual(actionsFor({ type: 'audio' }).map((a) => a.v), ['power', 'volume', 'source']);
  assert.deepEqual(actionsFor({ type: 'gate' }).map((a) => a.v), ['open']);
  assert.deepEqual(actionsFor({ type: 'meter', status: { on: true } }).map((a) => a.v), ['power']);
  assert.deepEqual(actionsFor({ type: 'sensor' }), []);
  assert.deepEqual(actionPatch('volume', 150), { volume: 100 });
  assert.deepEqual(actionPatch('armed', 'away'), { armed: 'away' });
  assert.equal(actionPatch('armed', 'talvez'), null);
  assert.deepEqual(actionPatch('vacuum', 'cleaning'), { state: 'cleaning' });
  assert.deepEqual(actionPatch('power', 'false'), { on: false });
  assert.ok(actionChoices('source', { type: 'projector' }).some(([v]) => v === 'HDMI 1'));
  assert.equal(describeAction('Alarme', 'armed', 'home'), 'armar Alarme (em casa)');
});

test('ativo, alternar e marcadores', () => {
  assert.equal(isActive({ type: 'gate', status: {} }), false);
  assert.deepEqual(togglePatch({ type: 'gate', status: { open: false } }), { open: true });
  assert.deepEqual(togglePatch({ type: 'audio', status: { on: true } }), { on: false });
  assert.ok(isSwitchable({ type: 'projector' }));
  assert.ok(!isSwitchable({ type: 'sensor' }));
  assert.equal(deviceActive({ type: 'alarm', status: { armed: 'away' } }), true);
  assert.equal(deviceActive({ type: 'vacuum', status: { state: 'docked' } }), false);
});

test('cenas: áudio, projetor, portão e alarme', () => {
  assert.deepEqual(cleanPatch('audio', { on: 1, volume: 250, source: 'Bluetooth', temp: 20 }), { on: true, volume: 100, source: 'Bluetooth' });
  assert.deepEqual(cleanPatch('alarm', { armed: 'talvez' }), {});
  const devs = [
    { id: 'g', type: 'gate', status: {} },
    { id: 'p', type: 'projector', status: { on: true, source: 'HDMI 2' } },
    { id: 'z', type: 'alarm', status: { armed: 'off' } },
  ];
  const acts = captureActions(devs, ['g', 'p', 'z']);
  assert.deepEqual(acts.find((a) => a.device_id === 'g').patch, { open: false });
  assert.deepEqual(acts.find((a) => a.device_id === 'p').patch, { on: true, source: 'HDMI 2' });
  assert.deepEqual(acts.find((a) => a.device_id === 'z').patch, { armed: 'off' });
  const cinema = normalizeScene({ name: 'Cinema', actions: [{ device_id: 'p', patch: { on: true, source: 'HDMI 2' } }, { device_id: 'g', patch: { open: false } }] });
  assert.ok(sceneMatches(cinema, devs));
});
