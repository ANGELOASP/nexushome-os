// ============================================================
// NexusHome OS — posição dos dispositivos integrados na planta (v2.8)
// Samsung SmartThings ("st-…") e Tuya ("tuya-…") vivem nos painéis de
// integração (não são linhas de devices); o ponto deles fica em
// device_pins (migração 020). Sem a tabela, segue sem posição.
// ============================================================

import { state, upsertDevice } from './state.js';

export let pinsTableOk = true;

const pinOf = (r) => {
  const p = { pos_x: r.pos_x, pos_z: r.pos_z, pos_floor: r.pos_floor };
  if (r.model != null) p.model = r.model;
  if (r.pos_y != null) p.pos_y = Number(r.pos_y);
  if (r.pos_rot != null) p.pos_rot = Number(r.pos_rot);
  return p;
};

export async function loadDevicePins(client) {
  try {
    const { data, error } = await client.from('device_pins').select('*');
    if (error) throw error;
    pinsTableOk = true;
    state.devicePins = Object.fromEntries((data || []).map((r) => [r.device_id, pinOf(r)]));
  } catch (err) {
    pinsTableOk = false;
    console.warn('[device_pins] indisponível (migração 020 pendente?)', err?.message || err);
  }
  // integrados já carregados recebem o ponto salvo
  state.devices.filter((d) => d.virtual && state.devicePins[d.id]).forEach((d) => upsertDevice({ ...d, ...state.devicePins[d.id] }));
}

/** Grava (ou apaga, se sem posição) o ponto de um integrado. Retorna a mensagem de erro, se houver. */
export async function saveDevicePin(client, d) {
  const placed = d.pos_x != null && d.pos_z != null;
  const row = { device_id: d.id, pos_x: d.pos_x, pos_z: d.pos_z, pos_floor: d.pos_floor ?? 0, model: d.model ?? null, pos_y: d.pos_y ?? null, pos_rot: d.pos_rot ?? null, updated_at: new Date().toISOString() };
  let res = placed
    ? await client.from('device_pins').upsert(row, { onConflict: 'device_id' })
    : await client.from('device_pins').delete().eq('device_id', d.id);
  if (placed && res.error && /model|pos_y|pos_rot/.test(res.error.message || '')) {
    // migração 021 pendente: grava só o ponto
    const { model: _m, pos_y: _y, pos_rot: _r, ...basic } = row;
    res = await client.from('device_pins').upsert(basic, { onConflict: 'device_id' });
  }
  if (res.error) return res.error.message || 'erro';
  if (placed) state.devicePins[d.id] = pinOf(row);
  else delete state.devicePins[d.id];
  return null;
}
