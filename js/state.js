// ============================================================
// NexusHome OS — Estado global + barramento de eventos (pub/sub)
// ============================================================

export const ROOM_ORDER = ['Sala de Estar', 'Quarto Principal', 'Cozinha', 'Área Externa'];

// Planta padrão (espelha os seeds de supabase/migrations/003_rooms.sql).
// Posições/tamanhos em METROS (1 célula do editor = 0,5 m; a cena 3D
// converte × 1.9). O eixo z equivale ao "y para baixo" da planta 2D.
export const DEFAULT_ROOMS = [
  { id: 'c1111111-1111-4111-8111-111111111111', name: 'Sala de Estar',    pos_x: -1.6, pos_z:  1.6, size_x: 3.0, size_z: 3.0, color: '#818cf8', sort_order: 1 },
  { id: 'c2222222-2222-4222-8222-222222222222', name: 'Quarto Principal', pos_x: -1.6, pos_z: -1.6, size_x: 3.0, size_z: 3.0, color: '#38bdf8', sort_order: 2 },
  { id: 'c3333333-3333-4333-8333-333333333333', name: 'Cozinha',          pos_x:  1.6, pos_z:  1.6, size_x: 3.0, size_z: 3.0, color: '#fbbf24', sort_order: 3 },
  { id: 'c4444444-4444-4444-8444-444444444444', name: 'Área Externa',     pos_x:  1.6, pos_z: -1.6, size_x: 3.0, size_z: 3.0, color: '#4ade80', sort_order: 4 },
];

export const state = {
  mode: 'demo',            // 'demo' | 'live'
  devices: [],             // linhas da tabela devices
  automations: [],         // linhas da tabela automations
  alerts: [],              // linhas da tabela alerts (mais recentes primeiro)
  rooms: [],               // linhas da tabela rooms (planta da residência)
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
  state.rooms = [...(rows || [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
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
