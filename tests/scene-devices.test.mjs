import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceModelKind } from '../js/scene-devices.js';

test('deviceModelKind: tipo nativo e modelo do fabricante', () => {
  assert.equal(deviceModelKind({ type: 'ac' }), 'ac');
  assert.equal(deviceModelKind({ type: 'light' }), 'light');
  assert.equal(deviceModelKind({ type: 'sensor', vendor: 'tuya', model: 'leak' }), 'leak');
  assert.equal(deviceModelKind({ type: 'sensor', vendor: 'tuya', model: 'level' }), 'level');
  assert.equal(deviceModelKind({ type: 'sensor', vendor: 'tuya', model: 'valve_meter' }), 'valve');
  assert.equal(deviceModelKind({ type: 'tv', vendor: 'smartthings' }), 'tv');
  assert.equal(deviceModelKind({ type: 'xyz' }), 'sensor');
});
