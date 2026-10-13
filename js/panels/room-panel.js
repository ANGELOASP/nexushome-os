// ============================================================
// NexusHome OS — Painel do cômodo (v2.6.0)
// Ao clicar num ambiente da cena 3D a câmera "entra" nele e este
// cartão mostra os dispositivos do cômodo (com atalhos liga/desliga)
// e todas as automações cadastradas para aquele ambiente.
// ============================================================

import { state, on } from '../state.js';
import { escapeHtml } from '../toasts.js';
import { updateStatus } from './devices.js';
import { automationsForRoom, describeAutomation, setAutomationActive, openAutomationModal } from './automations.js';
import { selectRoom } from '../scene3d.js';

let panel = null;
let current = null;
let lastHtml = '';   // a telemetria dispara devices-changed a cada leitura: só redesenha se mudou

const TYPE_LABEL = { light: 'Luz', ac: 'Ar-condicionado', tv: 'TV', valve: 'Válvula', meter: 'Medidor', sensor: 'Sensor' };
const SWITCHABLE = new Set(['light', 'ac', 'tv', 'valve']);

export function initRoomPanel() {
  panel = document.getElementById('room-panel');
  if (!panel) return;
  on('room-selected', (room) => { current = room || null; render(); });
  on('devices-changed', () => { if (current) render(); });
  on('automations-changed', () => { if (current) render(); });
  panel.addEventListener('click', onClick);
  panel.addEventListener('change', onChange);
}

function roomDevices(room) {
  return state.devices.filter((d) => !d.virtual && d.room === room);
}

function isOn(d) {
  return d.type === 'valve' ? d.status?.open !== false : !!d.status?.on;
}

function render() {
  if (!panel) return;
  if (!current) { panel.classList.remove('room-panel-open'); panel.setAttribute('aria-hidden', 'true'); return; }
  const devices = roomDevices(current);
  const rules = automationsForRoom(current);
  const active = devices.filter((d) => SWITCHABLE.has(d.type) && isOn(d)).length;

  const devHtml = devices.length
    ? devices.map((d) => {
      const sw = SWITCHABLE.has(d.type);
      const onNow = isOn(d);
      const label = d.type === 'valve' ? (onNow ? 'Aberta' : 'Fechada') : (onNow ? 'Ligado' : 'Desligado');
      return `<li class="rp-dev">
        <span class="rp-dev-dot ${onNow ? 'rp-on' : ''}"></span>
        <span class="rp-dev-name">${escapeHtml(d.name)}<small>${escapeHtml(TYPE_LABEL[d.type] || d.type)}${sw ? ` · ${label}` : ''}</small></span>
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

  const firstDev = devices.find((d) => SWITCHABLE.has(d.type)) || devices[0];
  const html = `
    <div class="rp-head">
      <div class="min-w-0">
        <p class="rp-kicker">Você está em</p>
        <h2 class="rp-title">${escapeHtml(current)}</h2>
        <p class="rp-sub">${devices.length} dispositivo${devices.length === 1 ? '' : 's'}${active ? ` · ${active} ativo${active > 1 ? 's' : ''}` : ''} · ${rules.length} automaç${rules.length === 1 ? 'ão' : 'ões'}</p>
      </div>
      <button type="button" class="rp-close" data-act="exit" aria-label="Sair do cômodo" title="Sair do cômodo (Esc)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>
    <div class="rp-body">
      <h3 class="rp-section">Dispositivos</h3>
      <ul class="rp-list">${devHtml}</ul>
      <h3 class="rp-section">Automações do ambiente</h3>
      <ul class="rp-list">${ruleHtml}</ul>
    </div>
    <div class="rp-foot">
      <button type="button" class="rp-add" data-act="new-rule" ${firstDev ? `data-dev="${escapeHtml(firstDev.id)}"` : 'disabled title="Cadastre um dispositivo neste cômodo primeiro"'}>+ Nova automação neste cômodo</button>
    </div>`;
  if (html !== lastHtml) { panel.innerHTML = html; lastHtml = html; }
  panel.classList.add('room-panel-open');
  panel.setAttribute('aria-hidden', 'false');
}

function onClick(e) {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.act === 'exit') { selectRoom(null); return; }
  if (btn.dataset.act === 'new-rule') { openAutomationModal({ deviceId: btn.dataset.dev }); return; }
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
