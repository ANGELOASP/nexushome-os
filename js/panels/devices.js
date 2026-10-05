// ============================================================
// NexusHome OS — Painel de Dispositivos (agrupados por cômodo)
// Controles: luz (power/brilho/cor), AC (power/temperatura),
// válvula (abrir/fechar), medidor/sensor (leituras).
// ============================================================

import { state, on, emit, ROOM_ORDER, getDevice, upsertDevice } from '../state.js';
import { toast, escapeHtml } from '../toasts.js';

let client = null;
let listEl = null;

const TYPE_ICONS = {
  light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.4 1 2.3h6c0-.9.4-1.8 1-2.3A7 7 0 0 0 12 2z"/></svg>',
  ac: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20"/><path d="m4.9 4.9 14.2 14.2"/><path d="M2 12h20"/><path d="m19.1 4.9-14.2 14.2"/></svg>',
  valve: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.7s6.5 7 6.5 11.3a6.5 6.5 0 0 1-13 0C5.5 9.7 12 2.7 12 2.7z"/></svg>',
  meter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>',
  sensor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/><path d="M8.5 10.5a5 5 0 0 1 7 0"/><path d="M5.6 7.6a9 9 0 0 1 12.8 0"/><path d="M12 18h.01"/></svg>',
  solar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.3 17.7-1.4 1.4"/><path d="m19.1 6.3-1.4 1.4"/></svg>',
};

export function initDevicesPanel(nexusClient) {
  client = nexusClient;
  listEl = document.getElementById('devices-list');
  render();

  on('devices-changed', render);
  on('room-selected', (room) => highlightRoom(room));
}

function render() {
  if (!listEl) return;
  const devices = state.devices;
  listEl.innerHTML = '';

  for (const room of ROOM_ORDER) {
    const roomDevices = devices.filter((d) => d.room === room);
    if (!roomDevices.length) continue;

    const group = document.createElement('div');
    group.className = 'device-room-group';
    group.dataset.room = room;
    group.innerHTML = `
      <button class="device-room-header" data-room="${escapeHtml(room)}">
        <span class="text-[11px] font-semibold uppercase tracking-widest text-slate-400">${escapeHtml(room)}</span>
        <span class="room-active-count text-[10px] text-cyan-300/80"></span>
      </button>
      <div class="device-room-body space-y-2"></div>`;
    const body = group.querySelector('.device-room-body');
    roomDevices.forEach((d) => body.appendChild(renderDevice(d)));
    group.querySelector('.device-room-header').addEventListener('click', () => emit('ui-select-room', room));
    listEl.appendChild(group);
  }
  updateActiveCounts();
}

function renderDevice(d) {
  const card = document.createElement('div');
  card.className = 'device-card glass-soft rounded-xl p-3 transition-all duration-200 hover:border-white/20';
  card.dataset.deviceId = d.id;
  card.dataset.room = d.room;

  const icon = TYPE_ICONS[d.type] || TYPE_ICONS.sensor;
  const online = d.is_online !== false;
  const s = d.status || {};

  let controls = '';
  if (d.type === 'light') {
    controls = `
      <div class="flex items-center justify-between gap-3 mt-2">
        <label class="switch"><input type="checkbox" data-ctl="power" ${s.on ? 'checked' : ''}><span class="slider-ui"></span></label>
        <input type="color" data-ctl="color" value="${escapeHtml(s.color || '#ffd9a0')}" class="color-input" title="Cor da luz">
      </div>
      <div class="mt-2 flex items-center gap-2">
        <span class="text-[10px] text-slate-500 w-14">Brilho <span data-lbl="brightness">${s.brightness ?? 70}</span>%</span>
        <input type="range" min="1" max="100" value="${s.brightness ?? 70}" data-ctl="brightness" class="range-input flex-1">
      </div>`;
  } else if (d.type === 'ac') {
    controls = `
      <div class="flex items-center justify-between gap-3 mt-2">
        <label class="switch"><input type="checkbox" data-ctl="power" ${s.on ? 'checked' : ''}><span class="slider-ui"></span></label>
        <span class="text-sm font-semibold text-sky-300 tabular-nums" data-lbl="temp">${s.temp ?? 23}°C</span>
      </div>
      <div class="mt-2 flex items-center gap-2">
        <span class="text-[10px] text-slate-500">16°</span>
        <input type="range" min="16" max="30" value="${s.temp ?? 23}" data-ctl="temp" class="range-input range-cool flex-1">
        <span class="text-[10px] text-slate-500">30°</span>
      </div>`;
  } else if (d.type === 'valve') {
    const open = s.open !== false;
    controls = `
      <button data-ctl="valve" class="valve-btn mt-2 w-full rounded-lg px-3 py-2 text-xs font-semibold tracking-wide transition-all ${open ? 'valve-open' : 'valve-closed'}">
        ${open ? 'ABERTA — fluxo liberado' : 'FECHADA — fluxo bloqueado'}
      </button>`;
  } else if (d.type === 'meter') {
    controls = `
      <div class="mt-2 flex items-end justify-between">
        <span class="text-[10px] uppercase tracking-widest text-slate-500">Consumo atual</span>
        <span class="text-lg font-bold text-cyan-300 tabular-nums" data-lbl="watts">${Math.round(s.watts || 0)} W</span>
      </div>`;
  } else if (d.type === 'sensor') {
    controls = `
      <div class="mt-2 grid grid-cols-2 gap-2 text-center">
        <div class="rounded-lg bg-white/5 py-1.5"><p class="text-[10px] text-slate-500">Temperatura</p><p class="text-sm font-semibold text-slate-200" data-lbl="temperature">—</p></div>
        <div class="rounded-lg bg-white/5 py-1.5"><p class="text-[10px] text-slate-500">Umidade</p><p class="text-sm font-semibold text-slate-200" data-lbl="humidity">—</p></div>
      </div>`;
  } else {
    controls = `<p class="mt-2 text-xs text-slate-500">Dispositivo monitorado</p>`;
  }

  card.innerHTML = `
    <div class="flex items-center gap-2.5">
      <span class="device-icon text-slate-300">${icon}</span>
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium text-slate-100 truncate">${escapeHtml(d.name)}</p>
        <p class="text-[10px] text-slate-500">${online ? '<span class="text-emerald-400">●</span> online' : '<span class="text-slate-500">●</span> offline'}</p>
      </div>
    </div>
    ${controls}`;

  wireControls(card, d);
  return card;
}

function wireControls(card, d) {
  card.querySelectorAll('[data-ctl]').forEach((el) => {
    const ctl = el.dataset.ctl;
    if (ctl === 'power') {
      el.addEventListener('change', () => updateStatus(d, { on: el.checked }, el.checked ? `${d.name} ligado` : `${d.name} desligado`));
    } else if (ctl === 'brightness') {
      const lbl = card.querySelector('[data-lbl="brightness"]');
      el.addEventListener('input', () => { if (lbl) lbl.textContent = el.value; });
      el.addEventListener('change', () => updateStatus(d, { brightness: Number(el.value) }, `Brilho ajustado para ${el.value}%`));
    } else if (ctl === 'color') {
      el.addEventListener('change', () => updateStatus(d, { color: el.value }, 'Cor da luz atualizada'));
    } else if (ctl === 'temp') {
      const lbl = card.querySelector('[data-lbl="temp"]');
      el.addEventListener('input', () => { if (lbl) lbl.textContent = `${el.value}°C`; });
      el.addEventListener('change', () => updateStatus(d, { temp: Number(el.value) }, `Temperatura do AC: ${el.value}°C`));
    } else if (ctl === 'valve') {
      el.addEventListener('click', () => {
        const open = !(d.status?.open !== false); // inverte
        updateStatus(d, { open }, open ? 'Válvula geral aberta' : 'Válvula geral fechada', open ? 'info' : 'warning');
      });
    }
  });
}

/** Atualização otimista + persistência (Supabase ou mock). */
export async function updateStatus(device, patch, toastMsg, toastType = 'success') {
  const current = getDevice(device.id) || device;
  const merged = { ...(current.status || {}), ...patch };
  upsertDevice({ ...current, status: merged });   // otimista: UI + 3D reagem já
  try {
    const { error } = await client.from('devices').update({ status: patch }).eq('id', device.id);
    if (error) throw new Error(error.message);
    if (toastMsg) toast(toastMsg, device.name, toastType);
  } catch (err) {
    console.error('[devices] falha ao atualizar', err);
    toast('Falha ao atualizar dispositivo', err.message, 'critical');
  }
}

function highlightRoom(room) {
  listEl?.querySelectorAll('.device-room-group').forEach((g) => {
    g.classList.toggle('device-room-highlight', g.dataset.room === room);
  });
  if (room) {
    listEl?.querySelector(`.device-room-group[data-room="${CSS.escape(room)}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function updateActiveCounts() {
  listEl?.querySelectorAll('.device-room-group').forEach((g) => {
    const n = state.devices.filter((d) => d.room === g.dataset.room && (d.type === 'light' || d.type === 'ac') && d.status?.on).length;
    const el = g.querySelector('.room-active-count');
    if (el) el.textContent = n ? `${n} ativo${n > 1 ? 's' : ''}` : '';
  });
}
