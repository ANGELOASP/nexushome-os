// Gera os JSON de exemplo do simulador com a planta REAL (seed residencia.sql) e o seed unificado.
// uso: node gerar-dados.mjs normal|alarme <pasta-de-saida>
//      node gerar-dados.mjs producao <pasta-de-saida>   → a planta e os aparelhos ATUAIS do NexusHome
//        (lê o iot-gateway de produção; precisa de NEXUS_DEVICE_KEY no ambiente — nunca grave a chave em arquivo)
import { readFileSync, writeFileSync } from 'node:fs';
import { buildSnapshot } from '../../../supabase/functions/iot-gateway/panel.ts';
import { buildPlan } from '../../../supabase/functions/iot-gateway/plan.ts';

if (process.argv[2] === 'producao') {
  const base = process.env.NEXUS_GATEWAY || 'https://gfjxcsvxhaojbtuixpjh.supabase.co/functions/v1/iot-gateway';
  const key = process.env.NEXUS_DEVICE_KEY;
  if (!key) { console.error('defina NEXUS_DEVICE_KEY (o IOT_DEVICE_SECRET) no ambiente'); process.exit(2); }
  const get = async (path) => {
    const r = await fetch(base + path, { headers: { 'x-device-key': key } });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${await r.text()}`);
    return r.text();
  };
  const [snap, plan] = await Promise.all([get('/panel?limit=80&plan=0'), get('/panel/plan?floor=0')]);
  writeFileSync(process.argv[3] + '/snap-producao.json', snap);
  writeFileSync(process.argv[3] + '/plan-producao.json', plan);
  const p = JSON.parse(plan);
  console.log(`planta de produção: ${p.rooms.length} cômodos, ${p.walls.length} paredes, assinatura ${p.sig ?? '-'}`);
  process.exit(0);
}
const R = new URL('../../../supabase/seeds/', import.meta.url).pathname;
const res = readFileSync(R + 'residencia.sql', 'utf8');
const rooms = [...res.matchAll(/\('[0-9a-f-]+', '([^']+)', (-?[\d.]+), (-?[\d.]+), ([\d.]+), ([\d.]+), '(#\w+)', \d+, (\d+), '[^']*', (?:'(\[.*?\])'::jsonb|null)\)/g)]
  .map(([, name, px, pz, sx, sz, color, floor, pts]) => ({ name, pos_x: +px, pos_z: +pz, size_x: +sx, size_z: +sz, color, floor: +floor, points: pts ? JSON.parse(pts) : null }));
const walls = [...res.matchAll(/\('[0-9a-f-]+', (\d+), (-?[\d.]+), (-?[\d.]+), (-?[\d.]+), (-?[\d.]+), [\d.]+, \d+\)/g)]
  .map(([, floor, x1, z1, x2, z2]) => ({ floor: +floor, x1: +x1, z1: +z1, x2: +x2, z2: +z2 }));
const uni = readFileSync(R + 'unificado.sql', 'utf8');
const devs = [...uni.matchAll(/\('(b[34]000000-[0-9a-f-]+)', '([^']+)', '(\w+)', '\w+', '([^']+)', '(\{[^']*\})'/g)]
  .map(([, id, name, type, room, st]) => ({ id, name, type, room, status: JSON.parse(st), is_online: true }));
const set = (end, st) => { const d = devs.find((x) => x.id.endsWith(end)); Object.assign(d.status, st); };
set('000000000001', { on: true }); set('000000000003', { on: true }); set('000000000010', { on: true });
set('000000000021', { temp: 24.6, hum: 58, presence: true }); set('000000000024', { temp: 22.1, hum: 61 });
set('000000000031', { gas_lel: 3 }); set('000000000050', { armed: 'home' });
set('000000000001', {}); set('b4000000-0000-4000-8000-000000000001'.slice(-12), { soc: 86, grid_fail: false });
devs.push({ id: 'b2000000-0000-4000-8000-000000000000', name: 'Quadro elétrico — consumo total', type: 'meter', room: 'Lavanderia', status: { in_total: false, watts: 3480 }, is_online: true });
devs.push({ id: 'b2000000-0000-4000-8000-000000000001', name: 'Chuveiro — Banheiro 1', type: 'meter', room: 'Banheiro 1', status: { in_total: true, watts: 0, on: true }, is_online: true });
devs.push({ id: 'b1000000-0000-4000-8000-000000000001', name: 'Água — Ramal 1 (Cozinha)', type: 'valve', room: 'Cozinha', status: { open: true, flow_lph: 96 }, is_online: true });
devs.push({ id: 'b1000000-0000-4000-8000-000000000008', name: 'Reservatórios (2 × 500 L)', type: 'sensor', room: 'Área Externa', status: { level_pct: 74 }, is_online: true });
const mode = process.argv[2] || 'normal';
if (mode === 'alarme') set('000000000022', { smoke: true });
const alerts = mode === 'alarme' ? [{ severity: 'critical', message: 'Fumaça detectada na Sala de TV — sirenes acionadas', created_at: '2026-10-15T14:00:00Z' }] : [];
writeFileSync(process.argv[3] + `/snap-${mode}.json`, JSON.stringify(buildSnapshot(devs, alerts)));
writeFileSync(process.argv[3] + '/plan.json', JSON.stringify(buildPlan(rooms, walls, devs)));
console.log(devs.length, 'aparelhos');
