import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanPatch, captureActions, sceneMatches, scenesForRoom, normalizeScene } from '../js/scenes.js';
import { bucketSeries, summarize, sparkPath, metricsIn } from '../js/history.js';

const devices = [
  { id: 'l', type: 'light', room: 'Sala', status: { on: true, brightness: 40, color: '#fff' } },
  { id: 'a', type: 'ac', room: 'Quarto', status: { on: false, temp: 23 } },
  { id: 'v', type: 'valve', room: 'Fora', status: {} },
  { id: 'm', type: 'meter', room: 'Cozinha', status: { watts: 300 } },
];

test('cleanPatch: só chaves do tipo e limites', () => {
  assert.deepEqual(cleanPatch('light', { on: 1, brightness: 500, temp: 20 }), { on: true, brightness: 100 });
  assert.deepEqual(cleanPatch('ac', { temp: 5 }), { temp: 16 });
  assert.deepEqual(cleanPatch('meter', { on: true }), {});
});

test('captureActions: estado atual, ignora tipos sem cena', () => {
  const acts = captureActions(devices, ['l', 'v', 'm']);
  assert.equal(acts.length, 2);
  assert.deepEqual(acts.find((a) => a.device_id === 'v').patch, { open: true });
});

test('sceneMatches e scenesForRoom', () => {
  const s1 = normalizeScene({ name: 'X', room: null, actions: [{ device_id: 'l', patch: { on: true, brightness: 40 } }] });
  const s2 = normalizeScene({ name: 'Y', room: 'Quarto', actions: [{ device_id: 'a', patch: { on: false, temp: 18 } }] });
  assert.ok(sceneMatches(s1, devices));
  assert.ok(sceneMatches(s2, devices));       // desligado: temperatura não importa
  assert.deepEqual(scenesForRoom([s1, s2], 'Sala', devices).map((s) => s.name), ['X']);
  assert.deepEqual(scenesForRoom([s1, s2], 'Quarto', devices).map((s) => s.name), ['Y']);
});

test('bucketSeries / summarize / sparkPath', () => {
  const from = 0, to = 1000;
  const rows = [
    { metric_type: 'temperature', value: 20, created_at: new Date(10).toISOString() },
    { metric_type: 'temperature', value: 22, created_at: new Date(20).toISOString() },
    { metric_type: 'temperature', value: 30, created_at: new Date(990).toISOString() },
    { metric_type: 'humidity', value: 50, created_at: new Date(500).toISOString() },
  ];
  const s = bucketSeries(rows, 'temperature', from, to, 10);
  assert.equal(s[0], 21);
  assert.equal(s[9], 30);
  assert.equal(s[5], null);
  assert.deepEqual(summarize(s), { min: 21, max: 30, avg: 25.5, last: 30, n: 2 });
  assert.ok(sparkPath(s, 100, 20).startsWith('M'));
  assert.equal(sparkPath([null, null], 100, 20), '');
  assert.deepEqual(metricsIn(rows), ['temperature', 'humidity']);
});
