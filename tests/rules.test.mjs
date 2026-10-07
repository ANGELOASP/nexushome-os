import test from 'node:test';
import assert from 'node:assert/strict';
import { compare, crossesThreshold } from '../js/rules.js';

test('compare cobre todos os operadores', () => {
  assert.equal(compare(5, '>', 4), true);
  assert.equal(compare(4, '>', 4), false);
  assert.equal(compare(4, '>=', 4), true);
  assert.equal(compare(3, '<', 4), true);
  assert.equal(compare(4, '<=', 4), true);
  assert.equal(compare(4, '==', 4), true);
  assert.equal(compare(4, '!=', 4), false); // operador desconhecido nunca dispara
});

test('crossesThreshold: primeira leitura que satisfaz dispara', () => {
  assert.equal(crossesThreshold(undefined, 3500, '>', 3000), true);
});

test('crossesThreshold: só dispara na transição', () => {
  assert.equal(crossesThreshold(1000, 3500, '>', 3000), true);
  assert.equal(crossesThreshold(3500, 3600, '>', 3000), false); // continua alto
  assert.equal(crossesThreshold(3600, 100, '>', 3000), false);  // desceu
  assert.equal(crossesThreshold(100, 4000, '>', 3000), true);   // nova transição
});

test('crossesThreshold: leitura que não satisfaz nunca dispara', () => {
  assert.equal(crossesThreshold(undefined, 10, '>', 3000), false);
});
