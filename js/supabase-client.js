// ============================================================
// NexusHome OS — Cliente de dados: Supabase real OU Modo Demo
// ------------------------------------------------------------
// createNexusClient():
//   1. Lê credenciais de localStorage ou js/config.js
//   2. Se existirem, tenta conectar ao Supabase (select de teste)
//   3. Em qualquer falha → MockSupabaseClient (Modo Demonstração)
//
// O mock implementa a MESMA superfície de API usada pelo app:
//   from(table).select() / .insert() / .update().eq() / .order() / .limit()
//   channel(name).on('postgres_changes', {table}, cb).subscribe()
// ============================================================

import { emit } from './state.js';

// ---- Seeds do modo demonstração (espelham supabase/migrations/001_init.sql)
export const DEMO_DEVICES = [
  {
    id: 'a1111111-1111-4111-8111-111111111111',
    name: 'Luz da Sala',
    type: 'light',
    room: 'Sala de Estar',
    status: { on: false, brightness: 70, color: '#ffd9a0' },
    is_online: true,
  },
  {
    id: 'a2222222-2222-4222-8222-222222222222',
    name: 'Ar-Condicionado',
    type: 'ac',
    room: 'Quarto Principal',
    status: { on: false, temp: 23 },
    is_online: true,
  },
  {
    id: 'a3333333-3333-4333-8333-333333333333',
    name: 'Válvula de Água Geral',
    type: 'valve',
    room: 'Área Externa',
    status: { open: true },
    is_online: true,
  },
  {
    id: 'a4444444-4444-4444-8444-444444444444',
    name: 'Medidor de Energia',
    type: 'meter',
    room: 'Cozinha',
    status: { watts: 0 },
    is_online: true,
  },
];

const DEMO_AUTOMATIONS = [
  {
    id: 'b1111111-1111-4111-8111-111111111111',
    name: 'Desligar AC em pico de energia',
    trigger_condition: { metric: 'energy_watts', operator: '>', threshold: 3000 },
    action_payload: { device_id: 'a2222222-2222-4222-8222-222222222222', action: 'power', value: false },
    is_active: false,
  },
  {
    id: 'b2222222-2222-4222-8222-222222222222',
    name: 'Fechar água com vazamento prolongado',
    trigger_condition: { metric: 'water_flow_lph', operator: '>', threshold: 50 },
    action_payload: { device_id: 'a3333333-3333-4333-8333-333333333333', action: 'valve', value: false },
    is_active: false,
  },
];

// ------------------------------------------------------------
// Mock Supabase
// ------------------------------------------------------------

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16));
}

class MockQueryBuilder {
  constructor(client, table) {
    this._client = client;
    this._table = table;
    this._op = 'select';
    this._payload = null;
    this._filters = [];
    this._order = null;
    this._limit = null;
  }
  select(_cols = '*') { return this; }
  insert(rows) { this._op = 'insert'; this._payload = Array.isArray(rows) ? rows : [rows]; return this; }
  update(patch) { this._op = 'update'; this._payload = patch; return this; }
  delete() { this._op = 'delete'; return this; }
  eq(col, val) { this._filters.push({ col, val }); return this; }
  order(col, opts = {}) { this._order = { col, ascending: opts.ascending !== false }; return this; }
  limit(n) { this._limit = n; return this; }

  then(resolve, reject) { return Promise.resolve(this._execute()).then(resolve, reject); }

  _rows() { return this._client._db[this._table] || (this._client._db[this._table] = []); }
  _match(row) { return this._filters.every((f) => row[f.col] === f.val); }

  _execute() {
    const rows = this._rows();
    const clone = (r) => JSON.parse(JSON.stringify(r));
    if (this._op === 'insert') {
      const inserted = this._payload.map((p) => {
        const row = { id: p.id || uuid(), created_at: new Date().toISOString(), ...clone(p) };
        rows.push(row);
        this._client._emitRealtime(this._table, 'INSERT', row);
        return clone(row);
      });
      return { data: inserted, error: null };
    }
    if (this._op === 'update') {
      const updated = [];
      rows.forEach((row) => {
        if (!this._match(row)) return;
        if (this._payload.status && row.status) {
          this._payload = { ...this._payload, status: { ...row.status, ...this._payload.status } };
        }
        Object.assign(row, clone(this._payload));
        updated.push(clone(row));
        this._client._emitRealtime(this._table, 'UPDATE', row);
      });
      return { data: updated, error: null };
    }
    if (this._op === 'delete') {
      const removed = [];
      for (let i = rows.length - 1; i >= 0; i--) {
        if (this._match(rows[i])) { removed.push(clone(rows[i])); rows.splice(i, 1); }
      }
      removed.forEach((r) => this._client._emitRealtime(this._table, 'DELETE', r));
      return { data: removed, error: null };
    }
    // select
    let out = rows.filter((r) => this._match(r)).map(clone);
    if (this._order) {
      const { col, ascending } = this._order;
      out.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (ascending ? 1 : -1));
    }
    if (this._limit) out = out.slice(0, this._limit);
    return { data: out, error: null };
  }
}

class MockChannel {
  constructor(client, name) {
    this._client = client;
    this.name = name;
    this._subs = [];
  }
  on(_event, filter, cb) {
    this._subs.push({ table: filter?.table, cb });
    return this;
  }
  subscribe(statusCb) {
    this._client._channels.push(this);
    if (statusCb) setTimeout(() => statusCb('SUBSCRIBED'), 10);
    return this;
  }
}

// ------------------------------------------------------------
// Mock de autenticação — mesma superfície de supabase.auth
// Aceita qualquer e-mail/senha (senha ≥ 6) e persiste uma
// sessão falsa em sessionStorage (limpa ao fechar a aba).
// ------------------------------------------------------------

class MockAuth {
  constructor() {
    this._listeners = [];
  }

  _sessionFromStorage() {
    try {
      const raw = sessionStorage.getItem('nh_demo_session');
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  async getSession() {
    return { data: { session: this._sessionFromStorage() }, error: null };
  }

  async signInWithPassword({ email, password }) { return this._demoSignIn(email, password); }
  async signUp({ email, password }) { return this._demoSignIn(email, password); }

  _demoSignIn(email, password) {
    if (!email || !String(email).includes('@')) {
      return { data: { session: null, user: null }, error: { message: 'Informe um e-mail válido' } };
    }
    if (!password || String(password).length < 6) {
      return { data: { session: null, user: null }, error: { message: 'Senha deve ter ao menos 6 caracteres' } };
    }
    const session = {
      access_token: 'demo-' + uuid(),
      token_type: 'bearer',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: uuid(), email: String(email), aud: 'authenticated', role: 'authenticated' },
    };
    try { sessionStorage.setItem('nh_demo_session', JSON.stringify(session)); } catch { /* modo restrito */ }
    this._notify('SIGNED_IN', session);
    return { data: { session, user: session.user }, error: null };
  }

  async signOut() {
    try { sessionStorage.removeItem('nh_demo_session'); } catch { /* noop */ }
    this._notify('SIGNED_OUT', null);
    return { error: null };
  }

  // Recuperação de senha (demo): resolve sem enviar e-mail de verdade.
  // A UI exibe uma nota âmbar avisando que o fluxo é apenas simulado.
  async resetPasswordForEmail(email, _opts = {}) {
    if (!email || !String(email).includes('@')) {
      return { data: {}, error: { message: 'Informe um e-mail válido' } };
    }
    return { data: {}, error: null };
  }

  // Redefinição de senha (demo): valida e entra direto (sem e-mail real,
  // o link de recovery nunca chega — esta chamada só ocorre por teste manual).
  async updateUser({ password } = {}) {
    if (!password || String(password).length < 6) {
      return { data: { user: null }, error: { message: 'Senha deve ter ao menos 6 caracteres' } };
    }
    let session = this._sessionFromStorage();
    if (!session) {
      session = {
        access_token: 'demo-' + uuid(),
        token_type: 'bearer',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: { id: uuid(), email: 'demo@nexushome.local', aud: 'authenticated', role: 'authenticated' },
      };
      try { sessionStorage.setItem('nh_demo_session', JSON.stringify(session)); } catch { /* modo restrito */ }
      this._notify('SIGNED_IN', session);
    }
    return { data: { user: session.user }, error: null };
  }

  onAuthStateChange(cb) {
    this._listeners.push(cb);
    return {
      data: {
        subscription: {
          unsubscribe: () => { this._listeners = this._listeners.filter((l) => l !== cb); },
        },
      },
    };
  }

  _notify(event, session) {
    this._listeners.forEach((cb) => {
      try { cb(event, session); } catch (e) { console.error('[mock auth]', e); }
    });
  }
}

export class MockSupabaseClient {
  constructor() {
    this.nexusMode = 'demo';
    this._channels = [];
    this._db = {
      devices: DEMO_DEVICES.map((d) => JSON.parse(JSON.stringify(d))),
      automations: DEMO_AUTOMATIONS.map((a) => JSON.parse(JSON.stringify(a))),
      telemetry_logs: [],
      alerts: [],
    };
    this._simTimer = null;
    this._waterTicksLeft = 0;
    this._temp = 24.5;
    this._hum = 55;
    this.auth = new MockAuth(); // mesma superfície de supabase.auth
  }

  from(table) { return new MockQueryBuilder(this, table); }
  channel(name) { return new MockChannel(this, name); }
  removeChannel(ch) {
    this._channels = this._channels.filter((c) => c !== ch);
    return Promise.resolve('ok');
  }

  _emitRealtime(table, eventType, row) {
    const payload = {
      eventType, schema: 'public', table,
      new: JSON.parse(JSON.stringify(row)),
      old: JSON.parse(JSON.stringify(row)),
    };
    this._channels.forEach((ch) =>
      ch._subs.forEach((s) => {
        if (!s.table || s.table === table) {
          try { s.cb(payload); } catch (e) { console.error('[mock realtime]', e); }
        }
      }));
  }

  // ---- Simulador de telemetria (a cada 3–5 s) ---------------------------
  startSimulation() {
    if (this._simTimer) return;
    const loop = () => {
      try { this._simTick(); } catch (e) { console.error('[sim]', e); }
      this._simTimer = setTimeout(loop, 3000 + Math.random() * 2000);
    };
    loop();
  }

  stopSimulation() {
    if (this._simTimer) {
      clearTimeout(this._simTimer);
      this._simTimer = null;
    }
  }

  _simTick() {
    const devs = this._db.devices;
    const light = devs.find((d) => d.type === 'light');
    const ac = devs.find((d) => d.type === 'ac');
    const valve = devs.find((d) => d.type === 'valve');
    const meter = devs.find((d) => d.type === 'meter');
    const valveOpen = valve?.status?.open !== false;

    // Energia: base + consumo real dos dispositivos + ruído + picos ocasionais
    let watts = 320 + Math.random() * 300;
    if (light?.status?.on) watts += 40 + (Number(light.status.brightness) || 0) * 0.6;
    if (ac?.status?.on) watts += 1100 + Math.random() * 800;
    watts += Math.random() * 700; // flutuação ambiente
    if (Math.random() < 0.07) watts += 1500 + Math.random() * 2200; // pico (pode ultrapassar 4500W)
    watts = Math.round(watts);

    // Água: eventos de consumo; raramente um evento longo (simula vazamento)
    if (this._waterTicksLeft <= 0 && valveOpen) {
      if (Math.random() < 0.04) this._waterTicksLeft = 11 + Math.floor(Math.random() * 4); // "vazamento"
      else if (Math.random() < 0.22) this._waterTicksLeft = 2 + Math.floor(Math.random() * 3); // uso normal
    }
    const flow = this._waterTicksLeft > 0 && valveOpen
      ? Math.round(280 + Math.random() * 620)
      : 0;
    if (this._waterTicksLeft > 0) this._waterTicksLeft--;
    if (!valveOpen) this._waterTicksLeft = 0;

    // Temperatura / umidade com leve deriva (AC puxa a temperatura para baixo)
    this._temp = clamp(this._temp + (Math.random() - 0.5) * 0.5 + (ac?.status?.on ? -0.18 : 0.06), 17, 34);
    this._hum = clamp(this._hum + (Math.random() - 0.5) * 2.2, 25, 90);

    const rows = [];
    if (meter) rows.push({ device_id: meter.id, metric_type: 'energy_watts', value: watts });
    if (valve) rows.push({ device_id: valve.id, metric_type: 'water_flow_lph', value: flow });
    if (ac) {
      rows.push({ device_id: ac.id, metric_type: 'temperature', value: Math.round(this._temp * 10) / 10 });
      rows.push({ device_id: ac.id, metric_type: 'humidity', value: Math.round(this._hum) });
    }

    for (const r of rows) {
      const row = { id: uuid(), created_at: new Date().toISOString(), ...r };
      this._db.telemetry_logs.push(row);
      if (this._db.telemetry_logs.length > 500) this._db.telemetry_logs.shift();
      this._emitRealtime('telemetry_logs', 'INSERT', row);
    }

    // mantém o medidor coerente com a leitura atual
    if (meter) {
      meter.status = { ...meter.status, watts };
      this._emitRealtime('devices', 'UPDATE', meter);
    }
  }
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// ------------------------------------------------------------
// Fábrica: tenta Supabase real, cai para demo
// ------------------------------------------------------------

export async function createNexusClient() {
  const cfg = window.NEXUSHOME_CONFIG || {};
  const url = (localStorage.getItem('nh_supabase_url') || cfg.SUPABASE_URL || '').trim();
  const key = (localStorage.getItem('nh_supabase_anon_key') || cfg.SUPABASE_ANON_KEY || '').trim();

  if (url && key && window.supabase?.createClient) {
    try {
      const client = window.supabase.createClient(url, key);
      const probe = client.from('devices').select('id').limit(1);
      const { error } = await withTimeout(probe, 6000);
      if (!error) {
        client.nexusMode = 'live';
        console.info('[NexusHome] Conectado ao Supabase:', url);
        return client;
      }
      console.warn('[NexusHome] Supabase respondeu com erro, entrando em demo:', error.message);
    } catch (err) {
      console.warn('[NexusHome] Falha ao conectar no Supabase, entrando em demo:', err?.message || err);
    }
  } else {
    console.info('[NexusHome] Sem credenciais Supabase — Modo Demonstração.');
  }

  const mock = new MockSupabaseClient();
  return mock;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}
