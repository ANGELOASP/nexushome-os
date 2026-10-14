// ============================================================
// NexusHome OS — Painel de Cenas (v2.7)
// Um botão aciona vários dispositivos ("Cinema", "Dormir", "Sair").
// Tabela scenes (migração 016); sem ela o painel avisa e funciona
// só nesta sessão. O cartão do cômodo também lista as cenas dele.
// ============================================================

import { TYPE_LABELS, SOURCES } from '../device-catalog.js';
import { ARMED_LABEL, VACUUM_LABEL } from '../device-actions.js';
import { state, on, emit, getRoomNames } from '../state.js';
import { toast, escapeHtml } from '../toasts.js';
import { updateStatus } from './devices.js';
import { SCENE_ICONS, normalizeScene, captureActions, cleanPatch, sceneableType, sceneMatches } from '../scenes.js';

let client = null;
let listEl = null;
let modal = null;
let editing = null;          // cena em edição (null = nova)
let tableOk = true;
let draftActions = new Map(); // device_id -> patch (formulário)

const TYPE_LABEL = TYPE_LABELS;

export function initScenesPanel(nexusClient) {
  client = nexusClient;
  listEl = document.getElementById('scenes-list');
  modal = document.getElementById('modal-scene');
  document.getElementById('btn-new-scene')?.addEventListener('click', () => openSceneModal());
  document.getElementById('btn-cancel-scene')?.addEventListener('click', closeModal);
  modal?.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  document.getElementById('form-scene')?.addEventListener('submit', onSubmit);
  document.getElementById('btn-scene-capture')?.addEventListener('click', captureCurrent);
  document.getElementById('btn-scene-delete')?.addEventListener('click', onDelete);
  document.getElementById('sc-devices')?.addEventListener('change', onDeviceFormChange);
  document.getElementById('sc-devices')?.addEventListener('input', onDeviceFormChange);
  listEl?.addEventListener('click', onListClick);
  on('scenes-changed', render);
  on('devices-changed', () => { const k = activeKey(); if (k !== lastActive) render(); });
  render();
}

let lastActive = '';
function activeKey() { return state.scenes.map((s) => (sceneMatches(s, state.devices) ? 1 : 0)).join(''); }

export async function loadScenes() {
  const { data, error } = await client.from('scenes').select('*').order('sort_order', { ascending: true });
  if (error) {
    tableOk = false;
    console.warn('[scenes] tabela indisponível', error.message);
    state.scenes = [];
  } else {
    tableOk = true;
    state.scenes = (data || []).map(normalizeScene);
  }
  emit('scenes-changed', state.scenes);
}

export function subscribeScenes() {
  return [client.channel('scenes-feed')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'scenes' }, () => loadScenes())
    .subscribe()];
}

/** Executa a cena: grava o status de cada dispositivo (otimista + banco). */
export async function runScene(id) {
  const sc = state.scenes.find((s) => s.id === id);
  if (!sc) return;
  let n = 0;
  const missing = [];
  await Promise.all(sc.actions.map(async (a) => {
    const d = state.devices.find((x) => x.id === a.device_id);
    if (!d) { missing.push(a.device_id); return; }
    const patch = cleanPatch(d.type, a.patch);
    if (!Object.keys(patch).length) return;
    n++;
    await updateStatus(d, patch);
  }));
  toast(`Cena “${sc.name}” ativada`, `${n} dispositivo${n === 1 ? '' : 's'} ajustado${n === 1 ? '' : 's'}${missing.length ? ` · ${missing.length} não encontrado(s)` : ''}.`, 'success');
  emit('scene-run', sc);
}

export function sceneIcon(icon) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${(SCENE_ICONS[icon] || SCENE_ICONS.spark).svg}</svg>`;
}

function render() {
  if (!listEl) return;
  lastActive = activeKey();
  if (!state.scenes.length) {
    listEl.innerHTML = `<p class="text-xs text-slate-500">${tableOk ? 'Nenhuma cena ainda. Crie “Cinema”, “Dormir” ou “Sair de casa” e acione tudo com um toque.' : 'Execute a migração 016_scenes.sql no Supabase para guardar cenas.'}</p>`;
    return;
  }
  listEl.innerHTML = state.scenes.map((s) => {
    const on = sceneMatches(s, state.devices);
    return `<div class="scene-tile ${on ? 'scene-on' : ''}">
      <button type="button" class="scene-run" data-run="${escapeHtml(s.id)}" title="Ativar cena">
        <span class="scene-ico">${sceneIcon(s.icon)}</span>
        <span class="scene-txt"><strong>${escapeHtml(s.name)}</strong><small>${escapeHtml(s.room || 'Casa toda')} · ${s.actions.length} disp.</small></span>
      </button>
      <button type="button" class="scene-edit" data-edit="${escapeHtml(s.id)}" aria-label="Editar cena ${escapeHtml(s.name)}" title="Editar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
      </button>
    </div>`;
  }).join('');
}

function onListClick(e) {
  const run = e.target.closest('[data-run]');
  if (run) { runScene(run.dataset.run); return; }
  const ed = e.target.closest('[data-edit]');
  if (ed) openSceneModal(ed.dataset.edit);
}

// ---- formulário -----------------------------------------------------------

export function openSceneModal(id = null, { room = null } = {}) {
  editing = id ? state.scenes.find((s) => s.id === id) || null : null;
  draftActions = new Map((editing?.actions || []).map((a) => [a.device_id, { ...a.patch }]));
  document.getElementById('sc-title').textContent = editing ? 'Editar cena' : 'Nova cena';
  document.getElementById('sc-name').value = editing?.name || '';
  const roomSel = document.getElementById('sc-room');
  roomSel.innerHTML = '<option value="">Casa toda</option>' + getRoomNames().map((n) => `<option>${escapeHtml(n)}</option>`).join('');
  roomSel.value = editing?.room || room || '';
  renderIcons(editing?.icon || 'spark');
  document.getElementById('btn-scene-delete').classList.toggle('hidden', !editing);
  renderDeviceRows();
  modal.classList.add('modal-open');
  setTimeout(() => document.getElementById('sc-name')?.focus(), 50);
}

function closeModal() { modal?.classList.remove('modal-open'); editing = null; }

function renderIcons(selected) {
  const el = document.getElementById('sc-icons');
  el.innerHTML = Object.entries(SCENE_ICONS).map(([k, v]) => `<button type="button" class="sc-icon ${k === selected ? 'sc-icon-on' : ''}" data-icon="${k}" title="${v.label}" aria-pressed="${k === selected}">${sceneIcon(k)}</button>`).join('');
  el.onclick = (e) => { const b = e.target.closest('[data-icon]'); if (b) renderIcons(b.dataset.icon); };
  el.dataset.value = selected;
}

function renderDeviceRows() {
  const el = document.getElementById('sc-devices');
  const devs = state.devices.filter((d) => !d.virtual && sceneableType(d.type));
  if (!devs.length) { el.innerHTML = '<p class="text-xs text-slate-500">Nenhum dispositivo que aceite cena (luz, AC, TV, áudio, projetor, válvula, cortina, portão...).</p>'; return; }
  el.innerHTML = devs.map((d) => {
    const p = draftActions.get(d.id);
    const inc = !!p;
    const st = d.status || {};
    const v = p || cleanPatch(d.type, { ...st, on: !!st.on, open: d.type === 'gate' ? st.open === true : st.open !== false });
    const opt = (k, pairs, cur) => `<select class="form-input sc-mini" data-k="${k}">${pairs.map(([val, l]) => `<option value="${escapeHtml(val)}" ${String(cur) === String(val) ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('')}</select>`;
    let ctl = '';
    if (d.type === 'valve' || d.type === 'curtain' || d.type === 'gate') {
      ctl = `<select class="form-input sc-mini" data-k="open"><option value="1" ${v.open ? 'selected' : ''}>Abrir</option><option value="0" ${!v.open ? 'selected' : ''}>Fechar</option></select>`;
    } else if (d.type === 'alarm') {
      ctl = opt('armed', Object.entries(ARMED_LABEL), v.armed || 'off');
    } else if (d.type === 'vacuum') {
      ctl = opt('state', Object.entries(VACUUM_LABEL), v.state || 'docked');
    } else {
      ctl = `<select class="form-input sc-mini" data-k="on"><option value="1" ${v.on ? 'selected' : ''}>Ligar</option><option value="0" ${!v.on ? 'selected' : ''}>Desligar</option></select>`;
      if (d.type === 'light') ctl += `<label class="sc-num">Brilho <input type="number" min="1" max="100" data-k="brightness" value="${v.brightness ?? 70}" class="form-input sc-mini">%</label>`;
      if (d.type === 'ac') ctl += `<label class="sc-num">Temp. <input type="number" min="16" max="30" data-k="temp" value="${v.temp ?? 23}" class="form-input sc-mini">°C</label>`;
      if (d.type === 'tv' || d.type === 'audio') ctl += `<label class="sc-num">Vol. <input type="number" min="0" max="100" data-k="volume" value="${v.volume ?? 30}" class="form-input sc-mini">%</label>`;
      if (SOURCES[d.type]) ctl += opt('source', [...new Set([v.source, ...SOURCES[d.type]].filter(Boolean))].map((x) => [x, x]), v.source || SOURCES[d.type][0]);
    }
    return `<div class="sc-dev ${inc ? '' : 'sc-dev-off'}" data-dev="${escapeHtml(d.id)}">
      <label class="sc-dev-name"><input type="checkbox" data-k="include" ${inc ? 'checked' : ''}> <span>${escapeHtml(d.name)}<small>${escapeHtml(TYPE_LABEL[d.type] || d.type)} · ${escapeHtml(d.room || '')}</small></span></label>
      <div class="sc-dev-ctl">${ctl}</div>
    </div>`;
  }).join('');
}

function readRow(row) {
  const d = state.devices.find((x) => x.id === row.dataset.dev);
  if (!d) return null;
  const patch = {};
  row.querySelectorAll('[data-k]').forEach((el) => {
    const k = el.dataset.k;
    if (k === 'include') return;
    if (k === 'on' || k === 'open') patch[k] = el.value === '1';
    else if (k === 'source' || k === 'armed' || k === 'state') patch[k] = el.value;
    else patch[k] = Number(el.value);
  });
  return cleanPatch(d.type, patch);
}

function onDeviceFormChange(e) {
  const row = e.target.closest('.sc-dev');
  if (!row) return;
  const include = row.querySelector('[data-k="include"]').checked;
  if (e.target.dataset.k !== 'include' && !include) {   // mexeu no controle: inclui o dispositivo
    row.querySelector('[data-k="include"]').checked = true;
  }
  const inc = row.querySelector('[data-k="include"]').checked;
  row.classList.toggle('sc-dev-off', !inc);
  if (inc) draftActions.set(row.dataset.dev, readRow(row));
  else draftActions.delete(row.dataset.dev);
}

function captureCurrent() {
  const ids = draftActions.size ? [...draftActions.keys()] : state.devices.filter((d) => {
    const room = document.getElementById('sc-room').value;
    return !d.virtual && sceneableType(d.type) && (!room || d.room === room);
  }).map((d) => d.id);
  draftActions = new Map(captureActions(state.devices, ids).map((a) => [a.device_id, a.patch]));
  renderDeviceRows();
  toast('Estado atual copiado', `${draftActions.size} dispositivo(s) na cena. Ajuste o que quiser e salve.`, 'info');
}

async function onSubmit(e) {
  e.preventDefault();
  const name = document.getElementById('sc-name').value.trim();
  if (!name) { toast('Dê um nome à cena', 'Ex.: Cinema, Dormir, Sair de casa.', 'warning'); return; }
  if (!draftActions.size) { toast('Escolha ao menos um dispositivo', 'Marque os dispositivos e o estado de cada um.', 'warning'); return; }
  const row = {
    name,
    icon: document.getElementById('sc-icons').dataset.value || 'spark',
    room: document.getElementById('sc-room').value || null,
    actions: [...draftActions.entries()].map(([device_id, patch]) => ({ device_id, patch })),
  };
  try {
    let res;
    if (editing) res = await client.from('scenes').update(row).eq('id', editing.id);
    else res = await client.from('scenes').insert({ ...row, sort_order: state.scenes.length + 1 });
    if (res.error) throw new Error(res.error.message);
    toast(editing ? 'Cena atualizada' : 'Cena criada', name, 'success');
    closeModal();
    await loadScenes();
  } catch (err) {
    toast('Não foi possível salvar a cena', /scenes/.test(err.message) ? `${err.message} — execute a migração 016_scenes.sql no Supabase.` : err.message, 'critical');
  }
}

async function onDelete() {
  if (!editing) return;
  if (!window.confirm(`Excluir a cena “${editing.name}”?`)) return;
  const { error } = await client.from('scenes').delete().eq('id', editing.id);
  if (error) { toast('Não foi possível excluir', error.message, 'critical'); return; }
  closeModal();
  await loadScenes();
}
