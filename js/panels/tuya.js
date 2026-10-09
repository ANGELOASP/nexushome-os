// ============================================================
// NexusHome OS — Painel Tuya Smart Life: hidráulica (v1.7.0)
// ------------------------------------------------------------
// Integra dispositivos Tuya/Smart Life de ÁGUA — válvulas Wi-Fi
// (setoriais e geral), válvula-medidora ultrassônica na entrada,
// monitores de nível ME201W e sensores de vazamento — pela Tuya
// Cloud API, via Edge Function `tuya-proxy`:
//
//   navegador → POST /functions/v1/tuya-proxy
//             → Tuya Cloud (assinatura HMAC-SHA256 na função)
//
// SEGURANÇA: Client ID / Client Secret / UID / região ficam
// SOMENTE no localStorage do navegador (nh_tuya_creds) e viajam
// no corpo de cada requisição ao proxy. Nunca vão para tabelas
// do Supabase, nunca são commitados, nunca são logados.
//
// DESCOBERTA DE DATAPOINTS: dispositivos Tuya expõem datapoints
// por código (switch, flow_rate, liquid_level_percent…) que
// variam por produto. O painel DESCOBRE os datapoints de cada
// dispositivo via /status e mapeia com um dicionário de
// melhor-esforço; códigos desconhecidos aparecem na seção
// expansível "dados brutos" — nunca quebram a renderização.
//
// VÍNCULOS (nh_tuya_links):
//   · cômodo da planta → o dispositivo entra no estado global
//     como virtual e a cena 3D reage (mesmo padrão SmartThings);
//   · "Válvula de Água Geral (nativa)": uma válvula-medidora
//     Tuya vinculada ALIMENTA a métrica de água do dashboard —
//     a cada poll o painel insere uma linha em telemetry_logs
//     (metric_type 'water_flow_lph'), que chega ao Monitor pelo
//     MESMO canal realtime já existente (postgres_changes no
//     live, evento do mock no demo) — demo e live idênticos,
//     sem caminho paralelo de dados. Monitores de nível
//     vinculados gravam 'water_level_pct' (migração 005),
//     ancorados no device_id da válvula geral (contexto
//     hídrico — a FK exige um device existente).
//   · o botão de emergência FECHAR VÁLVULA DE ÁGUA GERAL
//     também comanda a válvula Tuya vinculada: o painel escuta
//     'device-changed' da válvula nativa (edge-triggered) e
//     espelha abrir/fechar — sem import circular com monitor.js.
//
// VAZAMENTO: datapoint de leak em alarme insere um alerta
// CRÍTICO pelo pipeline existente (insertAlert do monitor.js) —
// aparece no Monitor de Recursos nos dois modos.
//
// Modo Demonstração: 3 dispositivos simulados (válvula-medidora,
// monitor de nível, sensor de vazamento) com leituras que derivam
// e um evento raro de vazamento — nenhuma chamada de rede.
// ============================================================

import { state, on, getRoomNames, upsertDevice, removeDevice } from '../state.js';
import { toast, escapeHtml } from '../toasts.js';
import { insertAlert } from './monitor.js';
import { registerVirtualRenderer } from './devices.js';

const CREDS_KEY = 'nh_tuya_creds';
const LINKS_KEY = 'nh_tuya_links';
const POLL_MS = 30000; // mesmo ritmo conservador do painel SmartThings

const MAIN_VALVE_ID = 'a3333333-3333-4333-8333-333333333333'; // Válvula de Água Geral (seed 001)
const MAIN_VALVE_LINK = '__main_valve__';                     // valor especial no select de vínculo

// Conversão de vazão: as válvulas ultrassônicas Tuya costumam
// reportar flow_rate em L/min — convertemos para L/h (métrica
// nativa do app). Se o seu produto reportar direto em L/h,
// mude para 1.
const FLOW_TO_LPH = 60;

// ---- dicionário de datapoints (melhor esforço) --------------
// Códigos variam por produto; o primeiro código encontrado no
// /status vence. Códigos fora da lista caem em "dados brutos".
const DP_MAP = {
  switch: ['switch', 'switch_valve', 'valve_switch', 'switch_1'],
  flow: ['flow_rate', 'water_flow', 'flowrate', 'flow'],
  consumption: ['water_consumed', 'total_flow', 'total_water', 'consumption_total'],
  temperature: ['temp_current', 'va_temperature', 'temperature'],
  levelPct: ['liquid_level_percent', 'level_percent', 'liquid_level'],
  depth: ['liquid_depth', 'water_depth', 'depth'],
  leak: ['watersensor_state', 'water_leak', 'leakage_state', 'alarm_water'],
};
const DP_LABEL = {
  switch: 'registro', flow: 'vazão', consumption: 'consumo',
  temperature: 'temperatura', levelPct: 'nível %', depth: 'profundidade', leak: 'vazamento',
};
const LEAK_ALARM_VALUES = ['alarm', 'leak', 'leakage', 'true', '1'];

// ---- dispositivos simulados do Modo Demonstração -------------
const DEMO_TUYA = [
  {
    id: 'demo-ty-valve', name: 'Válvula-Medidora Ultrassônica (Demo)', kind: 'valve_meter', online: true,
    dp: { on: true, switchCode: 'switch', flowLpm: 0, consumption: 182.4, temperature: 21.6 },
    raw: [{ code: 'fault', value: 0 }],
  },
  {
    id: 'demo-ty-level', name: 'ME201W Nível Caixa Principal (Demo)', kind: 'level', online: true,
    dp: { levelPct: 78, depth: 92 },
    raw: [{ code: 'battery_percentage', value: 86 }],
  },
  {
    id: 'demo-ty-leak', name: 'Sensor de Vazamento Cozinha (Demo)', kind: 'leak', online: true,
    dp: { leak: false },
    raw: [{ code: 'battery_percentage', value: 91 }],
  },
];

let client = null;
let demo = false;
let creds = null;        // { clientId, clientSecret, uid, region }
let links = {};          // { tuyaDeviceId: roomName | '__main_valve__' }
let tuyaDevices = [];    // [{ id, name, kind, online, dp:{}, raw:[] }]
let pollTimer = null;
let driftTimer = null;   // deriva dos simulados (modo demo)
let listEl = null;
let lastMainValveOpen = null;  // edge-trigger do espelho de emergência
let leakAlertOn = {};          // edge-trigger de vazamento por dispositivo

// ------------------------------------------------------------
// Init / teardown
// ------------------------------------------------------------

export function initTuyaPanel(nexusClient) {
  client = nexusClient;
  demo = state.mode === 'demo';
  listEl = document.getElementById('ty-list');
  loadLinks();
  // dispositivos vinculados a um cômodo também aparecem (e são comandados) no painel Dispositivos
  registerVirtualRenderer('tuya-', (v) => {
    const td = tuyaDevices.find((x) => `tuya-${x.id}` === v.id);
    return td ? renderDevice(td, { compact: true }) : null;
  });

  document.getElementById('btn-ty-connect')?.addEventListener('click', onConnect);
  document.getElementById('btn-ty-disconnect')?.addEventListener('click', disconnect);
  document.getElementById('btn-ty-refresh')?.addEventListener('click', () => refresh(true));
  document.getElementById('ty-client-secret')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); onConnect(); }
  });
  on('rooms-changed', () => { if (isConnectedView()) renderDevices(); });

  // espelho da válvula nativa → válvula Tuya vinculada
  // (botão de emergência do monitor.js e toggle do painel de
  // dispositivos passam por aqui — edge-triggered, sem loop)
  on('device-changed', (dev) => {
    if (!dev || dev.id !== MAIN_VALVE_ID) return;
    const open = dev.status?.open !== false;
    if (lastMainValveOpen === null) { lastMainValveOpen = open; return; } // primeira carga: só registra
    if (open === lastMainValveOpen) return;
    lastMainValveOpen = open;
    mirrorMainValve(open);
  });

  document.getElementById('ty-demo-badge')?.classList.toggle('hidden', !demo);
  document.getElementById('ty-demo-note')?.classList.toggle('hidden', !demo);

  if (demo) {
    // demo: dispositivos simulados, sem credenciais nem rede
    tuyaDevices = DEMO_TUYA.map((d) => ({ ...d, dp: { ...d.dp }, raw: [...d.raw] }));
    showConnected();
    renderDevices();
    syncVirtualDevices();
    startDemoDrift();
  } else {
    creds = loadCreds();
    if (creds) {
      showConnected();
      refresh(true); // valida as credenciais salvas na primeira carga
    } else {
      showSetup();
    }
  }
}

export function teardownTuya() {
  stopPolling();
  stopDemoDrift();
}

function isConnectedView() {
  return !document.getElementById('ty-connected')?.classList.contains('hidden');
}

function showSetup() {
  document.getElementById('ty-setup')?.classList.remove('hidden');
  document.getElementById('ty-connected')?.classList.add('hidden');
}

function showConnected() {
  document.getElementById('ty-setup')?.classList.add('hidden');
  document.getElementById('ty-connected')?.classList.remove('hidden');
}

// ------------------------------------------------------------
// Credenciais (localStorage apenas) + conexão / desconexão
// ------------------------------------------------------------

function loadCreds() {
  try {
    const c = JSON.parse(localStorage.getItem(CREDS_KEY) || 'null');
    if (c && c.clientId && c.clientSecret && c.uid) return { region: 'us', ...c };
  } catch { /* modo restrito */ }
  return null;
}

async function onConnect() {
  const msg = document.getElementById('ty-setup-msg');
  const c = {
    clientId: (document.getElementById('ty-client-id')?.value || '').trim(),
    clientSecret: (document.getElementById('ty-client-secret')?.value || '').trim(),
    uid: (document.getElementById('ty-uid')?.value || '').trim(),
    region: document.getElementById('ty-region')?.value || 'us',
  };
  if (!c.clientId || !c.clientSecret || !c.uid) {
    if (msg) { msg.textContent = 'Preencha Client ID, Client Secret e UID antes de conectar.'; msg.classList.remove('hidden'); }
    return;
  }
  creds = c;
  setBusy(true, 'Validando…');
  try {
    await tuyaCall('token'); // valida as credenciais contra a Tuya
    await listDevices();     // e confirma que o UID tem dispositivos vinculados
    try { localStorage.setItem(CREDS_KEY, JSON.stringify(c)); } catch { /* modo restrito */ }
    ['ty-client-id', 'ty-client-secret', 'ty-uid'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    if (msg) msg.classList.add('hidden');
    showConnected();
    renderDevices();
    syncVirtualDevices();
    startPolling();
    toast('Tuya Smart Life conectado', `${tuyaDevices.length} dispositivo(s) encontrado(s).`, 'success');
  } catch (err) {
    creds = null;
    handleError(err, 'Validar credenciais');
  } finally {
    setBusy(false, 'Conectar');
  }
}

function disconnect() {
  stopPolling();
  creds = null;
  tuyaDevices = [];
  try {
    localStorage.removeItem(CREDS_KEY);
    localStorage.removeItem(LINKS_KEY);
  } catch { /* modo restrito */ }
  links = {};
  if (demo) {
    tuyaDevices = DEMO_TUYA.map((d) => ({ ...d, dp: { ...d.dp }, raw: [...d.raw] }));
    renderDevices();
    syncVirtualDevices();
    return;
  }
  syncVirtualDevices();
  showSetup();
  toast('Tuya desconectado', 'Credenciais e vínculos removidos deste navegador.', 'info');
}

function setBusy(b, label) {
  const btn = document.getElementById('btn-ty-connect');
  if (btn) { btn.disabled = b; btn.textContent = label; }
}

// ------------------------------------------------------------
// Camada de API (via proxy) — nunca chamada no modo demo
// ------------------------------------------------------------

async function tuyaCall(action, extra = {}) {
  const { data, error } = await client.functions.invoke('tuya-proxy', {
    body: { action, creds, ...extra },
  });
  if (error) {
    let body = null;
    try { body = await error.context?.json?.(); } catch { /* sem corpo */ }
    const err = new Error(body?.msg || body?.error || error.message || 'Falha na chamada Tuya');
    err.status = error.context?.status ?? 0;
    throw err;
  }
  // a Tuya responde HTTP 200 com success:false em erros de negócio
  if (data && data.success === false) {
    const err = new Error(data.msg || `Erro Tuya (código ${data.code})`);
    err.status = 200;
    throw err;
  }
  return data;
}

async function listDevices() {
  const data = await tuyaCall('request', {
    method: 'GET',
    path: `/v1.0/users/${creds.uid}/devices`,
  });
  const items = data?.result || [];
  // status sequencial (mesmo cuidado de rate-limit do SmartThings)
  const out = [];
  for (const item of items) {
    const entry = {
      id: item.id,
      name: item.name || 'Dispositivo Tuya',
      kind: 'other',
      online: item.online !== false,
      dp: {},
      raw: [],
    };
    try {
      const status = await tuyaCall('request', { method: 'GET', path: `/v1.0/devices/${item.id}/status` });
      const mapped = mapDatapoints(status?.result || []);
      entry.dp = mapped.dp;
      entry.raw = mapped.raw;
      entry.kind = detectKind(mapped.dp);
    } catch {
      entry.online = false; // dispositivo inalcançável no momento
    }
    out.push(entry);
  }
  tuyaDevices = out;
  return out;
}

/** Mapeia o array [{code, value}] do /status com o dicionário DP_MAP. */
function mapDatapoints(statusArr) {
  const dp = {};
  const raw = [];
  const findCode = (keys) => statusArr.find((s) => keys.includes(String(s.code || '').toLowerCase()));

  const sw = findCode(DP_MAP.switch);
  if (sw) { dp.on = sw.value === true || sw.value === 'true'; dp.switchCode = sw.code; }

  const flow = findCode(DP_MAP.flow);
  if (flow && Number.isFinite(Number(flow.value))) dp.flowLpm = Number(flow.value);

  const cons = findCode(DP_MAP.consumption);
  if (cons && Number.isFinite(Number(cons.value))) dp.consumption = Number(cons.value);

  const temp = findCode(DP_MAP.temperature);
  if (temp && Number.isFinite(Number(temp.value))) dp.temperature = Number(temp.value);

  const lvl = findCode(DP_MAP.levelPct);
  if (lvl && Number.isFinite(Number(lvl.value))) dp.levelPct = Math.max(0, Math.min(100, Number(lvl.value)));

  const depth = findCode(DP_MAP.depth);
  if (depth && Number.isFinite(Number(depth.value))) dp.depth = Number(depth.value);

  const leak = findCode(DP_MAP.leak);
  if (leak) dp.leak = LEAK_ALARM_VALUES.includes(String(leak.value).toLowerCase());

  // códigos não mapeados → seção "dados brutos"
  const known = new Set(Object.values(DP_MAP).flat());
  statusArr.forEach((s) => {
    if (!known.has(String(s.code || '').toLowerCase())) raw.push({ code: s.code, value: s.value });
  });

  return { dp, raw };
}

function detectKind(dp) {
  if (dp.leak !== undefined) return 'leak';
  if (dp.levelPct !== undefined || dp.depth !== undefined) return 'level';
  if (dp.switchCode || dp.flowLpm !== undefined) return 'valve_meter';
  return 'other';
}

// ------------------------------------------------------------
// Comandos (abrir/fechar válvula)
// ------------------------------------------------------------

async function sendValveCommand(d, open, origem = 'painel') {
  const label = open ? 'Abrir válvula' : 'Fechar válvula';
  if (demo) {
    d.dp.on = open;
    renderDevices();
    syncVirtualDevices();
    toast(`Comando enviado: ${label}`, `${d.name}${origem === 'emergência' ? ' (via botão de emergência)' : ''}`, open ? 'success' : 'warning');
    return;
  }
  if (!creds) return;
  try {
    await tuyaCall('request', {
      method: 'POST',
      path: `/v1.0/devices/${d.id}/commands`,
      payload: { commands: [{ code: d.dp.switchCode || 'switch', value: open }] },
    });
    d.dp.on = open; // otimista
    renderDevices();
    toast(`Comando enviado: ${label}`, d.name, open ? 'success' : 'warning');
    setTimeout(() => refresh(false), 1500); // reflete o novo estado
  } catch (err) {
    handleError(err, label);
  }
}

/** Espelha o estado da válvula nativa nas válvulas Tuya vinculadas. */
function mirrorMainValve(open) {
  tuyaDevices
    .filter((d) => d.kind === 'valve_meter' && links[d.id] === MAIN_VALVE_LINK && d.dp.switchCode)
    .forEach((d) => {
      if ((d.dp.on !== false) === open) return; // já está no estado certo
      sendValveCommand(d, open, 'emergência');
    });
}

function handleError(err, contexto) {
  console.error(`[tuya] ${contexto}:`, err);
  if (err.status === 401) {
    toast('Credenciais Tuya inválidas — confira Client ID/Secret no iot.tuya.com', contexto, 'critical');
  } else if (err.status === 403) {
    toast('Sem permissão — vincule o app Smart Life ao projeto Cloud.', contexto, 'critical');
  } else {
    toast('Falha na comunicação com a Tuya Cloud', err.message || contexto, 'critical');
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

let refreshing = false;   // evita duas atualizações ao mesmo tempo

function setRefreshBusy(busy) {
  const btn = document.getElementById('btn-ty-refresh');
  if (!btn) return;
  btn.disabled = busy;
  btn.textContent = busy ? 'Atualizando…' : 'Atualizar';
}

async function refresh(manual) {
  if (refreshing) return;
  if (demo) {
    renderDevices();
    if (manual) toast('Tuya atualizado', 'Dispositivos simulados (modo demonstração).', 'info');
    return;
  }
  if (!creds) return;
  refreshing = true;
  if (manual) setRefreshBusy(true);
  try {
    const n = (await listDevices()).length;
    renderDevices();
    syncVirtualDevices();
    processWaterSignals(); // alimenta métrica de água + alertas de vazamento
    if (manual) {
      if (n) toast('Tuya atualizado', `${n} dispositivo(s) lido(s).`, 'success');
      else toast('Nenhum dispositivo encontrado', 'Confira se o app Smart Life está vinculado ao projeto e se a região está correta.', 'warning');
    }
  } catch (err) {
    handleError(err, 'Atualizar dispositivos');
    if (err.status === 401) { stopPolling(); creds = null; showSetup(); }
  } finally {
    refreshing = false;
    if (manual) setRefreshBusy(false);
  }
}

// ------------------------------------------------------------
// Sinais hidráulicos: métrica de água, nível e vazamento
// ------------------------------------------------------------

/**
 * Após cada poll (ou deriva demo):
 *  · válvula-medidora vinculada à válvula nativa → grava
 *    water_flow_lph em telemetry_logs (o Monitor recebe pelo
 *    canal realtime já existente — mesmo caminho demo/live);
 *  · monitor de nível vinculado → grava water_level_pct
 *    (métrica criada na migração 005), ancorado no device_id da
 *    válvula geral (contexto hídrico — a FK exige um device);
 *  · sensor de vazamento em alarme → alerta CRÍTICO pelo
 *    pipeline existente (insertAlert do monitor.js).
 */
function processWaterSignals() {
  tuyaDevices.forEach((d) => {
    if (!d.online) return;
    const linked = !!links[d.id];

    if (d.kind === 'valve_meter' && links[d.id] === MAIN_VALVE_LINK && d.dp.flowLpm != null) {
      const lph = Math.round(d.dp.flowLpm * FLOW_TO_LPH);
      insertTelemetry(MAIN_VALVE_ID, 'water_flow_lph', lph);
    }
    if (d.kind === 'level' && linked && d.dp.levelPct != null) {
      insertTelemetry(MAIN_VALVE_ID, 'water_level_pct', Math.round(d.dp.levelPct));
    }
    if (d.kind === 'leak') {
      const alarm = !!d.dp.leak;
      const was = !!leakAlertOn[d.id];
      if (alarm && !was) {
        // insertAlert alimenta o feed do Monitor e dispara o toast crítico
        insertAlert('critical', `VAZAMENTO detectado por "${d.name}" (Smart Life/Tuya)`, 'tuya');
      } else if (!alarm && was) {
        insertAlert('info', `Sensor de vazamento "${d.name}" voltou ao normal`, 'tuya');
      }
      leakAlertOn[d.id] = alarm;
    }
  });
}

async function insertTelemetry(deviceId, metricType, value) {
  try {
    await client.from('telemetry_logs').insert({ device_id: deviceId, metric_type: metricType, value });
  } catch (err) {
    console.error('[tuya] falha ao gravar telemetria', err);
  }
}

// ------------------------------------------------------------
// Vínculos com cômodos / válvula nativa → dispositivos virtuais
// ------------------------------------------------------------

function loadLinks() {
  try { links = JSON.parse(localStorage.getItem(LINKS_KEY) || '{}') || {}; }
  catch { links = {}; }
}

function saveLinks() {
  try { localStorage.setItem(LINKS_KEY, JSON.stringify(links)); } catch { /* modo restrito */ }
}

function syncVirtualDevices() {
  // desvinculados (ou removidos da conta) saem do painel Dispositivos e da cena 3D
  const keep = new Set(tuyaDevices.filter((d) => links[d.id] && links[d.id] !== MAIN_VALVE_LINK).map((d) => `tuya-${d.id}`));
  state.devices.filter((d) => d.virtual && d.id.startsWith('tuya-') && !keep.has(d.id)).forEach((d) => removeDevice(d.id));
  tuyaDevices.forEach((d) => {
    const room = links[d.id];
    if (!room || room === MAIN_VALVE_LINK) return; // vínculo com a válvula nativa não cria device virtual
    upsertDevice({
      id: `tuya-${d.id}`,
      name: d.name,
      type: 'sensor',
      room,
      status: d.kind === 'valve_meter'
        ? { open: d.dp.on !== false }
        : { on: true },
      is_online: d.online,
      virtual: true, // não aparece no painel de dispositivos nem aceita escrita direta
    });
  });
}

// ------------------------------------------------------------
// API pública (para futuras integrações)
// ------------------------------------------------------------

/** Lista atual de dispositivos Tuya (id, name, kind, online, dp). */
export function getTuyaDevices() {
  return tuyaDevices;
}

/** Painel conectado? (no Modo Demonstração conta como conectado) */
export function isTuyaConnected() {
  return demo || !!creds;
}

// ---- deriva dos simulados (somente Modo Demonstração) -------
// Vazão em rajadas, nível passeando 60–95 %, e um evento raro de
// vazamento (~2% por ciclo, dura 2 ciclos) para exercitar o alerta.
function startDemoDrift() {
  stopDemoDrift();
  let leakTicksLeft = 0;
  driftTimer = setInterval(() => {
    tuyaDevices.forEach((d) => {
      if (d.kind === 'valve_meter') {
        if (d.dp.on === false) {
          d.dp.flowLpm = 0;
        } else if (Math.random() < 0.25) {
          d.dp.flowLpm = d.dp.flowLpm > 0 ? 0 : Math.round((4 + Math.random() * 20) * 10) / 10; // rajadas 4–24 L/min
        }
        if (d.dp.flowLpm > 0) d.dp.consumption = Math.round((d.dp.consumption + d.dp.flowLpm / 12) * 10) / 10;
        d.dp.temperature = clamp(d.dp.temperature + (Math.random() - 0.5) * 0.4, 18, 28);
      } else if (d.kind === 'level') {
        d.dp.levelPct = clamp(d.dp.levelPct + (Math.random() - 0.52) * 1.6, 60, 95);
        d.dp.depth = Math.round(d.dp.levelPct * 1.2);
      } else if (d.kind === 'leak') {
        if (leakTicksLeft > 0) {
          leakTicksLeft--;
          if (leakTicksLeft === 0) d.dp.leak = false;
        } else if (Math.random() < 0.02) {
          d.dp.leak = true;
          leakTicksLeft = 2;
        }
      }
    });
    renderDevices();
    syncVirtualDevices();
    processWaterSignals();
  }, 5000);
}

function stopDemoDrift() {
  if (driftTimer) { clearInterval(driftTimer); driftTimer = null; }
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, Math.round(v * 10) / 10));
}

// ------------------------------------------------------------
// Render
// ------------------------------------------------------------

const KIND_ICON = {
  valve_meter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/><path d="m12 12 2.5-2.5"/></svg>',
  level: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/><path d="M9 15a3 3 0 0 0 3 3"/></svg>',
  leak: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.7s6.5 7 6.5 11.3a6.5 6.5 0 0 1-13 0C5.5 9.7 12 2.7 12 2.7z"/><path d="M9.5 13.5a2.5 2.5 0 0 0 2.5 2.5"/></svg>',
  other: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/></svg>',
};
const KIND_LABEL = {
  valve_meter: 'Válvula/Medidor',
  level: 'Nível de caixa',
  leak: 'Sensor de vazamento',
  other: 'Dispositivo',
};

function renderDevices() {
  if (!listEl) return;
  listEl.innerHTML = '';

  if (!tuyaDevices.length) {
    listEl.innerHTML = '<p class="text-xs text-slate-500 px-1">Nenhum dispositivo encontrado na conta Smart Life vinculada.</p>';
    return;
  }

  // agrupa por tipo detectado, na ordem de relevância hidráulica
  const order = ['valve_meter', 'level', 'leak', 'other'];
  order.forEach((kind) => {
    tuyaDevices.filter((d) => d.kind === kind).forEach((d) => listEl.appendChild(renderDevice(d)));
  });
}

function renderDevice(d, opts = {}) {
  const compact = !!opts.compact;   // no painel Dispositivos: sem dados brutos nem seletor de vínculo
  const card = document.createElement('div');
  card.className = 'device-card glass-soft rounded-xl p-3 transition-all duration-200';
  card.dataset.tyId = d.id;

  const dp = d.dp;
  let controls = '';

  if (d.kind === 'valve_meter') {
    const open = dp.on !== false;
    controls = `
      <button data-ctl="valve" class="mt-2 w-full rounded-lg px-3 py-2 text-xs font-semibold tracking-wide transition-all ${open ? 'valve-open' : 'valve-closed'}">
        ${open ? 'ABERTA — fluxo liberado' : 'FECHADA — fluxo bloqueado'}
      </button>
      <div class="st-row">
        <span class="st-label">Vazão</span>
        <span class="text-sm font-semibold text-sky-300 tabular-nums">${dp.flowLpm != null ? `${dp.flowLpm.toFixed(1)} L/min` : '—'}</span>
      </div>
      ${dp.consumption != null ? `<div class="st-row"><span class="st-label">Consumo acumulado</span><span class="text-xs text-slate-300 tabular-nums">${dp.consumption.toFixed(1)} L</span></div>` : ''}
      ${dp.temperature != null ? `<div class="st-row"><span class="st-label">Temperatura</span><span class="text-xs text-slate-300 tabular-nums">${dp.temperature.toFixed(1)} °C</span></div>` : ''}`;
  } else if (d.kind === 'level') {
    const pct = dp.levelPct ?? 0;
    controls = `
      <div class="st-row">
        <span class="st-label">Nível</span>
        <span class="text-sm font-semibold text-cyan-300 tabular-nums">${Math.round(pct)}%</span>
      </div>
      <div class="ty-level-track mt-1.5">
        <div class="ty-level-fill" style="width: ${pct}%"></div>
      </div>
      ${dp.depth != null ? `<div class="st-row mt-1"><span class="st-label">Profundidade</span><span class="text-xs text-slate-300 tabular-nums">${dp.depth} cm</span></div>` : ''}`;
  } else if (d.kind === 'leak') {
    const alarm = !!dp.leak;
    controls = `
      <div class="mt-2 flex items-center justify-center">
        <span class="ty-leak-badge ${alarm ? 'ty-leak-alarm' : 'ty-leak-ok'}">
          ${alarm ? '⚠ ALERTA DE VAZAMENTO' : 'Normal — sem vazamento'}
        </span>
      </div>`;
  } else {
    controls = '<p class="text-[10px] text-slate-500 mt-2">Tipo não reconhecido — veja os dados brutos abaixo.</p>';
  }

  // dados brutos: datapoints não mapeados (descoberta dinâmica)
  const rawSection = d.raw.length
    ? `<details class="ty-raw mt-2">
         <summary>Dados brutos (${d.raw.length})</summary>
         <div class="ty-raw-list">
           ${d.raw.map((r) => `<div class="ty-raw-row"><span class="ty-raw-code">${escapeHtml(r.code)}</span><span class="ty-raw-value">${escapeHtml(JSON.stringify(r.value))}</span></div>`).join('')}
         </div>
       </details>`
    : '';

  // vínculo: cômodo da planta OU a válvula nativa (contexto hídrico)
  const link = links[d.id] || '';
  const linkOpts = ['<option value="">Sem vínculo</option>']
    .concat(`<option value="${MAIN_VALVE_LINK}" ${link === MAIN_VALVE_LINK ? 'selected' : ''}>Válvula de Água Geral (nativa)</option>`)
    .concat(getRoomNames().map((r) => `<option value="${escapeHtml(r)}" ${r === link ? 'selected' : ''}>${escapeHtml(r)}</option>`))
    .join('');

  card.innerHTML = `
    <div class="flex items-center gap-2.5">
      <span class="device-icon text-slate-300">${KIND_ICON[d.kind] || KIND_ICON.other}</span>
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium text-slate-100 truncate">${escapeHtml(d.name)}</p>
        <p class="text-[10px] text-slate-500">
          ${KIND_LABEL[d.kind] || 'Dispositivo'} ·
          ${d.online ? '<span class="text-emerald-400">●</span> online' : '<span class="text-slate-500">●</span> offline'}
        </p>
      </div>
    </div>
    ${controls}
    ${compact ? '' : `${rawSection}
    <div class="mt-2">
      <label class="form-label">Vincular a</label>
      <select data-ctl="link" class="form-input">${linkOpts}</select>
    </div>`}`;

  wireDevice(card, d);
  return card;
}

function wireDevice(card, d) {
  const q = (sel) => card.querySelector(sel);

  q('[data-ctl="valve"]')?.addEventListener('click', () => {
    const open = !(d.dp.on !== false); // inverte
    sendValveCommand(d, open);
  });

  q('[data-ctl="link"]')?.addEventListener('change', (e) => {
    const val = e.target.value;
    if (val) {
      links[d.id] = val;
      if (val === MAIN_VALVE_LINK) {
        toast('Dispositivo vinculado à válvula geral',
          d.kind === 'valve_meter'
            ? `${d.name}: a vazão real passa a alimentar o dashboard e o botão de emergência também comanda esta válvula.`
            : `${d.name}: leituras entram no contexto hídrico da casa.`,
          'success');
        // aplica o estado atual da válvula nativa na Tuya vinculada
        if (d.kind === 'valve_meter' && lastMainValveOpen !== null) mirrorMainValve(lastMainValveOpen);
        processWaterSignals();
      } else {
        toast('Dispositivo vinculado', `${d.name} → ${val}.`, 'success');
      }
    } else {
      delete links[d.id];
    }
    saveLinks();
    syncVirtualDevices();
  });
}
