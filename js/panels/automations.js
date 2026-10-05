// ============================================================
// NexusHome OS — Painel de Automações (IFTTT)
// Lista, ativa/desativa, cria regras (modal) e avalia gatilhos
// no cliente: SE métrica (op) limiar ENTÃO ação no dispositivo.
// ============================================================

import { state, on, emit, upsertAutomation, getDevice } from '../state.js';
import { toast, escapeHtml } from '../toasts.js';
import { updateStatus } from './devices.js';

const METRICS = {
  energy_watts:   { label: 'Energia (W)',       unit: 'W' },
  water_flow_lph: { label: 'Fluxo de água (L/h)', unit: 'L/h' },
  temperature:    { label: 'Temperatura (°C)',   unit: '°C' },
  humidity:       { label: 'Umidade (%)',        unit: '%' },
};
const OPERATORS = { '>': 'maior que', '>=': 'maior ou igual a', '<': 'menor que', '<=': 'menor ou igual a', '==': 'igual a' };

const COOLDOWN_MS = 20000;
const lastFired = new Map();        // automation id -> timestamp
const lastMetricValue = {};         // metric -> último valor (edge trigger)

let client = null;
let modal, form;

export function initAutomationsPanel(nexusClient) {
  client = nexusClient;
  modal = document.getElementById('modal-automation');
  form = document.getElementById('form-automation');

  renderList();
  on('automations-changed', renderList);
  on('telemetry', ({ metric, value }) => evaluate(metric, value));

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
  list.innerHTML = '';
  state.automations.forEach((a) => {
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
        </div>
      </div>`;
    list.appendChild(el);
  });
}

function describe(a) {
  const t = a.trigger_condition || {};
  const p = a.action_payload || {};
  const m = METRICS[t.metric]?.label || t.metric || '?';
  const op = OPERATORS[t.operator] || t.operator || '?';
  const dev = getDevice(p.device_id);
  return `Se ${m} ${op} ${t.threshold} ${METRICS[t.metric]?.unit || ''} → ${describeAction(dev, p)}`;
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
  refreshActionOptions();
  modal.classList.add('modal-open');
  document.getElementById('f-name')?.focus();
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
  const dev = getDevice(document.getElementById('f-device').value);
  const actSel = document.getElementById('f-action');
  const actions = actionsFor(dev?.type);
  actSel.innerHTML = actions.length
    ? actions.map((a) => `<option value="${a.v}">${a.label}</option>`).join('')
    : '<option value="">(sem ações para este tipo)</option>';
  refreshValueInput();
}

function refreshValueInput() {
  const dev = getDevice(document.getElementById('f-device').value);
  const action = document.getElementById('f-action').value;
  const wrap = document.getElementById('f-value-wrap');
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

async function onCreate(e) {
  e.preventDefault();
  const name = document.getElementById('f-name').value.trim() || 'Nova automação';
  const metric = document.getElementById('f-metric').value;
  const operator = document.getElementById('f-operator').value;
  const threshold = Number(document.getElementById('f-threshold').value);
  const deviceId = document.getElementById('f-device').value;
  const action = document.getElementById('f-action').value;
  const valueEl = document.getElementById('f-value');

  if (!action || !valueEl) { toast('Selecione um dispositivo com ações disponíveis', '', 'warning'); return; }
  let value;
  if (valueEl.type === 'number') value = Number(valueEl.value);
  else if (valueEl.value === 'true') value = true;
  else if (valueEl.value === 'false') value = false;
  else value = valueEl.value;

  const row = {
    name,
    trigger_condition: { metric, operator, threshold },
    action_payload: { device_id: deviceId, action, value },
    is_active: true,
  };

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

async function executeAutomation(a) {
  const p = a.action_payload || {};
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
