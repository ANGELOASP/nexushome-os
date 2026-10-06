// ============================================================
// NexusHome OS — Painel de Automações (IFTTT)
// Lista, ativa/desativa, cria regras (modal) e avalia gatilhos
// no cliente: SE métrica (op) limiar ENTÃO ação no dispositivo.
//
// v1.5.0 — SmartThings nos DOIS lados da regra:
//   · gatilho:  { source:'smartthings', stDeviceId, metric, op, value }
//     (temperatura/umidade lidas do aparelho Samsung a cada poll)
//   · ação:     { type:'smartthings', stDeviceId, commands:[...] }
//     (comandos enviados pela Edge Function smartthings-proxy)
// ============================================================

import { state, on, emit, upsertAutomation, getDevice } from '../state.js';
import { toast, escapeHtml } from '../toasts.js';
import { updateStatus } from './devices.js';
import { getStDevices, getStDeviceInfo, isStConnected, executeStAutomationCommands } from './smartthings.js';

const METRICS = {
  energy_watts:   { label: 'Energia (W)',       unit: 'W' },
  water_flow_lph: { label: 'Fluxo de água (L/h)', unit: 'L/h' },
  temperature:    { label: 'Temperatura (°C)',   unit: '°C' },
  humidity:       { label: 'Umidade (%)',        unit: '%' },
};
const OPERATORS = { '>': 'maior que', '>=': 'maior ou igual a', '<': 'menor que', '<=': 'menor ou igual a', '==': 'igual a' };
const ST_METRICS = {
  temperature: { label: 'Temperatura', unit: '°C' },
  humidity:    { label: 'Umidade',     unit: '%' },
};

const COOLDOWN_MS = 20000;
const ST_AC_COOLDOWN_MS = 5 * 60 * 1000; // 5 min em ações de AC: evita "flapping" do compressor
const lastFired = new Map();        // automation id -> timestamp
const lastMetricValue = {};         // metric -> último valor (edge trigger)
const lastStValue = {};             // 'st|<id>|<metric>' -> último valor (edge trigger)

let client = null;
let modal, form;

export function initAutomationsPanel(nexusClient) {
  client = nexusClient;
  modal = document.getElementById('modal-automation');
  form = document.getElementById('form-automation');

  renderList();
  on('automations-changed', renderList);
  on('telemetry', ({ metric, value }) => evaluate(metric, value));
  on('st-readings', (readings) => evaluateStReadings(readings));   // gatilhos Samsung (v1.5.0)
  on('st-connection-changed', renderList);                         // badge "SmartThings offline"

  document.getElementById('btn-new-automation')?.addEventListener('click', openModal);
  document.getElementById('btn-cancel-automation')?.addEventListener('click', closeModal);
  modal?.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  document.getElementById('f-device')?.addEventListener('change', refreshActionOptions);
  document.getElementById('f-action')?.addEventListener('change', refreshValueInput);
  form?.addEventListener('submit', onCreate);
  document.getElementById('automations-list')?.addEventListener('click', onListClick);
}

// ------------------------------------------------------------
// Lista
// ------------------------------------------------------------

function renderList() {
  const list = document.getElementById('automations-list');
  if (!list) return;
  if (!state.automations.length) {
    list.innerHTML = '<p class="text-xs text-slate-500 px-1 py-2">Nenhuma automação. Crie a primeira regra no botão abaixo.</p>';
    return;
  }
  const stOffline = !isStConnected();
  list.innerHTML = '';
  state.automations.forEach((a) => {
    const st = isStRule(a);
    const badges = st
      ? `<span class="inline-flex items-center rounded-full border border-sky-400/40 bg-sky-400/10 px-1.5 py-px text-[8px] font-bold uppercase tracking-wider text-sky-300">Samsung</span>
         ${stOffline ? '<span class="inline-flex items-center rounded-full border border-amber-400/40 bg-amber-400/10 px-1.5 py-px text-[8px] font-bold tracking-wider text-amber-300">⏸ SmartThings offline</span>' : ''}`
      : '';
    const el = document.createElement('div');
    el.className = `automation-item glass-soft rounded-xl p-3 ${a.is_active ? '' : 'automation-off'}`;
    el.innerHTML = `
      <div class="flex items-center gap-3">
        <label class="switch switch-sm" title="Ativar/desativar">
          <input type="checkbox" data-auto-toggle="${a.id}" ${a.is_active ? 'checked' : ''}>
          <span class="slider-ui"></span>
        </label>
        <div class="min-w-0 flex-1">
          <p class="text-xs font-semibold text-slate-100 truncate">${escapeHtml(a.name || 'Automação')}</p>
          <p class="text-[11px] text-slate-400 leading-snug mt-0.5">${escapeHtml(describe(a))}</p>
          ${badges ? `<div class="mt-1 flex flex-wrap gap-1">${badges}</div>` : ''}
        </div>
      </div>`;
    list.appendChild(el);
  });
}

function isStRule(a) {
  return a?.trigger_condition?.source === 'smartthings' || a?.action_payload?.type === 'smartthings';
}

function describe(a) {
  const t = a.trigger_condition || {};
  const p = a.action_payload || {};
  if (t.source === 'smartthings') {
    const dev = getStDeviceInfo(t.stDeviceId);
    const m = ST_METRICS[t.metric]?.label || t.metric || '?';
    const unit = ST_METRICS[t.metric]?.unit || '';
    const op = OPERATORS[t.op] || t.op || '?';
    // dispara só na transição (edge trigger): a borda funciona como
    // histerese — a regra não repete enquanto a condição continuar valendo
    return `Se ${m} de ${dev?.name || 'aparelho Samsung'} ${op} ${t.value} ${unit} → ${describeStAction(p)} · dispara só na transição (histerese de borda)`;
  }
  const m = METRICS[t.metric]?.label || t.metric || '?';
  const op = OPERATORS[t.operator] || t.operator || '?';
  const dev = getDevice(p.device_id);
  return `Se ${m} ${op} ${t.threshold} ${METRICS[t.metric]?.unit || ''} → ${p.type === 'smartthings' ? describeStAction(p) : describeAction(dev, p)}`;
}

function describeAction(device, p) {
  const name = device?.name || 'dispositivo';
  switch (p.action) {
    case 'power': return `${p.value ? 'ligar' : 'desligar'} ${name}`;
    case 'valve': return `${p.value ? 'abrir' : 'fechar'} ${name}`;
    case 'temp': return `ajustar ${name} para ${p.value}°C`;
    case 'brightness': return `brilho de ${name} em ${p.value}%`;
    case 'color': return `cor de ${name} para ${p.value}`;
    default: return `acionar ${name}`;
  }
}

const ST_MODE_LABEL = Object.fromEntries([['cool', 'Frio'], ['heat', 'Quente'], ['dry', 'Desumidificar'], ['wind', 'Ventilar'], ['auto', 'Automático']]);

function describeStAction(p) {
  const dev = getStDeviceInfo(p.stDeviceId);
  const name = dev?.name || 'aparelho Samsung';
  const parts = [];
  (p.commands || []).forEach((c) => {
    if (c.capability === 'switch') parts.push(c.command === 'on' ? 'ligar' : 'desligar');
    else if (c.capability === 'airConditionerMode') parts.push(`modo ${ST_MODE_LABEL[c.arguments?.[0]] || c.arguments?.[0]}`);
    else if (c.capability === 'thermostatCoolingSetpoint') parts.push(`${c.arguments?.[0]} °C`);
    else if (c.capability === 'audioMute') parts.push(c.command === 'mute' ? 'mudo' : 'som ativo');
    else if (c.capability === 'audioVolume') parts.push(`volume ${c.arguments?.[0]}`);
    else parts.push(c.command);
  });
  return `${parts.join(' · ') || 'comandar'} ${name}`;
}

async function onListClick(e) {
  const toggle = e.target.closest('[data-auto-toggle]');
  if (!toggle) return;
  const id = toggle.dataset.autoToggle;
  const a = state.automations.find((x) => x.id === id);
  if (!a) return;
  upsertAutomation({ ...a, is_active: toggle.checked });
  try {
    const { error } = await client.from('automations').update({ is_active: toggle.checked }).eq('id', id);
    if (error) throw new Error(error.message);
    toast(toggle.checked ? 'Automação ativada' : 'Automação pausada', a.name, 'info');
  } catch (err) {
    toast('Falha ao atualizar automação', err.message, 'critical');
  }
}

// ------------------------------------------------------------
// Modal de criação
// ------------------------------------------------------------

function openModal() {
  const devSel = document.getElementById('f-device');
  devSel.innerHTML = state.devices
    .map((d) => `<option value="${d.id}">${escapeHtml(d.name)} — ${escapeHtml(d.room)}</option>`)
    .join('');

  // v1.5.0: com SmartThings conectado, sensores Samsung entram como gatilho
  // (optgroup no seletor de métrica) e os aparelhos como alvo de ação
  injectSmartThingsOptions();

  refreshActionOptions();
  modal.classList.add('modal-open');
  document.getElementById('f-name')?.focus();
}

function injectSmartThingsOptions() {
  const metricSel = document.getElementById('f-metric');
  const devSel = document.getElementById('f-device');
  metricSel?.querySelector('optgroup[data-st]')?.remove();
  devSel?.querySelector('optgroup[data-st]')?.remove();
  if (!isStConnected() || !getStDevices().length) return;

  const mGrp = document.createElement('optgroup');
  mGrp.label = 'Aparelhos Samsung';
  mGrp.dataset.st = '1';
  getStDevices().forEach((d) => {
    Object.entries(ST_METRICS).forEach(([metric, def]) => {
      const opt = document.createElement('option');
      opt.value = `st|${d.id}|${metric}`;
      opt.textContent = `Samsung · ${d.name} · ${def.label} (${def.unit})`;
      mGrp.appendChild(opt);
    });
  });
  metricSel.appendChild(mGrp);

  const dGrp = document.createElement('optgroup');
  dGrp.label = 'Samsung SmartThings';
  dGrp.dataset.st = '1';
  getStDevices().forEach((d) => {
    const opt = document.createElement('option');
    opt.value = `st|${d.id}`;
    opt.textContent = `${d.name} (Samsung)`;
    dGrp.appendChild(opt);
  });
  devSel.appendChild(dGrp);
}

function closeModal() {
  modal.classList.remove('modal-open');
  form.reset();
}

function actionsFor(type) {
  switch (type) {
    case 'light': return [
      { v: 'power', label: 'Ligar / desligar' },
      { v: 'brightness', label: 'Definir brilho (%)' },
      { v: 'color', label: 'Definir cor' },
    ];
    case 'ac': return [
      { v: 'power', label: 'Ligar / desligar' },
      { v: 'temp', label: 'Definir temperatura (°C)' },
    ];
    case 'valve': return [{ v: 'valve', label: 'Abrir / fechar' }];
    default: return [];
  }
}

function refreshActionOptions() {
  const selValue = document.getElementById('f-device').value;
  const actSel = document.getElementById('f-action');
  if (selValue?.startsWith('st|')) {
    // alvo SmartThings: comando único "builder" montado no campo de valor
    actSel.innerHTML = '<option value="st">Comandos SmartThings</option>';
    refreshValueInput();
    return;
  }
  const dev = getDevice(selValue);
  const actions = actionsFor(dev?.type);
  actSel.innerHTML = actions.length
    ? actions.map((a) => `<option value="${a.v}">${a.label}</option>`).join('')
    : '<option value="">(sem ações para este tipo)</option>';
  refreshValueInput();
}

function refreshValueInput() {
  const selValue = document.getElementById('f-device').value;
  const action = document.getElementById('f-action').value;
  const wrap = document.getElementById('f-value-wrap');

  if (selValue?.startsWith('st|')) {
    wrap.innerHTML = buildStActionForm(selValue.slice(3));
    return;
  }

  const dev = getDevice(selValue);
  let html = '';
  if (action === 'power') {
    html = `<select id="f-value" class="form-input"><option value="true">Ligar</option><option value="false">Desligar</option></select>`;
  } else if (action === 'valve') {
    html = `<select id="f-value" class="form-input"><option value="true">Abrir</option><option value="false">Fechar</option></select>`;
  } else if (action === 'brightness') {
    html = `<input id="f-value" type="number" min="1" max="100" value="80" class="form-input" required>`;
  } else if (action === 'temp') {
    html = `<input id="f-value" type="number" min="16" max="30" value="22" class="form-input" required>`;
  } else if (action === 'color') {
    html = `<input id="f-value" type="color" value="#ffd9a0" class="form-input h-10 p-1">`;
  }
  wrap.innerHTML = html;
}

// ---- construtor compacto de comandos SmartThings (modal) ---------------
// AC → ligar/desligar + modo + temperatura · TV → ligar/desligar + mudo
function buildStActionForm(stDeviceId) {
  const info = getStDeviceInfo(stDeviceId);
  const power = `
    <label class="form-label">Energia</label>
    <select id="f-st-power" class="form-input">
      <option value="on">Ligar</option>
      <option value="off">Desligar</option>
    </select>`;
  if (info?.kind === 'ac') {
    return `${power}
    <div class="grid grid-cols-2 gap-2 mt-2">
      <div>
        <label class="form-label">Modo</label>
        <select id="f-st-mode" class="form-input">
          ${Object.entries(ST_MODE_LABEL).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
        </select>
      </div>
      <div>
        <label class="form-label">Temperatura</label>
        <input id="f-st-temp" type="number" min="16" max="30" value="23" class="form-input" required>
      </div>
    </div>
    <p class="text-[10px] text-slate-500 mt-2">Modo e temperatura só são enviados ao ligar. Ações em AC respeitam cooldown de 5 min (protege o compressor).</p>`;
  }
  if (info?.kind === 'tv') {
    return `${power}
    <div class="mt-2">
      <label class="form-label">Mudo</label>
      <select id="f-st-mute" class="form-input">
        <option value="">Sem alteração</option>
        <option value="mute">Ativar mudo</option>
        <option value="unmute">Desativar mudo</option>
      </select>
    </div>`;
  }
  return power;
}

function readStCommands(stDeviceId) {
  const power = document.getElementById('f-st-power')?.value || 'on';
  const commands = [{ component: 'main', capability: 'switch', command: power, arguments: [] }];
  const info = getStDeviceInfo(stDeviceId);
  if (power === 'on' && info?.kind === 'ac') {
    const mode = document.getElementById('f-st-mode')?.value;
    const temp = Number(document.getElementById('f-st-temp')?.value);
    if (mode) commands.push({ component: 'main', capability: 'airConditionerMode', command: 'setAirConditionerMode', arguments: [mode] });
    if (Number.isFinite(temp)) commands.push({ component: 'main', capability: 'thermostatCoolingSetpoint', command: 'setCoolingSetpoint', arguments: [Math.min(30, Math.max(16, temp))] });
  }
  if (power === 'on' && info?.kind === 'tv') {
    const mute = document.getElementById('f-st-mute')?.value;
    if (mute) commands.push({ component: 'main', capability: 'audioMute', command: mute, arguments: [] });
  }
  return commands;
}

async function onCreate(e) {
  e.preventDefault();
  const name = document.getElementById('f-name').value.trim() || 'Nova automação';
  const metricRaw = document.getElementById('f-metric').value;
  const operator = document.getElementById('f-operator').value;
  const threshold = Number(document.getElementById('f-threshold').value);
  const deviceRaw = document.getElementById('f-device').value;
  const action = document.getElementById('f-action').value;
  const valueEl = document.getElementById('f-value');

  // ---- gatilho: telemetria nativa OU sensor SmartThings ------------------
  let trigger_condition;
  if (metricRaw.startsWith('st|')) {
    const [, stDeviceId, metric] = metricRaw.split('|');
    if (!stDeviceId || !ST_METRICS[metric]) { toast('Selecione um sensor Samsung válido', '', 'warning'); return; }
    if (!Number.isFinite(threshold)) { toast('Informe o limiar do gatilho', '', 'warning'); return; }
    trigger_condition = { source: 'smartthings', stDeviceId, metric, op: operator, value: threshold };
  } else {
    trigger_condition = { metric: metricRaw, operator, threshold };
  }

  // ---- ação: dispositivo nativo OU comandos SmartThings ------------------
  let action_payload;
  if (deviceRaw.startsWith('st|')) {
    const stDeviceId = deviceRaw.slice(3);
    const commands = readStCommands(stDeviceId);
    if (!commands.length) { toast('Monte ao menos um comando SmartThings', '', 'warning'); return; }
    action_payload = { type: 'smartthings', stDeviceId, commands };
  } else {
    if (!action || !valueEl) { toast('Selecione um dispositivo com ações disponíveis', '', 'warning'); return; }
    let value;
    if (valueEl.type === 'number') value = Number(valueEl.value);
    else if (valueEl.value === 'true') value = true;
    else if (valueEl.value === 'false') value = false;
    else value = valueEl.value;
    action_payload = { device_id: deviceRaw, action, value };
  }

  const row = { name, trigger_condition, action_payload, is_active: true };

  try {
    const { data, error } = await client.from('automations').insert(row).select();
    if (error) throw new Error(error.message);
    if (data?.[0]) upsertAutomation(data[0]);
    toast('Automação criada e ativada', name, 'success');
    closeModal();
  } catch (err) {
    toast('Falha ao criar automação', err.message, 'critical');
  }
}

// ------------------------------------------------------------
// Avaliador de regras (client-side, edge-trigger + cooldown)
// ------------------------------------------------------------

function compare(v, op, th) {
  switch (op) {
    case '>': return v > th;
    case '>=': return v >= th;
    case '<': return v < th;
    case '<=': return v <= th;
    case '==': return v === th;
    default: return false;
  }
}

function evaluate(metric, value) {
  const now = Date.now();
  for (const a of state.automations) {
    if (!a.is_active) continue;
    const t = a.trigger_condition || {};
    if (t.source === 'smartthings') continue; // avaliado em evaluateStReadings
    if (t.metric !== metric) continue;
    const th = Number(t.threshold);
    if (!compare(value, t.operator, th)) continue;

    // dispara apenas na transição (valor anterior não satisfazia)
    const prev = lastMetricValue[metric];
    if (prev !== undefined && compare(prev, t.operator, th)) continue;

    // cooldown por automação
    if (now - (lastFired.get(a.id) || 0) < COOLDOWN_MS) continue;
    lastFired.set(a.id, now);

    executeAutomation(a);
  }
  lastMetricValue[metric] = value;
}

// ------------------------------------------------------------
// Avaliador de gatilhos SmartThings (a cada poll/deriva demo)
// ------------------------------------------------------------

function evaluateStReadings(readings) {
  if (!readings) return;
  if (!isStConnected()) return; // offline: regras ST ficam pausadas (badge na lista)
  const now = Date.now();
  for (const a of state.automations) {
    if (!a.is_active) continue;
    const t = a.trigger_condition || {};
    if (t.source !== 'smartthings') continue;

    const r = readings[t.stDeviceId];
    const value = r?.[t.metric];
    if (value == null || !r.online) continue;
    if (!compare(value, t.op, Number(t.value))) continue;

    // edge trigger por aparelho+métrica (a borda funciona como histerese)
    const key = `st|${t.stDeviceId}|${t.metric}`;
    const prev = lastStValue[key];
    if (prev !== undefined && compare(prev, t.op, Number(t.value))) continue;

    // cooldown: 5 min quando a ação mexe num AC (protege o compressor)
    const cooldown = stActionTargetsAc(a.action_payload) ? ST_AC_COOLDOWN_MS : COOLDOWN_MS;
    if (now - (lastFired.get(a.id) || 0) < cooldown) continue;
    lastFired.set(a.id, now);

    executeAutomation(a);
  }
  // atualiza os valores anteriores de TODOS os sensores lidos (mesmo os que
  // não dispararam), senão o edge trigger perde a referência de transição
  Object.entries(readings).forEach(([id, r]) => {
    if (r.temperature != null) lastStValue[`st|${id}|temperature`] = r.temperature;
    if (r.humidity != null) lastStValue[`st|${id}|humidity`] = r.humidity;
  });
}

function stActionTargetsAc(payload) {
  if (payload?.type !== 'smartthings') return false;
  if (getStDeviceInfo(payload.stDeviceId)?.kind === 'ac') return true;
  // fallback sem o painel populado: comandos de termostato denunciam AC
  return (payload.commands || []).some((c) =>
    c.capability === 'airConditionerMode' || c.capability === 'thermostatCoolingSetpoint');
}

async function executeAutomation(a) {
  const p = a.action_payload || {};

  // ---- alvo SmartThings (v1.5.0) ----------------------------------------
  if (p.type === 'smartthings') {
    try {
      const dev = await executeStAutomationCommands(p.stDeviceId, p.commands || []);
      toast(`Automação '${a.name}' executada`, `${dev.name}: ${describeStAction(p)}`, 'success');
    } catch (err) {
      console.error('[automations] falha na ação SmartThings', err);
      toast(`Automação '${a.name}' falhou`, err.message, 'critical');
    }
    return;
  }

  // ---- alvo nativo (tabela devices) --------------------------------------
  const device = getDevice(p.device_id);
  if (!device) return;

  let patch = null;
  switch (p.action) {
    case 'power': patch = { on: !!p.value }; break;
    case 'valve': patch = { open: !!p.value }; break;
    case 'temp': patch = { temp: Number(p.value) }; break;
    case 'brightness': patch = { brightness: Number(p.value) }; break;
    case 'color': patch = { color: String(p.value) }; break;
  }
  if (!patch) return;

  toast('Automação executada', `${a.name}: ${describeAction(device, p)}`, 'info');
  await updateStatus(device, patch, null);
}

// ------------------------------------------------------------
// Carga inicial + realtime
// ------------------------------------------------------------

export async function loadAutomations() {
  const { data, error } = await client.from('automations').select('*').order('created_at', { ascending: true });
  if (!error && data) {
    state.automations = data;
    emit('automations-changed', state.automations);
  }
}

export function subscribeAutomations() {
  return [
    client.channel('automations-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'automations' }, (payload) => {
        if (payload.eventType === 'DELETE') {
          state.automations = state.automations.filter((a) => a.id !== payload.old?.id);
          emit('automations-changed', state.automations);
          return;
        }
        upsertAutomation(payload.new);
      })
      .subscribe(),
  ];
}
