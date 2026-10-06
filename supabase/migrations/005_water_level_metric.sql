-- ============================================================
-- NexusHome OS — 005_water_level_metric.sql
-- Integração Tuya Smart Life (v1.7.0): NÍVEL DA CAIXA D'ÁGUA.
--
--   · Amplia o CHECK de telemetry_logs.metric_type para aceitar
--     'water_level_pct' (percentual 0–100 reportado pelos
--     monitores ultrassônicos ME201W via painel Tuya).
--
-- COMO USAR:
--   · Execute DEPOIS de 004_rooms_floor_kind.sql (SQL Editor →
--     colar → Run).
--   · Idempotente: drop constraint if exists + recriação.
--   · O nome do constraint (telemetry_logs_metric_type_check) é
--     o padrão gerado pelo Postgres para o CHECK inline da 001.
-- ============================================================

alter table public.telemetry_logs
  drop constraint if exists telemetry_logs_metric_type_check;

alter table public.telemetry_logs
  add constraint telemetry_logs_metric_type_check
  check (metric_type in ('energy_watts', 'water_flow_lph', 'temperature', 'humidity', 'water_level_pct'));
