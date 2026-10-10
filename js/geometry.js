// ============================================================
// NexusHome OS — geometria 2D de plantas (módulo puro, sem DOM)
// Pontos são [x, z] em METROS. Cômodos poligonais guardam
// `points` RELATIVOS ao centro da caixa (pos_x/pos_z), então
// mover o cômodo é só mudar pos — igual ao retângulo.
// ============================================================

export const MIN_POLY_AREA = 0.5;     // m² — abaixo disso o polígono é descartado

export function isPoly(room) {
  return Array.isArray(room?.points) && room.points.length >= 3;
}

/** Área (m²) de um polígono simples (fórmula do cadarço). */
export function polyArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, z1] = pts[i];
    const [x2, z2] = pts[(i + 1) % pts.length];
    a += x1 * z2 - x2 * z1;
  }
  return Math.abs(a) / 2;
}

/** Centroide de área (cai para a média dos vértices se a área for ~0). */
export function polyCentroid(pts) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, z1] = pts[i];
    const [x2, z2] = pts[(i + 1) % pts.length];
    const k = x1 * z2 - x2 * z1;
    a += k; cx += (x1 + x2) * k; cz += (z1 + z2) * k;
  }
  if (Math.abs(a) < 1e-9) {
    const n = pts.length || 1;
    return [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

export function bboxOf(pts) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  pts.forEach(([x, z]) => {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  });
  return { minX, maxX, minZ, maxZ };
}

/** Ponto dentro do polígono (regra par-ímpar). */
export function pointInPoly(x, z, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i];
    const [xj, zj] = pts[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Distância de um ponto a um segmento. */
export function distToSegment(px, pz, x1, z1, x2, z2) {
  const dx = x2 - x1, dz = z2 - z1;
  const len2 = dx * dx + dz * dz;
  if (len2 === 0) return Math.hypot(px - x1, pz - z1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (pz - z1) * dz) / len2));
  return Math.hypot(px - (x1 + t * dx), pz - (z1 + t * dz));
}

/** Remove vértices repetidos/colineares e o ponto final que repete o inicial. */
export function cleanPoly(pts, eps = 1e-6) {
  let out = pts.map((p) => [Number(p[0]), Number(p[1])]).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (out.length > 1) {
    const f = out[0], l = out[out.length - 1];
    if (Math.hypot(f[0] - l[0], f[1] - l[1]) < eps) out = out.slice(0, -1);
  }
  out = out.filter((p, i) => {
    const q = out[(i + out.length - 1) % out.length];
    return Math.hypot(p[0] - q[0], p[1] - q[1]) > eps;
  });
  // colineares
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i + out.length - 1) % out.length], b = out[i], c = out[(i + 1) % out.length];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(cross) < eps) { out.splice(i, 1); changed = true; break; }
    }
  }
  return out;
}

/** Polígono simples? (nenhum par de arestas não adjacentes se cruza) */
export function isSimplePoly(pts) {
  const n = pts.length;
  if (n < 3) return false;
  const ccw = (a, b, c) => (c[1] - a[1]) * (b[0] - a[0]) > (b[1] - a[1]) * (c[0] - a[0]);
  const inter = (a, b, c, d) => ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(i - j) === 1 || (i === 0 && j === n - 1)) continue;
      if (inter(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return false;
    }
  }
  return true;
}

/** Vértices absolutos [x,z] de um cômodo poligonal. */
export function polyAbs(room) {
  return room.points.map(([x, z]) => [room.pos_x + x, room.pos_z + z]);
}

/**
 * Grava vértices absolutos num cômodo: recalcula pos (centro da caixa),
 * size (caixa) e points relativos. Mantém a caixa coerente com o resto do app.
 */
export function setPolyAbs(room, abs) {
  const b = bboxOf(abs);
  const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  room.pos_x = round3(cx);
  room.pos_z = round3(cz);
  room.size_x = round3(Math.max(0.5, b.maxX - b.minX));
  room.size_z = round3(Math.max(0.5, b.maxZ - b.minZ));
  room.points = abs.map(([x, z]) => [round3(x - room.pos_x), round3(z - room.pos_z)]);
  return room;
}

/** Retângulo → quatro vértices (para "Converter em polígono"). */
export function rectToPoints(room) {
  const hx = room.size_x / 2, hz = room.size_z / 2;
  return [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]];
}

/** Área do cômodo (retângulo ou polígono). */
export function roomArea(room) {
  return isPoly(room) ? polyArea(room.points) : room.size_x * room.size_z;
}

/**
 * Maior retângulo (mesma proporção da caixa) centrado no centroide e todo
 * dentro do polígono — onde cabe o mobiliário padrão dos presets.
 * Retorna { cx, cz, sx, sz } relativos ao centro da caixa.
 */
export function innerRect(points) {
  const b = bboxOf(points);
  const w = b.maxX - b.minX, h = b.maxZ - b.minZ;
  // candidatos: centroide + grade sobre a caixa (o centroide de um "L" pode cair fora do polígono)
  const [c0x, c0z] = polyCentroid(points);
  const cands = [[c0x, c0z]];
  const N = 14;
  for (let i = 1; i < N; i++) for (let k = 1; k < N; k++) cands.push([b.minX + (w * i) / N, b.minZ + (h * k) / N]);

  const probe = [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [1, 0], [0, 1], [-1, 0]];
  const fitsAt = (cx, cz, s) => {
    const hx = (w * s) / 2, hz = (h * s) / 2;
    return probe.every(([kx, kz]) => pointInPoly(cx + kx * hx, cz + kz * hz, points));
  };
  let best = null;
  cands.forEach(([cx, cz]) => {
    if (!pointInPoly(cx, cz, points)) return;
    let lo = 0, hi = 1;
    if (!fitsAt(cx, cz, 0.04)) return;
    lo = 0.04;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (fitsAt(cx, cz, mid)) lo = mid; else hi = mid;
    }
    if (!best || lo > best.s) best = { cx, cz, s: lo };
  });
  if (!best) return { cx: c0x, cz: c0z, sx: Math.max(1, w * 0.2), sz: Math.max(1, h * 0.2) };
  return { cx: best.cx, cz: best.cz, sx: Math.max(1, w * best.s), sz: Math.max(1, h * best.s) };
}

function round3(v) { return Math.round(v * 1000) / 1000; }

// ------------------------------------------------------------
// Portas e janelas (tabela openings): recortes em uma parede
// ------------------------------------------------------------

export const OPENING_DEFAULTS = {
  door:   { width: 0.9, height: 2.1, sill: 0 },
  window: { width: 1.2, height: 1.2, sill: 1.0 },
};
export const MIN_OPENING = 0.3;     // largura mínima (m)
const OPEN_MARGIN = 0.05;           // folga mínima até a ponta da parede (m)

/**
 * Normaliza e valida as aberturas de UMA parede de comprimento `len`:
 * limita ao vão da parede, descarta as menores que MIN_OPENING e as que se sobrepõem.
 * Retorna [{ ...o, a, b }] ordenadas, onde a/b são as bordas (m) medidas desde o início da parede.
 */
export function layoutOpenings(len, openings, wallH = 2.5) {
  const out = [];
  const list = (openings || [])
    .map((o) => ({ o, c: Number(o.offset_m) }))
    .filter(({ c }) => Number.isFinite(c))
    .sort((p, q) => p.c - q.c);
  let lastB = OPEN_MARGIN;
  for (const { o, c } of list) {
    const w = Number(o.width) || OPENING_DEFAULTS[o.kind]?.width || 0.9;
    const a = Math.max(c - w / 2, lastB);
    const b = Math.min(c + w / 2, len - OPEN_MARGIN);
    if (b - a < MIN_OPENING) continue;
    const sill = Math.max(0, Math.min(Number(o.sill) || 0, wallH - 0.3));
    const top = Math.min(wallH, sill + (Number(o.height) || OPENING_DEFAULTS[o.kind]?.height || 2.1));
    out.push({ ...o, a, b, sill, top });
    lastB = b;
  }
  return out;
}

/**
 * Peças de uma parede com aberturas (tudo ao longo do eixo da parede, a partir do início):
 *   solids: blocos de parede [{a, b, y0, y1}] (as pontas se estendem th/2, como a caixa da parede inteira)
 *   glass:  vidros das janelas [{a, b, y0, y1}]
 *   doors:  folhas de porta [{a, b, h}] (a = lado da dobradiça)
 */
export function wallPieces(len, th, openings, wallH = 2.5) {
  const ops = layoutOpenings(len, openings, wallH);
  const solids = [], glass = [], doors = [];
  let cur = 0;
  ops.forEach((o) => {
    if (o.a > cur + 1e-6) solids.push({ a: cur, b: o.a, y0: 0, y1: wallH });
    if (o.sill > 0) solids.push({ a: o.a, b: o.b, y0: 0, y1: o.sill });
    if (o.top < wallH - 1e-6) solids.push({ a: o.a, b: o.b, y0: o.top, y1: wallH });
    if (o.kind === 'window') glass.push({ a: o.a, b: o.b, y0: o.sill, y1: o.top });
    else doors.push({ a: o.a, b: o.b, h: o.top - o.sill });
    cur = o.b;
  });
  if (len > cur + 1e-6) solids.push({ a: cur, b: len, y0: 0, y1: wallH });
  if (solids.length) {
    // pontas: a caixa original tem len + th (cobre as quinas)
    const first = solids.reduce((m, s) => (s.a < m.a ? s : m), solids[0]);
    const last = solids.reduce((m, s) => (s.b > m.b ? s : m), solids[0]);
    if (first.a <= 1e-6) first.a -= th / 2;
    if (last.b >= len - 1e-6) last.b += th / 2;
  }
  return { solids, glass, doors };
}

/** Posição (m desde o início da parede) mais próxima de (x,z), limitada ao vão útil da parede. */
export function projectOnWall(wl, x, z) {
  const dx = wl.x2 - wl.x1, dz = wl.z2 - wl.z1;
  const len = Math.hypot(dx, dz);
  if (!len) return { t: 0, d: Math.hypot(x - wl.x1, z - wl.z1), len };
  const t = ((x - wl.x1) * dx + (z - wl.z1) * dz) / len;
  const tc = Math.max(0, Math.min(len, t));
  const d = Math.hypot(x - (wl.x1 + (dx / len) * tc), z - (wl.z1 + (dz / len) * tc));
  return { t, d, len };
}
