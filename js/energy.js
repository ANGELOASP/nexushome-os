// ============================================================
// NexusHome OS — Energia da casa (v2.11): soma dos medidores
// ------------------------------------------------------------
// Com um medidor só, "Energia" era a última leitura recebida. Com os 33
// circuitos do quadro elétrico (PZEM-016) isso pularia de circuito em
// circuito — o painel passa a mostrar a SOMA da última leitura de cada
// medidor. Os circuitos marcados `in_total: true` já estão somados no
// dispositivo "consumo total" do quadro (`in_total: false`): enquanto ele
// estiver reportando, os circuitos não entram de novo na conta.
// Lógica pura (testável com `npm test`).
// ============================================================

export const ENERGY_STALE_MS = 10 * 60 * 1000;   // leitura mais velha que isso não conta

/**
 * @param {Map<string,{w:number,t:number}>} latest  última leitura de energy_watts por dispositivo
 * @param {(id:string)=>object|undefined} getDevice
 */
export function houseWatts(latest, getDevice, now = Date.now()) {
  const fresh = [...latest].filter(([, r]) => Number.isFinite(r.w) && now - r.t <= ENERGY_STALE_MS);
  const flag = (id) => getDevice(id)?.status?.in_total;
  const hasTotal = fresh.some(([id]) => flag(id) === false);
  return fresh.reduce((sum, [id, r]) => (hasTotal && flag(id) === true ? sum : sum + r.w), 0);
}

export const DEFAULT_BANDS = { warning: 3000, critical: 4500 };

/**
 * Faixas de alerta do consumo da casa. Com o quadro elétrico (dispositivo
 * total `in_total: false`), as faixas saem do limite de demanda configurado
 * no firmware (85% / 100%); com o limite desligado (0) não há alerta pelo
 * navegador — cada chuveiro passaria de 4,5 kW e viraria push "crítico".
 */
export function energyBands(devices) {
  const total = (devices || []).find((d) => d?.type === 'meter' && d.status?.in_total === false);
  if (!total) return DEFAULT_BANDS;
  const limit = Number(total.status?.limit_w);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  return { warning: Math.round(limit * 0.85), critical: limit };
}

/** Faixa ('ok' | 'warn' | 'crit') de um consumo; sem faixas, sempre 'ok'. */
export function energyBand(watts, bands) {
  if (!bands) return 'ok';
  return watts > bands.critical ? 'crit' : watts > bands.warning ? 'warn' : 'ok';
}

// ---- água (v2.16) ----------------------------------------------------------
// A hidráulica manda a vazão de cada ramal e a SOMA na válvula geral; o Tuya manda
// a leitura do medidor da entrada na mesma válvula. Enquanto a geral estiver
// reportando, ela é o total da casa; senão, soma os ramais.
export const WATER_TOTAL_ID = 'a3333333-3333-4333-8333-333333333333';

/** @param {Map<string,{v:number,t:number}>} latest última leitura de water_flow_lph por dispositivo */
export function houseWaterFlow(latest, now = Date.now()) {
  const fresh = [...latest].filter(([, r]) => Number.isFinite(r.v) && now - r.t <= ENERGY_STALE_MS);
  const total = fresh.find(([id]) => id === WATER_TOTAL_ID);
  if (total) return total[1].v;
  return fresh.reduce((sum, [, r]) => sum + r.v, 0);
}

/**
 * Válvula geral de água (botão de emergência): pelo id fixo do projeto; sem ela,
 * a primeira válvula com "geral" no nome. Nunca a válvula de gás nem um ramal.
 */
export function mainWaterValve(devices) {
  const list = (devices || []).filter((d) => d?.type === 'valve');
  return list.find((d) => d.id === WATER_TOTAL_ID)
    || list.find((d) => /geral/i.test(d.name || '') && !/g[aá]s/i.test(d.name || '') && !d.virtual)
    || null;
}
