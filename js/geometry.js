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
