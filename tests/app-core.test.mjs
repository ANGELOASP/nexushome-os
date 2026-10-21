// Núcleo do app (auditoria, fase 7): logout limpa o estado, mock fiel ao Supabase,
// chave VAPID do build e config.js fora do build de produção.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { state, on, resetState } from '../js/state.js';
import { MockSupabaseClient } from '../js/supabase-client.js';
import { resolveVapidKey } from '../js/pwa.js';
import { stripLocalConfig } from '../vite.config.js';

const memStorage = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};

test('resetState zera os dados do usuário e avisa os ouvintes', () => {
  state.devices = [{ id: 'a' }];
  state.alerts = [{ id: 'x' }];
  state.automations = [{ id: 'r' }];
  state.scenes = [{ id: 's' }];
  state.rooms = [{ id: 'c', name: 'Sala' }];
  state.walls = [{ id: 'w' }];
  state.openings = [{ id: 'o' }];
  state.furniture = [{ id: 'f' }];
  state.devicePins = { 'st-1': { pos_x: 1 } };
  state.selectedRoom = 'Sala';
  state.lastTelemetry.energy_watts = 1234;
  state.stReadings = { d: { temperature: 20 } };
  const seen = [];
  const offs = ['devices-changed', 'alerts-changed', 'automations-changed', 'scenes-changed', 'rooms-changed', 'walls-changed', 'openings-changed', 'furniture-changed']
    .map((ev) => on(ev, (p) => seen.push([ev, p.length])));
  resetState();
  offs.forEach((off) => off());
  for (const k of ['devices', 'alerts', 'automations', 'scenes', 'rooms', 'walls', 'openings', 'furniture']) assert.deepEqual(state[k], [], k);
  assert.deepEqual(state.devicePins, {});
  assert.deepEqual(state.stReadings, {});
  assert.equal(state.selectedRoom, null);
  assert.equal(state.lastTelemetry.energy_watts, 0);
  assert.equal(seen.length, 8);
  assert.ok(seen.every(([, n]) => n === 0));
});

test('mock realtime respeita o tipo de evento (UPDATE não cai no ouvinte de INSERT)', async () => {
  const c = new MockSupabaseClient();
  const inserts = [];
  const all = [];
  c.channel('alerts-feed').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'alerts' }, (p) => inserts.push(p.eventType)).subscribe();
  c.channel('alerts-all').on('postgres_changes', { event: '*', schema: 'public', table: 'alerts' }, (p) => all.push(p.eventType)).subscribe();
  const { data } = await c.from('alerts').insert({ severity: 'critical', message: 'Vazamento', resolved: false });
  await c.from('alerts').update({ resolved: true }).eq('id', data[0].id);
  await c.from('alerts').delete().eq('id', data[0].id);
  assert.deepEqual(inserts, ['INSERT']);
  assert.deepEqual(all, ['INSERT', 'UPDATE', 'DELETE']);
});

test('mock: update de jsonb substitui a coluna (como o Postgres)', async () => {
  const c = new MockSupabaseClient();
  const { data } = await c.from('devices').insert({ name: 'Luz', type: 'light', status: { on: true, brightness: 80 } });
  const id = data[0].id;
  await c.from('devices').update({ status: { on: false } }).eq('id', id);
  const { data: rows } = await c.from('devices').select('*').eq('id', id);
  assert.deepEqual(rows[0].status, { on: false });
});

test('mock: update/delete sem filtro falham como no PostgREST; com filtro funcionam', async () => {
  const c = new MockSupabaseClient();
  const before = (await c.from('devices').select('*')).data.length;
  assert.ok(before > 0);
  const del = await c.from('devices').delete();
  assert.ok(del.error && /WHERE/.test(del.error.message));
  const upd = await c.from('devices').update({ room: 'X' });
  assert.ok(upd.error);
  assert.equal((await c.from('devices').select('*')).data.length, before);
  const none = await c.from('devices').delete().in('id', []);
  assert.equal(none.error, null);
  assert.equal(none.data.length, 0);
  const one = (await c.from('devices').select('*')).data[0];
  const ok = await c.from('devices').delete().eq('id', one.id);
  assert.equal(ok.error, null);
  assert.equal((await c.from('devices').select('*')).data.length, before - 1);
});

test('chave VAPID: localStorage → config.js → variável do build', () => {
  assert.equal(resolveVapidKey({ storage: memStorage(), cfg: {}, env: { VITE_VAPID_PUBLIC_KEY: ' BEnv ' } }), 'BEnv');
  assert.equal(resolveVapidKey({ storage: memStorage(), cfg: { VAPID_PUBLIC_KEY: 'BCfg' }, env: { VITE_VAPID_PUBLIC_KEY: 'BEnv' } }), 'BCfg');
  assert.equal(resolveVapidKey({ storage: memStorage({ nh_vapid_public_key: 'BLocal' }), cfg: { VAPID_PUBLIC_KEY: 'BCfg' }, env: { VITE_VAPID_PUBLIC_KEY: 'BEnv' } }), 'BLocal');
  assert.equal(resolveVapidKey({ storage: { getItem() { throw new Error('bloqueado'); } }, env: {} }), '');
  assert.equal(resolveVapidKey(), '');
});

test('build de produção tira a tag do js/config.js e mantém o resto', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<script src="js\/config\.js"><\/script>/);   // o dev continua lendo o config local
  const out = stripLocalConfig(html);
  assert.doesNotMatch(out, /js\/config\.js/);
  assert.doesNotMatch(out, /config\.example\.js/);
  assert.match(out, /supabase-js@\d+\.\d+\.\d+\//);
  assert.match(out, /three\.min\.js/);
  assert.match(out, /<script type="module" src="js\/app\.js"><\/script>/);
});

test('CDNs do index.html com versão exata e SRI onde o CDN manda CORS', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script src="(https:[^"]+)"([^>]*)>/g)].map((m) => ({ src: m[1], attrs: m[2] }));
  assert.ok(scripts.length >= 4);
  for (const s of scripts) {
    assert.doesNotMatch(s.src, /@\d+(\/|$)|@latest|cdn\.tailwindcss\.com\/?$/, `versão flutuante: ${s.src}`);
    if (!s.src.includes('cdn.tailwindcss.com')) {
      assert.match(s.attrs, /integrity="sha384-[A-Za-z0-9+/=]+"/, s.src);
      assert.match(s.attrs, /crossorigin="anonymous"/, s.src);
    }
  }
});
