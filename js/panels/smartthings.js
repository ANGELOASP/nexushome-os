// ============================================================
// NexusHome OS — Painel Samsung SmartThings (v1.5.0)
// ------------------------------------------------------------
// Controla TVs e ares-condicionados Samsung (Wi-Fi) pela API
// SmartThings, via Edge Function `smartthings-proxy`:
//
//   navegador → POST /functions/v1/smartthings-proxy
//             → SmartThings v1 (Authorization: Bearer <PAT>)
//
// SEGURANÇA: o Personal Access Token fica SOMENTE no
// localStorage do navegador (nh_smartthings_token) e viaja a
// cada requisição no header x-smartthings-token. Nunca vai para
// tabelas do Supabase, nunca é commitado, nunca é logado.
//
// Modo Demonstração: 2 aparelhos simulados (TV + AC) com
// controles locais — nenhuma chamada de rede é feita.
//
// Aparelhos vinculados a cômodos da planta entram no estado
// global como dispositivos virtuais (type 'ac' / 'tv') e a
// cena 3D reage (tons frios do AC, brilho sutil da TV).
// ============================================================

import { state, on, emit, getRoomNames, upsertDevice } from '../state.js';
import { toast, escapeHtml } from '../toasts.js';

const TOKEN_KEY = 'nh_smartthings_token';
const LINKS_KEY = 'nh_smartthings_links';
const POLL_MS = 30000; // a SmartThings limita requisições — 30 s é conservador

// ---- aparelhos simulados do Modo Demonstração ----------------
const DEMO_ST = [
  {
    id: 'demo-tv-1', name: 'TV Samsung (Demo)', kind: 'tv', online: true,
    caps: ['switch', 'audioVolume', 'audioMute', 'tvChannel'],
    st: { on: false, volume: 12, mute: false, channel: 5, temperature: 24.8, humidity: 52 },
  },
  {
    id: 'demo-ac-1', name: 'Ar-Condicionado Samsung (Demo)', kind: 'ac', online: true,
    caps: ['switch', 'thermostatCoolingSetpoint', 'airConditionerMode'],
    st: { on: false, setpoint: 23, mode: 'cool', temperature: 26.4, humidity: 58 },
  },
];

let client = null;
let demo = false;
let token = null;
let links = {};          // { deviceId: roomName }
let stDevices = [];      // [{ id, name, kind, caps[], st:{}, online }]
let pollTimer = null;
let driftTimer = null;   // deriva de sensores simulados (modo demo)
let listEl = null;
let refreshing = false;  // evita duas atualizações ao mesmo tempo (duplo clique / polling)

// ------------------------------------------------------------
// Init / teardown
// ------------------------------------------------------------

export function initSmartThingsPanel(nexusClient) {
  client = nexusClient;
  demo = state.mode === 'demo';
  listEl = document.getElementById('st-list');
  loadLinks();

  document.getElementById('btn-st-connect')?.addEventListener('click', onConnect);
  document.getElementById('btn-st-disconnect')?.addEventListener('click', disconnect);
  document.getElementById('btn-st-refresh')?.addEventListener('click', () => refresh(true));
  document.getElementById('st-token')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); onConnect(); }
  });
  on('rooms-changed', () => { if (isConnectedView()) renderDevices(); });

  document.getElementById('st-demo-badge')?.classList.toggle('hidden', !demo);
  document.getElementById('st-demo-note')?.classList.toggle('hidden', !demo);

  if (demo) {
    // demo: aparelhos simulados, sem token nem rede
    stDevices = DEMO_ST.map((d) => ({ ...d, st: { ...d.st } }));
    setStConnected(true);
    showConnected();
    renderDevices();
    syncVirtualDevices();
    publishReadings();
    startDemoDrift();
  } else {
    token = (localStorage.getItem(TOKEN_KEY) || '').trim() || null;
    if (token) {
      setStConnected(true); // otimista: refresh(true) desfaz se o token estiver inválido
      showConnected();
      refresh(true); // valida o token salvo na primeira carga
    } else {
      setStConnected(false);
      showSetup();
    }
  }
}

export function teardownSmartThings() {
  stopPolling();
  stopDemoDrift();
  setStConnected(false);
}

function isConnectedView() {
  return !document.getElementById('st-connected')?.classList.contains('hidden');
}

function showSetup() {
  document.getElementById('st-setup')?.classList.remove('hidden');
  document.getElementById('st-connected')?.classList.add('hidden');
}

function showConnected() {
  document.getElementById('st-setup')?.classList.add('hidden');
  document.getElementById('st-connected')?.classList.remove('hidden');
}

// ------------------------------------------------------------
// Conexão / desconexão
// ------------------------------------------------------------

async function onConnect() {
  const input = document.getElementById('st-token');
  const msg = document.getElementById('st-setup-msg');
  const t = (input?.value || '').trim();
  if (!t) {
    if (msg) { msg.textContent = 'Cole o token antes de conectar.'; msg.classList.remove('hidden'); }
    return;
  }
  token = t;
  setBusy(true, 'Validando…');
  try {
    await listDevices(); // valida o token contra a API real
    localStorage.setItem(TOKEN_KEY, t);
    if (input) input.value = '';
    if (msg) msg.classList.add('hidden');
    showConnected();
    renderDevices();
    syncVirtualDevices();
    startPolling();
    setStConnected(true);
    toast('SmartThings conectado', `${stDevices.length} aparelho(s) encontrado(s).`, 'success');
  } catch (err) {
    token = null;
    setStConnected(false);
    handleError(err, 'Validar token');
  } finally {
    setBusy(false, 'Conectar');
  }
}

function disconnect() {
  stopPolling();
  token = null;
  stDevices = [];
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(LINKS_KEY);
  } catch { /* modo restrito */ }
  links = {};
  if (demo) {
    stDevices = DEMO_ST.map((d) => ({ ...d, st: { ...d.st } }));
    renderDevices();
    return;
  }
  setStConnected(false);
  showSetup();
  toast('SmartThings desconectado', 'Token e vínculos removidos deste navegador.', 'info');
}

function setBusy(b, label) {
  const btn = document.getElementById('btn-st-connect');
  if (btn) { btn.disabled = b; btn.textContent = label; }
}

// ------------------------------------------------------------
// Camada de API (via proxy) — nunca chamada no modo demo
// ------------------------------------------------------------

async function stCall(path, method = 'GET', payload = undefined) {
  const { data, error } = await client.functions.invoke('smartthings-proxy', {
    body: { path, method, payload },
    headers: { 'x-smartthings-token': token },
  });
  if (error) {
    let body = null;
    try { body = await error.context?.json?.(); } catch { /* sem corpo */ }
    const raw = body?.error ?? body?.message;
    const msg = typeof raw === 'string' ? raw : (raw?.message || raw?.code || '');
    const err = new Error(msg || error.message || 'Falha na chamada SmartThings');
    err.status = error.context?.status ?? 0;
    err.sessionExpired = err.status === 401 && /login necess/i.test(msg);   // JWT do app, não o token Samsung
    throw err;
  }
  return data;
}

async function listDevices() {
  const data = await stCall('/devices');
  const items = data?.items || [];
  const out = items.map((item) => {
    const caps = (item.components?.[0]?.capabilities || []).map((c) => c.id);
    return {
      id: item.deviceId,
      name: item.label || item.name || 'Aparelho Samsung',
      kind: detectKind(item, caps), caps, online: true, st: {},
    };
  });
  // status em lotes de 4 em paralelo (um por vez deixava a atualização lenta com muitos aparelhos)
  for (let i = 0; i < out.length; i += 4) {
    await Promise.all(out.slice(i, i + 4).map(async (entry) => {
      try {
        entry.st = mapStatus(await stCall(`/devices/${entry.id}/status`));
      } catch {
        entry.online = false; // aparelho inalcançável no momento
      }
    }));
  }
  stDevices = out;
  return out;
}

function detectKind(item, caps) {
  const t = `${item.type || ''} ${item.deviceTypeName || ''}`.toLowerCase();
  if (caps.some((c) => c.startsWith('samsungvd')) || caps.includes('tvChannel') || t.includes('tv')) return 'tv';
  if (caps.includes('airConditionerMode') || caps.includes('thermostatCoolingSetpoint') || t.includes('air')) return 'ac';
  return 'other';
}

function mapStatus(status) {
  const main = status?.components?.main || {};
  const val = (cap, attr) => main?.[cap]?.[attr]?.value;
  return {
    on: val('switch', 'switch') === 'on',
    volume: Number(val('audioVolume', 'volume') ?? 0),
    mute: val('audioMute', 'mute') === 'muted',
    channel: val('tvChannel', 'tvChannel') ?? null,
    setpoint: Number(val('thermostatCoolingSetpoint', 'coolingSetpoint') ?? 23),
    mode: val('airConditionerMode', 'airConditionerMode') || 'cool',
    // sensores ambientais reportados pelo próprio aparelho (quando existem)
    temperature: numOrNull(val('temperatureMeasurement', 'temperature')),
    humidity: numOrNull(val('relativeHumidityMeasurement', 'humidity')),
  };
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ------------------------------------------------------------
// Comandos
// ------------------------------------------------------------

async function sendCommand(d, capability, command, args, label) {
  if (demo) {
    applyDemoCommand(d, capability, command, args);
    renderDevices();
    syncVirtualDevices();
    toast(`Comando enviado: ${label}`, d.name, 'success');
    return;
  }
  try {
    await stCall(`/devices/${d.id}/commands`, 'POST', {
      commands: [{ component: 'main', capability, command, arguments: args ?? [] }],
    });
    toast(`Comando enviado: ${label}`, d.name, 'success');
    setTimeout(() => refresh(false), 1500); // reflete o novo estado
  } catch (err) {
    handleError(err, label);
  }
}

function applyDemoCommand(d, capability, command, args) {
  const st = d.st;
  if (capability === 'switch') st.on = command === 'on';
  else if (capability === 'audioVolume' && command === 'setVolume') st.volume = args[0];
  else if (capability === 'audioMute') st.mute = command === 'mute';
  else if (capability === 'tvChannel') {
    st.channel = Math.max(1, (Number(st.channel) || 1) + (command === 'channelUp' ? 1 : -1));
  }
  else if (capability === 'thermostatCoolingSetpoint') st.setpoint = args[0];
  else if (capability === 'airConditionerMode') st.mode = args[0];
}

function handleError(err, contexto) {
  console.error(`[smartthings] ${contexto}:`, err);
  if (err.sessionExpired) {
    toast('Sua sessão do NexusHome expirou', 'Saia e entre de novo para atualizar a SmartThings.', 'critical');
  } else if (err.status === 401) {
    toast('Token inválido — gere outro em account.smartthings.com/tokens', contexto, 'critical');
  } else if (err.status === 403) {
    toast('Sem permissão — o token precisa dos escopos de Devices (Read/Execute).', contexto, 'critical');
  } else {
    toast('Falha na comunicação com a SmartThings', err.message || contexto, 'critical');
  }
}

// ------------------------------------------------------------
// Atualização periódica
// ------------------------------------------------------------

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => refresh(false), POLL_MS);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function setRefreshBusy(busy) {
  const btn = document.getElementById('btn-st-refresh');
  if (!btn) return;
  btn.disabled = busy;
  btn.textContent = busy ? 'Atualizando…' : 'Atualizar';
}

function markUpdated() {
  const el = document.getElementById('st-updated');
  if (el) el.textContent = `Atualizado às ${new Date().toLocaleTimeString('pt-BR')}`;
}

async function refresh(manual) {
  if (refreshing) return;
  if (demo) {
    renderDevices(); publishReadings(); markUpdated();
    if (manual) toast('SmartThings atualizado', 'Aparelhos simulados (modo demonstração).', 'info');
    return;
  }
  if (!token) return;
  refreshing = true;
  if (manual) setRefreshBusy(true);
  try {
    const n = (await listDevices()).length;
    renderDevices();
    syncVirtualDevices();
    publishReadings(); // alimenta as automações com gatilho SmartThings
    markUpdated();
    if (!pollTimer) startPolling();   // após carregar com token salvo, o polling também precisa rodar
    if (manual) {
      if (n) toast('SmartThings atualizado', `${n} aparelho(s) lido(s).`, 'success');
      else toast('Nenhum aparelho encontrado na sua conta SmartThings', '', 'warning');
    }
  } catch (err) {
    handleError(err, 'Atualizar aparelhos');
    if (err.status === 401 && !err.sessionExpired) { setStConnected(false); stopPolling(); showSetup(); }
  } finally {
    refreshing = false;
    if (manual) setRefreshBusy(false);
  }
}

// ------------------------------------------------------------
// Vínculos com cômodos da planta → dispositivos virtuais no 3D
// ------------------------------------------------------------

function loadLinks() {
  try { links = JSON.parse(localStorage.getItem(LINKS_KEY) || '{}') || {}; }
  catch { links = {}; }
}

function saveLinks() {
  try { localStorage.setItem(LINKS_KEY, JSON.stringify(links)); } catch { /* modo restrito */ }
}

function syncVirtualDevices() {
  stDevices.forEach((d) => {
    const room = links[d.id];
    if (!room) return;
    upsertDevice({
      id: `st-${d.id}`,
      name: d.name,
      type: d.kind === 'ac' ? 'ac' : d.kind === 'tv' ? 'tv' : 'sensor',
      room,
      status: d.kind === 'ac'
        ? { on: d.st.on, temp: d.st.setpoint }
        : { on: d.st.on, volume: d.st.volume },
      is_online: d.online,
      virtual: true, // não aparece no painel de dispositivos nem aceita escrita direta
    });
  });
}

// ------------------------------------------------------------
// API pública para o motor de automações (v1.5.0)
// ------------------------------------------------------------

/** Lista atual de aparelhos SmartThings (id, name, kind, online, st). */
export function getStDevices() {
  return stDevices;
}

/** Painel conectado? (no Modo Demonstração conta como conectado) */
export function isStConnected() {
  return demo || !!token;
}

function setStConnected(v) {
  if (state.stConnected === v) return;
  state.stConnected = v;
  emit('st-connection-changed', v);
}

/** Info pontual de um aparelho (para badges/descrições fora do painel). */
export function getStDeviceInfo(id) {
  const d = stDevices.find((x) => x.id === id);
  return d ? { id: d.id, name: d.name, kind: d.kind, online: d.online } : null;
}

/**
 * Publica as últimas leituras no estado global e dispara 'st-readings' —
 * o avaliador de automações escuta esse evento a cada poll (30 s) e a
 * cada deriva do simulador demo.
 */
function publishReadings() {
  const readings = {};
  stDevices.forEach((d) => {
    readings[d.id] = {
      temperature: d.st.temperature ?? null,
      humidity: d.st.humidity ?? null,
      online: d.online,
    };
  });
  state.stReadings = readings;
  emit('st-readings', readings);
}

// ---- deriva dos sensores simulados (somente Modo Demonstração) ----
// Temperatura passeia entre 22–31 °C para que regras de exemplo
// (ex.: "> 26 °C") cruzem a borda e disparem de verdade.
function startDemoDrift() {
  stopDemoDrift();
  driftTimer = setInterval(() => {
    stDevices.forEach((d) => {
      d.st.temperature = clamp(d.st.temperature + (Math.random() - 0.48) * 1.4, 22, 31);
      d.st.humidity = clamp(d.st.humidity + (Math.random() - 0.5) * 3, 40, 70);
    });
    publishReadings();
  }, 5000);
}

function stopDemoDrift() {
  if (driftTimer) { clearInterval(driftTimer); driftTimer = null; }
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, Math.round(v * 10) / 10));
}

/**
 * Executa uma lista de comandos SmartThings (ação de automação).
 * No demo aplica localmente; no live envia UM POST por aparelho via proxy.
 * Lança erro em caso de falha (o chamador trata com toast).
 * Retorna o aparelho afetado (para compor a mensagem de sucesso).
 */
export async function executeStAutomationCommands(stDeviceId, commands) {
  const d = stDevices.find((x) => x.id === stDeviceId);
  if (!d) throw new Error('Aparelho SmartThings não encontrado (reconecte o painel).');

  if (demo) {
    commands.forEach((c) => applyDemoCommand(d, c.capability, c.command, c.arguments));
    renderDevices();
    syncVirtualDevices();
    publishReadings();
    return d;
  }
  if (!token) throw new Error('SmartThings offline — conecte o painel com um token válido.');
  await stCall(`/devices/${stDeviceId}/commands`, 'POST', { commands });
  setTimeout(() => refresh(false), 1500);
  return d;
}

// ------------------------------------------------------------
// Render
// ------------------------------------------------------------

const KIND_ICON = {
  tv: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 22h8"/><path d="M12 18v4"/></svg>',
  ac: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20"/><path d="m4.9 4.9 14.2 14.2"/><path d="M2 12h20"/><path d="m19.1 4.9-14.2 14.2"/></svg>',
  other: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/></svg>',
};
const KIND_LABEL = { tv: 'TV', ac: 'Ar-Condicionado', other: 'Aparelho' };
const AC_MODES = [
  ['cool', 'Frio'], ['heat', 'Quente'], ['dry', 'Desumidificar'],
  ['wind', 'Ventilar'], ['auto', 'Automático'],
];

function renderDevices() {
  if (!listEl) return;
  listEl.innerHTML = '';

  if (!stDevices.length) {
    listEl.innerHTML = '<p class="text-xs text-slate-500 px-1">Nenhum aparelho encontrado na sua conta SmartThings.</p>';
    return;
  }

  stDevices.forEach((d) => listEl.appendChild(renderDevice(d)));
}

function renderDevice(d) {
  const card = document.createElement('div');
  card.className = 'device-card glass-soft rounded-xl p-3 transition-all duration-200';
  card.dataset.stId = d.id;

  const st = d.st;
  let controls = '';

  if (d.kind === 'tv') {
    const chRow = d.caps.includes('tvChannel')
      ? `<div class="st-row">
           <span class="st-label">Canal <span class="text-slate-300 tabular-nums">${st.channel ?? '—'}</span></span>
           <span class="st-btn-group">
             <button data-ctl="ch-down" class="st-mini-btn" title="Canal anterior">−</button>
             <button data-ctl="ch-up" class="st-mini-btn" title="Próximo canal">+</button>
           </span>
         </div>`
      : '';
    controls = `
      <div class="flex items-center justify-between gap-3 mt-2">
        <label class="switch"><input type="checkbox" data-ctl="power" ${st.on ? 'checked' : ''}><span class="slider-ui"></span></label>
        <button data-ctl="mute" class="st-mini-btn st-mute ${st.mute ? 'st-mute-on' : ''}" title="Mudo">
          ${st.mute ? 'COM MUDO' : 'SOM ATIVO'}
        </button>
      </div>
      <div class="st-row">
        <span class="st-label">Volume <span class="text-slate-300 tabular-nums">${st.volume}</span></span>
        <span class="st-btn-group">
          <button data-ctl="vol-down" class="st-mini-btn" title="Diminuir volume">−</button>
          <button data-ctl="vol-up" class="st-mini-btn" title="Aumentar volume">+</button>
        </span>
      </div>
      ${chRow}`;
  } else if (d.kind === 'ac') {
    controls = `
      <div class="flex items-center justify-between gap-3 mt-2">
        <label class="switch"><input type="checkbox" data-ctl="power" ${st.on ? 'checked' : ''}><span class="slider-ui"></span></label>
        <span class="text-sm font-semibold text-sky-300 tabular-nums" data-lbl="setpoint">${st.setpoint}°C</span>
      </div>
      <div class="mt-2 flex items-center gap-2">
        <span class="text-[10px] text-slate-500">16°</span>
        <input type="range" min="16" max="30" value="${st.setpoint}" data-ctl="setpoint" class="range-input range-cool flex-1">
        <span class="text-[10px] text-slate-500">30°</span>
      </div>
      <select data-ctl="mode" class="form-input mt-2">
        ${AC_MODES.map(([v, l]) => `<option value="${v}" ${st.mode === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>`;
  } else {
    controls = `
      <div class="flex items-center justify-between gap-3 mt-2">
        <label class="switch"><input type="checkbox" data-ctl="power" ${st.on ? 'checked' : ''}><span class="slider-ui"></span></label>
        <span class="text-[10px] text-slate-500">Liga/desliga</span>
      </div>`;
  }

  // vínculo com cômodo da planta
  const room = links[d.id] || '';
  const roomOpts = ['<option value="">Sem vínculo</option>']
    .concat(getRoomNames().map((r) => `<option value="${escapeHtml(r)}" ${r === room ? 'selected' : ''}>${escapeHtml(r)}</option>`))
    .join('');

  card.innerHTML = `
    <div class="flex items-center gap-2.5">
      <span class="device-icon text-slate-300">${KIND_ICON[d.kind] || KIND_ICON.other}</span>
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium text-slate-100 truncate">${escapeHtml(d.name)}</p>
        <p class="text-[10px] text-slate-500">
          ${KIND_LABEL[d.kind] || 'Aparelho'} ·
          ${d.online ? '<span class="text-emerald-400">●</span> online' : '<span class="text-slate-500">●</span> offline'}
        </p>
      </div>
    </div>
    ${controls}
    <div class="mt-2">
      <label class="form-label">Vincular a cômodo</label>
      <select data-ctl="room" class="form-input">${roomOpts}</select>
    </div>`;

  wireDevice(card, d);
  return card;
}

function wireDevice(card, d) {
  const q = (sel) => card.querySelector(sel);
  const st = d.st;

  q('[data-ctl="power"]')?.addEventListener('change', (e) => {
    sendCommand(d, 'switch', e.target.checked ? 'on' : 'off', [],
      e.target.checked ? `Ligar ${KIND_LABEL[d.kind] || 'aparelho'}` : `Desligar ${KIND_LABEL[d.kind] || 'aparelho'}`);
  });
  q('[data-ctl="vol-up"]')?.addEventListener('click', () =>
    sendCommand(d, 'audioVolume', 'setVolume', [Math.min(100, (st.volume || 0) + 5)], 'Volume +'));
  q('[data-ctl="vol-down"]')?.addEventListener('click', () =>
    sendCommand(d, 'audioVolume', 'setVolume', [Math.max(0, (st.volume || 0) - 5)], 'Volume −'));
  q('[data-ctl="mute"]')?.addEventListener('click', () =>
    sendCommand(d, 'audioMute', st.mute ? 'unmute' : 'mute', [], st.mute ? 'Desativar mudo' : 'Ativar mudo'));
  q('[data-ctl="ch-up"]')?.addEventListener('click', () =>
    sendCommand(d, 'tvChannel', 'channelUp', [], 'Canal +'));
  q('[data-ctl="ch-down"]')?.addEventListener('click', () =>
    sendCommand(d, 'tvChannel', 'channelDown', [], 'Canal −'));

  const setpoint = q('[data-ctl="setpoint"]');
  if (setpoint) {
    const lbl = card.querySelector('[data-lbl="setpoint"]');
    setpoint.addEventListener('input', () => { if (lbl) lbl.textContent = `${setpoint.value}°C`; });
    setpoint.addEventListener('change', () =>
      sendCommand(d, 'thermostatCoolingSetpoint', 'setCoolingSetpoint', [Number(setpoint.value)], `Temperatura: ${setpoint.value}°C`));
  }
  q('[data-ctl="mode"]')?.addEventListener('change', (e) => {
    const lbl = AC_MODES.find(([v]) => v === e.target.value)?.[1] || e.target.value;
    sendCommand(d, 'airConditionerMode', 'setAirConditionerMode', [e.target.value], `Modo: ${lbl}`);
  });

  q('[data-ctl="room"]')?.addEventListener('change', (e) => {
    if (e.target.value) {
      links[d.id] = e.target.value;
      toast('Aparelho vinculado', `${d.name} → ${e.target.value}. A cena 3D agora reage a ele.`, 'success');
    } else {
      delete links[d.id];
    }
    saveLinks();
    syncVirtualDevices();
  });
}
