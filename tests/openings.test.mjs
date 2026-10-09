import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutOpenings, wallPieces, projectOnWall } from '../js/geometry.js';

test('wallPieces: porta recorta o vão e deixa verga', () => {
  const p = wallPieces(4, 0.15, [{ kind: 'door', offset_m: 2, width: 0.9, height: 2.1, sill: 0 }], 2.5);
  const full = p.solids.filter((s) => s.y0 === 0 && s.y1 === 2.5);
  assert.equal(full.length, 2);
  assert.ok(Math.abs(full[0].b - 1.55) < 1e-9 && Math.abs(full[1].a - 2.45) < 1e-9);
  const lintel = p.solids.find((s) => s.y0 === 2.1);
  assert.ok(lintel && Math.abs(lintel.a - 1.55) < 1e-9);
  assert.equal(p.doors.length, 1);
  // pontas cobrem a quina (len + th)
  assert.ok(Math.min(...p.solids.map((s) => s.a)) < 0);
  assert.ok(Math.max(...p.solids.map((s) => s.b)) > 4);
});

test('wallPieces: janela tem peitoril, verga e vidro', () => {
  const p = wallPieces(3, 0.15, [{ kind: 'window', offset_m: 1.5, width: 1.2, height: 1.2, sill: 1 }], 2.5);
  assert.equal(p.glass.length, 1);
  assert.deepEqual([p.glass[0].y0, p.glass[0].y1], [1, 2.2]);
  assert.ok(p.solids.some((s) => s.y0 === 0 && s.y1 === 1 && Math.abs(s.a - 0.9) < 1e-9));
  assert.ok(p.solids.some((s) => Math.abs(s.y0 - 2.2) < 1e-9 && s.y1 === 2.5));
});

test('layoutOpenings: limita à parede, descarta sobrepostas e minúsculas', () => {
  const l = layoutOpenings(2, [
    { kind: 'door', offset_m: 0.1, width: 0.9 },       // estoura o início → encolhe para 0,05…0,55
    { kind: 'window', offset_m: 0.4, width: 1 },       // sobrepõe a primeira → encolhe para começar em 0,55
    { kind: 'door', offset_m: 1.99, width: 0.9 },      // estoura o fim → < MIN após limite? 1,54…1,95 = 0,41
  ]);
  assert.ok(l.every((o) => o.a >= 0.05 && o.b <= 1.95));
  for (let i = 1; i < l.length; i++) assert.ok(l[i].a >= l[i - 1].b);
});

test('projectOnWall: projeção e distância', () => {
  const r = projectOnWall({ x1: 0, z1: 0, x2: 4, z2: 0 }, 1, 0.3);
  assert.ok(Math.abs(r.t - 1) < 1e-9 && Math.abs(r.d - 0.3) < 1e-9 && r.len === 4);
});
