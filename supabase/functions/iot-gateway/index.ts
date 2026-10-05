// ============================================================
// NexusHome OS — Edge Function "iot-gateway" (Deno)
// ------------------------------------------------------------
// Ponte entre o hardware (ESP32) e o Supabase.
//
// POST /iot-gateway
//   Headers:  x-device-key: <IOT_DEVICE_SECRET>
//   Body:     { "device_id": "<uuid>",
//               "metric_type": "energy_watts|water_flow_lph|temperature|humidity",
//               "value": 1234.5,
//               "status": { "watts": 1234 }        // opcional: atualiza devices.status
//             }
//
// GET  /iot-gateway/health  → status simples
//
// Variáveis de ambiente (configuradas via `supabase secrets set`):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (provisionadas automaticamente)
//   IOT_DEVICE_SECRET                        (segredo compartilhado com o firmware)
//
// SEGURANÇA:
//   · A SERVICE_ROLE KEY ignora o RLS por design — é o que permite à
//     função gravar telemetria mesmo com as políticas "apenas
//     autenticados" da migração 002_auth_rls.sql. Por isso ela
//     NUNCA deve ser exposta ao frontend (nem commitada).
//   · O mecanismo de autenticação dos dispositivos IoT é o header
//     x-device-key (segredo compartilhado, definido em IOT_DEVICE_SECRET).
//     Não use a anon key no ESP32: o fluxo do firmware não muda.
//
// Deploy:  supabase functions deploy iot-gateway
// ============================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_METRICS = new Set(["energy_watts", "water_flow_lph", "temperature", "humidity"]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-device-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  if (req.method === "GET") {
    return json({ ok: true, service: "nexushome-iot-gateway", path: url.pathname });
  }
  if (req.method !== "POST") return json({ error: "Método não suportado" }, 405);

  // --- autenticação simples por segredo compartilhado ---------
  const expected = Deno.env.get("IOT_DEVICE_SECRET");
  const provided = req.headers.get("x-device-key");
  if (expected && provided !== expected) {
    return json({ error: "Chave de dispositivo inválida" }, 401);
  }

  // --- validação do payload -----------------------------------
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }

  const deviceId = String(body.device_id ?? "");
  const metricType = String(body.metric_type ?? "");
  const value = Number(body.value);

  if (!deviceId) return json({ error: "device_id é obrigatório" }, 400);
  if (!ALLOWED_METRICS.has(metricType)) {
    return json({ error: `metric_type inválido. Use: ${[...ALLOWED_METRICS].join(", ")}` }, 400);
  }
  if (!Number.isFinite(value)) return json({ error: "value deve ser numérico" }, 400);

  // --- escrita no Supabase (service role: ignora RLS) ---------
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  const { error: telErr } = await supabase
    .from("telemetry_logs")
    .insert({ device_id: deviceId, metric_type: metricType, value });

  if (telErr) return json({ error: `Falha ao gravar telemetria: ${telErr.message}` }, 500);

  // opcional: o firmware pode atualizar o status do dispositivo
  // (ex.: medidor publica {"watts": X} para o painel 3D reagir)
  if (body.status && typeof body.status === "object") {
    const { data: dev } = await supabase
      .from("devices")
      .select("status")
      .eq("id", deviceId)
      .maybeSingle();

    const merged = { ...(dev?.status ?? {}), ...(body.status as Record<string, unknown>) };
    const { error: devErr } = await supabase
      .from("devices")
      .update({ status: merged, is_online: true })
      .eq("id", deviceId);

    if (devErr) return json({ error: `Telemetria gravada, mas status falhou: ${devErr.message}` }, 207);
  }

  return json({ ok: true, device_id: deviceId, metric_type: metricType, value });
});
