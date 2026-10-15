// ============================================================
// NexusHome OS — Edge Function "iot-gateway" (Deno)
// ------------------------------------------------------------
// Ponte entre o hardware (ESP32) e o Supabase.
//
// POST /iot-gateway
//   Headers:  x-device-key: <IOT_DEVICE_SECRET>
//   Body:     { "device_id": "<uuid>",
//               "metric_type": "energy_watts|water_flow_lph|temperature|humidity|water_level_pct",
//               "value": 1234.5,
//               "status": { "watts": 1234 }        // opcional: atualiza devices.status
//               "ts": "2026-10-13T12:00:00Z"       // opcional (v2.7): horário real de leitura
//               "replayed": true                   //   reenviada da fila offline (não mexe no status)
//             }
//
// POST /iot-gateway  { "readings": [ {device_id, metric_type?, value?, status?, ts?, replayed?}, ... ] }
//        (v2.11) EM LOTE — até 100 itens num POST só; item só com status atualiza o
//        painel sem gravar histórico. Usado pelo ESP32 elétrico (33 circuitos). Resposta:
//        { ok, rows, statuses, alerts, errors: [{index, error}] }  (itens inválidos não derrubam o lote)
//        "alerts": [{severity: info|warning|critical, message}] (opcional, até 10) → tabela alerts
//        "source": "eletrica|agua|seguranca|nobreak" (v2.16) → alerts.source_module
//        métricas da 025 (battery_soc, gas_lel...) sem a migração: o status grava e a
//        resposta avisa "execute a migração 025" (o histórico novo fica de fora)
//
// GET  /iot-gateway/panel?room=&limit=   (v2.16) → resumo para as telas de parede (P4 10,1" e 7")
// GET  /iot-gateway/panel/plan?floor=0     (v2.16) → a planta do app (cômodos, paredes, aparelhos) para o P4
// POST /iot-gateway/panel/command          (v2.16) → {device_id, action, value} — aciona um aparelho
//        (aparelhos com hw: o gatilho da 013/024/025 enfileira o comando para a tela do quadro)
// GET  /iot-gateway/health    → status simples
// GET  /iot-gateway/commands  → comandos pendentes para o ESP32 (x-device-key; migração 013)
//        resposta: { commands: [{ id, device_id, command: { open: true|false } | { on: true|false } }] }
//        ("on": circuitos com devices.hw — migração 023)
//        cada comando é entregue uma única vez (vira "delivered")
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
// Deploy:  supabase functions deploy iot-gateway --no-verify-jwt   (ou scripts/publicar-funcoes.ps1)
// ============================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { parseReadingTs } from "./ts.ts";
import { ALLOWED_METRICS, METRICS_025, alertSource, parseAlerts, splitBatch } from "./batch.ts";
import { buildSnapshot, validateCommand, type Device } from "./panel.ts";
import { buildPlan } from "./plan.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

/** Comparação em tempo (quase) constante para não vazar o segredo por timing. */
function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  const wantsCommands = req.method === "GET" && url.pathname.endsWith("/commands");
  const wantsPanel = req.method === "GET" && url.pathname.endsWith("/panel");
  const wantsPlan = req.method === "GET" && url.pathname.endsWith("/panel/plan");
  const wantsPanelCommand = req.method === "POST" && url.pathname.endsWith("/panel/command");
  if (req.method === "GET" && !wantsCommands && !wantsPanel && !wantsPlan) {
    return json({ ok: true, service: "nexushome-iot-gateway", version: 11, path: url.pathname });
  }
  if (req.method !== "POST" && !wantsCommands && !wantsPanel && !wantsPlan) return json({ error: "Método não suportado" }, 405);

  // --- autenticação simples por segredo compartilhado ---------
  // Fail-closed: sem IOT_DEVICE_SECRET configurado a função recusa tudo,
  // pois ela grava com service_role (ignora RLS).
  const expected = Deno.env.get("IOT_DEVICE_SECRET");
  if (!expected) {
    console.error("[iot-gateway] IOT_DEVICE_SECRET não configurado — requisição recusada");
    return json({ error: "Gateway não configurado (IOT_DEVICE_SECRET ausente)" }, 503);
  }
  if (!safeEqual(req.headers.get("x-device-key") ?? "", expected)) {
    return json({ error: "Chave de dispositivo inválida" }, 401);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  // --- telas de parede (v2.16): resumo da casa e comandos ---------
  if (wantsPanel) return await handlePanel(supabase, url);
  if (wantsPlan) return await handlePlan(supabase, url);
  if (wantsPanelCommand) return await handlePanelCommand(supabase, req);

  // --- comandos pendentes para o ESP32 (app → válvulas) ---------
  if (wantsCommands) {
    // ?devices=uuid1,uuid2 (v2.7): só os comandos dos dispositivos DESTE painel —
    // com várias casas no projeto, um ESP32 não consome os comandos de outro
    const only = (new URL(req.url).searchParams.get("devices") ?? "")
      .split(",").map((x) => x.trim()).filter((x) => /^[0-9a-f-]{36}$/i.test(x));
    let q = supabase
      .from("device_commands")
      .select("id, device_id, command")
      .eq("status", "pending");
    if (only.length) q = q.in("device_id", only);
    const { data: cmds, error: cmdErr } = await q.order("created_at").limit(20);
    if (cmdErr) return json({ error: `Falha ao ler comandos (migração 013 aplicada?): ${cmdErr.message}` }, 500);
    const ids = (cmds ?? []).map((c) => c.id);
    if (ids.length) {
      const { error: updErr } = await supabase
        .from("device_commands")
        .update({ status: "delivered", delivered_at: new Date().toISOString() })
        .in("id", ids);
      if (updErr) return json({ error: `Falha ao marcar comandos: ${updErr.message}` }, 500);
    }
    return json({ commands: cmds ?? [] });
  }

  // --- validação do payload -----------------------------------
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }

  if (Array.isArray(body.readings)) return await handleBatch(supabase, body.readings, body.alerts, body.source);

  const deviceId = String(body.device_id ?? "");
  const metricType = String(body.metric_type ?? "");
  const value = Number(body.value);

  if (!deviceId) return json({ error: "device_id é obrigatório" }, 400);
  if (!ALLOWED_METRICS.has(metricType)) {
    return json({ error: `metric_type inválido. Use: ${[...ALLOWED_METRICS].join(", ")}` }, 400);
  }
  if (!Number.isFinite(value)) return json({ error: "value deve ser numérico" }, 400);

  // --- escrita no Supabase (service role: ignora RLS) ---------
  // leitura reenviada da fila offline do ESP32: grava com o horário real da medida
  const createdAt = parseReadingTs(body.ts);
  const replayed = body.replayed === true;
  const { error: telErr } = await supabase
    .from("telemetry_logs")
    .insert({ device_id: deviceId, metric_type: metricType, value, ...(createdAt ? { created_at: createdAt } : {}) });

  if (telErr) {
    const hint = telErr.code === "23514" && METRICS_025.has(metricType) ? " — execute a migração 025" : "";
    return json({ error: `Falha ao gravar telemetria: ${telErr.message}${hint}` }, hint ? 422 : 500);
  }

  // opcional: o firmware pode atualizar o status do dispositivo
  // (ex.: medidor publica {"watts": X} para o painel 3D reagir)
  if (!replayed && body.status && typeof body.status === "object") {
    // migração 013: device_report_status grava o estado reportado sem gerar comando de volta (eco)
    const { error: rpcErr } = await supabase.rpc("device_report_status", { p_device: deviceId, p_patch: body.status });
    if (!rpcErr) return json({ ok: true, device_id: deviceId, metric_type: metricType, value });
    if (!/device_report_status|function/i.test(rpcErr.message)) {
      return json({ error: `Telemetria gravada, mas status falhou: ${rpcErr.message}` }, 207);
    }
    // sem a migração 013: merge manual (comportamento anterior)
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

// ---- envio em lote (v2.11) -------------------------------------------------
// deno-lint-ignore no-explicit-any
async function handleBatch(supabase: any, readings: unknown[], alerts?: unknown, source?: unknown): Promise<Response> {
  const { rows, statuses, errors } = splitBatch(readings);
  if (errors.length && errors[0].index === -1) return json({ error: errors[0].error }, 400);

  let rowsSaved = rows;
  if (rows.length) {
    let { error } = await supabase.from("telemetry_logs").insert(rows);
    if (error?.code === "23514" && rows.some((r) => METRICS_025.has(r.metric_type))) {
      // sem a migração 025 o banco recusa as métricas novas: grava o resto e avisa
      rowsSaved = rows.filter((r) => !METRICS_025.has(r.metric_type));
      errors.push({ index: -1, error: "histórico de bateria/gás/rede ignorado: execute a migração 025" });
      error = rowsSaved.length ? (await supabase.from("telemetry_logs").insert(rowsSaved)).error : null;
    }
    if (error?.code === "23503") {
      // algum device_id não existe (seed não rodado / aparelho excluído): grava os demais um a um
      for (const row of rowsSaved) {
        const { error: e1 } = await supabase.from("telemetry_logs").insert(row);
        if (e1) errors.push({ index: -1, error: `telemetria de ${row.device_id}: ${e1.message}` });
      }
    } else if (error) {
      return json({ error: `Falha ao gravar telemetria: ${error.message}`, errors }, 500);
    }
  }
  // status em paralelo; device_report_status (013) não gera comando de volta (eco)
  const results = await Promise.all(statuses.map((s) =>
    supabase.rpc("device_report_status", { p_device: s.device_id, p_patch: s.status })));
  results.forEach((r: { error?: { message: string } | null }, i: number) => {
    if (r.error) errors.push({ index: -1, error: `status de ${statuses[i].device_id}: ${r.error.message}` });
  });
  const alertRows = parseAlerts(alerts, alertSource(source));
  if (alertRows.length) {
    const { error } = await supabase.from("alerts").insert(alertRows);
    if (error) errors.push({ index: -1, error: `alertas: ${error.message}` });
  }
  return json({ ok: true, rows: rowsSaved.length, statuses: statuses.length, alerts: alertRows.length, errors }, errors.length ? 207 : 200);
}

// ---- telas de parede (v2.16) -------------------------------------------------
// deno-lint-ignore no-explicit-any
async function handlePanel(supabase: any, url: URL): Promise<Response> {
  const room = url.searchParams.get("room") ?? "";
  const limit = Number(url.searchParams.get("limit") ?? "80");
  // ?plan=0 (painel do corredor): junta a assinatura da planta do andar → o painel
  // baixa a planta de novo assim que ela muda no Editor de Planta do app
  const planFloor = url.searchParams.has("plan") ? Number(url.searchParams.get("plan") || "0") : null;
  const [devs, alerts, plan] = await Promise.all([
    supabase.from("devices").select(planFloor === null ? "id, name, type, room, status, is_online" : "*"),
    supabase.from("alerts").select("severity, message, created_at, resolved")
      .eq("resolved", false).gte("created_at", new Date(Date.now() - 86400000).toISOString())
      .order("created_at", { ascending: false }).limit(20),
    planFloor === null ? null : loadPlanRows(supabase),
  ]);
  if (devs.error) return json({ error: `Falha ao ler dispositivos: ${devs.error.message}` }, 500);
  const snap = buildSnapshot(devs.data ?? [], alerts.data ?? [], { room, limit: Number.isFinite(limit) ? limit : 80 });
  if (plan && !plan.rooms.error) {
    const f = Number.isFinite(planFloor) ? planFloor! : 0;
    return json({ ...snap, ps: buildPlan(plan.rooms.data ?? [], plan.walls.error ? [] : plan.walls.data ?? [], devs.data ?? [], f).sig });
  }
  return json(snap);
}

// deno-lint-ignore no-explicit-any
function loadPlanRows(supabase: any) {
  return Promise.all([
    supabase.from("rooms").select("*"),
    supabase.from("walls").select("floor, x1, z1, x2, z2"),
  ]).then(([rooms, walls]) => ({ rooms, walls }));
}

// deno-lint-ignore no-explicit-any
async function handlePlan(supabase: any, url: URL): Promise<Response> {
  const floor = Number(url.searchParams.get("floor") ?? "0");
  const [{ rooms, walls }, devs] = await Promise.all([
    loadPlanRows(supabase),
    supabase.from("devices").select("*"),
  ]);
  if (rooms.error) return json({ error: `Falha ao ler a planta: ${rooms.error.message}` }, 500);
  // sem a 006 (paredes) a planta sai só com os cômodos
  return json(buildPlan(rooms.data ?? [], walls.error ? [] : walls.data ?? [], devs.data ?? [], Number.isFinite(floor) ? floor : 0));
}

// deno-lint-ignore no-explicit-any
async function handlePanelCommand(supabase: any, req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }
  const id = String(body?.device_id ?? "");
  const { data: dev } = /^[0-9a-f-]{36}$/i.test(id)
    ? await supabase.from("devices").select("id, name, type, room, status, is_online").eq("id", id).maybeSingle()
    : { data: null };
  const v = validateCommand(body, dev as Device | null);
  if (v.error) return json({ error: v.error }, v.status ?? 400);
  const status = { ...((dev as Device).status ?? {}), ...v.patch };
  // update comum (não device_report_status): o gatilho enfileira o comando para a tela do quadro
  const { error } = await supabase.from("devices").update({ status }).eq("id", id);
  if (error) return json({ error: `Falha ao acionar: ${error.message}` }, 500);
  return json({ ok: true, device_id: id, status });
}
