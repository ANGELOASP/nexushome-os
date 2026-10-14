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
