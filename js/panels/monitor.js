// ============================================================
// NexusHome OS — Painel de Telemetria & Segurança
// Energia (W), água (L/h), badge de saúde, feed de alertas,
// detecção de vazamento e botão de emergência da válvula geral.
// ============================================================

import { state, on, emit, upsertDevice, prependAlert, allDevicesOff, getDevice } from '../state.js';
import { toast, escapeHtml } from '../toasts.js';
import { Sparkline, animateNumber } from '../charts.js';
import { updateStatus } from './devices.js';
import { houseWatts, energyBands, energyBand } from '../energy.js';

const LEAK_WINDOW_MS = 30000;

let client = null;
let sparkEnergy, sparkWater;
let currentBand = 'ok';           // 'ok' | 'warn' | 'crit'
let flowHistory = [];             // [{t, v}] para detecção de vazamento
const energyLatest = new Map();   // deviceId -> {w, t}: o painel mostra a SOMA dos medidores (v2.11)
let leakAlertActive = false;

export function initMonitorPanel(nexusClient) {
  client = nexusClient;

  sparkEnergy = new Sparkline(document.getElementById('spark-energy'), { stroke: '#fbbf24', fill: '#f59e0b', min: 0 });
  sparkWater = new Sparkline(document.getElementById('spark-water'), { stroke: '#38bdf8', fill: '#0ea5e9', min: 0 });

  document.getElementById('btn-emergency')?.addEventListener('click', emergencyShutoff);
  document.getElementById('alerts-list')?.addEventListener('click', onAlertAction);

  on('alerts-changed', renderAlerts);
  on('device-changed', (d) => { if (d?.type === 'valve') syncEmergencyButton(d.status?.open !== false); });
  on('telemetry', ({ metric, value, deviceId }) => handleTelemetry(metric, value, deviceId));
}

// ------------------------------------------------------------
// Telemetria recebida (via realtime / mock)
// ------------------------------------------------------------

function handleTelemetry(metric, value, deviceId) {
  state.lastTelemetry[metric] = value;

  if (metric === 'energy_watts') {
    // vários medidores (quadro elétrico): soma da última leitura de cada um
    if (deviceId) {
      energyLatest.set(deviceId, { w: value, t: Date.now() });
      value = houseWatts(energyLatest, getDevice);
      state.lastTelemetry.energy_watts = value;
    }
    sparkEnergy.push(value);
    animateNumber(document.getElementById('stat-energy'), value, { suffix: ' W' });
    checkEnergyThresholds(value);
  } else if (metric === 'water_flow_lph') {
    sparkWater.push(value);
    animateNumber(document.getElementById('stat-water'), value, { suffix: ' L/h' });
    checkLeak(value);
  } else if (metric === 'temperature') {
    animateNumber(document.getElementById('stat-temp'), value, { decimals: 1, suffix: '°C' });
  } else if (metric === 'humidity') {
    animateNumber(document.getElementById('stat-hum'), value, { suffix: '%' });
  }
  updateHealthBadge();
}

function checkEnergyThresholds(watts) {
  // faixas: 3000/4500 W com um medidor só; com o quadro elétrico, o limite de demanda do firmware
  const bands = energyBands(state.devices);
  const band = energyBand(watts, bands);
  if (band !== currentBand) {
    if (band === 'warn') {
      insertAlert('warning', `Consumo de energia elevado: ${Math.round(watts)} W (acima de ${bands.warning} W)`, 'telemetria');
    } else if (band === 'crit') {
      insertAlert('critical', `Consumo de energia CRÍTICO: ${Math.round(watts)} W (acima de ${bands.critical} W)`, 'telemetria');
    }
    currentBand = band;
  }
}

function checkLeak(flow) {
  const now = Date.now();
  flowHistory.push({ t: now, v: flow });
  flowHistory = flowHistory.filter((p) => now - p.t <= LEAK_WINDOW_MS + 8000);

  const windowPoints = flowHistory.filter((p) => now - p.t <= LEAK_WINDOW_MS);
  const longEnough = windowPoints.length && (now - windowPoints[0].t) >= LEAK_WINDOW_MS;
  const allPositive = windowPoints.length > 2 && windowPoints.every((p) => p.v > 0);

  if (longEnough && allPositive && allDevicesOff() && !leakAlertActive) {
    leakAlertActive = true;
    insertAlert('warning', 'Possível vazamento: fluxo de água contínuo há mais de 30 s com todos os dispositivos desligados', 'segurança');
  }
  if (flow === 0 && leakAlertActive) leakAlertActive = false; // rearmar quando o fluxo para
}

// ------------------------------------------------------------
// Saúde do sistema
// ------------------------------------------------------------

function computeHealth() {
  if (state.alerts.some((a) => !a.resolved && a.severity === 'critical')) return 'critical';
  const band = energyBand(state.lastTelemetry.energy_watts || 0, energyBands(state.devices));
  if (band === 'crit') return 'critical';
  if (band === 'warn') return 'warning';
  if (state.alerts.some((a) => !a.resolved && a.severity === 'warning')) return 'warning';
  return 'safe';
}

const HEALTH_UI = {
  safe:     { label: 'Seguro',   cls: 'health-safe' },
  warning:  { label: 'Atenção',  cls: 'health-warning' },
  critical: { label: 'Crítico',  cls: 'health-critical' },
};

export function updateHealthBadge() {
  const h = computeHealth();
  state.health = h;
  const el = document.getElementById('health-badge');
  if (!el) return;
  const ui = HEALTH_UI[h];
  el.className = `health-badge ${ui.cls}`;
  el.querySelector('[data-health-label]').textContent = ui.label;
}

// ------------------------------------------------------------
// Alertas
// ------------------------------------------------------------

export async function insertAlert(severity, message, sourceModule) {
  const row = { severity, message, source_module: sourceModule, resolved: false };
  try {
    const { data, error } = await client.from('alerts').insert(row).select();
    if (error) throw new Error(error.message);
    if (data?.[0]) prependAlert(data[0]); // otimista (o realtime também emite, prependAlert deduplica)
  } catch (err) {
    console.error('[alerts] falha ao inserir', err);
  }
}

const SEVERITY_UI = {
  info:     { cls: 'alert-info',     label: 'Info' },
  warning:  { cls: 'alert-warning',  label: 'Atenção' },
  critical: { cls: 'alert-critical', label: 'Crítico' },
};

function renderAlerts(alerts) {
  const list = document.getElementById('alerts-list');
  if (!list) return;
  if (!alerts.length) {
    list.innerHTML = '<p class="text-xs text-slate-500 px-1 py-2">Nenhum alerta registrado. Sistema operando normalmente.</p>';
    return;
  }
  list.innerHTML = '';
  alerts.slice(0, 20).forEach((a) => {
    const ui = SEVERITY_UI[a.severity] || SEVERITY_UI.info;
    const el = document.createElement('div');
    el.className = `alert-item ${ui.cls} ${a.resolved ? 'alert-resolved' : ''}`;
    const time = a.created_at ? new Date(a.created_at).toLocaleTimeString('pt-BR') : '';
    el.innerHTML = `
      <div class="flex items-start gap-2">
        <span class="alert-sev">${ui.label}</span>
        <div class="min-w-0 flex-1">
          <p class="text-xs text-slate-200 leading-snug">${escapeHtml(a.message)}</p>
          <p class="text-[10px] text-slate-500 mt-0.5">${escapeHtml(a.source_module || 'sistema')} · ${time}</p>
        </div>
        ${a.resolved
          ? '<span class="text-[10px] text-slate-500 shrink-0">resolvido</span>'
          : `<button class="alert-resolve shrink-0" data-alert-id="${a.id}" title="Marcar como resolvido">Resolver</button>`}
      </div>`;
    list.appendChild(el);
  });
  updateHealthBadge();
}

async function onAlertAction(e) {
  const btn = e.target.closest('[data-alert-id]');
  if (!btn) return;
  const id = btn.dataset.alertId;
  btn.disabled = true;
  try {
    const { error } = await client.from('alerts').update({ resolved: true }).eq('id', id);
    if (error) throw new Error(error.message);
    const a = state.alerts.find((x) => x.id === id);
    if (a) { a.resolved = true; emit('alerts-changed', state.alerts); }
    toast('Alerta resolvido', '', 'success');
  } catch (err) {
    toast('Falha ao resolver alerta', err.message, 'critical');
  }
}

// ------------------------------------------------------------
// Botão de emergência — fecha a válvula geral de água
// ------------------------------------------------------------

async function emergencyShutoff() {
  const btn = document.getElementById('btn-emergency');
  const valve = state.devices.find((d) => d.type === 'valve');
  if (!valve) { toast('Válvula não encontrada', '', 'critical'); return; }

  btn?.classList.add('btn-pressed');
  setTimeout(() => btn?.classList.remove('btn-pressed'), 300);

  await updateStatus(valve, { open: false }, 'Válvula de água geral FECHADA', 'warning');
  await insertAlert('critical', 'Acionamento manual: válvula de água geral fechada pelo usuário', 'emergência');
}

function syncEmergencyButton(isOpen) {
  const btn = document.getElementById('btn-emergency');
  if (!btn) return;
  btn.classList.toggle('emergency-done', !isOpen);
  btn.querySelector('[data-emergency-label]').textContent = isOpen
    ? 'FECHAR VÁLVULA DE ÁGUA GERAL'
    : 'VÁLVULA GERAL FECHADA';
}

// ------------------------------------------------------------
// Carga inicial + assinaturas realtime
// ------------------------------------------------------------

export async function loadInitialMonitorData() {
  const { data: alerts } = await client.from('alerts').select('*').order('created_at', { ascending: false }).limit(20);
  state.alerts = alerts || [];
  emit('alerts-changed', state.alerts);

  const { data: logs } = await client.from('telemetry_logs').select('*').order('created_at', { ascending: false }).limit(120);
  (logs || []).reverse().forEach((l) => {
    state.lastTelemetry[l.metric_type] = Number(l.value);
    if (l.metric_type === 'energy_watts') {
      energyLatest.set(l.device_id, { w: Number(l.value), t: Date.parse(l.created_at) || Date.now() });
      const total = houseWatts(energyLatest, getDevice);
      state.lastTelemetry.energy_watts = total;
      sparkEnergy.push(total);
    }
    if (l.metric_type === 'water_flow_lph') sparkWater.push(Number(l.value));
  });
  const lt = state.lastTelemetry;
  if (lt.energy_watts) animateNumber(document.getElementById('stat-energy'), lt.energy_watts, { suffix: ' W' });
  if (lt.temperature != null) animateNumber(document.getElementById('stat-temp'), lt.temperature, { decimals: 1, suffix: '°C' });
  if (lt.humidity != null) animateNumber(document.getElementById('stat-hum'), lt.humidity, { suffix: '%' });
  updateHealthBadge();

  const valve = state.devices.find((d) => d.type === 'valve');
  if (valve) syncEmergencyButton(valve.status?.open !== false);
}

export function subscribeTelemetry() {
  const channels = [];

  channels.push(
    client.channel('telemetry-feed')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'telemetry_logs' }, (payload) => {
        const row = payload.new;
        emit('telemetry', { metric: row.metric_type, value: Number(row.value), deviceId: row.device_id });
      })
      .subscribe()
  );

  channels.push(
    client.channel('alerts-feed')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'alerts' }, (payload) => {
        prependAlert(payload.new);
        const a = payload.new;
        toast(a.severity === 'critical' ? 'Alerta crítico' : a.severity === 'warning' ? 'Atenção' : 'Informação',
          a.message, a.severity === 'info' ? 'info' : a.severity);
      })
      .subscribe()
  );

  channels.push(
    client.channel('devices-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'devices' }, (payload) => {
        if (payload.eventType === 'DELETE') return;
        // mescla status para não perder campos
        const prev = state.devices.find((d) => d.id === payload.new.id);
        upsertDevice({ ...prev, ...payload.new, status: { ...(prev?.status || {}), ...(payload.new.status || {}) } });
      })
      .subscribe()
  );

  return channels;
}
