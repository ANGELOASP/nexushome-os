// Lógica pura do notify-alert (testável com `npm test`, sem Deno).

export interface AlertRecord {
  id?: string;
  severity?: string;
  message?: string;
  source_module?: string;
  created_at?: string;
}

const RANK: Record<string, number> = { info: 0, warning: 1, critical: 2 };
const ICON: Record<string, string> = { critical: "🚨", warning: "⚠️", info: "ℹ️" };
const LABEL: Record<string, string> = { critical: "CRÍTICO", warning: "ATENÇÃO", info: "INFO" };

/** Deve notificar? `minSeverity` padrão = critical (info/warning ficam só no app). */
export function shouldNotify(severity: string | undefined, minSeverity = "critical"): boolean {
  const s = RANK[severity ?? ""];
  const min = RANK[minSeverity] ?? RANK.critical;
  return s !== undefined && s >= min;
}

/** Escapa o texto para o parse_mode HTML do Telegram. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatMessage(a: AlertRecord): string {
  const sev = a.severity ?? "info";
  const src = a.source_module ? ` · ${escapeHtml(a.source_module)}` : "";
  return `${ICON[sev] ?? "ℹ️"} <b>NexusHome — ${LABEL[sev] ?? "INFO"}</b>${src}\n${escapeHtml(a.message ?? "(sem mensagem)")}`;
}

/** Comparação em tempo (quase) constante para o segredo do webhook. */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}
