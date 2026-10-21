// Dono da casa no iot-gateway (auditoria v2.18), lógica pura testável com `npm test`.
//
// O gateway grava/lê com service role (ignora o RLS). Com o cadastro do app aberto e a
// migração 018 (owner_id em todas as tabelas), ele precisa saber DE QUEM é a casa:
//   1. secret IOT_OWNER_ID (uuid do usuário dono) — o caminho recomendado;
//   2. sem o secret: "a única conta que tem dispositivos" (distinct owner_id em devices),
//      com cache curto em memória. Com 0 ou 2+ contas o dono fica indefinido:
//      as rotas /panel* respondem 503 e as leituras continuam gravando (alertas sem
//      owner_id explícito, como antes — o gatilho alerts_owner da 018 decide).

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export type OwnerResult = { owner: string | null; source: "env" | "devices" | "none"; reason?: string };

/** Mensagem das rotas /panel* quando o dono não pôde ser resolvido. */
export const OWNER_HINT = "configure o secret IOT_OWNER_ID (uuid do usuário dono da casa) no Supabase";

/** Decide o dono a partir da lista de owner_id distintos encontrados em devices. */
export function ownerFromCandidates(owners: unknown[]): OwnerResult {
  const uniq = [...new Set(owners.filter(isUuid).map((o) => o.toLowerCase()))];
  if (uniq.length === 1) return { owner: uniq[0], source: "devices" };
  return {
    owner: null,
    source: "none",
    reason: uniq.length === 0 ? "nenhuma conta com dispositivos" : "mais de uma conta com dispositivos",
  };
}

export const OWNER_CACHE_MS = 60_000;
type Cache = { value: OwnerResult | null; at: number };
const defaultCache: Cache = { value: null, at: 0 };

/**
 * Resolve o dono. `env` = valor de IOT_OWNER_ID; `lookup` devolve até dois owner_id
 * distintos de devices (basta saber se é 0, 1 ou "mais de 1"). Falha do lookup não
 * entra no cache (tenta de novo na próxima requisição).
 */
export async function resolveOwner(
  env: string | undefined,
  lookup: () => Promise<unknown[]>,
  nowMs = Date.now(),
  cache: Cache = defaultCache,
): Promise<OwnerResult> {
  const e = (env ?? "").trim();
  if (e) {
    return isUuid(e)
      ? { owner: e.toLowerCase(), source: "env" }
      : { owner: null, source: "none", reason: "IOT_OWNER_ID não é um uuid válido" };
  }
  if (cache.value && nowMs - cache.at < OWNER_CACHE_MS) return cache.value;
  let owners: unknown[];
  try {
    owners = await lookup();
  } catch (err) {
    return { owner: null, source: "none", reason: `falha ao procurar o dono: ${(err as Error)?.message ?? err}` };
  }
  const r = ownerFromCandidates(owners);
  cache.value = r;
  cache.at = nowMs;
  return r;
}

export type AlertInsert = { severity: string; message: string; source_module: string; owner_id?: string; device_id?: string };

/** Linhas de alerta do lote com o dono resolvido (quando houver) e o device_id do item. */
export function alertRowsFor(
  alerts: { severity: string; message: string; source_module: string; device_id?: string }[],
  owner: string | null,
): AlertInsert[] {
  return alerts.map((a) => ({
    severity: a.severity,
    message: a.message,
    source_module: a.source_module,
    ...(owner ? { owner_id: owner } : {}),
    ...(isUuid(a.device_id) ? { device_id: a.device_id } : {}),
  }));
}

/**
 * O insert falhou por causa do device_id? (coluna ainda não existe — migração 027 não
 * aplicada: 42703 / PGRST204 — ou aparelho inexistente: 23503). Aí refaz sem device_id.
 */
export function deviceIdRejected(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "42703" || error.code === "PGRST204" || error.code === "23503") return true;
  return /device_id/i.test(error.message ?? "");
}

export const withoutDeviceId = (rows: AlertInsert[]): AlertInsert[] =>
  rows.map(({ device_id: _drop, ...rest }) => rest);

/** A função device_patch_status (027) não existe ainda? → cai no update antigo. */
export function rpcMissing(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "PGRST202" || error.code === "42883";
}

/**
 * Filtro ?devices= de GET /commands. Parâmetro ausente → sem filtro (firmware antigo).
 * Presente → só os UUIDs válidos; se nenhum sobrar, `none` = true (responder lista vazia,
 * em vez de entregar os comandos de TODAS as telas).
 */
export function parseDeviceFilter(raw: string | null): { ids: string[]; none: boolean } {
  if (raw === null) return { ids: [], none: false };
  const ids = [...new Set(raw.split(",").map((x) => x.trim()).filter(isUuid))];
  return { ids, none: ids.length === 0 };
}

/** Reordena as linhas que o UPDATE devolveu na ordem dos candidatos (created_at). */
export function inCandidateOrder<T extends { id: unknown }>(candidates: { id: unknown }[], claimed: T[]): T[] {
  const pos = new Map(candidates.map((c, i) => [c.id, i]));
  return [...claimed].sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
}
