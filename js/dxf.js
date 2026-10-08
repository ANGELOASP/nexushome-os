// ============================================================
// NexusHome OS — leitor de DXF (ASCII) para plantas baixas
// ------------------------------------------------------------
// Lê LINE, LWPOLYLINE, POLYLINE/VERTEX, ARC, CIRCLE e INSERT
// (blocos, com escala/rotação) e devolve itens por camada.
// `dxfToPlan` converte para o modelo do NexusHome: paredes
// (segmentos em metros) e cômodos (polígonos fechados).
//
// DWG é um formato binário proprietário e NÃO é lido aqui:
// exporte/converta para DXF (veja docs/importar-planta-cad.md).
// DXF binário também não é suportado.
// ============================================================

import { cleanPoly, polyArea, isSimplePoly, pointInPoly } from './geometry.js';

const INSUNITS = { 1: 0.0254, 2: 0.3048, 3: 1609.344, 4: 0.001, 5: 0.01, 6: 1, 7: 1000, 8: 2.54e-8, 9: 2.54e-5, 10: 0.9144 };
export const UNIT_LABELS = { 0.001: 'milímetros', 0.01: 'centímetros', 1: 'metros', 0.0254: 'polegadas', 0.3048: 'pés' };
const MAX_SEGMENTS = 30000;
const ARC_STEP_DEG = 12;

export class DxfError extends Error {}

/** Lê pares (código de grupo, valor) do texto DXF. */
function toPairs(text) {
  const lines = text.split(/\r?\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) continue;
    pairs.push([code, lines[i + 1].trim()]);
  }
  return pairs;
}

function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; }

/** Pontos de um arco/bulge, de a0 a a1 (graus, anti-horário). */
function arcPoints(cx, cy, r, a0, a1) {
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += 360;
  const n = Math.max(2, Math.ceil(sweep / ARC_STEP_DEG));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = ((a0 + (sweep * i) / n) * Math.PI) / 180;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

/** Segmento com bulge (LWPOLYLINE) → pontos intermediários (sem repetir o 1º). */
function bulgePoints(p1, p2, bulge) {
  if (!bulge) return [p2];
  const theta = 4 * Math.atan(bulge);                // ângulo do arco (com sinal)
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-9) return [p2];
  const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
  const mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2;
  const h = r * Math.cos(theta / 2);
  const nx = -dy / chord, ny = dx / chord;           // normal à corda
  const sign = bulge > 0 ? 1 : -1;                   // CCW (bulge>0): centro à esquerda da corda
  const cx = mx + sign * nx * h, cy = my + sign * ny * h;
  const a0 = Math.atan2(p1[1] - cy, p1[0] - cx);
  const steps = Math.max(2, Math.ceil((Math.abs(theta) * 180) / Math.PI / ARC_STEP_DEG));
  const out = [];
  for (let i = 1; i <= steps; i++) {
    const a = a0 + (theta * i) / steps;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  out[out.length - 1] = p2;
  return out;
}

/** Divide os pares em entidades { type, pairs[] } e blocos. */
function splitSections(pairs) {
  const sections = {};
  let i = 0;
  while (i < pairs.length) {
    if (pairs[i][0] === 0 && pairs[i][1] === 'SECTION' && pairs[i + 1]?.[0] === 2) {
      const name = pairs[i + 1][1];
      let j = i + 2;
      while (j < pairs.length && !(pairs[j][0] === 0 && pairs[j][1] === 'ENDSEC')) j++;
      sections[name] = pairs.slice(i + 2, j);
      i = j + 1;
    } else i++;
  }
  return sections;
}

function entitiesOf(pairs) {
  const ents = [];
  let cur = null;
  for (const p of pairs) {
    if (p[0] === 0) { cur = { type: p[1], pairs: [] }; ents.push(cur); }
    else if (cur) cur.pairs.push(p);
  }
  return ents;
}

function lastNum(pairs, code, from = 0) {
  for (let k = pairs.length - 1; k >= from; k--) if (pairs[k][0] === code) return num(pairs[k][1]);
  return 0;
}
function firstVal(pairs, code, dflt = '') {
  const f = pairs.find((p) => p[0] === code);
  return f ? f[1] : dflt;
}

/** Converte uma lista de entidades em itens { layer, kind, pts, closed }. */
function convertEntities(ents, blocks, tf, depth, out, skipped) {
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    const layer = firstVal(e.pairs, 8, '0');
    const T = (x, y) => tf(x, y);
    switch (e.type) {
      case 'LINE': {
        const x1 = num(firstVal(e.pairs, 10)), y1 = num(firstVal(e.pairs, 20));
        const x2 = num(firstVal(e.pairs, 11)), y2 = num(firstVal(e.pairs, 21));
        out.push({ layer, kind: 'line', pts: [T(x1, y1), T(x2, y2)], closed: false });
        break;
      }
      case 'LWPOLYLINE': {
        const flags = parseInt(firstVal(e.pairs, 70, '0'), 10) || 0;
        const verts = [];
        for (let k = 0; k < e.pairs.length; k++) {
          if (e.pairs[k][0] === 10) {
            const x = num(e.pairs[k][1]);
            let y = 0, bulge = 0;
            for (let m = k + 1; m < e.pairs.length && e.pairs[m][0] !== 10; m++) {
              if (e.pairs[m][0] === 20) y = num(e.pairs[m][1]);
              if (e.pairs[m][0] === 42) bulge = num(e.pairs[m][1]);
            }
            verts.push({ x, y, bulge });
          }
        }
        pushPoly(out, layer, verts, !!(flags & 1), T);
        break;
      }
      case 'POLYLINE': {
        const flags = parseInt(firstVal(e.pairs, 70, '0'), 10) || 0;
        const verts = [];
        let j = i + 1;
        while (j < ents.length && ents[j].type === 'VERTEX') {
          verts.push({ x: num(firstVal(ents[j].pairs, 10)), y: num(firstVal(ents[j].pairs, 20)), bulge: num(firstVal(ents[j].pairs, 42)) });
          j++;
        }
        if (ents[j]?.type === 'SEQEND') j++;
        i = j - 1;
        pushPoly(out, layer, verts, !!(flags & 1), T);
        break;
      }
      case 'ARC': {
        const pts = arcPoints(num(firstVal(e.pairs, 10)), num(firstVal(e.pairs, 20)), num(firstVal(e.pairs, 40)), num(firstVal(e.pairs, 50)), num(firstVal(e.pairs, 51)));
        out.push({ layer, kind: 'line', pts: pts.map(([x, y]) => T(x, y)), closed: false });
        break;
      }
      case 'CIRCLE': {
        const cx = num(firstVal(e.pairs, 10)), cy = num(firstVal(e.pairs, 20)), r = num(firstVal(e.pairs, 40));
        const pts = arcPoints(cx, cy, r, 0, 360).slice(0, -1);
        out.push({ layer, kind: 'line', pts: pts.map(([x, y]) => T(x, y)), closed: true });
        break;
      }
      case 'INSERT': {
        const name = firstVal(e.pairs, 2);
        const blk = blocks[name];
        if (!blk || depth >= 4) { skipped.INSERT = (skipped.INSERT || 0) + 1; break; }
        const ix = num(firstVal(e.pairs, 10)), iy = num(firstVal(e.pairs, 20));
        const sx = firstVal(e.pairs, 41) !== '' ? num(firstVal(e.pairs, 41)) : 1;
        const sy = firstVal(e.pairs, 42) !== '' ? num(firstVal(e.pairs, 42)) : 1;
        const rot = (num(firstVal(e.pairs, 50)) * Math.PI) / 180;
        const c = Math.cos(rot), s = Math.sin(rot);
        const inner = (x, y) => {
          const bx = (x - blk.base[0]) * sx, by = (y - blk.base[1]) * sy;
          return tf(ix + bx * c - by * s, iy + bx * s + by * c);
        };
        convertEntities(blk.ents, blocks, inner, depth + 1, out, skipped);
        break;
      }
      case 'VERTEX': case 'SEQEND': case 'ENDBLK': case 'BLOCK': break;
      default:
        skipped[e.type] = (skipped[e.type] || 0) + 1;
    }
  }
}

function pushPoly(out, layer, verts, closed, T) {
  if (verts.length < 2) return;
  const pts = [T(verts[0].x, verts[0].y)];
  const n = closed ? verts.length : verts.length - 1;
  for (let k = 0; k < n; k++) {
    const a = verts[k], b = verts[(k + 1) % verts.length];
    bulgePoints([a.x, a.y], [b.x, b.y], a.bulge).forEach(([x, y]) => pts.push(T(x, y)));
  }
  if (closed && pts.length > 1) pts.pop();               // último = primeiro
  out.push({ layer, kind: 'poly', pts, closed });
}

/**
 * Lê um DXF ASCII. Retorna { items, layers, units, insunits, bounds, skipped }.
 * `units` = metros por unidade do desenho (null se o arquivo não declara).
 */
export function parseDxf(text) {
  if (typeof text !== 'string' || !text.length) throw new DxfError('Arquivo vazio.');
  if (text.startsWith('AutoCAD Binary DXF')) {
    throw new DxfError('Este é um DXF binário. Salve como DXF ASCII (texto) no seu programa de CAD.');
  }
  const pairs = toPairs(text);
  const sections = splitSections(pairs);
  if (!sections.ENTITIES) throw new DxfError('Não encontrei a seção ENTITIES — o arquivo não parece ser um DXF válido.');

  // unidades do cabeçalho
  let insunits = 0;
  const hdr = sections.HEADER || [];
  for (let i = 0; i < hdr.length; i++) {
    if (hdr[i][0] === 9 && hdr[i][1] === '$INSUNITS' && hdr[i + 1]) insunits = parseInt(hdr[i + 1][1], 10) || 0;
  }

  // blocos
  const blocks = {};
  if (sections.BLOCKS) {
    const bents = entitiesOf(sections.BLOCKS);
    let cur = null;
    bents.forEach((e) => {
      if (e.type === 'BLOCK') {
        cur = { ents: [], base: [num(firstVal(e.pairs, 10)), num(firstVal(e.pairs, 20))] };
        blocks[firstVal(e.pairs, 2)] = cur;
      } else if (e.type === 'ENDBLK') cur = null;
      else if (cur) cur.ents.push(e);
    });
  }

  const items = [];
  const skipped = {};
  convertEntities(entitiesOf(sections.ENTITIES), blocks, (x, y) => [x, y], 0, items, skipped);
  if (!items.length) throw new DxfError('Nenhuma linha ou polilinha encontrada no arquivo.');

  const layers = {};
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  items.forEach((it) => {
    const L = (layers[it.layer] ||= { items: 0, closed: 0 });
    L.items++;
    if (it.closed) L.closed++;
    it.pts.forEach(([x, y]) => {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    });
  });
  return {
    items, layers, skipped, insunits,
    units: INSUNITS[insunits] ?? null,
    bounds: { minX, maxX, minY, maxY },
  };
}

/** Palpite de unidade quando o arquivo não declara: pela maior dimensão do desenho. */
export function guessUnitScale(bounds) {
  const extent = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  if (extent > 2000) return 0.001;   // milímetros (casa de 10 m = 10 000)
  if (extent > 150) return 0.01;     // centímetros
  return 1;                          // metros
}

/** Camadas que "parecem" paredes (nomes comuns em PT/EN). */
export function looksLikeWallLayer(name) {
  return /wall|parede|alvenaria|mur[oa]|a-wall|arq/i.test(name);
}

/**
 * Converte itens do DXF para o modelo do NexusHome.
 * opts: { layers:Set|null, scale (m por unidade), walls:boolean, rooms:boolean,
 *         recenter:boolean, minRoomArea, maxRoomArea }
 * Retorna { walls:[{x1,z1,x2,z2}], rooms:[{points:[[x,z]...]}], bounds, offset }
 * Coordenadas em metros; z = -y (a planta 2D tem z para baixo).
 */
export function dxfToPlan(parsed, opts = {}) {
  const {
    layers = null, scale = parsed.units ?? guessUnitScale(parsed.bounds),
    walls: wantWalls = true, rooms: wantRooms = true, recenter = true,
    minRoomArea = 1.5, maxRoomArea = 600,
  } = opts;

  const sel = parsed.items.filter((it) => !layers || layers.has(it.layer));
  const toM = ([x, y]) => [x * scale, -y * scale];

  // deslocamento para centralizar na origem (usa as camadas escolhidas)
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  sel.forEach((it) => it.pts.forEach((p) => {
    const [x, z] = toM(p);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }));
  if (!sel.length) return { walls: [], rooms: [], bounds: null, offset: [0, 0], stats: { items: 0 } };
  const offset = recenter ? [-(minX + maxX) / 2, -(minZ + maxZ) / 2] : [0, 0];
  const T = (p) => { const [x, z] = toM(p); return [round(x + offset[0]), round(z + offset[1])]; };

  const walls = [];
  const rooms = [];
  const seen = new Set();
  const addWall = (a, b) => {
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.05) return;           // fiapo
    const k1 = `${r2(a[0])},${r2(a[1])},${r2(b[0])},${r2(b[1])}`;
    const k2 = `${r2(b[0])},${r2(b[1])},${r2(a[0])},${r2(a[1])}`;
    if (seen.has(k1) || seen.has(k2)) return;                          // linha duplicada
    seen.add(k1);
    walls.push({ x1: a[0], z1: a[1], x2: b[0], z2: b[1] });
  };

  sel.forEach((it) => {
    const pts = it.pts.map(T);
    if (wantWalls) {
      for (let i = 0; i + 1 < pts.length; i++) addWall(pts[i], pts[i + 1]);
      if (it.closed && pts.length > 2) addWall(pts[pts.length - 1], pts[0]);
    }
    if (wantRooms && it.closed && pts.length >= 3) {
      const poly = cleanPoly(pts);
      if (poly.length >= 3) {
        const a = polyArea(poly);
        if (a >= minRoomArea && a <= maxRoomArea && isSimplePoly(poly)) rooms.push({ points: poly, area: a });
      }
    }
  });

  // contorno externo (a linha que envolve a casa toda) não é um cômodo:
  // descarta o polígono que contém ≥2 outros ou que cobre o desenho inteiro
  // quando há paredes internas desenhadas separadamente.
  const W = maxX - minX, D = maxZ - minZ;
  const bbox = (poly) => {
    const xs = poly.map((p) => p[0]), zs = poly.map((p) => p[1]);
    return [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  };
  const centroidIn = (inner, outer) => {
    const c = inner.reduce((s, p) => [s[0] + p[0] / inner.length, s[1] + p[1] / inner.length], [0, 0]);
    return pointInPoly(c[0], c[1], outer);
  };
  const envelope = new Set();
  rooms.forEach((r, i) => {
    const contained = rooms.filter((o, j) => j !== i && o.area < r.area && centroidIn(o.points, r.points)).length;
    const [x0, x1, z0, z1] = bbox(r.points);
    const covers = (x1 - x0) >= W * 0.95 && (z1 - z0) >= D * 0.95;
    if (contained >= 2 || (covers && walls.length > r.points.length + 1)) envelope.add(i);
  });
  const finalRooms = rooms.filter((_, i) => !envelope.has(i));

  if (walls.length > MAX_SEGMENTS) {
    throw new DxfError(`O desenho tem ${walls.length} segmentos (limite ${MAX_SEGMENTS}). Selecione apenas as camadas de paredes.`);
  }
  return {
    walls, rooms: finalRooms,
    bounds: { w: maxX - minX, d: maxZ - minZ },
    offset,
    stats: { items: sel.length, walls: walls.length, rooms: finalRooms.length },
  };
}

function round(v) { return Math.round(v * 1000) / 1000; }
function r2(v) { return Math.round(v * 50) / 50; }   // grade de 2 cm para detectar duplicatas
