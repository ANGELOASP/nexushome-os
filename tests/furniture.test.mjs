import test from 'node:test';
import assert from 'node:assert/strict';
import { FURNITURE, FURNITURE_BY_KIND, furnitureCorners, furnitureHit, normalizeFurniture } from '../js/furniture.js';

test('catálogo: tipos únicos e medidas positivas', () => {
  assert.equal(new Set(FURNITURE.map((f) => f.kind)).size, FURNITURE.length);
  FURNITURE.forEach((f) => assert.ok(f.w > 0 && f.d > 0 && f.h > 0 && f.label, f.kind));
});

test('furnitureCorners: rotação de 90° troca largura e profundidade', () => {
  const sofa = FURNITURE_BY_KIND.sofa;
  const c = furnitureCorners({ kind: 'sofa', x: 1, z: 2, rot: 90 });
  const xs = c.map((p) => p[0]), zs = c.map((p) => p[1]);
  assert.ok(Math.abs((Math.max(...xs) - Math.min(...xs)) - sofa.d) < 1e-9);
  assert.ok(Math.abs((Math.max(...zs) - Math.min(...zs)) - sofa.w) < 1e-9);
});

test('furnitureHit: dentro, fora e com rotação', () => {
  assert.ok(furnitureHit({ kind: 'cama_casal', x: 0, z: 0, rot: 0 }, 0.7, 0.9));
  assert.ok(!furnitureHit({ kind: 'cama_casal', x: 0, z: 0, rot: 0 }, 0.9, 0));
  assert.ok(furnitureHit({ kind: 'cama_casal', x: 0, z: 0, rot: 90 }, 0.9, 0));
});

test('normalizeFurniture: rotação negativa e textos', () => {
  const r = normalizeFurniture({ id: 'a', floor: '1', kind: 'sofa', x: '2.5', z: '-1', rot: -90 });
  assert.deepEqual([r.floor, r.x, r.z, r.rot], [1, 2.5, -1, 270]);
});
