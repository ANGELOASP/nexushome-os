// Lógica pura do iot-gateway (testável com `npm test`, sem Deno).

const MAX_PAST_MS = 7 * 24 * 3600 * 1000;   // fila offline do ESP32: aceita até 7 dias de atraso
const MAX_FUTURE_MS = 5 * 60 * 1000;        // relógio do aparelho adiantado até 5 min

/**
 * Horário de uma leitura reenviada (`ts`: ISO 8601 ou epoch em s/ms).
 * Retorna o ISO normalizado, ou null se ausente/inválido/fora da janela
 * (nesse caso a leitura fica com o horário do servidor).
 */
export function parseReadingTs(ts: unknown, nowMs = Date.now()): string | null {
  if (ts === undefined || ts === null || ts === "") return null;
  let ms: number;
  if (typeof ts === "number" || (typeof ts === "string" && /^\d+(\.\d+)?$/.test(ts))) {
    const n = Number(ts);
    ms = n < 1e12 ? n * 1000 : n;           // epoch em segundos ou milissegundos
  } else if (typeof ts === "string") {
    ms = Date.parse(ts);
  } else {
    return null;
  }
  if (!Number.isFinite(ms)) return null;
  if (ms > nowMs + MAX_FUTURE_MS || ms < nowMs - MAX_PAST_MS) return null;
  return new Date(ms).toISOString();
}
