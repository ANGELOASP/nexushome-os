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
// SEGURANÇA: fail-closed — sem NOTIFY_WEBHOOK_SECRET a função
// recusa tudo; o token do bot nunca é logado nem devolvido.
// ============================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { formatMessage, safeEqual, shouldNotify } from "./format.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Método não suportado" }, 405);

  const secret = Deno.env.get("NOTIFY_WEBHOOK_SECRET");
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  if (!secret || !token || !chatId) {
    console.error("[notify-alert] secrets ausentes (NOTIFY_WEBHOOK_SECRET/TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID)");
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

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: formatMessage(alert), parse_mode: "HTML" }),
    });
    console.log(`[notify-alert] ${alert.severity} -> Telegram ${res.status}`); // nunca loga o token
    if (!res.ok) return json({ error: "Telegram recusou a mensagem", status: res.status }, 502);
    return json({ ok: true });
  } catch (err) {
    console.error("[notify-alert] falha de rede:", (err as Error)?.message ?? err);
    return json({ error: "Falha ao contatar o Telegram" }, 502);
  }
});
