import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveSupabaseConfig } from '../js/supabase-client.js';
import { panelsForTab, TABS } from '../js/mobile-nav.js';

const store = (o = {}) => ({ getItem: (k) => o[k] ?? null });

test('produção: sem config local, o build usa o projeto NexusHome', () => {
  const { url, key } = resolveSupabaseConfig({ storage: store(), production: true });
  assert.equal(url, 'https://gfjxcsvxhaojbtuixpjh.supabase.co');
  assert.ok(key.length > 100);
  // a chave embutida é a anon (pública), nunca a service_role
  const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString());
  assert.equal(payload.role, 'anon');
  assert.equal(payload.ref, 'gfjxcsvxhaojbtuixpjh');
});

test('dev e testes continuam no modo demonstração', () => {
  assert.deepEqual(resolveSupabaseConfig({ storage: store(), production: false }), { url: '', key: '' });
});

test('localStorage e js/config.js têm prioridade; ?demo=1 força a demonstração', () => {
  const local = resolveSupabaseConfig({ storage: store({ nh_supabase_url: 'https://x.supabase.co', nh_supabase_anon_key: 'k' }), production: true });
  assert.deepEqual(local, { url: 'https://x.supabase.co', key: 'k' });
  const cfg = resolveSupabaseConfig({ storage: store(), cfg: { SUPABASE_URL: 'https://y.supabase.co', SUPABASE_ANON_KEY: 'c' }, production: true });
  assert.equal(cfg.url, 'https://y.supabase.co');
  assert.deepEqual(resolveSupabaseConfig({ storage: store(), production: true, search: '?demo=1' }), { url: '', key: '' });
  assert.deepEqual(resolveSupabaseConfig({ storage: store(), production: true, search: '?x=1&demo' }), { url: '', key: '' });
  assert.notEqual(resolveSupabaseConfig({ storage: store(), production: true, search: '?demolir=1' }).url, '');
  // storage bloqueado (modo privado) não derruba o boot
  const broken = { getItem() { throw new Error('bloqueado'); } };
  assert.equal(resolveSupabaseConfig({ storage: broken, production: true }).url, 'https://gfjxcsvxhaojbtuixpjh.supabase.co');
});

test('celular: todo painel do index.html pertence a uma aba existente', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const panels = [...html.matchAll(/<aside id="(panel-[\w-]+)"([^>]*)>/g)].map(([, id, attrs]) => ({
    id, dataset: { mtab: (attrs.match(/data-mtab="([^"]+)"/) || [])[1] },
  }));
  assert.ok(panels.length >= 7);
  panels.forEach((p) => assert.ok(p.dataset.mtab && p.dataset.mtab.split(' ').every((t) => TABS.includes(t)), `${p.id} sem aba`));
  const ids = (tab) => panelsForTab(tab, panels).map((p) => p.id);
  assert.deepEqual(ids('dispositivos'), ['panel-devices']);
  assert.deepEqual(ids('rotinas'), ['panel-scenes', 'panel-automations']);
  assert.deepEqual(ids('energia'), ['panel-monitor']);
  assert.deepEqual(ids('mais'), ['panel-more', 'panel-smartthings', 'panel-tuya']);
  assert.deepEqual(ids('casa'), []);
  TABS.forEach((t) => assert.ok(html.includes(`data-tab="${t}"`), `aba ${t} sem botão`));
});
