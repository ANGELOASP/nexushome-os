import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDxf, dxfToPlan, detectRoomsFromWalls, guessUnitScale, looksLikeWallLayer, DxfError } from '../js/dxf.js';
import { polyArea, polyCentroid, pointInPoly, cleanPoly, isSimplePoly, setPolyAbs, polyAbs, innerRect, rectToPoints, roomArea, isPoly } from '../js/geometry.js';

const dxf = readFileSync(new URL('./fixtures/casa.dxf', import.meta.url), 'utf8');

test('geometria: área, centroide e ponto dentro', () => {
  const sq = [[0, 0], [4, 0], [4, 3], [0, 3]];
  assert.equal(polyArea(sq), 12);
  assert.deepEqual(polyCentroid(sq), [2, 1.5]);
  assert.equal(pointInPoly(1, 1, sq), true);
  assert.equal(pointInPoly(5, 1, sq), false);
  // L: o canto "vazado" está fora
  const L = [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]];
  assert.equal(polyArea(L), 12);
  assert.equal(pointInPoly(3, 3, L), false);
  assert.equal(pointInPoly(1, 3, L), true);
});

test('geometria: cleanPoly remove repetidos e colineares; isSimplePoly detecta cruzamento', () => {
  assert.equal(cleanPoly([[0, 0], [2, 0], [4, 0], [4, 3], [0, 3], [0, 0]]).length, 4);
  assert.equal(isSimplePoly([[0, 0], [4, 0], [4, 3], [0, 3]]), true);
  assert.equal(isSimplePoly([[0, 0], [4, 3], [4, 0], [0, 3]]), false); // gravata
});

test('geometria: setPolyAbs mantém caixa/pos coerentes e polyAbs devolve os mesmos pontos', () => {
  const abs = [[10, 20], [14, 20], [14, 23], [10, 23]];
  const room = setPolyAbs({}, abs);
  assert.equal(room.pos_x, 12); assert.equal(room.pos_z, 21.5);
  assert.equal(room.size_x, 4); assert.equal(room.size_z, 3);
  assert.deepEqual(polyAbs(room), abs);
  assert.equal(isPoly(room), true);
  assert.equal(roomArea(room), 12);
  assert.equal(roomArea({ size_x: 3, size_z: 2 }), 6);
  assert.deepEqual(rectToPoints({ size_x: 4, size_z: 2 }), [[-2, -1], [2, -1], [2, 1], [-2, 1]]);
});

test('geometria: innerRect cabe dentro de um L', () => {
  const L = [[0, 0], [8, 0], [8, 3], [3, 3], [3, 8], [0, 8]];
  const r = innerRect(L);
  const hx = r.sx / 2, hz = r.sz / 2;
  [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([kx, kz]) => assert.equal(pointInPoly(r.cx + kx * hx, r.cz + kz * hz, L), true));
});

test('DXF: lê camadas, unidades e entidades (LINE, LWPOLYLINE, INSERT, CIRCLE); ignora TEXT', () => {
  const p = parseDxf(dxf);
  assert.equal(p.units, 1);
  assert.deepEqual(Object.keys(p.layers).sort(), ['MOVEIS', 'PAREDES', 'PORTAS']);
  assert.equal(p.layers.PAREDES.items, 3);
  assert.equal(p.skipped.TEXT, 1);
});

test('DXF → planta: paredes sem duplicatas e cômodo a partir da polilinha fechada', () => {
  const p = parseDxf(dxf);
  const plan = dxfToPlan(p, { layers: new Set(['PAREDES']), walls: true, rooms: true, recenter: false });
  // retângulo (4 arestas) + divisória (as duas linhas iguais valem uma só)
  assert.equal(plan.walls.length, 5);
  assert.equal(plan.rooms.length, 1);
  assert.ok(Math.abs(plan.rooms[0].area - 12) < 1e-6);
  // eixo y do CAD (para cima) vira z (para baixo)
  const zs = plan.rooms[0].points.map((q) => q[1]);
  assert.ok(Math.min(...zs) <= -2.99);
});

test('DXF → planta: recentraliza na origem e aplica escala', () => {
  const p = parseDxf(dxf);
  const plan = dxfToPlan(p, { layers: new Set(['PAREDES']), recenter: true, scale: 2 });
  const xs = plan.walls.flatMap((w) => [w.x1, w.x2]);
  assert.ok(Math.abs((Math.max(...xs) + Math.min(...xs)) / 2) < 1e-6);
  assert.equal(Math.max(...xs) - Math.min(...xs), 8);   // 4 m × escala 2
});

test('DXF: bloco INSERT é expandido com rotação (porta de 0,9 m rodada 90°)', () => {
  const p = parseDxf(dxf);
  const porta = p.items.find((i) => i.layer === 'PORTAS');
  assert.ok(porta);
  const [a, b] = porta.pts;
  assert.ok(Math.abs(Math.hypot(b[0] - a[0], b[1] - a[1]) - 0.9) < 1e-9);
  assert.ok(Math.abs(b[0] - a[0]) < 1e-9);  // ficou vertical
});

test('DXF: erros claros para arquivo vazio, binário e inválido', () => {
  assert.throws(() => parseDxf(''), DxfError);
  assert.throws(() => parseDxf('AutoCAD Binary DXF\r\n\x1a\x00'), /bin[aá]rio/i);
  assert.throws(() => parseDxf('isto não é dxf'), DxfError);
});

test('DXF: heurística de unidade e de camada de paredes', () => {
  assert.equal(guessUnitScale({ minX: 0, maxX: 12000, minY: 0, maxY: 8000 }), 0.001);
  assert.equal(guessUnitScale({ minX: 0, maxX: 1200, minY: 0, maxY: 800 }), 0.01);
  assert.equal(guessUnitScale({ minX: 0, maxX: 12, minY: 0, maxY: 8 }), 1);
  assert.equal(looksLikeWallLayer('A-WALL'), true);
  assert.equal(looksLikeWallLayer('PAREDES'), true);
  assert.equal(looksLikeWallLayer('MOVEIS'), false);
});

test('dxf: contorno externo da casa não vira cômodo', () => {
  const pl = (id, pts) => `0\nLWPOLYLINE\n8\nPAREDES\n90\n${pts.length}\n70\n1\n` + pts.map(([x, y]) => `10\n${x}\n20\n${y}\n`).join('');
  const doc = '0\nSECTION\n2\nENTITIES\n' +
    pl(1, [[0, 0], [10, 0], [10, 6], [0, 6]]) +
    pl(2, [[0, 0], [5, 0], [5, 6], [0, 6]]) +
    pl(3, [[5, 0], [10, 0], [10, 6], [5, 6]]) +
    '0\nENDSEC\n0\nEOF\n';
  const plan = dxfToPlan(parseDxf(doc), { layers: new Set(['PAREDES']), scale: 1 });
  assert.equal(plan.rooms.length, 2);
  assert.ok(plan.rooms.every((r) => Math.abs(r.area - 30) < 0.01));
});

test('dxf: detecta cômodos por paredes em linhas (vão de porta e entrada larga)', () => {
  const L = (x1, z1, x2, z2) => ({ x1, z1, x2, z2 });
  // casa 10 x 6 m, parede interna em x=5 com porta de 0,9 m, entrada de 1,4 m na fachada
  const segs = [
    L(0, 0, 10, 0), L(10, 0, 10, 6), L(0, 6, 3, 6), L(4.4, 6, 10, 6), L(0, 0, 0, 6),
    L(5, 0, 5, 2.5), L(5, 3.4, 5, 6),
  ];
  const rooms = detectRoomsFromWalls(segs, {});
  assert.equal(rooms.length, 2);
  rooms.forEach((r) => assert.ok(r.area > 20 && r.area < 31, `área ${r.area}`));
});

test('dxf: sem paredes fechando nada, não inventa cômodos', () => {
  assert.deepEqual(detectRoomsFromWalls([{ x1: 0, z1: 0, x2: 5, z2: 0 }], {}), []);
});
