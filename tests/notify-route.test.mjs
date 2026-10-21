import test from 'node:test';
import assert from 'node:assert/strict';
import { routeAlert, pushSubscriptionsQuery } from '../supabase/functions/notify-alert/route.ts';

const P = 'aaaaaaaa-0000-4000-8000-000000000001';  // principal (IOT_OWNER_ID)
const X = 'cccccccc-0000-4000-8000-000000000003';  // outra conta

test('C1: alerta do principal → push dele + Telegram', () => {
  const r = routeAlert(P, P);
  assert.equal(r.pushUserId, P);
  assert.equal(r.pushAll, false);
  assert.equal(r.telegram, true);
  assert.deepEqual(r.warnings, []);
});

test('C1: alerta de outra conta → push só dela, sem Telegram', () => {
  const r = routeAlert(X, P);
  assert.equal(r.pushUserId, X);
  assert.equal(r.telegram, false);
  assert.equal(pushSubscriptionsQuery(r), `push_subscriptions?select=endpoint,p256dh,auth&user_id=eq.${X}`);
});

test('C1: alerta sem dono → push do principal + Telegram', () => {
  const r = routeAlert(null, P);
  assert.equal(r.pushUserId, P);
  assert.equal(r.telegram, true);
});

test('C1: sem principal → comportamento antigo com aviso', () => {
  const sem = routeAlert(null, undefined);
  assert.equal(sem.pushAll, true);
  assert.equal(sem.telegram, true);
  assert.equal(pushSubscriptionsQuery(sem), 'push_subscriptions?select=endpoint,p256dh,auth');
  assert.ok(sem.warnings.length >= 2);
  // alerta com dono, sem principal: push só do dono; Telegram como antes (com aviso)
  const comDono = routeAlert(X, '');
  assert.equal(comDono.pushUserId, X);
  assert.equal(comDono.telegram, true);
  assert.ok(comDono.warnings.some((w) => /Telegram/.test(w)));
});

test('C1: principal inválido é ignorado (com aviso); owner_id inválido conta como sem dono', () => {
  const r = routeAlert(X, 'nao-uuid');
  assert.equal(r.pushUserId, X);
  assert.equal(r.telegram, true);
  assert.ok(r.warnings.some((w) => /uuid/.test(w)));
  assert.equal(routeAlert('lixo', P).pushUserId, P);
});
