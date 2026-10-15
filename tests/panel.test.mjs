import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, houseSummary, panelPatch, panelActions, validateCommand, toPanelDevice } from '../supabase/functions/iot-gateway/panel.ts';
import { actionPatch } from '../js/device-actions.js';

const dev = (id, type, room, status = {}, extra = {}) => ({ id: `b2000000-0000-4000-8000-0000000000${id}`, name: `${type} ${id}`, type, room, status, is_online: true, ...extra });

const devices = [
  dev('00', 'meter', 'Lavanderia', { in_total: false, watts: 4321.4 }),
  dev('01', 'meter', 'Banheiro 1', { in_total: true, watts: 4000, on: true }),
  dev('09', 'meter', 'Quarto Principal', { in_total: true, watts: 50 }),       // só medição: fica fora das telas
  dev('11', 'valve', 'Cozinha', { open: true, flow_lph: 120 }),
  dev('12', 'valve', 'Banheiro 1', { open: false, flow_lph: 30 }),
  dev('13', 'sensor', 'Área Externa', { level_pct: 72.6 }),
  dev('14', 'light', 'Cozinha', { on: true, brightness: 70 }),
  dev('15', 'ac', 'Quarto Principal', { on: false, temp: 23 }),
];

test('resumo da casa: total do quadro, vazão somada, nível e saúde', () => {
  const h = houseSummary(devices, []);
  assert.equal(h.watts, 4321);
  assert.equal(h.water_lph, 150);
  assert.equal(h.level_pct, 73);
  assert.equal(h.soc, null);
  assert.equal(h.health, 'safe');
  // sem total do quadro: soma os medidores
  assert.equal(houseSummary(devices.slice(1), []).watts, 4050);
  // alerta crítico aberto ou alarme em aparelho → crítico
  assert.equal(houseSummary(devices, [{ severity: 'warning', message: 'x', created_at: '' }]).health, 'warning');
  assert.equal(houseSummary([...devices, dev('16', 'valve', 'Laje', { alarm_burst: true })], []).health, 'critical');
  const nb = houseSummary([...devices, dev('17', 'solar', 'Sala Técnica', { soc: 81.4, grid_fail: true })], []);
  assert.equal(nb.soc, 81); assert.equal(nb.grid_ok, false); assert.equal(nb.health, 'critical');
});

test('snapshot: filtra cômodo, esconde medidor sem relé, chaves curtas', () => {
  const s = buildSnapshot(devices, [{ severity: 'critical', message: 'Vazamento', created_at: '2026-10-15T10:00:00Z' }], { now: new Date('2026-10-15T10:00:00Z') });
  assert.equal(s.v, 1);
  assert.ok(!s.devices.some((d) => d.id.endsWith('09')));
  assert.equal(s.devices.length, 6);
  assert.deepEqual(s.alerts, [{ sev: 'critical', msg: 'Vazamento', at: '2026-10-15T10:00:00Z' }]);
  assert.deepEqual(s.rooms, ['Área Externa', 'Banheiro 1', 'Cozinha', 'Lavanderia', 'Quarto Principal']);
  const coz = buildSnapshot(devices, [], { room: 'cozinha' });
  assert.deepEqual(coz.devices.map((d) => d.t), ['light', 'valve']);
  assert.equal(coz.house.watts, 4321);   // o resumo da casa vem sempre
  const luz = coz.devices[0];
  assert.deepEqual(luz, { id: devices[6].id, n: 'light 14', r: 'Cozinha', t: 'light', ok: true, on: true, bri: 70, act: ['power', 'brightness'] });
  assert.ok(JSON.stringify(buildSnapshot(devices, [])).length < 2000);
});

test('ações da tela: mesmo patch do app', () => {
  for (const [a, v] of [['power', 'true'], ['power', false], ['valve', true], ['open', 'false'], ['brightness', 40], ['armed', 'away']]) {
    assert.deepEqual(panelPatch(a, v), actionPatch(a, v), `${a}=${v}`);
  }
  assert.deepEqual(panelPatch('temp', 22), { temp: 22 });
  assert.equal(panelPatch('temp', 50), null);
  assert.deepEqual(panelPatch('brightness', 500), { brightness: 100 });
  assert.equal(panelPatch('armed', 'talvez'), null);
  assert.deepEqual(panelActions({ type: 'meter', status: { on: true } }), ['power']);
  assert.deepEqual(panelActions({ type: 'meter', status: {} }), []);
  assert.deepEqual(panelActions({ type: 'sensor', status: {} }), []);
});

test('comando: valida aparelho, ação e valor', () => {
  const luz = devices[6];
  assert.deepEqual(validateCommand({ device_id: luz.id, action: 'power', value: false }, luz), { patch: { on: false } });
  assert.equal(validateCommand({ device_id: 'x', action: 'power' }, luz).status, 400);
  assert.equal(validateCommand({ device_id: luz.id, action: 'power' }, null).status, 404);
  assert.equal(validateCommand({ device_id: luz.id, action: 'valve', value: true }, luz).status, 422);
  assert.equal(validateCommand({ device_id: devices[2].id, action: 'power', value: true }, devices[2]).status, 422);
  assert.equal(validateCommand(null, luz).status, 400);
});

test('válvula travada e circuito desarmado aparecem como bloqueados', () => {
  assert.equal(toPanelDevice(dev('20', 'valve', 'Laje', { open: false, alarm_burst: true })).lock, true);
  assert.equal(toPanelDevice(dev('21', 'meter', 'Oficina', { on: false, trip: true })).alarm, true);
});
