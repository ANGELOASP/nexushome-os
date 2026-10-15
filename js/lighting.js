// ============================================================
// NexusHome OS — Iluminação: circuitos, luminárias e pontos de comando (v2.17)
// ------------------------------------------------------------
// Lógica pura (testável com `npm test`). Um dispositivo do tipo "light" é um
// CIRCUITO de iluminação: várias luminárias que acendem juntas e os pontos de
// onde ele é acionado. Fica em devices.lighting (migração 026):
//   {
//     fixtures: [{ model, x, z, y, rot, floor }],   luminárias (model da biblioteca, grupo Iluminação)
//     switches: [{ kind, x, z, y, rot, floor }],    pontos de comando na parede
//     control:  { mode }                            como o circuito é acionado
//   }
// A 1ª luminária é também a posição do dispositivo (pos_x/pos_z/model), para o
// marcador do app, o painel P4 e quem ainda não conhece o campo lighting.
// ============================================================

import { DEVICE_CATALOG } from './device-catalog.js';

/** Luminárias: as entradas "light" da biblioteca (plafon, pendente, spot, fita LED...). */
export const FIXTURE_TYPES = DEVICE_CATALOG.filter((c) => c.type === 'light');
const FIXTURE_MODELS = new Set(FIXTURE_TYPES.map((c) => c.model));

/** Pontos de comando, com o símbolo usado em planta elétrica (NBR 5444). */
export const SWITCH_KINDS = [
  { kind: 'simples', label: 'Interruptor simples', sym: 'S', hint: 'um único ponto de comando' },
  { kind: 'paralelo', label: 'Paralelo (three-way)', sym: 'S3w', hint: 'comanda de dois pontos; vai em par' },
  { kind: 'intermediario', label: 'Intermediário (four-way)', sym: 'S4w', hint: 'entre dois paralelos, para 3 ou mais pontos' },
  { kind: 'pulsador', label: 'Pulsador', sym: 'P', hint: 'minuteria ou relé de impulso' },
  { kind: 'dimmer', label: 'Dimmer', sym: 'Sd', hint: 'liga e regula o brilho' },
  { kind: 'presenca', label: 'Sensor de presença', sym: 'SP', hint: 'acende ao detectar movimento' },
];
export const SWITCH_BY_KIND = Object.fromEntries(SWITCH_KINDS.map((s) => [s.kind, s]));

/** Como o circuito é acionado. */
export const CONTROL_MODES = [
  { mode: 'parede', label: 'Só interruptor de parede', desc: 'Liga e desliga só pelos interruptores. O app mostra o circuito, mas não comanda.' },
  { mode: 'quadro', label: 'Quadro de automação (three-way com relé)', desc: 'Parede, app, telas e automações. O relé faz o papel de um dos paralelos e o retorno mostra o estado real.' },
  { mode: 'inteligente', label: 'Interruptor ou lâmpada inteligente', desc: 'Wi-Fi ou Zigbee (Tuya, SmartThings) ou ESP32: o app comanda pela integração.' },
];
export const CONTROL_BY_MODE = Object.fromEntries(CONTROL_MODES.map((c) => [c.mode, c]));

/** Os 10 pontos de luz do Quadro de Automação (docs/projeto-unificado.md §9 e seed unificado.sql). */
export const QUADRO_POINTS = Array.from({ length: 10 }, (_, i) => {
  const n = i + 1;
  return {
    id: `b3000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    ponto: `L${String(n).padStart(2, '0')}`,
    rele: n <= 8 ? 90 : 91,
    canal: n <= 8 ? n : n - 8,
    kr: `KR${n}`,
  };
});
const QUADRO_BY_ID = new Map(QUADRO_POINTS.map((p) => [p.id, p]));

/** Ponto do quadro (L01–L10) deste dispositivo, ou null. */
export function quadroPoint(id) { return QUADRO_BY_ID.get(String(id || '').toLowerCase()) || null; }

const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
const fin = (v) => Number.isFinite(num(v));
const r3 = (v) => Math.round(v * 1000) / 1000;

/** Modo de acionamento: o gravado; senão o quadro para L01–L10 com hw; senão inteligente. */
export function controlModeFor(d) {
  const m = d?.lighting?.control?.mode;
  if (CONTROL_BY_MODE[m]) return m;
  if (quadroPoint(d?.id) && d?.hw) return 'quadro';
  return 'inteligente';
}

function cleanPoint(p, kinds) {
  if (!p || typeof p !== 'object' || !fin(p.x) || !fin(p.z)) return null;
  const out = { x: r3(num(p.x)), z: r3(num(p.z)), floor: Number.isInteger(num(p.floor)) ? num(p.floor) : 0 };
  out.y = fin(p.y) ? Math.round(num(p.y) * 100) / 100 : null;
  out.rot = fin(p.rot) ? ((Math.round(num(p.rot)) % 360) + 360) % 360 : null;
  if (kinds === 'fixture') {
    if (!FIXTURE_MODELS.has(p.model)) return null;
    out.model = p.model;
  } else {
    if (!SWITCH_BY_KIND[p.kind]) return null;
    out.kind = p.kind;
  }
  return out;
}

/** Lighting válido (descarta pontos sem coordenada e tipos desconhecidos). */
export function normalizeLighting(raw, d = {}) {
  const l = raw && typeof raw === 'object' ? raw : {};
  const fixtures = (Array.isArray(l.fixtures) ? l.fixtures : []).map((p) => cleanPoint(p, 'fixture')).filter(Boolean);
  const switches = (Array.isArray(l.switches) ? l.switches : []).map((p) => cleanPoint(p, 'switch')).filter(Boolean);
  const mode = CONTROL_BY_MODE[l.control?.mode] ? l.control.mode : controlModeFor({ ...d, lighting: null });
  return { fixtures, switches, control: { mode } };
}

/**
 * Luminárias do circuito. Sem o campo lighting, o próprio dispositivo posicionado é a
 * única luminária (assim os circuitos antigos aparecem e podem ganhar mais pontos).
 */
export function circuitFixtures(d) {
  const l = d?.lighting;
  if (l && Array.isArray(l.fixtures)) return normalizeLighting(l, d).fixtures;
  if (!fin(d?.pos_x) || !fin(d?.pos_z)) return [];
  const model = FIXTURE_MODELS.has(d.model) ? d.model : 'plafon';
  return [cleanPoint({ model, x: d.pos_x, z: d.pos_z, y: d.pos_y, rot: d.pos_rot, floor: d.pos_floor ?? 0 }, 'fixture')].filter(Boolean);
}
export function circuitSwitches(d) { return d?.lighting ? normalizeLighting(d.lighting, d).switches : []; }

/** Garante o campo lighting (a partir da posição atual) antes de editar. */
export function ensureLighting(d) {
  if (!d.lighting || !Array.isArray(d.lighting.fixtures)) {
    d.lighting = { fixtures: circuitFixtures(d), switches: circuitSwitches(d), control: { mode: controlModeFor(d) } };
  } else {
    d.lighting = normalizeLighting(d.lighting, d);
  }
  return d.lighting;
}

/** A 1ª luminária vira a posição do dispositivo; sem luminárias, ele sai da planta. */
export function syncPrimary(d) {
  const f = d.lighting?.fixtures?.[0];
  if (f) {
    d.pos_x = f.x; d.pos_z = f.z; d.pos_floor = f.floor; d.pos_y = f.y; d.pos_rot = f.rot; d.model = f.model;
  } else {
    d.pos_x = null; d.pos_z = null; d.pos_floor = null;
  }
  return d;
}

const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

/** Avisos de ligação (o que impediria o circuito de funcionar como desenhado). */
export function lightingWarnings(d) {
  const fx = circuitFixtures(d);
  const sw = circuitSwitches(d);
  const mode = controlModeFor(d);
  const count = (k) => sw.filter((s) => s.kind === k).length;
  const out = [];
  if (!fx.length) out.push('Nenhuma luminária: clique na planta para colocar a primeira.');
  if (mode === 'quadro') {
    if (!quadroPoint(d.id)) out.push('Só os pontos L01–L10 do Quadro de Automação têm relé e retorno: escolha outro modo ou edite um desses circuitos.');
    if (count('simples')) out.push('No three-way com relé o interruptor da parede é paralelo (three-way), não simples.');
    if (count('paralelo') > 1) out.push('Com o relé, use 1 paralelo na parede (o relé faz o outro) e intermediários para os demais pontos.');
    if (count('intermediario') && !count('paralelo')) out.push('O intermediário precisa de um paralelo na parede.');
  } else if (mode === 'parede') {
    if (!sw.length) out.push('Sem ponto de comando: este circuito não tem como acender.');
    if (count('paralelo') === 1) out.push('Paralelo vai em par: coloque o segundo paralelo (ou troque por simples).');
    if (count('paralelo') > 2) out.push('Mais de 2 paralelos: use 2 paralelos nas pontas e intermediários entre eles.');
    if (count('intermediario') && count('paralelo') < 2) out.push('Intermediário só funciona entre dois paralelos.');
  }
  return out;
}

/** Linha de resumo: "4 luminárias (spot) · 2 pontos de comando · Quadro L03 (relé 90/3)". */
export function lightingSummary(d) {
  const fx = circuitFixtures(d);
  const sw = circuitSwitches(d);
  const models = [...new Set(fx.map((f) => FIXTURE_TYPES.find((c) => c.model === f.model)?.label.split(' /')[0].toLowerCase()))].filter(Boolean);
  const parts = [`${plural(fx.length, 'luminária', 'luminárias')}${models.length ? ` (${models.join(', ')})` : ''}`];
  parts.push(plural(sw.length, 'ponto de comando', 'pontos de comando'));
  const mode = controlModeFor(d);
  const q = quadroPoint(d.id);
  parts.push(mode === 'quadro' && q ? `Quadro ${q.ponto} (relé ${q.rele}/${q.canal})` : mode === 'parede' ? 'só parede' : 'inteligente');
  return parts.join(' · ');
}

/** Letra de comando do circuito no cômodo (a, b, c...), como na planta elétrica. */
export function commandLetter(devices, d) {
  const same = (devices || []).filter((x) => x.type === 'light' && (x.room || '') === (d.room || ''))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'pt-BR') || String(a.id).localeCompare(String(b.id)));
  const i = same.findIndex((x) => x.id === d.id);
  return i < 0 ? 'a' : String.fromCharCode(97 + (i % 26));
}

/**
 * Traçado da fiação para desenhar na planta (só no andar pedido): as luminárias em cadeia
 * (vizinho mais próximo) e cada ponto de comando até a luminária mais próxima.
 * Devolve [{ x1, z1, x2, z2, kind: 'luz' | 'comando' }].
 */
export function wiringSegments(d, floor = 0) {
  const fx = circuitFixtures(d).filter((f) => f.floor === floor);
  const sw = circuitSwitches(d).filter((s) => s.floor === floor);
  const seg = [];
  if (fx.length) {
    const rest = fx.slice(1);
    let cur = fx[0];
    while (rest.length) {
      let k = 0;
      rest.forEach((p, i) => { if (Math.hypot(p.x - cur.x, p.z - cur.z) < Math.hypot(rest[k].x - cur.x, rest[k].z - cur.z)) k = i; });
      const nx = rest.splice(k, 1)[0];
      seg.push({ x1: cur.x, z1: cur.z, x2: nx.x, z2: nx.z, kind: 'luz' });
      cur = nx;
    }
    sw.forEach((s) => {
      let best = fx[0];
      fx.forEach((f) => { if (Math.hypot(f.x - s.x, f.z - s.z) < Math.hypot(best.x - s.x, best.z - s.z)) best = f; });
      seg.push({ x1: s.x, z1: s.z, x2: best.x, z2: best.z, kind: 'comando' });
    });
  }
  return seg;
}

/** Ponto (luminária ou comando) mais próximo de (x, z) num raio, no andar: { kind, index } ou null. */
export function lightingPointAt(d, x, z, floor = 0, radius = 0.3) {
  let best = null;
  const test = (list, kind) => list.forEach((p, index) => {
    if (p.floor !== floor) return;
    const dist = Math.hypot(p.x - x, p.z - z);
    if (dist <= radius && (!best || dist < best.dist)) best = { kind, index, dist };
  });
  test(circuitFixtures(d), 'fixture');
  test(circuitSwitches(d), 'switch');
  return best && { kind: best.kind, index: best.index };
}
