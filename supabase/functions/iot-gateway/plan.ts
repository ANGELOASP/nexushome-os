// Planta da casa para o painel do corredor (v2.16), testável com `npm test`.
//
// GET /iot-gateway/panel/plan?floor=0  → a MESMA planta do app (tabelas rooms + walls,
// desenhada no Editor de Planta ou importada do DXF), simplificada para o ESP32-P4 desenhar:
//   { v:1, floor, bbox:[minX,minZ,maxX,maxZ],
//     rooms:[{ n, c, p:[[x,z],...] }],      p = polígono ABSOLUTO em metros (cm de precisão)
//     walls:[[x1,z1,x2,z2], ...],
//     devs:[{ id, x, z }],                  posição de cada aparelho (pos_x/pos_z; sem posição = centro do cômodo)
//     sig }                                 assinatura da planta: o GET /panel?plan=0 devolve a mesma em `ps`,
//                                           e o painel baixa a planta de novo assim que ela muda no app
// Coordenadas: as do app (x para a direita, z para baixo no plano), em metros.

export type RoomRow = {
  name: string; pos_x: number | string | null; pos_z: number | string | null;
  size_x: number | string | null; size_z: number | string | null;
  color?: string | null; floor?: number | null; points?: unknown;
};
export type WallRow = { floor?: number | null; x1: number | string; z1: number | string; x2: number | string; z2: number | string };
export type DevRow = { id: string; room: string | null; pos_x?: number | string | null; pos_z?: number | string | null; pos_floor?: number | null };

const n = (v: unknown, d = 0) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Polígono absoluto do cômodo: `points` (relativos ao centro) ou o retângulo size_x × size_z. */
export function roomPolygon(r: RoomRow): [number, number][] {
  const cx = n(r.pos_x), cz = n(r.pos_z);
  const pts = Array.isArray(r.points) ? r.points as unknown[] : null;
  if (pts && pts.length >= 3 && pts.every((p) => Array.isArray(p) && p.length >= 2)) {
    return (pts as number[][]).map(([x, z]) => [r2(cx + n(x)), r2(cz + n(z))]);
  }
  const hx = n(r.size_x, 3) / 2, hz = n(r.size_z, 3) / 2;
  return [[r2(cx - hx), r2(cz - hz)], [r2(cx + hx), r2(cz - hz)], [r2(cx + hx), r2(cz + hz)], [r2(cx - hx), r2(cz + hz)]];
}

/** Centro (média dos vértices) — onde ficam o nome e os aparelhos sem posição. */
export function centroid(p: [number, number][]): [number, number] {
  const s = p.reduce((a, [x, z]) => [a[0] + x, a[1] + z], [0, 0]);
  return [r2(s[0] / p.length), r2(s[1] / p.length)];
}

export function buildPlan(rooms: RoomRow[], walls: WallRow[], devices: DevRow[], floor = 0) {
  const onFloor = (f: number | null | undefined) => (f ?? 0) === floor;
  const rs = rooms.filter((r) => onFloor(r.floor)).map((r) => ({ n: r.name, c: r.color || '#64748b', p: roomPolygon(r) }));
  const ws = walls.filter((w) => onFloor(w.floor)).map((w) => [r2(n(w.x1)), r2(n(w.z1)), r2(n(w.x2)), r2(n(w.z2))]);
  const xs: number[] = [], zs: number[] = [];
  rs.forEach((r) => r.p.forEach(([x, z]) => { xs.push(x); zs.push(z); }));
  ws.forEach(([a, b, c, d]) => { xs.push(a, c); zs.push(b, d); });
  const bbox = xs.length ? [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)] : [0, 0, 1, 1];

  // aparelho sem posição: espalha num pequeno círculo em volta do centro do cômodo
  const centers = new Map(rs.map((r) => [r.n, centroid(r.p)]));
  const perRoom = new Map<string, number>();
  const devs = devices.flatMap((d) => {
    if (d.pos_x != null && d.pos_z != null && onFloor(d.pos_floor)) return [{ id: d.id, x: r2(n(d.pos_x)), z: r2(n(d.pos_z)) }];
    const c = d.room ? centers.get(d.room) : undefined;
    if (!c) return [];
    const k = perRoom.get(d.room!) ?? 0;
    perRoom.set(d.room!, k + 1);
    const ang = k * 2.4, rad = k ? 0.35 + 0.12 * Math.floor(k / 6) : 0;
    return [{ id: d.id, x: r2(c[0] + rad * Math.cos(ang)), z: r2(c[1] + 0.35 + rad * Math.sin(ang)) }];
  });
  const plan = { v: 1, floor, bbox: bbox.map(r2), rooms: rs, walls: ws, devs };
  return { ...plan, sig: planSignature(plan) };
}

/** Assinatura curta (FNV-1a 32 bits, hex) — muda quando qualquer cômodo, parede ou aparelho da planta muda. */
export function planSignature(plan: { floor: number; rooms: unknown; walls: unknown; devs: unknown }): string {
  const s = JSON.stringify([plan.floor, plan.rooms, plan.walls, plan.devs]);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
