// ============================================================
// NexusHome OS — Estado global + barramento de eventos (pub/sub)
// ============================================================

export const ROOM_ORDER = ['Sala de Estar', 'Quarto Principal', 'Cozinha', 'Área Externa'];

export const state = {
  mode: 'demo',            // 'demo' | 'live'
  devices: [],             // linhas da tabela devices
  automations: [],         // linhas da tabela automations
  alerts: [],              // linhas da tabela alerts (mais recentes primeiro)
  selectedRoom: null,      // nome do cômodo selecionado no 3D
  health: 'safe',          // 'safe' | 'warning' | 'critical'
  lastTelemetry: {         // último valor conhecido por métrica
    energy_watts: 0,
    water_flow_lph: 0,
    temperature: null,
    humidity: null,
  },
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

export function allDevicesOff() {
  return state.devices.every((d) => {
    if (d.type === 'light' || d.type === 'ac') return !d.status?.on;
    return true; // válvula/medidor não contam como "liga/desliga"
  });
}
