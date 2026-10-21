// Para quem vai cada alerta (auditoria v2.18) — lógica pura testável com `npm test`.
//
// Com o cadastro do app aberto, qualquer conta pode inserir alertas da própria casa
// (política 018 owner_id = auth.uid()). O webhook INSERT chama esta função para TODOS;
// então:
//   · push → só as inscrições do dono do alerta (push_subscriptions.user_id);
//     alerta sem dono → as do principal (IOT_OWNER_ID); sem nenhum dos dois →
//     todas as inscrições (comportamento antigo) + aviso no log;
//   · Telegram (um chat só: o do principal) → só alertas do principal ou sem dono;
//     sem principal configurado → tudo (comportamento antigo) + aviso no log.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v: unknown): string | null =>
  typeof v === "string" && UUID.test(v.trim()) ? v.trim().toLowerCase() : null;

export type AlertRoute = {
  /** user_id das inscrições de push; null = todas (pushAll) */
  pushUserId: string | null;
  pushAll: boolean;
  telegram: boolean;
  warnings: string[];
};

export function routeAlert(ownerId: unknown, principalEnv: string | undefined): AlertRoute {
  const warnings: string[] = [];
  const owner = uuidOrNull(ownerId);
  const rawPrincipal = (principalEnv ?? "").trim();
  const principal = uuidOrNull(rawPrincipal);
  if (rawPrincipal && !principal) warnings.push("IOT_OWNER_ID não é um uuid válido — ignorado");

  const pushUserId = owner ?? principal;
  if (!pushUserId) warnings.push("alerta sem owner_id e IOT_OWNER_ID ausente: push para TODAS as inscrições");

  let telegram = true;
  if (principal) telegram = !owner || owner === principal;
  else warnings.push("IOT_OWNER_ID ausente: o Telegram recebe alertas de todas as contas");

  return { pushUserId, pushAll: !pushUserId, telegram, warnings };
}

/** Consulta PostgREST das inscrições de push para a rota. */
export function pushSubscriptionsQuery(route: Pick<AlertRoute, "pushUserId">): string {
  const base = "push_subscriptions?select=endpoint,p256dh,auth";
  return route.pushUserId ? `${base}&user_id=eq.${encodeURIComponent(route.pushUserId)}` : base;
}
