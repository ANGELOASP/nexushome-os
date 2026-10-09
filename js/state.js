// ============================================================
// NexusHome OS — Estado global + barramento de eventos (pub/sub)
// ============================================================

export const ROOM_ORDER = ['Sala de Estar', 'Quarto Principal', 'Cozinha', 'Área Externa'];

// ---- Tipos de cômodo (v1.6.0) --------------------------------------------
// Presets do Editor de Planta: nome/cor/ícone/tamanho padrão. O `kind`
// viaja na tabela rooms (migração 004) e orienta o mobiliário da cena 3D.
export const ROOM_PRESETS = [
  { kind: 'sala_estar',  label: 'Sala de Estar',  color: '#818cf8', sx: 4.5, sz: 3.5, icon: '<path d="M5 11V8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3"/><path d="M3 13a2 2 0 0 1 4 0v1h10v-1a2 2 0 0 1 4 0v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3z"/><path d="M5 18v2M19 18v2"/>' },
  { kind: 'sala_jantar', label: 'Sala de Jantar', color: '#f59e0b', sx: 3.5, sz: 3.0, icon: '<circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2"/>' },
  { kind: 'quarto',      label: 'Quarto',         color: '#38bdf8', sx: 3.5, sz: 3.0, icon: '<path d="M3 18v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6"/><path d="M3 18h18"/><path d="M5 10V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v4"/><path d="M9 7h6"/>' },
  { kind: 'suite',       label: 'Suíte',          color: '#6366f1', sx: 4.0, sz: 3.5, icon: '<path d="M3 18v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6"/><path d="M3 18h18"/><path d="M5 10V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v4"/><path d="m12 4.5.9 1.8 2 .3-1.45 1.4.35 2-1.8-.95-1.8.95.35-2L9.1 6.6l2-.3z"/>' },
  { kind: 'banheiro',    label: 'Banheiro',       color: '#2dd4bf', sx: 2.0, sz: 2.0, icon: '<path d="M4 21V5a2 2 0 0 1 2-2h1a2 2 0 0 1 2 2v1"/><path d="M9 6h6"/><path d="M12 6v3"/><path d="M8 12c0 2 1.5 3 4 5.5 2.5-2.5 4-3.5 4-5.5a4 4 0 0 0-8 0z" fill="none"/>' },
  { kind: 'cozinha',     label: 'Cozinha',        color: '#fbbf24', sx: 3.5, sz: 3.0, icon: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M5 10h14"/><path d="M8 5v2M8 14v4"/>' },
  { kind: 'lavanderia',  label: 'Lavanderia',     color: '#94a3b8', sx: 2.5, sz: 2.0, icon: '<rect x="4" y="2" width="16" height="20" rx="2"/><circle cx="12" cy="13" r="5"/><circle cx="12" cy="13" r="1.8"/><path d="M7 5.5h2"/>' },
  { kind: 'escritorio',  label: 'Escritório',     color: '#a78bfa', sx: 3.0, sz: 2.5, icon: '<rect x="3" y="4" width="18" height="11" rx="1.5"/><path d="M8 21h8M12 15v6"/><path d="M7 8h6M7 11h4"/>' },
  { kind: 'varanda',     label: 'Varanda',        color: '#4ade80', sx: 3.5, sz: 2.0, icon: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>' },
  { kind: 'garagem',     label: 'Garagem',        color: '#64748b', sx: 5.5, sz: 3.0, icon: '<path d="M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11"/><path d="M4 11h16a1 1 0 0 1 1 1v5h-2M3 17H2v-5a1 1 0 0 1 1-1z"/><path d="M5 17h14"/><circle cx="7.5" cy="17" r="1.8"/><circle cx="16.5" cy="17" r="1.8"/>' },
  { kind: 'corredor',    label: 'Corredor',       color: '#78716c', sx: 4.0, sz: 1.5, icon: '<path d="M4 12h16"/><path d="m14 6 6 6-6 6"/><path d="M4 6v12" stroke-dasharray="2 2"/>' },
  { kind: 'area_externa', label: 'Área Externa',  color: '#22c55e', sx: 4.0, sz: 4.0, icon: '<path d="M12 22v-6"/><path d="M12 16c-4 0-7-2.5-7-7 0-3 2.5-5.5 7-7 4.5 1.5 7 4 7 7 0 4.5-3 7-7 7z"/><path d="M9 9c1.5 1 4.5 1 6 0"/>' },
  { kind: 'closet',      label: 'Closet',         color: '#f472b6', sx: 2.0, sz: 1.5, icon: '<rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M12 3v18"/><path d="M9.5 10v3M14.5 10v3"/>' },
  { kind: 'despensa',    label: 'Despensa',       color: '#fb923c', sx: 1.5, sz: 1.5, icon: '<path d="m12 2 9 5v10l-9 5-9-5V7z"/><path d="m3 7 9 5 9-5"/><path d="M12 12v10"/>' },
  { kind: 'personalizado', label: 'Personalizado', color: '#c084fc', sx: 3.0, sz: 3.0, icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v4a2 2 0 0 1-4 0"/><path d="M21 15h-4a2 2 0 0 0 0 4h4"/>' },
];

/** Teto de andares do editor/cena (0 = térreo … 2 = 2º andar). */
export const MAX_FLOORS = 3;

/** Rótulo de exibição de um andar. */
export function floorLabel(f) {
  const n = Number(f) || 0;
  return n === 0 ? 'Térreo' : `${n}º Andar`;
}

/** Infere o `kind` a partir do nome (plantas antigas sem a coluna). */
export function inferRoomKind(name) {
  const n = String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  if (n.includes('externa') || n.includes('quintal') || n.includes('jardim')) return 'area_externa';
  if (n.includes('suite')) return 'suite';
  if (n.includes('quarto') || n.includes('dormitorio')) return 'quarto';
  if (n.includes('jantar')) return 'sala_jantar';
  if (n.includes('sala')) return 'sala_estar';
  if (n.includes('banheiro') || n.includes('lavabo') || n.includes('wc')) return 'banheiro';
  if (n.includes('cozinha')) return 'cozinha';
  if (n.includes('lavanderia') || n.includes('servico')) return 'lavanderia';
  if (n.includes('escritorio') || n.includes('office') || n.includes('estudo')) return 'escritorio';
  if (n.includes('varanda') || n.includes('sacada') || n.includes('terraco')) return 'varanda';
  if (n.includes('garagem')) return 'garagem';
  if (n.includes('corredor') || n.includes('hall')) return 'corredor';
  if (n.includes('closet')) return 'closet';
  if (n.includes('despensa')) return 'despensa';
  return 'personalizado';
}

/** Preset pelo kind (fallback: personalizado). */
export function presetByKind(kind) {
  return ROOM_PRESETS.find((p) => p.kind === kind) || ROOM_PRESETS[ROOM_PRESETS.length - 1];
}

/** Normaliza uma linha da tabela rooms: garante floor int e kind válido. */
export function normalizeRoom(row) {
  const floor = Number.isFinite(Number(row.floor)) ? Math.max(0, Math.min(MAX_FLOORS - 1, Math.trunc(Number(row.floor)))) : 0;
  const kind = row.kind && ROOM_PRESETS.some((p) => p.kind === row.kind) ? row.kind : inferRoomKind(row.name);
  // `points`: polígono [[x,z],...] relativo ao centro da caixa (migração 008); nulo = retângulo
  const pts = Array.isArray(row.points) && row.points.length >= 3
    ? row.points.map((p) => [Number(p[0]), Number(p[1])]).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
    : null;
  return { ...row, floor, kind, points: pts && pts.length >= 3 ? pts : null };
}

// Planta padrão (espelha os seeds de supabase/migrations/003_rooms.sql
// + backfill de kind da migração 004). Posições/tamanhos em METROS
// (1 célula do editor = 0,5 m; a cena 3D converte × 1.9). O eixo z
// equivale ao "y para baixo" da planta 2D. Todos no térreo (floor 0).
export const DEFAULT_ROOMS = [
  { id: 'c1111111-1111-4111-8111-111111111111', name: 'Sala de Estar',    pos_x: -1.6, pos_z:  1.6, size_x: 3.0, size_z: 3.0, color: '#818cf8', sort_order: 1, floor: 0, kind: 'sala_estar' },
  { id: 'c2222222-2222-4222-8222-222222222222', name: 'Quarto Principal', pos_x: -1.6, pos_z: -1.6, size_x: 3.0, size_z: 3.0, color: '#38bdf8', sort_order: 2, floor: 0, kind: 'quarto' },
  { id: 'c3333333-3333-4333-8333-333333333333', name: 'Cozinha',          pos_x:  1.6, pos_z:  1.6, size_x: 3.0, size_z: 3.0, color: '#fbbf24', sort_order: 3, floor: 0, kind: 'cozinha' },
  { id: 'c4444444-4444-4444-8444-444444444444', name: 'Área Externa',     pos_x:  1.6, pos_z: -1.6, size_x: 3.0, size_z: 3.0, color: '#4ade80', sort_order: 4, floor: 0, kind: 'area_externa' },
];

export const state = {
  mode: 'demo',            // 'demo' | 'live'
  devices: [],             // linhas da tabela devices
  automations: [],         // linhas da tabela automations
  alerts: [],              // linhas da tabela alerts (mais recentes primeiro)
  rooms: [],               // linhas da tabela rooms (planta da residência)
  walls: [],               // paredes vetoriais da planta (tabela walls) — renderizadas no 3D
  selectedRoom: null,      // nome do cômodo selecionado no 3D
  health: 'safe',          // 'safe' | 'warning' | 'critical'
  lastTelemetry: {         // último valor conhecido por métrica
    energy_watts: 0,
    water_flow_lph: 0,
    temperature: null,
    humidity: null,
  },
  stReadings: {},          // últimas leituras SmartThings: { deviceId: { temperature, humidity, online } }
  stConnected: false,      // painel SmartThings com token válido (demo conta como conectado)
};

// ---- mini pub/sub -------------------------------------------------------
const listeners = new Map(); // event -> Set<fn>

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}

export function emit(event, payload) {
  listeners.get(event)?.forEach((fn) => {
    try { fn(payload); } catch (err) { console.error(`[state] erro em listener de "${event}"`, err); }
  });
}

// ---- helpers de domínio -------------------------------------------------

export function getDevice(id) {
  return state.devices.find((d) => d.id === id) || null;
}

export function upsertDevice(row) {
  const i = state.devices.findIndex((d) => d.id === row.id);
  if (i >= 0) state.devices[i] = { ...state.devices[i], ...row };
  else state.devices.push(row);
  emit('devices-changed', state.devices);
  emit('device-changed', getDevice(row.id));
}

/** Remove um dispositivo do estado (ex.: aparelho SmartThings/Tuya desvinculado do cômodo). */
export function removeDevice(id) {
  const i = state.devices.findIndex((d) => d.id === id);
  if (i < 0) return;
  state.devices.splice(i, 1);
  emit('devices-changed', state.devices);
}

export function upsertAutomation(row) {
  const i = state.automations.findIndex((a) => a.id === row.id);
  if (i >= 0) state.automations[i] = { ...state.automations[i], ...row };
  else state.automations.push(row);
  emit('automations-changed', state.automations);
}

export function prependAlert(row) {
  if (state.alerts.some((a) => a.id === row.id)) return;
  state.alerts.unshift(row);
  state.alerts = state.alerts.slice(0, 40);
  emit('alerts-changed', state.alerts);
  emit('alert-new', row);
}

// ---- planta da residência (rooms) ---------------------------------------

export function setRooms(rows) {
  state.rooms = [...(rows || [])]
    .map(normalizeRoom)
    .sort((a, b) => ((a.floor ?? 0) - (b.floor ?? 0)) || ((a.sort_order ?? 0) - (b.sort_order ?? 0)));
  emit('rooms-changed', state.rooms);
}

/** Nomes dos cômodos na ordem da planta (fallback: planta padrão). */
export function getRoomNames() {
  const names = state.rooms.map((r) => r.name);
  return names.length ? names : [...ROOM_ORDER];
}

export function allDevicesOff() {
  return state.devices.every((d) => {
    if (d.type === 'light' || d.type === 'ac') return !d.status?.on;
    return true; // válvula/medidor não contam como "liga/desliga"
  });
}
