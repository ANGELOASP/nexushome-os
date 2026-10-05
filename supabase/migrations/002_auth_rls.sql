-- ============================================================
-- NexusHome OS — 002_auth_rls.sql
-- Endurecimento de segurança: RLS apenas para usuários
-- AUTENTICADOS (Supabase Auth com e-mail/senha).
--
-- COMO USAR:
--   · Execute DEPOIS de 001_init.sql (SQL Editor → colar → Run).
--   · Esta migração REVOGA o acesso anônimo: a chave anon
--     passa a não ler nem escrever nas 4 tabelas sem login.
--   · O app continua funcionando normalmente após o login,
--     pois o supabase-js envia o JWT do usuário autenticado
--     (role "authenticated") em todas as chamadas e canais
--     realtime.
--   · A Edge Function iot-gateway usa a SERVICE_ROLE KEY,
--     que IGNORA o RLS por design — a ingestão de telemetria
--     do ESP32 continua funcionando sem alterações. Essa chave
--     NUNCA deve aparecer no frontend.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Remove as políticas públicas permissivas da 001
-- ------------------------------------------------------------
drop policy if exists "public_all_devices"     on public.devices;
drop policy if exists "public_all_automations" on public.automations;
drop policy if exists "public_all_telemetry"   on public.telemetry_logs;
drop policy if exists "public_all_alerts"      on public.alerts;

-- ------------------------------------------------------------
-- 2) Políticas somente para usuários autenticados
--    (for all = SELECT + INSERT + UPDATE + DELETE)
-- ------------------------------------------------------------
drop policy if exists "auth_all_devices"     on public.devices;
drop policy if exists "auth_all_automations" on public.automations;
drop policy if exists "auth_all_telemetry"   on public.telemetry_logs;
drop policy if exists "auth_all_alerts"      on public.alerts;

create policy "auth_all_devices"
  on public.devices for all to authenticated
  using (true) with check (true);

create policy "auth_all_automations"
  on public.automations for all to authenticated
  using (true) with check (true);

create policy "auth_all_telemetry"
  on public.telemetry_logs for all to authenticated
  using (true) with check (true);

create policy "auth_all_alerts"
  on public.alerts for all to authenticated
  using (true) with check (true);
