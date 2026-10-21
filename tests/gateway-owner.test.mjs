import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ownerFromCandidates, resolveOwner, alertRowsFor, deviceIdRejected, withoutDeviceId,
  rpcMissing, parseDeviceFilter, inCandidateOrder, OWNER_CACHE_MS,
} from '../supabase/functions/iot-gateway/owner.ts';
import { parseAlerts } from '../supabase/functions/iot-gateway/batch.ts';
import { validateCommand, toPanelDevice, deviceLocked } from '../supabase/functions/iot-gateway/panel.ts';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const D = 'b2000000-0000-4000-8000-000000000001';

test('C2: IOT_OWNER_ID manda e não consulta o banco', async () => {
  let calls = 0;
  const r = await resolveOwner(` ${A.toUpperCase()} `, async () => { calls++; return [B]; }, 0, { value: null, at: 0 });
  assert.deepEqual(r, { owner: A, source: 'env' });
  assert.equal(calls, 0);
  const bad = await resolveOwner('nao-e-uuid', async () => [A], 0, { value: null, at: 0 });
  assert.equal(bad.owner, null);
  assert.match(bad.reason, /uuid/);
});

test('C2: sem o secret, só uma conta com aparelhos vira o dono; 0 ou 2+ → indefinido', () => {
  assert.deepEqual(ownerFromCandidates([A]), { owner: A, source: 'devices' });
  assert.deepEqual(ownerFromCandidates([A, A]), { owner: A, source: 'devices' });
  assert.equal(ownerFromCandidates([]).owner, null);
  assert.equal(ownerFromCandidates([A, B]).owner, null);
  assert.match(ownerFromCandidates([A, B]).reason, /mais de uma/);
  assert.equal(ownerFromCandidates([null, 'x']).owner, null);
});

test('C2: fallback usa cache curto; falha do lookup não entra no cache', async () => {
  const cache = { value: null, at: 0 };
  let calls = 0;
  const lookup = async () => { calls++; return [A]; };
  assert.equal((await resolveOwner(undefined, lookup, 1000, cache)).owner, A);
  assert.equal((await resolveOwner('', lookup, 1000 + OWNER_CACHE_MS - 1, cache)).owner, A);
  assert.equal(calls, 1);
  await resolveOwner(undefined, lookup, 1000 + OWNER_CACHE_MS, cache);
  assert.equal(calls, 2);
  const c2 = { value: null, at: 0 };
  const failed = await resolveOwner(undefined, async () => { throw new Error('rede'); }, 0, c2);
  assert.equal(failed.owner, null);
  assert.equal(c2.value, null);
});

test('C3: alertas do lote levam owner_id e device_id (quando válido)', () => {
  const parsed = parseAlerts([
    { severity: 'critical', message: 'Disjuntor 3 desarmou', device_id: D },
    { severity: 'warning', message: 'Sem id' },
    { severity: 'info', message: 'id ruim', device_id: '123' },
  ], 'eletrica');
  assert.equal(parsed[0].device_id, D);
  assert.equal('device_id' in parsed[1], false);
  assert.equal('device_id' in parsed[2], false);
  const rows = alertRowsFor(parsed, A);
  assert.deepEqual(rows[0], { severity: 'critical', message: 'Disjuntor 3 desarmou', source_module: 'eletrica', owner_id: A, device_id: D });
  assert.equal(rows[1].owner_id, A);
  // sem dono resolvido: grava como antes (o gatilho da 018 decide)
  assert.equal('owner_id' in alertRowsFor(parsed, null)[0], false);
  assert.equal('device_id' in withoutDeviceId(rows)[0], false);
  assert.equal(withoutDeviceId(rows)[0].owner_id, A);
});

test('C3: detecta recusa do device_id (sem a 027 / aparelho inexistente)', () => {
  assert.equal(deviceIdRejected({ code: '42703', message: 'column "device_id" does not exist' }), true);
  assert.equal(deviceIdRejected({ code: 'PGRST204', message: "Could not find the 'device_id' column" }), true);
  assert.equal(deviceIdRejected({ code: '23503', message: 'violates foreign key' }), true);
  assert.equal(deviceIdRejected({ code: 'XX', message: 'algo com device_id' }), true);
  assert.equal(deviceIdRejected({ code: '23514', message: 'check' }), false);
  assert.equal(deviceIdRejected(null), false);
});

test('B5: fallback quando device_patch_status (027) não existe', () => {
  assert.equal(rpcMissing({ code: 'PGRST202' }), true);
  assert.equal(rpcMissing({ code: '42883' }), true);
  assert.equal(rpcMissing({ code: '42501', message: 'permission denied' }), false);
  assert.equal(rpcMissing(null), false);
});

test('C4: ?devices= presente mas vazio/inválido → nenhum comando (não "todos")', () => {
  assert.deepEqual(parseDeviceFilter(null), { ids: [], none: false });
  assert.deepEqual(parseDeviceFilter(''), { ids: [], none: true });
  assert.deepEqual(parseDeviceFilter(',, ,'), { ids: [], none: true });
  assert.deepEqual(parseDeviceFilter('------------------------------------'), { ids: [], none: true });
  assert.deepEqual(parseDeviceFilter(`${D}, lixo,${D}`), { ids: [D], none: false });
});

test('C5: entrega só o que o UPDATE marcou, na ordem dos candidatos', () => {
  const cands = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.deepEqual(inCandidateOrder(cands, [{ id: 3, c: 'z' }, { id: 1, c: 'x' }]), [{ id: 1, c: 'x' }, { id: 3, c: 'z' }]);
  assert.deepEqual(inCandidateOrder(cands, []), []);
});

const circuit = (status) => ({ id: D, name: 'Chuveiro', type: 'meter', room: 'Banheiro', status, is_online: true });

test('C7: circuito desarmado por sobrecarga não religa pela parede (409)', () => {
  const v = validateCommand({ device_id: D, action: 'power', value: true }, circuit({ on: false, trip: true }));
  assert.equal(v.status, 409);
  assert.match(v.error, /sobrecarga/);
  // desligar continua permitido
  assert.deepEqual(validateCommand({ device_id: D, action: 'power', value: false }, circuit({ on: false, trip: true })), { patch: { on: false } });
  // sem trip religa normalmente
  assert.deepEqual(validateCommand({ device_id: D, action: 'power', value: true }, circuit({ on: false })), { patch: { on: true } });
});

test('C7: válvula travada por rompimento/pânico não reabre pela parede', () => {
  const valve = (status) => ({ id: D, name: 'Geral', type: 'valve', room: 'Laje', status, is_online: true });
  const v = validateCommand({ device_id: D, action: 'valve', value: true }, valve({ open: false, alarm_burst: true }));
  assert.equal(v.status, 409);
  assert.equal(validateCommand({ device_id: D, action: 'valve', value: true }, valve({ open: false, panic: true })).status, 409);
  assert.deepEqual(validateCommand({ device_id: D, action: 'valve', value: false }, valve({ open: true, panic: true })), { patch: { open: false } });
  // o "lock" da tela usa a mesma regra
  assert.equal(toPanelDevice(circuit({ on: false, trip: true })).lock, true);
  assert.equal(deviceLocked({ trip: false }), false);
});
