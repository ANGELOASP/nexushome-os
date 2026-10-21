// Correções da auditoria (painéis e integrações): status parcial (027), válvula geral
// do botão de emergência e escape do canal da TV SmartThings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { patchDeviceStatus, isMissingPatchFn, _resetPatchWarning } from '../js/device-status.js';
import { mainWaterValve, WATER_TOTAL_ID } from '../js/energy.js';

/** client falso: registra rpc e update; `rpcResult` decide a resposta da 027. */
function fakeClient({ rpcResult, withRpc = true, updateError = null } = {}) {
  const calls = { rpc: [], update: [] };
  const client = {
    calls,
    from(table) {
      return {
        update(row) {
          return { eq: async (col, id) => { calls.update.push({ table, row, col, id }); return { error: updateError }; } };
        },
      };
    },
  };
  if (withRpc) client.rpc = async (fn, args) => { calls.rpc.push({ fn, args }); return rpcResult; };
  return client;
}

test('patchDeviceStatus: com a 027 manda só o patch e devolve o status do banco', async () => {
  _resetPatchWarning();
  const c = fakeClient({ rpcResult: { data: { on: true, watts: 120 }, error: null } });
  const r = await patchDeviceStatus(c, 'id-1', { on: true }, { merged: { on: true, watts: 0 }, notify: () => assert.fail('não deve avisar') });
  assert.deepEqual(c.calls.rpc, [{ fn: 'device_patch_status', args: { p_device: 'id-1', p_patch: { on: true } } }]);
  assert.equal(c.calls.update.length, 0);
  assert.deepEqual(r, { status: { on: true, watts: 120 }, error: null, fallback: false });
});

test('patchDeviceStatus: sem a função (PGRST202) cai no update mesclado e avisa uma vez', async () => {
  _resetPatchWarning();
  let avisos = 0;
  const notify = () => { avisos++; };
  const c = fakeClient({ rpcResult: { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.device_patch_status' } } });
  const merged = { on: false, brightness: 40 };
  const r1 = await patchDeviceStatus(c, 'id-2', { on: false }, { merged, notify });
  const r2 = await patchDeviceStatus(c, 'id-2', { on: true }, { merged: { on: true, brightness: 40 }, notify });
  assert.equal(avisos, 1);
  assert.deepEqual(c.calls.update[0], { table: 'devices', row: { status: merged }, col: 'id', id: 'id-2' });
  assert.equal(r1.fallback, true);
  assert.equal(r1.error, null);
  assert.equal(r2.fallback, true);
});

test('patchDeviceStatus: mock sem rpc grava o status mesclado sem avisar', async () => {
  _resetPatchWarning();
  const c = fakeClient({ withRpc: false });
  const r = await patchDeviceStatus(c, 'id-3', { open: false }, { merged: { open: false }, notify: () => assert.fail('demo não avisa') });
  assert.deepEqual(c.calls.update[0].row, { status: { open: false } });
  assert.equal(r.fallback, true);
});

test('patchDeviceStatus: outro erro da rpc não cai no caminho antigo', async () => {
  _resetPatchWarning();
  const err = { code: '22023', message: 'device_patch_status: p_patch precisa ser um objeto JSON' };
  const c = fakeClient({ rpcResult: { data: null, error: err } });
  const r = await patchDeviceStatus(c, 'id-4', { on: true }, { notify: () => assert.fail('não é migração ausente') });
  assert.equal(c.calls.update.length, 0);
  assert.equal(r.error, err);
});

test('isMissingPatchFn reconhece só "função inexistente"', () => {
  assert.equal(isMissingPatchFn({ code: '42883', message: 'function x does not exist' }), true);
  assert.equal(isMissingPatchFn({ code: '', message: 'function public.device_patch_status(uuid, jsonb) does not exist' }), true);
  assert.equal(isMissingPatchFn({ code: '22P02', message: 'invalid input syntax for type uuid: "st-1"' }), false);
  assert.equal(isMissingPatchFn(null), false);
});

test('mainWaterValve: a geral pelo id, nunca o gás nem um ramal', () => {
  const gas = { id: 'b3000000-0000-4000-8000-000000000033', name: 'Válvula de gás', type: 'valve' };
  const ramal = { id: 'b1000000-0000-4000-8000-000000000001', name: 'Água — Ramal 1 (Cozinha)', type: 'valve' };
  const geral = { id: WATER_TOTAL_ID, name: 'Válvula de Água Geral', type: 'valve' };
  assert.equal(mainWaterValve([gas, ramal, geral]), geral);
  // sem o id do projeto: pelo nome "geral"
  const outra = { id: 'x', name: 'Registro geral da casa', type: 'valve' };
  assert.equal(mainWaterValve([gas, ramal, outra]), outra);
  assert.equal(mainWaterValve([gas, ramal, { id: 'y', name: 'Gás geral', type: 'valve' }]), null);
  assert.equal(mainWaterValve([gas, ramal]), null);
  assert.equal(mainWaterValve(undefined), null);
});

test('SmartThings: canal da TV entra escapado no cartão', () => {
  const src = readFileSync(new URL('../js/panels/smartthings.js', import.meta.url), 'utf8');
  assert.match(src, /escapeHtml\(String\(st\.channel \?\? '—'\)\)/);
  assert.doesNotMatch(src, /\$\{st\.channel \?\?/);
});
