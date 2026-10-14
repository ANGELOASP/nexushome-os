import test from 'node:test';
import assert from 'node:assert/strict';
import { FURNITURE_BY_KIND, furnitureDims, furnitureCorners, furnitureHit, normalizeFurniture } from '../js/furniture.js';
import { mountDevice } from '../js/device-mount.js';
import { CATALOG_BY_MODEL } from '../js/device-catalog.js';

test('sem medidas personalizadas: usa as do catálogo', () => {
  const def = FURNITURE_BY_KIND.sofa;
  const dm = furnitureDims({ kind: 'sofa' });
  assert.deepEqual([dm.w, dm.d, dm.h, dm.sx, dm.custom], [def.w, def.d, def.h, 1, false]);
});

test('medidas personalizadas mudam pegada, clique e escala 3D', () => {
  const f = { kind: 'sofa', x: 0, z: 0, rot: 0, w: 3, d: 1.2 };
  const dm = furnitureDims(f);
  assert.equal(dm.w, 3); assert.equal(dm.d, 1.2); assert.equal(dm.custom, true);
  assert.equal(dm.sx, 3 / FURNITURE_BY_KIND.sofa.w);
  const xs = furnitureCorners(f).map(([x]) => x);
  assert.equal(Math.max(...xs), 1.5);
  assert.ok(furnitureHit(f, 1.4, 0));
  assert.ok(!furnitureHit({ ...f, w: null }, 1.4, 0));
});

test('medidas inválidas caem no catálogo; limites 0,1–8 m', () => {
  assert.equal(furnitureDims({ kind: 'sofa', w: -1 }).w, FURNITURE_BY_KIND.sofa.w);
  assert.equal(furnitureDims({ kind: 'sofa', w: 'abc' }).w, FURNITURE_BY_KIND.sofa.w);
  assert.equal(furnitureDims({ kind: 'sofa', w: 50 }).w, 8);
  const n = normalizeFurniture({ id: 'a', kind: 'sofa', x: '1', z: '2', rot: 0, w: '2.5', d: null });
  assert.equal(n.w, 2.5); assert.equal(n.d, null); assert.equal(n.h, null);
});

test('TV sobre rack com altura personalizada apoia no topo novo', () => {
  const ctx = { walls: [], openings: [], furniture: [{ id: 'r', kind: 'rack_tv', x: 0, z: 0, rot: 0, h: 0.7 }] };
  const m = mountDevice(CATALOG_BY_MODEL.smart_tv, 0, 0, ctx);
  assert.equal(m.y, 0.7);
});
