// ============================================================
// NexusHome OS — histórico de telemetria por cômodo (v2.7)
// Módulo puro: agrupa leituras em faixas de tempo e desenha
// sparklines em SVG (o cartão do cômodo mostra as últimas 24 h).
// ============================================================

export const METRIC_INFO = {
  energy_watts:    { label: 'Energia',     unit: 'W',   color: '#f2b24a', digits: 0 },
  water_flow_lph:  { label: 'Água',        unit: 'L/h', color: '#5bc0eb', digits: 0 },
  temperature:     { label: 'Temperatura', unit: '°C',  color: '#fb923c', digits: 1 },
  humidity:        { label: 'Umidade',     unit: '%',   color: '#2dd4bf', digits: 0 },
  water_level_pct: { label: 'Nível',       unit: '%',   color: '#38bdf8', digits: 0 },
};

/**
 * Agrupa leituras ({ metric_type, value, created_at }) de uma métrica em
 * `buckets` faixas iguais entre `from` e `to` (ms). Faixa sem leitura = null.
 */
export function bucketSeries(rows, metric, from, to, buckets = 48) {
  const span = Math.max(1, to - from);
  const sum = new Array(buckets).fill(0);
  const cnt = new Array(buckets).fill(0);
  rows.forEach((r) => {
    if (r.metric_type !== metric) return;
    const t = Date.parse(r.created_at);
    const v = Number(r.value);
    if (!Number.isFinite(t) || !Number.isFinite(v) || t < from || t > to) return;
    const i = Math.min(buckets - 1, Math.floor(((t - from) / span) * buckets));
    sum[i] += v; cnt[i] += 1;
  });
  return sum.map((s, i) => (cnt[i] ? s / cnt[i] : null));
}

export function summarize(values) {
  const v = values.filter((x) => x != null && Number.isFinite(x));
  if (!v.length) return null;
  const min = Math.min(...v), max = Math.max(...v);
  return { min, max, avg: v.reduce((a, b) => a + b, 0) / v.length, last: v[v.length - 1], n: v.length };
}

/** Caminho SVG da série (faixas vazias são puladas: a linha liga as leituras vizinhas). */
export function sparkPath(values, w, h, pad = 2) {
  const s = summarize(values);
  if (!s) return '';
  const span = s.max - s.min || 1;
  const n = values.length;
  const x = (i) => pad + (n <= 1 ? 0 : (i / (n - 1)) * (w - pad * 2));
  const y = (v) => h - pad - ((v - s.min) / span) * (h - pad * 2);
  const pts = values.map((v, i) => (v == null ? null : [x(i), y(v)])).filter(Boolean);
  if (pts.length === 1) pts.push([w - pad, pts[0][1]]);   // uma leitura só: linha reta
  return pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`).join(' ');
}

/** Métricas presentes nas leituras (na ordem de METRIC_INFO). */
export function metricsIn(rows) {
  const set = new Set(rows.map((r) => r.metric_type));
  return Object.keys(METRIC_INFO).filter((m) => set.has(m));
}
