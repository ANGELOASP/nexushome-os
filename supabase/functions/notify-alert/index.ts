// ============================================================
// NexusHome OS — Edge Function "notify-alert" (Deno)
// ------------------------------------------------------------
// Envia alertas da tabela `alerts` para o Telegram (vazamento,
// consumo crítico, válvula fechada...), mesmo com o app fechado.
//
// COMO FUNCIONA:
//   Um Database Webhook do Supabase (INSERT em public.alerts)
//   chama esta função; ela filtra pela severidade e envia a
//   mensagem pela Bot API do Telegram.
//
// CONFIGURAÇÃO (uma vez):
//   1. Telegram → @BotFather → /newbot → copie o token.
//   2. Mande qualquer mensagem ao seu bot e abra
//      https://api.telegram.org/bot<TOKEN>/getUpdates
//      → copie "chat":{"id": ...} (é o TELEGRAM_CHAT_ID).
//   3. supabase secrets set TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... \
//        NOTIFY_WEBHOOK_SECRET="<segredo forte>"
//      (opcional) NOTIFY_MIN_SEVERITY=critical|warning|info  (padrão: critical)
//   4. supabase functions deploy notify-alert --no-verify-jwt
//      (--no-verify-jwt: quem chama é o webhook do banco, que se
//       autentica pelo header x-webhook-secret, não por JWT.)
//   5. Dashboard → Database → Webhooks → Create: tabela `alerts`,
//      evento INSERT, tipo "Supabase Edge Functions" → notify-alert,
//      header HTTP  x-webhook-secret: <o mesmo segredo>.
//
// PUSH NO CELULAR (v2.7, opcional — funciona com ou sem Telegram):
//   1. npx web-push generate-vapid-keys   (gera o par de chaves)
//   2. supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... \
//        VAPID_SUBJECT="mailto:voce@exemplo.com"
//   3. js/config.js → VAPID_PUBLIC_KEY: "<a mesma chave pública>"
//   4. Rode a migração 017_push_subscriptions.sql e, no app, toque em
//      "Ativar notificações" em cada aparelho.
//   SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já vêm no ambiente da função.
//
// DONO DA CASA (v2.18, recomendado): supabase secrets set IOT_OWNER_ID=<uuid do usuário dono>
//   (o mesmo do iot-gateway). Push só para as inscrições do dono do alerta; o Telegram só
//   recebe alertas do dono (ou sem dono). Sem o secret: comportamento antigo + aviso no log.
//
// SEGURANÇA: fail-closed — sem NOTIFY_WEBHOOK_SECRET a função
// recusa tudo; o token do bot nunca é logado nem devolvido.
// ============================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import webpush from "npm:web-push@3.6.7";
import { formatMessage, pushPayload, safeEqual, shouldNotify } from "./format.ts";
import { type AlertRoute, pushSubscriptionsQuery, routeAlert } from "./route.ts";

/** Nenhum fetch externo segura a instância além disso (Telegram, PostgREST, push). */
const TIMEOUT_MS = 10_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Método não suportado" }, 405);

  const secret = Deno.env.get("NOTIFY_WEBHOOK_SECRET");
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  const telegramOn = !!(token && chatId);
  const pushOn = !!(Deno.env.get("VAPID_PUBLIC_KEY") && Deno.env.get("VAPID_PRIVATE_KEY"));
  if (!secret || (!telegramOn && !pushOn)) {
    console.error("[notify-alert] secrets ausentes (NOTIFY_WEBHOOK_SECRET + Telegram e/ou VAPID)");
    return json({ error: "Função não configurada" }, 503);
  }
  if (!safeEqual(req.headers.get("x-webhook-secret") ?? "", secret)) {
    return json({ error: "Não autorizado" }, 401);
  }

  let payload: { type?: string; record?: Record<string, string> };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }
  if (payload.type !== "INSERT" || !payload.record) return json({ ok: true, skipped: "não é INSERT" });

  const alert = payload.record;
  if (!shouldNotify(alert.severity, Deno.env.get("NOTIFY_MIN_SEVERITY") ?? "critical")) {
    return json({ ok: true, skipped: "severidade abaixo do mínimo" });
  }

  // v2.18: roteia pelo dono do alerta (cadastro aberto = várias contas no mesmo projeto)
  const route = routeAlert(alert.owner_id, Deno.env.get("IOT_OWNER_ID"));
  route.warnings.forEach((w) => console.warn(`[notify-alert] ${w}`));
  const telegramTry = telegramOn && route.telegram;

  const result: Record<string, unknown> = { ok: true };
  if (telegramTry) result.telegram = await sendTelegram(token!, chatId!, alert);
  else if (telegramOn) result.telegram = "ignorado (alerta de outra conta)";
  if (pushOn) result.push = await sendPush(alert, route);
  const failed = (telegramTry && result.telegram !== "ok") && (!pushOn || (result.push as { sent?: number })?.sent === 0);
  return json(result, failed ? 502 : 200);
});

async function sendTelegram(token: string, chatId: string, alert: Record<string, string>): Promise<string> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: formatMessage(alert), parse_mode: "HTML" }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    console.log(`[notify-alert] ${alert.severity} -> Telegram ${res.status}`); // nunca loga o token
    return res.ok ? "ok" : `erro ${res.status}`;
  } catch (err) {
    console.error("[notify-alert] falha de rede (Telegram):", (err as Error)?.message ?? err);
    return "falha de rede";
  }
}

/** Envia o alerta aos aparelhos inscritos do dono (ver route.ts); remove inscrições expiradas (404/410). */
async function sendPush(alert: Record<string, string>, route: AlertRoute): Promise<{ sent: number; removed: number; failed: number }> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const out = { sent: 0, removed: 0, failed: 0 };
  if (!url || !key) return out;
  webpush.setVapidDetails(
    Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@nexushome.local",
    Deno.env.get("VAPID_PUBLIC_KEY")!,
    Deno.env.get("VAPID_PRIVATE_KEY")!,
  );
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  let res: Response;
  try {
    res = await fetch(`${url}/rest/v1/${pushSubscriptionsQuery(route)}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    console.error("[notify-alert] push_subscriptions: falha de rede:", (err as Error)?.message ?? err);
    return out;
  }
  if (!res.ok) { console.error("[notify-alert] push_subscriptions:", res.status); return out; }
  const subs: { endpoint: string; p256dh: string; auth: string }[] = await res.json();
  const body = JSON.stringify(pushPayload(alert));
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 3600, urgency: alert.severity === "critical" ? "high" : "normal", timeout: TIMEOUT_MS });
      out.sent++;
    } catch (err) {
      const code = (err as { statusCode?: number })?.statusCode;
      if (code === 404 || code === 410) {
        out.removed++;
        await fetch(`${url}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: "DELETE", headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
          .catch((e) => console.error("[notify-alert] remover inscrição expirada:", (e as Error)?.message ?? e));
      } else {
        out.failed++;
        console.error("[notify-alert] push falhou:", code ?? (err as Error)?.message);
      }
    }
  }));
  console.log(`[notify-alert] push: ${out.sent} enviados, ${out.removed} expirados, ${out.failed} falhas`);
  return out;
}
