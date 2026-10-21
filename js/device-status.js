// ============================================================
// NexusHome OS — Gravação parcial do status de um dispositivo
// ------------------------------------------------------------
// Gravar o status INTEIRO (mesclado no navegador) podia desfazer o que o
// firmware acabou de relatar (ex.: "on" mudado pelo interruptor de parede)
// e gerar um comando indevido para o ESP32. Com a migração 027 o banco
// mescla só o patch: `status = status || p_patch` (função device_patch_status).
// Sem a 027 (ou no mock de demonstração, que não tem rpc), cai no update
// antigo com o objeto mesclado e avisa uma vez por sessão.
// ============================================================

let warned027 = false;
let toastFn = null;   // carregado sob demanda (toasts.js mexe no DOM; os testes rodam no Node)

/** A função da 027 não existe no banco (ou o cache do PostgREST ainda não a conhece)? */
export function isMissingPatchFn(error) {
  if (!error) return false;
  const code = String(error.code || '');
  if (code === 'PGRST202' || code === '42883') return true;
  // só "função inexistente": o erro de patch inválido (22023) também cita o nome da função
  const msg = String(error.message || '');
  return /device_patch_status/i.test(msg) && /could not find|does not exist|not exist|schema cache|n[ãa]o existe/i.test(msg);
}

async function warnMigration027(notify) {
  if (warned027) return;
  warned027 = true;
  try {
    if (notify) { notify(); return; }
    if (!toastFn) ({ toast: toastFn } = await import('./toasts.js'));
    toastFn('Execute a migração 027 no Supabase', 'Sem supabase/migrations/027 o app grava o status inteiro do dispositivo (pode desfazer um relato do quadro).', 'warning');
  } catch { /* sem DOM */ }
}

/** Só para os testes: reinicia o aviso de "uma vez por sessão". */
export function _resetPatchWarning() { warned027 = false; }

/**
 * Grava `patch` no status do dispositivo `id`.
 * @param {object} client  supabase-js (ou o mock de demonstração)
 * @param {string} id
 * @param {object} patch   só as chaves que mudaram
 * @param {{ merged?: object, notify?: () => void }} [opts]  status mesclado para o
 *        caminho antigo (padrão: o patch) e aviso alternativo (testes)
 * @returns {Promise<{ status: object|null, error: object|null, fallback: boolean }>}
 */
export async function patchDeviceStatus(client, id, patch, opts = {}) {
  const merged = opts.merged || patch;
  if (typeof client?.rpc === 'function') {
    let res;
    try {
      res = await client.rpc('device_patch_status', { p_device: id, p_patch: patch });
    } catch (err) {
      res = { error: err };
    }
    if (!res?.error) {
      const st = res?.data;
      return { status: st && typeof st === 'object' && !Array.isArray(st) ? st : null, error: null, fallback: false };
    }
    if (!isMissingPatchFn(res.error)) return { status: null, error: res.error, fallback: false };
    await warnMigration027(opts.notify);
  }
  // caminho antigo: status inteiro (o mesclado no cliente)
  const { error } = await client.from('devices').update({ status: merged }).eq('id', id);
  return { status: error ? null : merged, error: error || null, fallback: true };
}
