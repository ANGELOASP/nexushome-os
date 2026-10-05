// ============================================================
// NexusHome OS — Edge Function "smartthings-proxy" (Deno)
// ------------------------------------------------------------
// Proxy seguro entre o navegador do usuário e a API REST da
// Samsung SmartThings (https://api.smartthings.com/v1).
//
// POR QUE EXISTE:
//   A API da SmartThings exige um Personal Access Token (PAT) e
//   não é garantida como CORS-friendly para chamadas diretas do
//   navegador. Esta função recebe a chamada do app e repassa com
//   o header Authorization correto.
//
// MODELO DE SEGURANÇA:
//   · O PAT é digitado UMA vez na UI e fica SOMENTE no
//     localStorage do navegador do usuário (chave
//     nh_smartthings_token). Nada é persistido no Supabase,
//     nada vai para o repositório, nada é logado.
//   · O token viaja A CADA REQUISIÇÃO no header
//     x-smartthings-token e é usado apenas em memória para
//     montar o Authorization: Bearer da chamada upstream.
//   · Logamos apenas métodos e status codes — JAMAIS o token.
//   · Apenas caminhos que começam com /devices são aceitos:
//     sem URLs absolutas, sem "..", sem query arbitrária fora
//     do padrão — o proxy não vira um túnel genérico.
//
// POST /smartthings-proxy
//   Headers:  x-smartthings-token: <PAT>
//   Body:     { "path": "/devices",
//               "method": "GET" | "POST",
//               "payload": { ... } }        // opcional (POST)
//
// Deploy:  supabase functions deploy smartthings-proxy --no-verify-jwt
//   (--no-verify-jwt espelha o iot-gateway: a função é chamada
//    com o contexto anon do app; a credencial real é o PAT do
//    usuário, que muda por sessão/navegador e não cabe no JWT.)
// ============================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const UPSTREAM = "https://api.smartthings.com/v1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*", // proxy de API chamado com o contexto anon do app (mesmo padrão do iot-gateway)
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-smartthings-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método não suportado" }, 405);

  // --- autenticação: PAT vem do navegador do usuário ----------
  const token = (req.headers.get("x-smartthings-token") ?? "").trim();
  if (!token) {
    return json({ error: "Token SmartThings ausente (header x-smartthings-token)" }, 401);
  }

  // --- validação do payload ------------------------------------
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }

  const path = String(body.path ?? "");
  const method = String(body.method ?? "GET").toUpperCase();

  // allowlist: somente caminhos relativos da API /devices — nada de
  // URLs absolutas, "..", "@" ou quebra de linha (o proxy não é túnel)
  if (
    !path.startsWith("/devices") ||
    path.includes("..") ||
    path.includes("://") ||
    path.includes("@") ||
    /[\r\n]/.test(path)
  ) {
    return json({ error: "path inválido — apenas /devices... da API SmartThings v1" }, 400);
  }
  if (method !== "GET" && method !== "POST") {
    return json({ error: "method deve ser GET ou POST" }, 400);
  }

  // --- repasse upstream (token usado só em memória) ------------
  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: method === "POST" && body.payload !== undefined
        ? JSON.stringify(body.payload)
        : undefined,
    });
  } catch (err) {
    console.error("[smartthings-proxy] falha de rede upstream:", (err as Error)?.message ?? err);
    return json({ error: "Falha ao contatar a API SmartThings" }, 502);
  }

  // loga APENAS método e status — nunca o token
  console.log(`[smartthings-proxy] ${method} ${path} -> ${upstream.status}`);

  // resposta upstream pode ser vazia ou não-JSON: tratar com cuidado
  const text = await upstream.text();
  if (!text) return json({ ok: upstream.ok }, upstream.status);
  try {
    return json(JSON.parse(text), upstream.status);
  } catch {
    return json({ error: "Resposta não-JSON da SmartThings", raw: text.slice(0, 500) }, upstream.status);
  }
});