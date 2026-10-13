import test from 'node:test';
import assert from 'node:assert/strict';
import { isPlaced, pinFloor, roomAtPoint, deviceActive, pinStyle } from '../js/device-pins.js';

const rooms = [
  { name: 'Sala', floor: 0, pos_x: 0, pos_z: 0, size_x: 4, size_z: 4 },
  { name: 'Nicho', floor: 0, pos_x: 1, pos_z: 1, size_x: 1, size_z: 1 },
  { name: 'Suíte', floor: 1, pos_x: 0, pos_z: 0, size_x: 4, size_z: 4 },
  { name: 'L', floor: 0, pos_x: 10, pos_z: 0, size_x: 4, size_z: 4, points: [[-2, -2], [2, -2], [2, 0], [0, 0], [0, 2], [-2, 2]] },
];

test('isPlaced: exige pos_x e pos_z numéricos', () => {
  assert.ok(isPlaced({ pos_x: 0, pos_z: 0 }));
  assert.ok(!isPlaced({ pos_x: null, pos_z: 1 }));
  assert.ok(!isPlaced({}));
  assert.ok(!isPlaced(null));
});

test('pinFloor: usa pos_floor, senão o andar do cômodo', () => {
  assert.equal(pinFloor({ pos_floor: 2 }, rooms), 2);
  assert.equal(pinFloor({ room: 'Suíte' }, rooms), 1);
  assert.equal(pinFloor({ room: 'Inexistente' }, rooms), 0);
});

test('roomAtPoint: andar certo, menor cômodo e polígono', () => {
  assert.equal(roomAtPoint(rooms, 0, -1, -1).name, 'Sala');
  assert.equal(roomAtPoint(rooms, 0, 1.2, 1.2).name, 'Nicho');
  assert.equal(roomAtPoint(rooms, 1, 1.2, 1.2).name, 'Suíte');
  assert.equal(roomAtPoint(rooms, 0, 9, -1).name, 'L');
  assert.equal(roomAtPoint(rooms, 0, 11, 1), null);   // recorte do L
});

test('deviceActive e pinStyle', () => {
  assert.ok(deviceActive({ type: 'valve', status: {} }));
  assert.ok(!deviceActive({ type: 'valve', status: { open: false } }));
  assert.ok(deviceActive({ type: 'light', status: { on: true } }));
  assert.equal(pinStyle('nada').letter, '•');
});
