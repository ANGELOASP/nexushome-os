import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FLOOR_TYPES, FLOOR_BY_KEY, floorTypeOf, normalizeFloorType } from '../js/floors.js';

test('catálogo de pisos: chaves únicas e repetição positiva', () => {
  assert.equal(new Set(FLOOR_TYPES.map((f) => f.key)).size, FLOOR_TYPES.length);
  FLOOR_TYPES.forEach((f) => assert.ok(f.label && f.tile > 0, f.key));
});

test('floorTypeOf: escolhido > padrão do tipo > madeira', () => {
  assert.equal(floorTypeOf({ kind: 'cozinha', floor_type: 'marble' }), 'marble');
  assert.equal(floorTypeOf({ kind: 'cozinha' }), 'tile');
  assert.equal(floorTypeOf({ kind: 'area_externa' }), 'grass');
  assert.equal(floorTypeOf({ kind: 'personalizado', floor_type: 'inexistente' }), 'wood');
});

test('normalizeFloorType: desconhecido vira null (automático)', () => {
  assert.equal(normalizeFloorType('hydraulic'), 'hydraulic');
  assert.equal(normalizeFloorType('xx'), null);
  assert.equal(normalizeFloorType(undefined), null);
});

test('todo piso do catálogo tem textura no 3D', () => {
  const src = readFileSync(new URL('../js/scene3d.js', import.meta.url), 'utf8');
  const missing = FLOOR_TYPES.filter((f) => f.key !== 'concrete' && !src.includes(`case '${f.key}'`)).map((f) => f.key);
  assert.deepEqual(missing, []);
  assert.ok(FLOOR_BY_KEY.concrete);
});
