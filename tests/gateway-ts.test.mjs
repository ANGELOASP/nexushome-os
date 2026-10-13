import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReadingTs } from '../supabase/functions/iot-gateway/ts.ts';

const now = Date.parse('2026-10-13T12:00:00Z');

test('parseReadingTs: ISO, epoch s e ms', () => {
  assert.equal(parseReadingTs('2026-10-13T11:30:00Z', now), '2026-10-13T11:30:00.000Z');
  assert.equal(parseReadingTs(now / 1000 - 60, now), '2026-10-13T11:59:00.000Z');
  assert.equal(parseReadingTs(String(now - 1000), now), '2026-10-13T11:59:59.000Z');
});

test('parseReadingTs: ausente, inválido ou fora da janela → null', () => {
  assert.equal(parseReadingTs(undefined, now), null);
  assert.equal(parseReadingTs('ontem', now), null);
  assert.equal(parseReadingTs('2026-10-13T12:10:00Z', now), null);   // 10 min no futuro
  assert.equal(parseReadingTs('2026-09-01T00:00:00Z', now), null);   // > 7 dias
  assert.equal(parseReadingTs({}, now), null);
});
