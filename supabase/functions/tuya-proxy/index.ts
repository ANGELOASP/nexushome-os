// ============================================================
// NexusHome OS — Edge Function "tuya-proxy" (Deno)
// ------------------------------------------------------------
// Proxy seguro entre o navegador do usuário e a Tuya Cloud API
// (Smart Life): válvulas Wi-Fi, medidores ultrassônicos,
// monitores de nível ME201W e sensores de vazamento.
//
// POR QUE EXISTE:
//   A Tuya Cloud exige assinatura HMAC-SHA256 por requisição
//   (client_id + access_token + timestamp + stringToSign), o que
//   não pode ser feito no navegador sem expor o Client Secret.
//   Esta função recebe as credenciais a cada chamada, assina e
//   repassa — nada é persistido, nada é logado além de status.
//
// MODELO DE SEGURANÇA:
//   · Client ID / Client Secret / UID / região são digitados UMA
//     vez na UI e ficam SOMENTE no localStorage do navegador
//     (chave nh_tuya_creds). Nunca vão para tabelas do Supabase,
//     nunca são commitados, nunca são logados.
//   · As credenciais viajam no CORPO de cada requisição e são
//     usadas apenas em memória para assinar a chamada upstream.
//   · O access_token (vida ~2 h) fica em cache em memória da
//     instância, chaveado pelo client_id — nunca em disco/log.
//   · Logamos apenas método, caminho e status — JAMAIS segredos.
//   · Allowlist de caminhos: apenas /v1.0/users/... e
//     /v1.0/devices/... — o proxy não vira um túnel genérico.
//
// ASSINATURA TUYA (HMAC-SHA256) — detalhe crítico:
//   stringToSign = MÉTODO + "\n" + sha256_hex(corpo || "")
//                + "\n" + "" (headers assinados: nenhum)
//                + "\n" + caminho_com_query
//   sign = HMAC_SHA256(client_secret,
//            client_id + [access_token] + t + stringToSign)
//          em hex MAIÚSCULO
//   Headers: client_id, sign, t (ms), sign_method=HMAC-SHA256
//   (+ access_token nas chamadas de negócio)
//
// POST /tuya-proxy
//   Body: { action: "token",
//           creds: { clientId, clientSecret, uid, region } }
//        | { action: "request", creds: {...},
//            method: "GET"|"POST", path: "/v1.0/devices/...",
//            payload: {...} }               // opcional (POST)
//
// Regiões: us → openapi.tuyaus.com (padrão — contas Smart Life
// BR normalmente funcionam no cluster US), eu, cn, in.
//
// Deploy:  supabase functions deploy tuya-proxy
//   (SEM --no-verify-jwt: a plataforma valida o JWT e a função exige
//    role "authenticated" — só usuários logados usam o proxy. O
//    supabase-js envia o token da sessão sozinho em functions.invoke.)
// ============================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const REGIONS: Record<string, string> = {
  us: "https://openapi.tuyaus.com",
  eu: "https://openapi.tuyaeu.com",
  cn: "https://openapi.tuyacn.com",
  in: "https://openapi.tuyain.com",
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*", // exige JWT de usuário logado (ver isAuthenticatedUser)
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ---- cache de access_token em memória (por instância) -------
// chave = client_id; valor = token + expiração (com margem de 120 s)
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

// ---- criptografia (Web Crypto — nativo no Deno) --------------
const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

async function hmacSha256HexUpper(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return toHex(sig).toUpperCase();
}

/**
 * Monta os headers assinados de uma chamada Tuya.
 * accessToken vazio = chamada de obtenção de token (grant_type=1).
 */
async function signedHeaders(
  clientId: string,
  clientSecret: string,
  accessToken: string,
  method: string,
  pathWithQuery: string,
  bodyText: string,
): Promise<Record<string, string>> {
  const t = Date.now().toString();
  const contentHash = await sha256Hex(bodyText);
  // stringToSign: MÉTODO \n hash_sha256_do_corpo \n headers(vazio) \n caminho?query
  const stringToSign = [method.toUpperCase(), contentHash, "", pathWithQuery].join("\n");
  // payload da assinatura: client_id + [access_token] + t + stringToSign
  const sign = await hmacSha256HexUpper(clientSecret, clientId + accessToken + t + stringToSign);
  const headers: Record<string, string> = {
    client_id: clientId,
    sign,
    t,
    sign_method: "HMAC-SHA256",
  };
  if (accessToken) headers.access_token = accessToken;
  return headers;
}

// ---- erro upstream carregando o JSON original da Tuya -------
class UpstreamError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super("Erro upstream Tuya");
    this.status = status;
    this.body = body;
  }
}

/** GET /v1.0/token?grant_type=1 — assinado SEM access_token. */
async function fetchToken(base: string, clientId: string, clientSecret: string) {
  const path = "/v1.0/token?grant_type=1";
  const headers = await signedHeaders(clientId, clientSecret, "", "GET", path, "");
  const res = await fetch(base + path, { method: "GET", headers });
  const data = await res.json().catch(() => null);
  console.log(`[tuya-proxy] GET ${path} -> ${res.status}`);
  if (!res.ok || !data?.success || !data?.result?.access_token) {
    throw new UpstreamError(res.ok ? 401 : res.status, data ?? { error: "Resposta inválida da Tuya" });
  }
  const ttlMs = (Number(data.result.expire_time) || 7200) * 1000;
  tokenCache.set(clientId, { token: data.result.access_token, expiresAt: Date.now() + ttlMs - 120_000 });
  return data;
}

/** Token válido do cache ou um novo (renovado uma vez se a Tuya disser 1010). */
async function getToken(base: string, clientId: string, clientSecret: string): Promise<string> {
  const cached = tokenCache.get(clientId);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const data = await fetchToken(base, clientId, clientSecret);
  return data.result.access_token;
}

// ------------------------------------------------------------

interface Creds {
  clientId?: string;
  clientSecret?: string;
  uid?: string;
  region?: string;
}

/**
 * Exige um usuário LOGADO. A plataforma já valida a assinatura do JWT
 * (deploy SEM --no-verify-jwt); aqui rejeitamos o JWT da chave anon
 * (role "anon"), que também é um JWT válido e está no frontend.
 */
function isAuthenticatedUser(req: Request): boolean {
  const m = /^Bearer\s+([\w-]+)\.([\w-]+)\.[\w-]+$/.exec(req.headers.get("authorization") ?? "");
  if (!m) return false;
  try {
    const b64 = m[2].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
    return claims?.role === "authenticated";
  } catch {
    return false;
  }
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método não suportado" }, 405);
  if (!isAuthenticatedUser(req)) return json({ error: "Login necessário" }, 401);

  // --- payload -------------------------------------------------
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }

  const action = String(body.action ?? "");
  const creds = (body.creds ?? {}) as Creds;
  const clientId = String(creds.clientId ?? "").trim();
  const clientSecret = String(creds.clientSecret ?? "").trim();
  const region = String(creds.region ?? "us").trim().toLowerCase() || "us";

  if (!clientId || !clientSecret) {
    return json({ error: "Credenciais Tuya ausentes (clientId/clientSecret)" }, 400);
  }
  const base = REGIONS[region];
  if (!base) {
    return json({ error: "Região inválida — use us, eu, cn ou in" }, 400);
  }

  // --- action=token: apenas valida as credenciais --------------
  if (action === "token") {
    try {
      const data = await fetchToken(base, clientId, clientSecret);
      return json(data, 200);
    } catch (err) {
      if (err instanceof UpstreamError) return json(err.body, err.status);
      console.error("[tuya-proxy] falha de rede upstream (token):", (err as Error)?.message ?? err);
      return json({ error: "Falha ao contatar a Tuya Cloud" }, 502);
    }
  }

  // --- action=request: chamada de negócio assinada -------------
  if (action !== "request") {
    return json({ error: "action deve ser token ou request" }, 400);
  }

  const path = String(body.path ?? "");
  const method = String(body.method ?? "GET").toUpperCase();

  // allowlist: somente /v1.0/users/... e /v1.0/devices/... — nada de
  // URLs absolutas, "..", "@" ou quebra de linha (o proxy não é túnel)
  if (
    !/^\/v1\.0\/(users|devices)\//.test(path) ||
    path.includes("..") ||
    path.includes("://") ||
    path.includes("@") ||
    /[\r\n]/.test(path)
  ) {
    return json({ error: "path inválido — apenas /v1.0/users/... ou /v1.0/devices/... da Tuya Cloud" }, 400);
  }
  if (method !== "GET" && method !== "POST") {
    return json({ error: "method deve ser GET ou POST" }, 400);
  }

  const bodyText = method === "POST" && body.payload !== undefined
    ? JSON.stringify(body.payload)
    : "";

  try {
    let accessToken = await getToken(base, clientId, clientSecret);

    const callUpstream = async (token: string) => {
      const headers = await signedHeaders(clientId, clientSecret, token, method, path, bodyText);
      return fetch(base + path, {
        method,
        headers: { ...headers, "Content-Type": "application/json" },
        body: method === "POST" && bodyText ? bodyText : undefined,
      });
    };

    let upstream = await callUpstream(accessToken);
    let text = await upstream.text();

    // token expirou no meio do caminho (código Tuya 1010)? renova e tenta 1×
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* não-JSON */ }
    if ((parsed as { code?: number })?.code === 1010) {
      tokenCache.delete(clientId);
      accessToken = await getToken(base, clientId, clientSecret);
      upstream = await callUpstream(accessToken);
      text = await upstream.text();
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    }

    // loga APENAS método, caminho e status — nunca credenciais/token
    console.log(`[tuya-proxy] ${method} ${path} -> ${upstream.status}`);

    if (!text) return json({ ok: upstream.ok }, upstream.status);
    if (parsed !== null) return json(parsed, upstream.status);
    return json({ error: "Resposta não-JSON da Tuya", raw: text.slice(0, 500) }, upstream.status);
  } catch (err) {
    if (err instanceof UpstreamError) return json(err.body, err.status);
    console.error("[tuya-proxy] falha de rede upstream:", (err as Error)?.message ?? err);
    return json({ error: "Falha ao contatar a Tuya Cloud" }, 502);
  }
});
