// Auditoria do Editor de Planta (fase 7): o salvar só apaga o que saiu do rascunho,
// a planta padrão ganha ids próprios e o leitor DXF tem limites contra arquivos patológicos.
import test from 'node:test';
import assert from 'node:assert/strict';
import { removedIds, cloneDefaultRooms } from '../js/floorplan.js';
import { DEFAULT_ROOMS } from '../js/state.js';
import { parseDxf, dxfToPlan, DxfError } from '../js/dxf.js';

test('salvar: apaga só baseline − rascunho (nunca banco − rascunho)', () => {
  const base = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const draft = [{ id: 'a' }, { id: 'c' }, { id: 'novo' }];
  assert.deepEqual(removedIds(base, draft), ['b']);
  // carga falhou: baseline vazio → nada a apagar, mesmo que o banco tenha linhas
  assert.deepEqual(removedIds([], draft), []);
  // carga marcada como falha: não apaga nada daquela tabela
  assert.deepEqual(removedIds(base, [], false), []);
  // sem mudança: nada a apagar
  assert.deepEqual(removedIds(base, base.map((r) => ({ ...r }))), []);
});

test('planta padrão: ids novos a cada clone, nunca os fixos de DEFAULT_ROOMS', () => {
  let n = 0;
  const gen = () => `id-${++n}`;
  const a = cloneDefaultRooms(gen);
  const fixed = new Set(DEFAULT_ROOMS.map((r) => r.id));
  assert.equal(a.length, DEFAULT_ROOMS.length);
  assert.ok(a.every((r) => !fixed.has(r.id)));
  assert.equal(new Set(a.map((r) => r.id)).size, a.length);
  // não muta a constante compartilhada
  assert.ok(DEFAULT_ROOMS.every((r) => fixed.has(r.id)));
  assert.deepEqual(a.map((r) => r.name), DEFAULT_ROOMS.map((r) => r.name));
});

test('restaurar padrão: cômodo atual de mesmo nome empresta o id (update, sem excluir antes)', () => {
  const current = [{ id: 'meu-cozinha', name: 'Cozinha ' }, { id: 'meu-escritorio', name: 'Escritório' }];
  let n = 0;
  const out = cloneDefaultRooms(() => `g${++n}`, current);
  assert.equal(out.find((r) => r.name === 'Cozinha').id, 'meu-cozinha');
  // o escritório sai do rascunho: só ele entra na lista de exclusão
  assert.deepEqual(removedIds(current, out), ['meu-escritorio']);
});

/** DXF mínimo: blocos aninhados (cada nível insere `per` vezes o anterior) + entidades soltas. */
function nestedDxf(per, levels, linesPerLeaf) {
  const L = [];
  const p = (c, v) => L.push(String(c), String(v));
  p(0, 'SECTION'); p(2, 'BLOCKS');
  p(0, 'BLOCK'); p(2, 'B0'); p(10, 0); p(20, 0);
  for (let i = 0; i < linesPerLeaf; i++) { p(0, 'LINE'); p(8, 'P'); p(10, i); p(20, 0); p(11, i); p(21, 1); }
  p(0, 'ENDBLK');
  for (let k = 1; k <= levels; k++) {
    p(0, 'BLOCK'); p(2, `B${k}`); p(10, 0); p(20, 0);
    for (let i = 0; i < per; i++) { p(0, 'INSERT'); p(2, `B${k - 1}`); p(10, i * 10); p(20, 0); }
    p(0, 'ENDBLK');
  }
  p(0, 'ENDSEC');
  p(0, 'SECTION'); p(2, 'ENTITIES');
  for (let i = 0; i < per; i++) { p(0, 'INSERT'); p(2, `B${levels}`); p(10, 0); p(20, i * 10); }
  p(0, 'ENDSEC'); p(0, 'EOF');
  return L.join('\n');
}

test('DXF: INSERT aninhado explosivo para no teto de entidades (DxfError, sem travar)', () => {
  const text = nestedDxf(20, 3, 10);   // 20^4 × 10 = 1,6 M linhas se não houvesse limite
  assert.ok(text.length < 10000);
  const t0 = Date.now();
  assert.throws(() => parseDxf(text), (err) => err instanceof DxfError && /entidades/.test(err.message));
  assert.ok(Date.now() - t0 < 5000);
});

test('DXF: blocos aninhados dentro do limite continuam funcionando', () => {
  const p = parseDxf(nestedDxf(2, 2, 3));   // 2^3 × 3 = 24 linhas
  assert.equal(p.items.length, 24);
});

test('DXF: muitos segmentos param antes da detecção de cômodos', () => {
  // 31 000 linhas distintas (> 30 000 segmentos), em grade, sem polilinhas fechadas
  const L = ['0', 'SECTION', '2', 'ENTITIES'];
  for (let i = 0; i < 31000; i++) {
    const x = (i % 200) * 0.3, y = Math.floor(i / 200) * 0.3;
    L.push('0', 'LINE', '8', 'P', '10', String(x), '20', String(y), '11', String(x + 0.2), '21', String(y + 0.1));
  }
  L.push('0', 'ENDSEC', '0', 'EOF');
  const p = parseDxf(L.join('\n'));
  assert.throws(() => dxfToPlan(p, { scale: 1, detectRooms: true }), (err) => err instanceof DxfError && /segmentos/.test(err.message));
});

test('DXF: LINE sem coordenadas obrigatórias é descartada e contada', () => {
  const text = [
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '8', 'P', '10', '500', '20', '500', '11', '600', '21', '500',
    '0', 'LINE', '8', 'P', '10', '500', '20', '500',            // sem 11/21
    '0', 'LINE', '8', 'P', '10', '1', '20', 'x', '11', '2', '21', '2', // 20 inválido
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\n');
  const p = parseDxf(text);
  assert.equal(p.items.length, 1);
  assert.equal(p.skipped['LINE sem coordenadas'], 2);
  assert.deepEqual(p.bounds, { minX: 500, maxX: 600, minY: 500, maxY: 500 });
});
