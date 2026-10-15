// ============================================================
// NexusHome OS — Leituras dos sensores e do nobreak (v2.16)
// ------------------------------------------------------------
// Lógica pura (testável com `npm test`): o que o cartão de um sensor mostra a
// partir do status que a tela do quadro publica (docs/projeto-unificado.md §15).
//   sensores por cômodo: temp, hum, presence, smoke, heat, door (true = aberta)
//   gás: gas_lel, gas_al1, gas_al2      reservatório: level_pct, volume_l
//   nobreak: soc, batt_v, batt_a, grid_v, grid_fail, on_battery, autonomy_h, out_w
// ============================================================

const fmt = (v, d = 0) => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Leituras de um sensor: [{ key, label, value, alarm }] na ordem de exibição. */
export function sensorReadings(s = {}) {
  const out = [];
  if (isNum(s.gas_lel) || s.gas_al1 !== undefined || s.gas_al2 !== undefined) {
    const al2 = s.gas_al2 === true || s.gas === true;
    out.push({ key: 'gas', label: 'Gás', value: isNum(s.gas_lel) ? `${fmt(s.gas_lel)}% LEL` : '—', alarm: al2 || s.gas_al1 === true });
  }
  if (isNum(s.level_pct)) out.push({ key: 'level', label: 'Nível', value: `${fmt(s.level_pct)}%`, alarm: s.level_pct < 20 });
  if (isNum(s.volume_l)) out.push({ key: 'volume', label: 'Volume', value: `${fmt(s.volume_l)} L`, alarm: false });
  if ('temp' in s || 'temperature' in s) {
    const t = isNum(s.temp) ? s.temp : s.temperature;
    out.push({ key: 'temp', label: 'Temperatura', value: isNum(t) ? `${fmt(t, 1)}°C` : '—', alarm: false });
  }
  if ('hum' in s || 'humidity' in s) {
    const h = isNum(s.hum) ? s.hum : s.humidity;
    out.push({ key: 'hum', label: 'Umidade', value: isNum(h) ? `${fmt(h)}%` : '—', alarm: false });
  }
  if (typeof s.presence === 'boolean') out.push({ key: 'presence', label: 'Presença', value: s.presence ? 'alguém' : 'vazio', alarm: false });
  if (typeof s.smoke === 'boolean') out.push({ key: 'smoke', label: 'Fumaça', value: s.smoke ? 'ALARME' : 'normal', alarm: s.smoke });
  if (typeof s.heat === 'boolean') out.push({ key: 'heat', label: 'Calor', value: s.heat ? 'ALARME' : 'normal', alarm: s.heat });
  // door: true = porta ABERTA (firmware esp32s3_seguranca: contato NF aberto)
  if (typeof s.door === 'boolean') out.push({ key: 'door', label: 'Porta', value: s.door ? 'aberta' : 'fechada', alarm: false });
  if (s.leak === true) out.push({ key: 'leak', label: 'Vazamento', value: 'ALARME', alarm: true });
  return out;
}

/** Nobreak / banco de baterias (status do firmware esp32s3_nobreak) — null se não houver dados. */
export function batteryView(s = {}) {
  if (!isNum(s.soc) && !isNum(s.batt_v)) return null;
  const soc = isNum(s.soc) ? Math.max(0, Math.min(100, Math.round(s.soc))) : null;
  const level = soc === null ? 'ok' : soc <= 10 ? 'crit' : soc <= 20 ? 'warn' : 'ok';
  const lines = [];
  if (isNum(s.batt_v)) lines.push(`${fmt(s.batt_v, 1)} V${isNum(s.batt_a) ? ` · ${fmt(s.batt_a, 1)} A` : ''}`);
  if (s.grid_fail === true || s.on_battery === true) {
    lines.push(`sem rede — casa no inversor${isNum(s.out_w) ? ` (${fmt(s.out_w)} W)` : ''}`);
    if (isNum(s.autonomy_h)) lines.push(`autonomia ≈ ${fmt(s.autonomy_h, 1)} h`);
  } else if (isNum(s.grid_v)) {
    lines.push(`rede ${fmt(s.grid_v)} V`);
  }
  return { soc, level, onBattery: s.grid_fail === true || s.on_battery === true, lines };
}
