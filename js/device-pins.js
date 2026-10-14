// ============================================================
// NexusHome OS — dispositivos posicionados na planta (v2.7.0)
// Módulo puro (sem DOM): cada dispositivo pode ter um ponto na
// planta (pos_x/pos_z em METROS, pos_floor = andar — migração 015).
// O editor 2D e a cena 3D usam estas regras em comum.
// ============================================================

import { isPoly, pointInPoly } from './geometry.js';

/** Cor e letra do marcador por tipo de dispositivo. */
export const PIN_STYLE = {
  light:  { color: '#f2b24a', letter: 'L', label: 'Luz' },
  ac:     { color: '#38bdf8', letter: 'A', label: 'Ar-condicionado' },
  tv:     { color: '#818cf8', letter: 'T', label: 'TV' },
  valve:  { color: '#22d3ee', letter: 'V', label: 'Válvula' },
  meter:  { color: '#4ade80', letter: 'M', label: 'Medidor' },
  sensor: { color: '#2dd4bf', letter: 'S', label: 'Sensor' },
  solar:  { color: '#facc15', letter: 'E', label: 'Solar' },
  fan:    { color: '#7dd3fc', letter: 'F', label: 'Ventilador' },
  plug:   { color: '#a3e635', letter: 'P', label: 'Tomada' },
  switch: { color: '#fcd34d', letter: 'I', label: 'Interruptor' },
  lock:   { color: '#f472b6', letter: 'K', label: 'Fechadura' },
  camera: { color: '#c084fc', letter: 'C', label: 'Câmera' },
  curtain: { color: '#fb923c', letter: 'R', label: 'Cortina' },
  speaker: { color: '#60a5fa', letter: 'A', label: 'Assistente' },
  hub:    { color: '#94a3b8', letter: 'H', label: 'Hub' },
  // v2.13 — biblioteca ampliada
  audio:     { color: '#38bdf8', letter: '♪', label: 'Áudio' },
  projector: { color: '#a78bfa', letter: 'J', label: 'Projetor' },
  media:     { color: '#818cf8', letter: 'M', label: 'Mídia' },
  computer:  { color: '#93c5fd', letter: 'PC', label: 'Computador' },
  tablet:    { color: '#67e8f9', letter: 'T', label: 'Tablet' },
  network:   { color: '#5eead4', letter: 'W', label: 'Rede' },
  appliance: { color: '#fdba74', letter: 'E', label: 'Eletrodoméstico' },
  vacuum:    { color: '#86efac', letter: 'R', label: 'Robô aspirador' },
  alarm:     { color: '#f87171', letter: '!', label: 'Alarme' },
  gate:      { color: '#fbbf24', letter: 'G', label: 'Portão' },
};
export const PIN_DEFAULT = { color: '#94a3b8', letter: '•', label: 'Dispositivo' };

export function pinStyle(type) { return PIN_STYLE[type] || PIN_DEFAULT; }

/** O dispositivo tem um ponto válido na planta? */
export function isPlaced(d) {
  return d != null && d.pos_x != null && d.pos_z != null
    && Number.isFinite(Number(d.pos_x)) && Number.isFinite(Number(d.pos_z));
}

/** Andar do marcador: o gravado; senão o do cômodo do dispositivo; senão térreo. */
export function pinFloor(d, rooms = []) {
  if (d?.pos_floor != null && Number.isFinite(Number(d.pos_floor))) return Math.max(0, Math.trunc(Number(d.pos_floor)));
  const r = rooms.find((x) => x.name === d?.room);
  return Math.max(0, Math.trunc(Number(r?.floor) || 0));
}

/** O ponto (x, z) está dentro do cômodo (retângulo ou polígono)? */
export function roomContainsPoint(row, x, z) {
  const px = Number(row.pos_x) || 0, pz = Number(row.pos_z) || 0;
  if (isPoly(row)) return pointInPoly(x - px, z - pz, row.points);
  return Math.abs(x - px) <= (Number(row.size_x) || 0) / 2 && Math.abs(z - pz) <= (Number(row.size_z) || 0) / 2;
}

/** Cômodo do andar que contém o ponto (o menor, se houver sobreposição). */
export function roomAtPoint(rooms, floor, x, z) {
  const hits = (rooms || []).filter((r) => (Math.trunc(Number(r.floor) || 0)) === floor && roomContainsPoint(r, x, z));
  if (!hits.length) return null;
  const area = (r) => (Number(r.size_x) || 0) * (Number(r.size_z) || 0);
  return hits.sort((a, b) => area(a) - area(b))[0];
}

/** O dispositivo está "ligado" (luz/AC/TV acesos, válvula aberta)? */
export function deviceActive(d) {
  if (!d) return false;
  const s = d.status || {};
  if (d.type === 'valve') return s.open !== false;
  if (d.type === 'gate') return s.open === true;
  if (d.type === 'alarm') return !!s.armed && s.armed !== 'off';
  if (d.type === 'vacuum') return s.state === 'cleaning';
  return !!s.on;
}
