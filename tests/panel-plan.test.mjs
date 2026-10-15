import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPlan, roomPolygon, centroid, planSignature } from '../supabase/functions/iot-gateway/plan.ts';

// a planta real da casa (seed importado do DXF da RESIDENCIA) — a mesma que o app mostra
const seed = readFileSync(new URL('../supabase/seeds/residencia.sql', import.meta.url), 'utf8');
const rooms = [...seed.matchAll(/\('[0-9a-f-]+', '([^']+)', (-?[\d.]+), (-?[\d.]+), ([\d.]+), ([\d.]+), '(#\w+)', \d+, (\d+), '[^']*', (?:'(\[.*?\])'::jsonb|null)\)/g)]
  .map(([, name, px, pz, sx, sz, color, floor, pts]) => ({ name, pos_x: +px, pos_z: +pz, size_x: +sx, size_z: +sz, color, floor: +floor, points: pts ? JSON.parse(pts) : null }));
const walls = [...seed.matchAll(/\('[0-9a-f-]+', (\d+), (-?[\d.]+), (-?[\d.]+), (-?[\d.]+), (-?[\d.]+), [\d.]+, \d+\)/g)]
  .map(([, floor, x1, z1, x2, z2]) => ({ floor: +floor, x1: +x1, z1: +z1, x2: +x2, z2: +z2 }));

test('planta real: 10 cômodos, 129 paredes, caixa da casa e tamanho para o ESP32', () => {
  assert.equal(rooms.length, 10);
  assert.equal(walls.length, 129);
  const devs = [
    { id: 'a', room: 'Cozinha' }, { id: 'b', room: 'Cozinha' }, { id: 'c', room: 'Sala de Estar', pos_x: 1, pos_z: 2, pos_floor: 0 },
    { id: 'd', room: 'Cômodo que não existe' },
  ];
  const p = buildPlan(rooms, walls, devs);
  assert.equal(p.v, 1);
  assert.equal(p.rooms.length, 10);
  assert.equal(p.walls.length, 129);
  assert.ok(p.bbox[0] < -4 && p.bbox[2] > 8.6 && p.bbox[1] < -8 && p.bbox[3] > 8.3);
  const coz = p.rooms.find((r) => r.n === 'Cozinha');
  assert.deepEqual(coz.p[0], [0.62, -5.82]);          // 2.3 + (-1.675), -2.825 + (-3), em cm
  assert.equal(coz.c, '#fbbf24');
  // aparelhos: com posição vai direto; sem posição vai para perto do centro do cômodo; cômodo inexistente fica de fora
  assert.deepEqual(p.devs.find((x) => x.id === 'c'), { id: 'c', x: 1, z: 2 });
  const [a, b] = ['a', 'b'].map((id) => p.devs.find((x) => x.id === id));
  assert.notDeepEqual([a.x, a.z], [b.x, b.z]);
  assert.ok(!p.devs.some((x) => x.id === 'd'));
  assert.ok(JSON.stringify(p).length < 12000, `planta grande demais: ${JSON.stringify(p).length}`);
});

test('cômodo sem polígono vira retângulo; andar filtra', () => {
  assert.deepEqual(roomPolygon({ name: 'x', pos_x: 1, pos_z: 1, size_x: 2, size_z: 4 }), [[0, -1], [2, -1], [2, 3], [0, 3]]);
  assert.deepEqual(centroid([[0, 0], [2, 0], [2, 2], [0, 2]]), [1, 1]);
  const p = buildPlan([{ name: 'Sótão', pos_x: 0, pos_z: 0, size_x: 2, size_z: 2, floor: 1 }], [], [], 0);
  assert.equal(p.rooms.length, 0);
  assert.deepEqual(p.bbox, [0, 0, 1, 1]);
  assert.equal(buildPlan([{ name: 'Sótão', pos_x: 0, pos_z: 0, size_x: 2, size_z: 2, floor: 1 }], [], [], 1).rooms.length, 1);
});

test('assinatura da planta: igual para a mesma planta, muda quando o app edita cômodo, parede ou aparelho', () => {
  const devs = [{ id: 'a', room: 'Cozinha' }];
  const p = buildPlan(rooms, walls, devs);
  assert.match(p.sig, /^[0-9a-f]{8}$/);
  assert.equal(buildPlan(rooms, walls, devs).sig, p.sig);
  assert.equal(planSignature(p), p.sig);
  const moved = rooms.map((r) => (r.name === 'Cozinha' ? { ...r, pos_x: r.pos_x + 0.1 } : r));
  assert.notEqual(buildPlan(moved, walls, devs).sig, p.sig);
  const renamed = rooms.map((r) => (r.name === 'Cozinha' ? { ...r, name: 'Cozinha Gourmet' } : r));
  assert.notEqual(buildPlan(renamed, walls, devs).sig, p.sig);
  assert.notEqual(buildPlan(rooms, walls.slice(1), devs).sig, p.sig);
  assert.notEqual(buildPlan(rooms, walls, [{ id: 'a', room: 'Cozinha', pos_x: 1, pos_z: 1, pos_floor: 0 }]).sig, p.sig);
  // outro andar não mexe na assinatura do térreo
  assert.equal(buildPlan([...rooms, { name: 'Sótão', pos_x: 0, pos_z: 0, size_x: 2, size_z: 2, floor: 1 }], walls, devs).sig, p.sig);
});
