// ============================================================
// NexusHome OS — fixação automática de dispositivos (v2.9)
// ------------------------------------------------------------
// Módulo puro: dado o modelo da biblioteca (device-catalog.js) e o
// clique na planta, devolve onde o aparelho fica de verdade:
//   { x, z, y, rot, note, ok }
//   x, z  ponto em metros (na face da parede, sobre o móvel...)
//   y     altura da base do aparelho (m)
//   rot   graus; frente do aparelho = (-sin rot, cos rot) — mesma
//         convenção dos móveis (furniture.js)
//   note  texto curto para o usuário ("na parede, acima da janela")
// ============================================================

import { projectOnWall, layoutOpenings } from './geometry.js';
import { FURNITURE_BY_KIND } from './furniture.js';

const SNAP_WALL = 0.9;       // m: distância máxima até a parede
const SNAP_FURN = 0.5;       // m: folga ao redor do móvel
const SNAP_OPEN = 1.2;       // m: distância até a porta/janela

const deg = (r) => ((Math.round((r * 180) / Math.PI) % 360) + 360) % 360;
/** Giro cuja frente aponta para o vetor (fx, fz). */
export function rotFacing(fx, fz) { return deg(Math.atan2(-fx, fz)); }

/** Parede mais próxima do ponto (com o pé da perpendicular e o lado do clique). */
export function nearestWall(walls, x, z, maxD = SNAP_WALL) {
  let best = null;
  for (const wl of walls || []) {
    const p = projectOnWall(wl, x, z);
    if (!p.len || p.t < 0 || p.t > p.len) continue;
    if (p.d <= maxD && (!best || p.d < best.d)) best = { wl, ...p };
  }
  if (!best) return null;
  const { wl, t, len } = best;
  const ux = (wl.x2 - wl.x1) / len, uz = (wl.z2 - wl.z1) / len;
  const nx = -uz, nz = ux;                                   // normal da parede
  const fx = wl.x1 + ux * t, fz = wl.z1 + uz * t;            // pé da perpendicular
  const side = ((x - fx) * nx + (z - fz) * nz) >= 0 ? 1 : -1; // lado em que o usuário clicou
  return { ...best, ux, uz, nx: nx * side, nz: nz * side, fx, fz };
}

/** Coloca na face da parede, virado para dentro do cômodo. */
function onWall(hit, y, along = hit.t) {
  const th = Number(hit.wl.th) || 0.15;
  const px = hit.wl.x1 + hit.ux * along, pz = hit.wl.z1 + hit.uz * along;
  return { x: r3(px + hit.nx * (th / 2)), z: r3(pz + hit.nz * (th / 2)), y, rot: rotFacing(hit.nx, hit.nz) };
}

const r3 = (v) => Math.round(v * 1000) / 1000;

/** Aberturas da parede já com limites (a, b) e altura (sill, top). */
function wallOpenings(wl, openings) {
  const len = Math.hypot(wl.x2 - wl.x1, wl.z2 - wl.z1);
  return layoutOpenings(len, (openings || []).filter((o) => o.wall_id === wl.id), Number(wl.height) || 2.5);
}

/** Abertura (porta/janela) mais próxima do ponto, em qualquer parede. */
function nearestOpening(walls, openings, kind, x, z) {
  let best = null;
  for (const wl of walls || []) {
    const ops = wallOpenings(wl, openings).filter((o) => o.kind === kind);
    if (!ops.length) continue;
    const p = projectOnWall(wl, x, z);
    for (const o of ops) {
      const c = (o.a + o.b) / 2;
      const along = Math.max(o.a, Math.min(o.b, p.t));
      const d = Math.hypot(p.d, p.t - along);
      if (d <= SNAP_OPEN && (!best || d < best.d)) best = { wl, o, c, d, t: p.t };
    }
  }
  return best;
}

/** Móvel compatível sob (ou perto de) o ponto. */
function nearestFurniture(furniture, kinds, x, z) {
  let best = null;
  for (const f of furniture || []) {
    if (!kinds.includes(f.kind)) continue;
    const def = FURNITURE_BY_KIND[f.kind];
    if (!def) continue;
    const a = ((Number(f.rot) || 0) * Math.PI) / 180;
    const c = Math.cos(a), s = Math.sin(a);
    const dx = x - f.x, dz = z - f.z;
    const lx = dx * c + dz * s, lz = -dx * s + dz * c;       // ponto no referencial do móvel
    const ex = Math.max(0, Math.abs(lx) - def.w / 2), ez = Math.max(0, Math.abs(lz) - def.d / 2);
    const d = Math.hypot(ex, ez);
    if (d <= SNAP_FURN && (!best || d < best.d)) best = { f, def, d };
  }
  return best;
}

/**
 * Onde o aparelho fica. `ctx` = { walls, openings, furniture } do andar atual.
 * Sem parede/móvel por perto, fica no ponto clicado com a altura padrão (ok: false explica).
 */
export function mountDevice(entry, x, z, ctx = {}) {
  const base = { x: r3(x), z: r3(z), y: entry?.y ?? 0, rot: null, ok: true, note: '' };
  if (!entry) return base;
  const walls = ctx.walls || [];
  switch (entry.mount) {
    case 'ceiling': return { ...base, note: 'no teto' };
    case 'floor': return { ...base, y: 0, note: 'no piso' };
    case 'wall': {
      const hit = nearestWall(walls, x, z);
      if (!hit) return { ...base, ok: false, note: 'sem parede por perto — clique junto a uma parede' };
      const out = { ...base, ...onWall(hit, entry.y), note: 'na parede' };
      if (entry.aboveWindow) {
        const win = wallOpenings(hit.wl, ctx.openings).find((o) => o.kind === 'window' && hit.t >= o.a - 0.35 && hit.t <= o.b + 0.35);
        if (win) {
          const wallH = Number(hit.wl.height) || 2.5;
          // centraliza sobre a janela e sobe acima da verga (respeitando o teto)
          Object.assign(out, onWall(hit, Math.min(wallH - 0.32, win.top + 0.12), (win.a + win.b) / 2));
          out.note = 'na parede, acima da janela';
        }
      }
      return out;
    }
    case 'window': {
      const hit = nearestOpening(walls, ctx.openings, 'window', x, z);
      if (!hit) return { ...base, ok: false, note: 'sem janela por perto — clique junto a uma janela' };
      const side = nearestWall([hit.wl], x, z, 5);
      const pos = onWall(side, hit.o.top + 0.05, hit.c);
      return { ...base, ...pos, width: r3(hit.o.b - hit.o.a + 0.2), note: 'sobre a janela' };
    }
    case 'door': {
      const hit = nearestOpening(walls, ctx.openings, 'door', x, z);
      if (!hit) return { ...base, ok: false, note: 'sem porta por perto — clique junto a uma porta' };
      const side = nearestWall([hit.wl], x, z, 5);
      // lado da maçaneta: oposto à dobradiça
      const latch = hit.o.hinge === 'end' ? hit.o.a + 0.1 : hit.o.b - 0.1;
      const along = entry.model === 'lock' ? latch : (hit.o.a + hit.o.b) / 2;
      const y = entry.model === 'lock' ? entry.y : Math.min(hit.o.top + 0.03, 2.3);
      return { ...base, ...onWall({ ...side, t: along }, y, along), note: entry.model === 'lock' ? 'na porta, lado da maçaneta' : 'no batente da porta' };
    }
    case 'furniture': {
      const hit = nearestFurniture(ctx.furniture, entry.furniture || [], x, z);
      if (!hit) {
        // sem móvel: TV vai para a parede; outros ficam no ponto, à altura padrão
        if (entry.type === 'tv') {
          const w = nearestWall(walls, x, z);
          if (w) return { ...base, ...onWall(w, 1.0), note: 'na parede (sem móvel por perto)' };
        }
        return { ...base, ok: false, note: 'sem móvel compatível por perto' };
      }
      const { f, def } = hit;
      const rot = ((Number(f.rot) || 0) % 360 + 360) % 360;
      const a = (rot * Math.PI) / 180;
      const fx = -Math.sin(a), fz = Math.cos(a);              // frente do móvel
      if (f.kind === 'painel_tv' && entry.type === 'tv') {
        // TV presa no painel (face do painel fica a 0,13 m atrás do centro)
        return { ...base, x: r3(f.x - fx * 0.12), z: r3(f.z - fz * 0.12), y: 0.85, rot, note: 'fixada no painel' };
      }
      const backish = entry.type === 'tv' ? -def.d / 2 + 0.12 : 0;    // TV mais para o fundo do móvel
      return { ...base, x: r3(f.x + fx * backish), z: r3(f.z + fz * backish), y: def.h, rot, note: `sobre ${def.label.toLowerCase()}` };
    }
    default: return base;
  }
}
