import test from 'node:test';
import assert from 'node:assert/strict';
import { splitBatch, MAX_BATCH } from '../supabase/functions/iot-gateway/batch.ts';

const now = Date.parse('2026-10-14T12:00:00Z');
const A = 'b2000000-0000-4000-8000-000000000001';
const B = 'b2000000-0000-4000-8000-000000000002';

test('splitBatch: telemetria e status separados; item só com status não grava histórico', () => {
  const { rows, statuses, errors } = splitBatch([
    { device_id: A, metric_type: 'energy_watts', value: 7600, status: { watts: 7600, on: true } },
    { device_id: B, status: { watts: 12, volts: 220.4 } },
  ], now);
  assert.deepEqual(errors, []);
  assert.deepEqual(rows, [{ device_id: A, metric_type: 'energy_watts', value: 7600 }]);
  assert.deepEqual(statuses, [
    { device_id: A, status: { watts: 7600, on: true } },
    { device_id: B, status: { watts: 12, volts: 220.4 } },
  ]);
});

test('splitBatch: itens inválidos viram erro sem derrubar o lote', () => {
  const { rows, statuses, errors } = splitBatch([
    { device_id: 'x', status: {} },
    { device_id: A, metric_type: 'volts', value: 1 },
    { device_id: A, metric_type: 'energy_watts', value: 'abc' },
    { device_id: A, metric_type: 'energy_watts' },
    { device_id: A },
    null,
    { device_id: B, metric_type: 'energy_watts', value: 0 },
  ], now);
  assert.equal(errors.length, 6);
  assert.deepEqual(errors.map((e) => e.index), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(rows, [{ device_id: B, metric_type: 'energy_watts', value: 0 }]);
  assert.deepEqual(statuses, []);
});

test('splitBatch: reenviada (fila offline) leva o horário e não mexe no status', () => {
  const { rows, statuses } = splitBatch([
    { device_id: A, metric_type: 'energy_watts', value: 50, ts: '2026-10-14T11:00:00Z', replayed: true, status: { watts: 50 } },
  ], now);
  assert.equal(rows[0].created_at, '2026-10-14T11:00:00.000Z');
  assert.deepEqual(statuses, []);
});

test('splitBatch: patches do mesmo aparelho são mesclados (o último vence)', () => {
  const { statuses } = splitBatch([
    { device_id: A, status: { on: true, watts: 1 } },
    { device_id: A, status: { watts: 2, trip: false } },
  ], now);
  assert.deepEqual(statuses, [{ device_id: A, status: { on: true, watts: 2, trip: false } }]);
});

test('splitBatch: lote que não é lista ou grande demais é recusado inteiro', () => {
  assert.equal(splitBatch({}, now).errors[0].index, -1);
  const big = Array.from({ length: MAX_BATCH + 1 }, () => ({ device_id: A, status: { on: true } }));
  assert.equal(splitBatch(big, now).errors[0].index, -1);
  assert.equal(splitBatch(big, now).statuses.length, 0);
});

test('parseAlerts: valida severidade e mensagem, limita a 10', async () => {
  const { parseAlerts } = await import('../supabase/functions/iot-gateway/batch.ts');
  assert.deepEqual(parseAlerts([
    { severity: 'critical', message: ' Chuveiro desarmado por sobrecarga ' },
    { severity: 'grave', message: 'x' },
    { severity: 'info', message: '' },
    null,
  ]), [{ severity: 'critical', message: 'Chuveiro desarmado por sobrecarga', source_module: 'eletrica' }]);
  assert.deepEqual(parseAlerts('nada'), []);
  assert.equal(parseAlerts(Array.from({ length: 20 }, () => ({ severity: 'info', message: 'a' }))).length, 10);
});
