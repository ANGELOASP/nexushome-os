// ============================================================
// NexusHome OS — Painel de Dispositivos (agrupados por cômodo)
// Controles: luz (power/brilho/cor), AC (power/temperatura),
// válvula (abrir/fechar), medidor/sensor (leituras).
// ============================================================

import { state, on, emit, getRoomNames, getDevice, upsertDevice, removeDevice } from '../state.js';
import { lightingSummary, controlModeFor } from '../lighting.js';
import { sensorReadings, batteryView } from '../sensor-readings.js';
import { toast, escapeHtml } from '../toasts.js';
import { SOURCES, LEGACY_TYPES, defaultStatus } from '../device-catalog.js';
import { ARMED_LABEL } from '../device-actions.js';

let client = null;
let listEl = null;

// Dispositivos virtuais (SmartThings `st-…`, Tuya `tuya-…`) vinculados a um cômodo também
// aparecem no grupo do cômodo, mas quem sabe desenhá-los e comandá-los é o painel de origem:
// ele registra aqui um renderizador por prefixo de id.
const virtualRenderers = new Map();   // prefixo -> (device) => HTMLElement | null
const openMenus = new Set();          // ids com o menu ⋯ aberto (sobrevive aos redesenhos do painel)

export function registerVirtualRenderer(prefix, fn) {
  virtualRenderers.set(prefix, fn);
  if (listEl) render();
}

function virtualRenderer(d) {
  if (!d.virtual) return null;
  for (const [prefix, fn] of virtualRenderers) if (d.id.startsWith(prefix)) return fn;
  return null;
}

/** Aparece no painel: dispositivos normais + virtuais que têm renderizador registrado. */
function listable(d) { return !d.virtual || !!virtualRenderer(d); }

const TYPE_ICONS = {
  light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.4 1 2.3h6c0-.9.4-1.8 1-2.3A7 7 0 0 0 12 2z"/></svg>',
  ac: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20"/><path d="m4.9 4.9 14.2 14.2"/><path d="M2 12h20"/><path d="m19.1 4.9-14.2 14.2"/></svg>',
  valve: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.7s6.5 7 6.5 11.3a6.5 6.5 0 0 1-13 0C5.5 9.7 12 2.7 12 2.7z"/></svg>',
  meter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>',
  sensor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/><path d="M8.5 10.5a5 5 0 0 1 7 0"/><path d="M5.6 7.6a9 9 0 0 1 12.8 0"/><path d="M12 18h.01"/></svg>',
  // v2.13 — biblioteca ampliada
  tv: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="13" rx="2"/><path d="M8 21h8"/></svg>',
  audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><circle cx="12" cy="14" r="4"/><path d="M12 6h.01"/></svg>',
  projector: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="8" width="20" height="9" rx="2"/><circle cx="16" cy="12.5" r="2.5"/><path d="M6 12h4"/></svg>',
  media: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="m10 9 5 3-5 3z"/></svg>',
  computer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/><path d="M12 16v4"/></svg>',
  tablet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M11 18h2"/></svg>',
  network: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5a10 10 0 0 1 14 0"/><path d="M8.5 16a5 5 0 0 1 7 0"/><path d="M2 9a14 14 0 0 1 20 0"/><path d="M12 19.5h.01"/></svg>',
  appliance: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><circle cx="12" cy="13" r="4.5"/><path d="M8 5h.01M11 5h.01"/></svg>',
  vacuum: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="9" r="2"/><path d="M8 16h8"/></svg>',
  alarm: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10z"/><path d="M12 8v4"/><path d="M12 15.5h.01"/></svg>',
  gate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21V9l9-6 9 6v12"/><path d="M7 21v-8h10v8"/><path d="M7 16h10"/></svg>',
  solar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.3 17.7-1.4 1.4"/><path d="m19.1 6.3-1.4 1.4"/></svg>',
};

export function initDevicesPanel(nexusClient) {
  client = nexusClient;
  listEl = document.getElementById('devices-list');
  render();

  on('devices-changed', scheduleRender);   // o quadro elétrico manda ~34 atualizações juntas: um redesenho por quadro
  on('rooms-changed', render); // planta editada → reagrupa os dispositivos
  on('room-selected', (room) => highlightRoom(room));
  initAddForm();
}

// ------------------------------------------------------------
// Cadastro de dispositivo pelo app (antes só por SQL)
// ------------------------------------------------------------
function initAddForm() {
  const btn = document.getElementById('btn-device-add');
  const form = document.getElementById('device-add-form');
  if (!btn || !form) return;
  const nameEl = document.getElementById('dev-add-name');
  const typeEl = document.getElementById('dev-add-type');
  const roomEl = document.getElementById('dev-add-room');
  const result = document.getElementById('dev-add-result');
  const uuidEl = document.getElementById('dev-add-uuid');
  const fillRooms = () => {
    const keep = roomEl.value;
    roomEl.innerHTML = getRoomNames().map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join('');
    if (keep) roomEl.value = keep;
  };
  const toggle = (open) => {
    form.classList.toggle('hidden', !open);
    btn.setAttribute('aria-expanded', String(open));
    if (open) { fillRooms(); result.classList.add('hidden'); nameEl.focus(); }
  };
  btn.addEventListener('click', () => toggle(form.classList.contains('hidden')));
  document.getElementById('dev-add-cancel')?.addEventListener('click', () => toggle(false));
  on('rooms-changed', () => { if (!form.classList.contains('hidden')) fillRooms(); });
  document.getElementById('dev-add-copy')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(uuidEl.textContent); toast('Código copiado', '', 'success'); }
    catch { toast('Não foi possível copiar', 'Selecione o código e copie manualmente.', 'warning'); }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = nameEl.value.trim();
    const room = roomEl.value;
    const type = typeEl.value;
    if (!name) { toast('Nome obrigatório', 'Dê um nome ao dispositivo.', 'warning'); return; }
    if (!room) { toast('Cômodo obrigatório', 'Desenhe a planta com ao menos um cômodo antes.', 'warning'); return; }
    if (state.devices.some((d) => !d.virtual && d.name.trim().toLowerCase() === name.toLowerCase() && d.room === room)) {
      toast('Já existe um dispositivo com esse nome neste cômodo', name, 'warning'); return;
    }
    const status = defaultStatus(type);
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      let { data, error } = await client.from('devices')
        .insert({ name, type, room, status, is_online: false }).select();
      if (error && /devices_type_check/.test(error.message || '') && !LEGACY_TYPES.includes(type)) {
        // tipo novo da v2.13 sem a migração 024: grava como "hub" e avisa
        ({ data, error } = await client.from('devices').insert({ name, type: 'hub', room, status, is_online: false }).select());
        if (!error) toast('Execute a migração 024', `“${name}” foi gravado como Hub: o banco ainda não aceita o tipo novo (supabase/migrations/024_device_library.sql).`, 'warning');
      }
      if (error && /devices_type_check/.test(error.message || '')) throw new Error('o banco ainda não aceita este tipo — execute a migração 021_device_catalog.sql no Supabase e tente de novo');
      if (error) throw new Error(error.message);
      const row = Array.isArray(data) ? data[0] : data;
      if (row) upsertDevice(row);
      uuidEl.textContent = row?.id || '';
      result.classList.toggle('hidden', !row?.id);
      nameEl.value = '';
      toast('Dispositivo cadastrado', `${name} · ${room}`, 'success');
    } catch (err) {
      console.error('[devices] falha ao cadastrar', err);
      toast('Não foi possível cadastrar', err.message, 'critical');
    } finally {
      submit.disabled = false;
    }
  });
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  const run = () => {
    // usuário mexendo num controle da lista (entrada, volume, cor...): redesenhar agora fecharia o
    // seletor ou soltaria o slider — espera ele terminar
    const a = document.activeElement;
    if (listEl?.contains(a) && /^(SELECT|INPUT)$/.test(a.tagName) && a.type !== 'checkbox') { setTimeout(run, 400); return; }
    renderQueued = false;
    render();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run); else setTimeout(run, 16);
}

function render() {
  if (!listEl) return;
  const devices = state.devices.filter(listable);
  listEl.innerHTML = '';

  // cômodos da planta + eventuais grupos órfãos (cômodo renomeado/excluído)
  const names = getRoomNames();
  const orphans = [...new Set(devices.map((d) => d.room).filter((r) => r && !names.includes(r)))];
  for (const room of [...names, ...orphans]) {
    const roomDevices = devices.filter((d) => d.room === room);
    if (!roomDevices.length) continue;

    const group = document.createElement('div');
    group.className = 'device-room-group';
    group.dataset.room = room;
    group.innerHTML = `
      <button class="device-room-header" data-room="${escapeHtml(room)}">
        <span class="text-[11px] font-semibold uppercase tracking-widest text-slate-400">${escapeHtml(room)}${names.includes(room) ? '' : ' <span class="normal-case tracking-normal text-amber-300/90" title="Este cômodo não existe mais na planta. Mova ou exclua os dispositivos pelo menu ⋯ de cada card.">· fora da planta</span>'}</span>
        <span class="room-active-count text-[10px] text-cyan-300/80"></span>
      </button>
      <div class="device-room-body space-y-2"></div>`;
    const body = group.querySelector('.device-room-body');
    roomDevices.forEach((d) => {
      const card = virtualRenderer(d)?.(d) || (d.virtual ? null : renderDevice(d));
      if (card) body.appendChild(card);
    });
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
  // v2.17: circuito de iluminação desenhado no Editor de Planta (luminárias + pontos de comando)
  const circuitInfo = d.type === 'light' && d.lighting
    ? `<p class="text-[10px] text-slate-500 mt-1.5 leading-snug">${escapeHtml(lightingSummary(d))}${controlModeFor(d) === 'parede' ? ' — o app não comanda este circuito' : ''}</p>`
    : '';
  if (d.type === 'light' && d.hw) {
    // v2.16: luz em three-way pelo quadro (relé + interruptor de parede): só liga/desliga, estado real
    controls = `
      <div class="flex items-center justify-between gap-3 mt-2">
        <label class="switch"><input type="checkbox" data-ctl="power" ${s.on ? 'checked' : ''}><span class="slider-ui"></span></label>
        <span class="text-[11px] text-slate-500">${s.on ? 'acesa' : 'apagada'} · interruptor de parede ativo</span>
      </div>${circuitInfo}`;
  } else if (d.type === 'light') {
    controls = `
      <div class="flex items-center justify-between gap-3 mt-2">
        <label class="switch"><input type="checkbox" data-ctl="power" ${s.on ? 'checked' : ''}><span class="slider-ui"></span></label>
        <input type="color" data-ctl="color" value="${escapeHtml(s.color || '#ffd9a0')}" class="color-input" title="Cor da luz">
      </div>
      <div class="mt-2 flex items-center gap-2">
        <span class="text-[10px] text-slate-500 w-14">Brilho <span data-lbl="brightness">${s.brightness ?? 70}</span>%</span>
        <input type="range" min="1" max="100" value="${s.brightness ?? 70}" data-ctl="brightness" class="range-input flex-1">
      </div>${circuitInfo}`;
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
    controls = meterControls(s);
  } else if (d.type === 'tv' || d.type === 'audio' || d.type === 'projector' || d.type === 'media') {
    controls = avControls(d.type, s);
  } else if (d.type === 'alarm') {
    const armed = s.armed || 'off';
    controls = `
      <div class="mt-2 grid grid-cols-3 gap-1.5">${Object.entries(ARMED_LABEL).map(([v, l]) =>
        `<button type="button" data-ctl="armed" data-val="${v}" class="dev-seg ${armed === v ? (v === 'off' ? 'dev-seg-on' : 'dev-seg-alarm') : ''}">${{ off: 'Desarmado', home: 'Em casa', away: 'Ausente' }[v] || l}</button>`).join('')}</div>
      ${s.triggered ? '<p class="mt-1.5 text-[11px] font-semibold text-red-400">ALARME DISPARADO</p>' : ''}`;
  } else if (d.type === 'gate' || d.type === 'curtain') {
    const open = d.type === 'gate' ? s.open === true : s.open !== false;
    controls = `
      <button data-ctl="open" class="valve-btn mt-2 w-full rounded-lg px-3 py-2 text-xs font-semibold tracking-wide ${open ? 'valve-closed' : 'valve-open'}">
        ${open ? 'ABERTO — tocar para fechar' : 'FECHADO — tocar para abrir'}
      </button>`;
  } else if (d.type === 'vacuum') {
    const cleaning = s.state === 'cleaning';
    controls = `
      <div class="mt-2 flex items-center justify-between gap-2">
        <span class="text-xs ${cleaning ? 'text-sky-300' : 'text-slate-400'}">${cleaning ? 'Limpando' : 'Na base'}${s.battery != null ? ` · ${Math.round(s.battery)}%` : ''}</span>
        <button type="button" data-ctl="vacuum" class="dev-seg ${cleaning ? '' : 'dev-seg-on'}">${cleaning ? 'Voltar à base' : 'Iniciar limpeza'}</button>
      </div>`;
  } else if (d.type === 'solar' && batteryView(s)) {
    // v2.16: nobreak / banco de baterias (tela T4 do quadro)
    const b = batteryView(s);
    const bar = b.level === 'crit' ? 'bg-red-400' : b.level === 'warn' ? 'bg-amber-400' : 'bg-emerald-400';
    controls = `
      <div class="mt-2 flex items-center gap-3">
        <span class="text-2xl font-bold tabular-nums ${b.level === 'ok' ? 'text-emerald-300' : b.level === 'warn' ? 'text-amber-300' : 'text-red-300'}">${b.soc ?? '—'}%</span>
        <div class="flex-1 h-2 rounded-full bg-white/10 overflow-hidden"><span class="block h-full ${bar}" style="width:${b.soc ?? 0}%"></span></div>
      </div>
      ${b.onBattery ? '<p class="mt-1.5 text-[11px] font-semibold text-amber-300">FALTA DE ENERGIA</p>' : ''}
      <p class="mt-1 text-[11px] text-slate-400 tabular-nums">${b.lines.map(escapeHtml).join(' · ')}</p>`;
  } else if (d.type === 'tablet' || d.type === 'network') {
    const info = [];
    if (s.battery != null) info.push(`bateria ${Math.round(s.battery)}%`);
    if (s.ip) info.push(escapeHtml(String(s.ip)));
    if (s.clients != null) info.push(`${s.clients} conectados`);
    controls = `<p class="mt-2 text-xs text-slate-500">${info.length ? info.join(' · ') : 'Monitorado (online/offline)'}</p>`;
  } else if (['computer', 'appliance', 'fan', 'plug', 'switch', 'speaker'].includes(d.type) || typeof s.on === 'boolean') {
    controls = `
      <div class="mt-2 flex items-center justify-between gap-3">
        <label class="switch"><input type="checkbox" data-ctl="power" ${s.on ? 'checked' : ''}><span class="slider-ui"></span></label>
        ${s.watts != null ? `<span class="text-sm font-semibold text-cyan-300 tabular-nums">${Math.round(s.watts)} W</span>` : `<span class="text-[11px] text-slate-500">${s.on ? 'ligado' : 'desligado'}</span>`}
      </div>`;
  } else if (d.type === 'sensor') {
    // v2.16: o que a tela do quadro publica (temperatura, umidade, presença, fumaça, gás, nível...)
    const rd = sensorReadings(s);
    controls = rd.length
      ? `<div class="mt-2 grid grid-cols-2 gap-1.5 text-center">${rd.map((r) => `
          <div class="rounded-lg py-1.5 ${r.alarm ? 'bg-red-500/15 ring-1 ring-red-400/50' : 'bg-white/5'}">
            <p class="text-[10px] text-slate-500">${r.label}</p>
            <p class="text-sm font-semibold tabular-nums ${r.alarm ? 'text-red-300' : 'text-slate-200'}">${escapeHtml(r.value)}</p>
          </div>`).join('')}</div>`
      : `<p class="mt-2 text-xs text-slate-500">Aguardando a primeira leitura</p>`;
  } else {
    controls = `<p class="mt-2 text-xs text-slate-500">Dispositivo monitorado</p>`;
  }

  const names = getRoomNames();
  const roomOpts = [...new Set([...names, d.room])]
    .map((r) => `<option value="${escapeHtml(r)}" ${r === d.room ? 'selected' : ''}>${escapeHtml(r)}${names.includes(r) ? '' : ' (fora da planta)'}</option>`)
    .join('');
  card.innerHTML = `
    <div class="flex items-center gap-2.5">
      <span class="device-icon text-slate-300">${icon}</span>
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium text-slate-100 truncate">${escapeHtml(d.name)}</p>
        <p class="text-[10px] text-slate-500">${online ? '<span class="text-emerald-400">●</span> online' : '<span class="text-slate-500">●</span> offline'}</p>
      </div>
      <button data-ctl="menu" type="button" class="device-menu-btn" title="Mover de cômodo ou excluir" aria-label="Opções do dispositivo" aria-expanded="false">⋯</button>
    </div>
    ${controls}
    <div class="device-menu hidden mt-2 space-y-2 border-t border-white/10 pt-2" data-menu>
      <label class="form-label">Mover para o cômodo</label>
      <select data-ctl="move" class="form-input">${roomOpts}</select>
      <button data-ctl="delete" type="button" class="fp-btn fp-btn-danger w-full">Excluir dispositivo</button>
    </div>`;

  if (openMenus.has(d.id)) {
    card.querySelector('[data-menu]')?.classList.remove('hidden');
    card.querySelector('[data-ctl="menu"]')?.setAttribute('aria-expanded', 'true');
  }
  wireControls(card, d);
  return card;
}

// Medidor (v2.11): circuito do quadro elétrico (PZEM-016) mostra tensão, corrente, kWh e,
// se tiver relé ("on" no status), o liga/desliga — o banco vira comando para o ESP32 (migração 023).
function meterControls(s) {
  const fmt = (v, dec, unit) => (Number.isFinite(Number(v)) ? `${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: dec, maximumFractionDigits: dec })} ${unit}` : '—');
  const badges = [];
  if (s.trip) badges.push('<span class="meter-badge meter-badge-crit" title="Corrente acima do disjuntor por 30 s: o ESP32 cortou o circuito. Para religar pelo app, desligue e ligue de novo (aceito 5 min após o desarme) ou use rearmar N na serial.">desligado por sobrecarga</span>');
  if (s.shed) badges.push('<span class="meter-badge meter-badge-warn" title="Consumo da casa acima do limite de demanda: este circuito volta sozinho quando houver folga.">cortado pela demanda</span>');
  if (s.meter_ok === false) badges.push('<span class="meter-badge" title="O PZEM-016 deste circuito não respondeu no barramento RS-485.">medidor sem resposta</span>');
  const details = [];
  if (s.volts != null) details.push(fmt(s.volts, 1, 'V'));
  if (s.amps != null) details.push(fmt(s.amps, 2, 'A'));
  if (s.kwh != null) details.push(fmt(s.kwh, 1, 'kWh'));
  if (s.pf != null) details.push(`FP ${fmt(s.pf, 2, '').trim()}`);
  if (s.meters != null) details.push(`${s.meters_ok ?? 0}/${s.meters} medidores`);
  if (Number(s.limit_w) > 0) details.push(`limite ${fmt(s.limit_w / 1000, 1, 'kW')}`);
  const load = Number(s.load_pct);
  const loadBar = Number.isFinite(load) && s.amps != null
    ? `<div class="meter-load mt-1.5" title="Corrente em relação ao disjuntor do circuito"><span style="width:${Math.min(100, Math.max(0, load))}%" class="${load >= 95 ? 'meter-load-crit' : load >= 80 ? 'meter-load-warn' : ''}"></span></div>`
    : '';
  const hasSwitch = typeof s.on === 'boolean';
  return `
      <div class="mt-2 flex items-end justify-between gap-3">
        ${hasSwitch
          ? `<label class="switch" title="Liga/desliga o circuito no quadro"><input type="checkbox" data-ctl="power" ${s.on ? 'checked' : ''}><span class="slider-ui"></span></label>`
          : '<span class="text-[10px] uppercase tracking-widest text-slate-500">Consumo atual</span>'}
        <span class="text-lg font-bold text-cyan-300 tabular-nums" data-lbl="watts">${Math.round(s.watts || 0)} W</span>
      </div>
      ${details.length ? `<p class="mt-1 text-[10px] text-slate-400 tabular-nums">${details.join(' · ')}</p>` : ''}
      ${loadBar}
      ${badges.length ? `<div class="mt-1.5 flex flex-wrap gap-1">${badges.join('')}</div>` : ''}`;
}

// Áudio e vídeo (v2.13): liga/desliga, volume, mudo e entrada de sinal
function avControls(type, s) {
  const sources = SOURCES[type] || SOURCES.media;
  const hasVolume = type === 'tv' || type === 'audio';
  const vol = Number.isFinite(Number(s.volume)) ? Number(s.volume) : 30;
  return `
      <div class="mt-2 flex items-center justify-between gap-2">
        <label class="switch"><input type="checkbox" data-ctl="power" ${s.on ? 'checked' : ''}><span class="slider-ui"></span></label>
        <select data-ctl="source" class="form-input dev-source" title="Entrada">
          ${[...new Set([s.source, ...sources].filter(Boolean))].map((x) => `<option value="${escapeHtml(x)}" ${x === s.source ? 'selected' : ''}>${escapeHtml(x)}</option>`).join('')}
        </select>
      </div>
      ${hasVolume ? `
      <div class="mt-2 flex items-center gap-2">
        <button type="button" data-ctl="mute" class="dev-seg ${s.muted ? 'dev-seg-alarm' : ''}" title="Mudo">${s.muted ? 'Mudo' : 'Som'}</button>
        <input type="range" min="0" max="100" value="${vol}" data-ctl="volume" class="range-input flex-1">
        <span class="text-[10px] text-slate-400 w-8 text-right tabular-nums" data-lbl="volume">${vol}%</span>
      </div>` : ''}`;
}

function wireControls(card, d) {
  card.querySelectorAll('[data-ctl]').forEach((el) => {
    const ctl = el.dataset.ctl;
    if (ctl === 'menu') {
      el.addEventListener('click', () => {
        const menu = card.querySelector('[data-menu]');
        const open = menu?.classList.toggle('hidden') === false;
        el.setAttribute('aria-expanded', String(open));
        if (open) openMenus.add(d.id); else openMenus.delete(d.id);
      });
    } else if (ctl === 'move') {
      el.addEventListener('change', () => moveDevice(d, el.value));
    } else if (ctl === 'delete') {
      el.addEventListener('click', () => deleteDevice(d));
    } else if (ctl === 'power') {
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
    } else if (ctl === 'volume') {
      const lbl = card.querySelector('[data-lbl="volume"]');
      el.addEventListener('input', () => { if (lbl) lbl.textContent = `${el.value}%`; });
      el.addEventListener('change', () => updateStatus(d, { volume: Number(el.value) }, `Volume: ${el.value}%`));
    } else if (ctl === 'mute') {
      el.addEventListener('click', () => { const m = !d.status?.muted; updateStatus(d, { muted: m }, m ? 'Som mudo' : 'Som ativado'); });
    } else if (ctl === 'source') {
      el.addEventListener('change', () => updateStatus(d, { source: el.value }, `Entrada: ${el.value}`));
    } else if (ctl === 'armed') {
      el.addEventListener('click', () => {
        const v = el.dataset.val;
        updateStatus(d, { armed: v, ...(v === 'off' ? { triggered: false } : {}) }, ARMED_LABEL[v], v === 'off' ? 'info' : 'warning');
      });
    } else if (ctl === 'open') {
      el.addEventListener('click', () => {
        const open = !(d.type === 'gate' ? d.status?.open === true : d.status?.open !== false);
        updateStatus(d, { open }, `${d.name}: ${open ? 'abrindo' : 'fechando'}`, open && d.type === 'gate' ? 'warning' : 'info');
      });
    } else if (ctl === 'vacuum') {
      el.addEventListener('click', () => {
        const state = d.status?.state === 'cleaning' ? 'docked' : 'cleaning';
        updateStatus(d, { state }, state === 'cleaning' ? 'Limpeza iniciada' : 'Voltando à base');
      });
    } else if (ctl === 'valve') {
      el.addEventListener('click', () => {
        const open = !(d.status?.open !== false); // inverte
        // o banco transforma a mudança num comando para o ESP32 (migração 013); a tela do painel mostra o resultado
        updateStatus(d, { open }, open ? 'Válvula aberta' : 'Válvula fechada', open ? 'info' : 'warning');
      });
    }
  });
}

/** Move o dispositivo para outro cômodo (persiste no banco). */
async function moveDevice(device, room) {
  if (!room || room === device.room) return;
  const current = getDevice(device.id) || device;
  try {
    const { error } = await client.from('devices').update({ room }).eq('id', device.id);
    if (error) throw new Error(error.message);
    upsertDevice({ ...current, room });
    toast('Dispositivo movido', `${device.name} → ${room}`, 'success');
  } catch (err) {
    console.error('[devices] falha ao mover', err);
    toast('Não foi possível mover o dispositivo', err.message, 'critical');
    render();
  }
}

/** Exclui o dispositivo (e a telemetria dele, por cascata). Avisa se alguma automação o usa. */
async function deleteDevice(device) {
  const used = state.automations.filter((a) => a.action_payload?.device_id === device.id);
  const warn = used.length
    ? `\n\nAtenção: ${used.length} automação(ões) usam este dispositivo e deixarão de funcionar: ${used.map((a) => a.name).join(', ')}.`
    : '';
  if (!window.confirm(`Excluir “${device.name}” (${device.room})? A telemetria dele também será apagada.${warn}`)) return;
  try {
    const { error } = await client.from('devices').delete().eq('id', device.id);
    if (error) throw new Error(error.message);
    openMenus.delete(device.id);
    removeDevice(device.id);
    toast('Dispositivo excluído', device.name, 'info');
  } catch (err) {
    console.error('[devices] falha ao excluir', err);
    toast('Não foi possível excluir o dispositivo', err.message, 'critical');
  }
}

/** Atualização otimista + persistência (Supabase ou mock). */
export async function updateStatus(device, patch, toastMsg, toastType = 'success') {
  const current = getDevice(device.id) || device;
  const merged = { ...(current.status || {}), ...patch };
  upsertDevice({ ...current, status: merged });   // otimista: UI + 3D reagem já
  try {
    // grava o status MESCLADO: update({status: patch}) substituía a coluna inteira no Supabase
    // (perdia brilho/cor, as leituras do quadro elétrico e a marca in_total do total da casa)
    const { error } = await client.from('devices').update({ status: merged }).eq('id', device.id);
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
    const n = state.devices.filter((d) => listable(d) && d.room === g.dataset.room && (d.type === 'light' || d.type === 'ac' || d.type === 'tv') && d.status?.on).length;
    const el = g.querySelector('.room-active-count');
    if (el) el.textContent = n ? `${n} ativo${n > 1 ? 's' : ''}` : '';
  });
}