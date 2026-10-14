// Lógica pura do envio EM LOTE do iot-gateway (v2.11), testável com `npm test`.
//
// POST /iot-gateway  { "readings": [ item, item, ... ] }   (até MAX_BATCH itens)
//   item = { device_id, metric_type?, value?, status?, ts?, replayed? }
//   · com metric_type + value → vira uma linha em telemetry_logs (histórico/gráficos/automações)
//   · com status              → atualiza devices.status (painel ao vivo), sem linha de histórico
// O ESP32 elétrico manda o estado dos 33 circuitos a cada 15 s num único POST (uma
// conexão TLS em vez de 33) e só grava histórico de tempos em tempos.

import { parseReadingTs } from "./ts.ts";

export const ALLOWED_METRICS = new Set(["energy_watts", "water_flow_lph", "temperature", "humidity", "water_level_pct"]);  // water_level_pct: migração 005
export const MAX_BATCH = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TelemetryRow = { device_id: string; metric_type: string; value: number; created_at?: string };
export type StatusPatch = { device_id: string; status: Record<string, unknown> };

/**
 * Separa o lote em linhas de telemetria e patches de status.
 * Itens inválidos não derrubam o lote: entram em `errors` (índice + motivo).
 */
export function splitBatch(readings: unknown, nowMs = Date.now()) {
  const rows: TelemetryRow[] = [];
  const statuses: StatusPatch[] = [];
  const errors: { index: number; error: string }[] = [];
  if (!Array.isArray(readings)) return { rows, statuses, errors: [{ index: -1, error: "readings deve ser uma lista" }] };
  if (readings.length > MAX_BATCH) return { rows, statuses, errors: [{ index: -1, error: `no máximo ${MAX_BATCH} itens por lote` }] };

  readings.forEach((r, index) => {
    if (!r || typeof r !== "object") { errors.push({ index, error: "item inválido" }); return; }
    const it = r as Record<string, unknown>;
    const deviceId = String(it.device_id ?? "");
    if (!UUID.test(deviceId)) { errors.push({ index, error: "device_id inválido" }); return; }

    const hasMetric = it.metric_type !== undefined && it.metric_type !== null;
    const hasStatus = !!it.status && typeof it.status === "object" && !Array.isArray(it.status);
    if (!hasMetric && !hasStatus) { errors.push({ index, error: "informe metric_type/value e/ou status" }); return; }

    if (hasMetric) {
      const metric = String(it.metric_type);
      const value = Number(it.value);
      if (!ALLOWED_METRICS.has(metric)) { errors.push({ index, error: `metric_type inválido: ${metric}` }); return; }
      if (it.value === null || it.value === undefined || it.value === "" || !Number.isFinite(value)) {
        errors.push({ index, error: "value deve ser numérico" }); return;
      }
      const createdAt = parseReadingTs(it.ts, nowMs);
      rows.push({ device_id: deviceId, metric_type: metric, value, ...(createdAt ? { created_at: createdAt } : {}) });
    }
    // leitura reenviada da fila offline: só histórico (o status atual não volta no tempo)
    if (hasStatus && it.replayed !== true) statuses.push({ device_id: deviceId, status: it.status as Record<string, unknown> });
  });

  // vários patches do mesmo aparelho no lote: mescla na ordem (o último vence)
  const merged = new Map<string, Record<string, unknown>>();
  for (const s of statuses) merged.set(s.device_id, { ...(merged.get(s.device_id) ?? {}), ...s.status });
  return { rows, statuses: [...merged].map(([device_id, status]) => ({ device_id, status })), errors };
}

export type AlertRow = { severity: "info" | "warning" | "critical"; message: string; source_module: string };
export const MAX_ALERTS = 10;
const SEVERITIES = new Set(["info", "warning", "critical"]);

/**
 * Alertas que o firmware levanta (ex.: circuito desarmado por sobrecarga) — vão para a
 * tabela alerts; os críticos geram push no celular (notify-alert). Inválidos são ignorados.
 */
export function parseAlerts(alerts: unknown, source = "eletrica"): AlertRow[] {
  if (!Array.isArray(alerts)) return [];
  return alerts.slice(0, MAX_ALERTS).flatMap((a) => {
    if (!a || typeof a !== "object") return [];
    const it = a as Record<string, unknown>;
    const severity = String(it.severity ?? "");
    const message = String(it.message ?? "").trim().slice(0, 300);
    if (!SEVERITIES.has(severity) || !message) return [];
    return [{ severity: severity as AlertRow["severity"], message, source_module: source }];
  });
}
