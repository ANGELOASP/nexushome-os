// ============================================================
// NexusHome OS — posição dos dispositivos integrados na planta (v2.8)
// Samsung SmartThings ("st-…") e Tuya ("tuya-…") vivem nos painéis de
// integração (não são linhas de devices); o ponto deles fica em
// device_pins (migração 020). Sem a tabela, segue sem posição.
// ============================================================

import { state, upsertDevice } from './state.js';

export let pinsTableOk = true;

export async function loadDevicePins(client) {
  try {
    const { data, error } = await client.from('device_pins').select('*');
    if (error) throw error;
    pinsTableOk = true;
    state.devicePins = Object.fromEntries((data || []).map((r) => [r.device_id, { pos_x: r.pos_x, pos_z: r.pos_z, pos_floor: r.pos_floor }]));
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
  const res = placed
    ? await client.from('device_pins').upsert({ device_id: d.id, pos_x: d.pos_x, pos_z: d.pos_z, pos_floor: d.pos_floor ?? 0, updated_at: new Date().toISOString() }, { onConflict: 'device_id' })
    : await client.from('device_pins').delete().eq('device_id', d.id);
  if (res.error) return res.error.message || 'erro';
  if (placed) state.devicePins[d.id] = { pos_x: d.pos_x, pos_z: d.pos_z, pos_floor: d.pos_floor ?? 0 };
  else delete state.devicePins[d.id];
  return null;
}
