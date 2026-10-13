// ============================================================
// NexusHome OS — Painel do cômodo (v2.6.0)
// Ao clicar num ambiente da cena 3D a câmera "entra" nele e este
// cartão mostra os dispositivos do cômodo (com atalhos liga/desliga)
// e todas as automações cadastradas para aquele ambiente.
// ============================================================

import { state, on, emit } from '../state.js';
import { escapeHtml } from '../toasts.js';
import { updateStatus } from './devices.js';
import { automationsForRoom, describeAutomation, setAutomationActive, openAutomationModal } from './automations.js';
import { selectRoom } from '../scene3d.js';
import { scenesForRoom, sceneMatches } from '../scenes.js';
import { runScene, sceneIcon, openSceneModal } from './scenes.js';
import { METRIC_INFO, bucketSeries, summarize, sparkPath, metricsIn } from '../history.js';

let panel = null;
let current = null;
let client = null;
let history = { room: null, rows: [], at: 0, loading: false, error: '' };   // telemetria das últimas 24 h do cômodo
let historyTimer = 0;
const HISTORY_MS = 24 * 3600 * 1000;
let lastHtml = '';   // a telemetria dispara devices-changed a cada leitura: só redesenha se mudou

const TYPE_LABEL = { light: 'Luz', ac: 'Ar-condicionado', tv: 'TV', valve: 'Válvula', meter: 'Medidor', sensor: 'Sensor' };
const SWITCHABLE = new Set(['light', 'ac', 'tv', 'valve']);

export function initRoomPanel(nexusClient) {
  client = nexusClient;
  panel = document.getElementById('room-panel');
  if (!panel) return;
  on('room-selected', (room) => {
    current = room || null;
    clearInterval(historyTimer);
    if (current) { loadHistory(current); historyTimer = setInterval(() => current && loadHistory(current), 60000); }
    render();
  });
  on('scenes-changed', () => { if (current) render(); });
  on('devices-changed', () => { if (current) render(); });
  on('automations-changed', () => { if (current) render(); });
  // clique num marcador do 3D: destaca o dispositivo no cartão
  on('device-picked', (id) => setTimeout(() => {
    const row = panel.querySelector(`[data-row="${CSS.escape(id)}"]`);
    if (!row) return;
    row.classList.remove('rp-dev-flash'); void row.offsetWidth; row.classList.add('rp-dev-flash');
    row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, 60));
  panel.addEventListener('click', onClick);
  panel.addEventListener('change', onChange);
}

function roomDevices(room) {
  return state.devices.filter((d) => d.room === room);   // nativos + integrados (Samsung, Tuya...)
}

function isOn(d) {
  return d.type === 'valve' ? d.status?.open !== false : !!d.status?.on;
}

function render() {
  if (!panel) return;
  if (!current) { panel.classList.remove('room-panel-open'); panel.setAttribute('aria-hidden', 'true'); document.body.classList.remove('room-open'); emit('room-panel', false); return; }
  const devices = roomDevices(current);
  const rules = automationsForRoom(current);
  const active = devices.filter((d) => SWITCHABLE.has(d.type) && isOn(d)).length;

  const devHtml = devices.length
    ? devices.map((d) => {
      const sw = SWITCHABLE.has(d.type) && !d.virtual;   // integrados: comando pelo painel da integração
      const onNow = isOn(d);
      const label = d.type === 'valve' ? (onNow ? 'Aberta' : 'Fechada') : (onNow ? 'Ligado' : 'Desligado');
      return `<li class="rp-dev" data-row="${escapeHtml(d.id)}">
        <span class="rp-dev-dot ${onNow ? 'rp-on' : ''}"></span>
        <span class="rp-dev-name">${escapeHtml(d.name)}<small>${d.vendor ? `${d.vendor === 'smartthings' ? 'Samsung' : d.vendor === 'tuya' ? 'Tuya' : 'Integrado'} · ` : ''}${escapeHtml(TYPE_LABEL[d.type] || d.type)}${sw ? ` · ${label}` : ''}</small></span>
        ${sw ? `<button type="button" class="rp-dev-btn ${onNow ? 'rp-dev-btn-on' : ''}" data-dev="${escapeHtml(d.id)}" aria-pressed="${onNow}">${d.type === 'valve' ? (onNow ? 'Fechar' : 'Abrir') : (onNow ? 'Desligar' : 'Ligar')}</button>` : ''}
      </li>`;
    }).join('')
    : '<li class="rp-empty">Nenhum dispositivo neste cômodo.</li>';

  const ruleHtml = rules.length
    ? rules.map((a) => `<li class="rp-rule ${a.is_active ? '' : 'rp-rule-off'}">
        <div class="rp-rule-text"><strong>${escapeHtml(a.name || 'Automação')}</strong><span>${escapeHtml(describeAutomation(a))}</span></div>
        <label class="rp-switch" title="${a.is_active ? 'Desativar' : 'Ativar'} automação">
          <input type="checkbox" data-rule="${escapeHtml(a.id)}" ${a.is_active ? 'checked' : ''} aria-label="Automação ${escapeHtml(a.name || '')} ativa">
          <span></span>
        </label>
      </li>`).join('')
    : '<li class="rp-empty">Nenhuma automação cadastrada para este cômodo.</li>';

  const scenes = scenesForRoom(state.scenes, current, state.devices);
  const sceneHtml = scenes.map((sc) => `<button type="button" class="rp-scene ${sceneMatches(sc, state.devices) ? 'rp-scene-on' : ''}" data-scene="${escapeHtml(sc.id)}" title="Ativar cena">${sceneIcon(sc.icon)}${escapeHtml(sc.name)}</button>`).join('')
    + '<button type="button" class="rp-scene" data-act="new-scene" title="Criar cena para este cômodo">+ Cena</button>';

  const firstDev = devices.find((d) => SWITCHABLE.has(d.type)) || devices[0];
  const html = `
    <div class="rp-head">
      <div class="min-w-0">
        <p class="rp-kicker">Você está em</p>
        <h2 class="rp-title">${escapeHtml(current)}</h2>
        <p class="rp-sub">${devices.length} dispositivo${devices.length === 1 ? '' : 's'}${active ? ` · ${active} ativo${active > 1 ? 's' : ''}` : ''} · ${rules.length} automaç${rules.length === 1 ? 'ão' : 'ões'}</p>
      </div>
      <div class="rp-actions">
        <button type="button" class="rp-close" data-act="min" aria-label="Minimizar painel" title="Minimizar / expandir">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 12h12"/></svg>
        </button>
        <button type="button" class="rp-close" data-act="exit" aria-label="Sair do cômodo" title="Sair do cômodo (Esc)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
    </div>
    <div class="rp-body">
      <h3 class="rp-section">Dispositivos</h3>
      <ul class="rp-list">${devHtml}</ul>
      <h3 class="rp-section">Cenas</h3>
      <div class="rp-scenes">${sceneHtml}</div>
      <h3 class="rp-section">Automações do ambiente</h3>
      <ul class="rp-list">${ruleHtml}</ul>
      <h3 class="rp-section">Últimas 24 h</h3>
      ${historyHtml(devices)}
    </div>
    <div class="rp-foot">
      <button type="button" class="rp-add" data-act="new-rule" ${firstDev ? `data-dev="${escapeHtml(firstDev.id)}"` : 'disabled title="Cadastre um dispositivo neste cômodo primeiro"'}>+ Nova automação neste cômodo</button>
    </div>`;
  if (html !== lastHtml) { panel.innerHTML = html; lastHtml = html; }
  if (!panel.classList.contains('room-panel-open')) {
    panel.classList.add('room-panel-open');
    document.body.classList.add('room-open');     // o painel ocupa o lugar do trilho direito
    emit('room-panel', true);                      // a cena 3D recentra o cômodo na faixa livre
  }
  panel.setAttribute('aria-hidden', 'false');
}

function onClick(e) {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.act === 'exit') { selectRoom(null); return; }
  if (btn.dataset.act === 'min') { panel.classList.toggle('room-panel-min'); emit('room-panel', true); return; }
  if (btn.dataset.act === 'new-rule') { openAutomationModal({ deviceId: btn.dataset.dev }); return; }
  if (btn.dataset.act === 'new-scene') { openSceneModal(null, { room: current }); return; }
  if (btn.dataset.scene) { runScene(btn.dataset.scene); return; }
  if (btn.dataset.dev) {
    const d = state.devices.find((x) => x.id === btn.dataset.dev);
    if (!d) return;
    const next = !isOn(d);
    if (d.type === 'valve') updateStatus(d, { open: next }, next ? 'Válvula aberta' : 'Válvula fechada', next ? 'info' : 'warning');
    else updateStatus(d, { on: next }, `${d.name} ${next ? 'ligado' : 'desligado'}`);
  }
}

function onChange(e) {
  const input = e.target.closest('input[data-rule]');
  if (input) setAutomationActive(input.dataset.rule, input.checked);
}

// ---- histórico de 24 h (telemetry_logs dos dispositivos do cômodo) ------

async function loadHistory(room) {
  const ids = roomDevices(room).map((d) => d.id);
  if (!client || !ids.length) { history = { room, rows: [], at: Date.now(), loading: false, error: '' }; render(); return; }
  history = { ...history, room, loading: history.room !== room || history.loading };
  if (history.room !== room) history.rows = [];
  const since = new Date(Date.now() - HISTORY_MS).toISOString();
  try {
    const { data, error } = await client.from('telemetry_logs')
      .select('device_id, metric_type, value, created_at')
      .in('device_id', ids).gte('created_at', since)
      .order('created_at', { ascending: true }).limit(5000);
    if (current !== room) return;
    history = { room, rows: error ? [] : (data || []), at: Date.now(), loading: false, error: error?.message || '' };
  } catch (err) {
    history = { room, rows: [], at: Date.now(), loading: false, error: err.message };
  }
  render();
}

function fmtNum(v, digits) {
  return Number(v).toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function historyHtml(devices) {
  if (!devices.length) return '<p class="rp-empty">Sem dispositivos, sem histórico.</p>';
  if (history.room !== current || (history.loading && !history.rows.length)) return '<p class="rp-empty">Carregando histórico…</p>';
  if (history.error) return `<p class="rp-empty">Histórico indisponível: ${escapeHtml(history.error)}</p>`;
  const metrics = metricsIn(history.rows);
  if (!metrics.length) return '<p class="rp-empty">Nenhuma leitura nas últimas 24 h.</p>';
  const to = history.at || Date.now();
  const from = to - HISTORY_MS;
  const firstT = Date.parse(history.rows[0]?.created_at) || from;
  // pouco histórico (ex.: modo demo): a janela começa na 1ª leitura
  const start = Math.max(from, firstT);
  return `<div class="rp-hist">${metrics.map((m) => {
    const info = METRIC_INFO[m];
    const series = bucketSeries(history.rows, m, start, to, 48);
    const st = summarize(series);
    if (!st) return '';
    const d = sparkPath(series, 160, 34);
    return `<div class="rp-hist-row">
      <div class="rp-hist-head"><span>${info.label}</span><strong>${fmtNum(st.last, info.digits)} ${info.unit}</strong></div>
      <svg viewBox="0 0 160 34" preserveAspectRatio="none" class="rp-spark" aria-hidden="true"><path d="${d}" fill="none" stroke="${info.color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>
      <div class="rp-hist-foot">mín ${fmtNum(st.min, info.digits)} · média ${fmtNum(st.avg, info.digits)} · máx ${fmtNum(st.max, info.digits)}${start > from ? ` · desde ${new Date(start).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : ''}</div>
    </div>`;
  }).join('')}</div>`;
}
