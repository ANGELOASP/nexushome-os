// Firmware do painel de parede (firmware/nexus_painel): o modelo em C++ lê o JSON que o
// servidor gera (supabase/functions/iot-gateway/panel.ts). Compila com g++ no PC e roda.
// Pulado se não houver g++ ou a biblioteca ArduinoJson (defina ARDUINOJSON_SRC).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { buildSnapshot } from '../supabase/functions/iot-gateway/panel.ts';
import { buildPlan } from '../supabase/functions/iot-gateway/plan.ts';

// a planta real (seed da RESIDENCIA importada do DXF) — a mesma que o app mostra
const seed = readFileSync(new URL('../supabase/seeds/residencia.sql', import.meta.url), 'utf8');
const rooms = [...seed.matchAll(/\('[0-9a-f-]+', '([^']+)', (-?[\d.]+), (-?[\d.]+), ([\d.]+), ([\d.]+), '(#\w+)', \d+, (\d+), '[^']*', (?:'(\[.*?\])'::jsonb|null)\)/g)]
  .map(([, name, px, pz, sx, sz, color, floor, pts]) => ({ name, pos_x: +px, pos_z: +pz, size_x: +sx, size_z: +sz, color, floor: +floor, points: pts ? JSON.parse(pts) : null }));
const walls = [...seed.matchAll(/\('[0-9a-f-]+', (\d+), (-?[\d.]+), (-?[\d.]+), (-?[\d.]+), (-?[\d.]+), [\d.]+, \d+\)/g)]
  .map(([, floor, x1, z1, x2, z2]) => ({ floor: +floor, x1: +x1, z1: +z1, x2: +x2, z2: +z2 }));

const candidates = [process.env.ARDUINOJSON_SRC, '/var/tmp/ardu/user/libraries/ArduinoJson/src',
  join(homedir(), 'Arduino/libraries/ArduinoJson/src'), join(homedir(), 'Documents/Arduino/libraries/ArduinoJson/src')].filter(Boolean);
const ajson = candidates.find((p) => existsSync(join(p, 'ArduinoJson.h')));
const gpp = spawnSync('g++', ['--version']).status === 0;

const d = (id, type, room, status, name) => ({ id: `b3000000-0000-4000-8000-0000000000${id}`, name: name ?? `Disp ${id}`, type, room, status, is_online: true });

test('modelo C++ do painel lê o snapshot e a planta reais do servidor', { skip: !(ajson && gpp) && 'sem g++/ArduinoJson' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'painel-'));
  const snap = buildSnapshot([
    d('00', 'meter', 'Lavanderia', { in_total: false, watts: 1234.6 }, 'Quadro elétrico — consumo total'),
    d('01', 'light', 'Sala de Estar', { on: true }, 'Luz — Sala de Estar'),
    d('02', 'light', 'Cozinha', { on: false }, 'Luz — Cozinha'),
    d('11', 'valve', 'Cozinha', { open: true, flow_lph: 42 }, 'Água — Ramal 1 (Cozinha)'),
    d('12', 'valve', 'Laje', { open: false, alarm_burst: true }, 'Válvula de Água Geral'),
    d('13', 'meter', 'Banheiro 1', { in_total: true, watts: 7600, on: true }, 'Chuveiro — Banheiro 1'),
    d('14', 'ac', 'Quarto Principal', { on: true, temp: 22 }, 'Ar — Quarto Principal'),
    d('15', 'alarm', 'Sala de Estar', { armed: 'away' }, 'Alarme da casa'),
    d('16', 'solar', 'Sala Técnica', { soc: 63.4, grid_fail: true }, 'Nobreak — banco LiFePO4'),
    d('17', 'sensor', 'Área Externa', { level_pct: 81.2 }, 'Reservatórios'),
  ], [{ severity: 'critical', message: 'Água: rompimento detectado', created_at: '2026-10-15T10:00:00Z' }]);
  const json = join(dir, 'snap.json');
  writeFileSync(json, JSON.stringify(snap));
  const plan = join(dir, 'plan.json');
  writeFileSync(plan, JSON.stringify(buildPlan(rooms, walls, [{ id: 'x', room: 'Cozinha' }])));
  const bin = join(dir, 'teste');
  execFileSync('g++', ['-std=c++17', '-Wall', '-Wextra', '-Werror', `-I${ajson}`, '-o', bin,
    new URL('../firmware/nexus_painel/teste/teste_modelo.cpp', import.meta.url).pathname]);
  const out = execFileSync(bin, [json, plan]).toString();
  assert.match(out, /OK planta: 10 cômodos, 129 paredes/);
  assert.match(out, /OK modelo do painel/);
});
