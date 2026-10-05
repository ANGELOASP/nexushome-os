-- ============================================================
-- NexusHome OS — 001_init.sql
-- Esquema completo: tabelas, constraints, RLS (políticas
-- públicas permissivas), realtime e dados de exemplo (pt-BR).
--
-- Como usar: Supabase Dashboard → SQL Editor → colar e Run.
-- ============================================================

create extension if not exists "pgcrypto";

-- ------------------------------------------------------------
-- 1) DISPOSITIVOS
-- ------------------------------------------------------------
create table if not exists public.devices (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  type        text not null check (type in ('light', 'ac', 'sensor', 'valve', 'solar', 'meter')),
  room        text not null,
  status      jsonb not null default '{}'::jsonb,
  is_online   boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 2) AUTOMAÇÕES (regras IFTTT)
--    trigger_condition: {"metric":"energy_watts","operator":">","threshold":3000}
--    action_payload:    {"device_id":"<uuid>","action":"power","value":false}
-- ------------------------------------------------------------
create table if not exists public.automations (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  trigger_condition jsonb not null,
  action_payload    jsonb not null,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 3) TELEMETRIA
-- ------------------------------------------------------------
create table if not exists public.telemetry_logs (
  id          uuid primary key default gen_random_uuid(),
  device_id   uuid not null references public.devices (id) on delete cascade,
  metric_type text not null check (metric_type in ('energy_watts', 'water_flow_lph', 'temperature', 'humidity')),
  value       numeric not null,
  created_at  timestamptz not null default now()
);

create index if not exists telemetry_logs_created_at_idx on public.telemetry_logs (created_at desc);
create index if not exists telemetry_logs_device_idx      on public.telemetry_logs (device_id, created_at desc);

-- ------------------------------------------------------------
-- 4) ALERTAS
-- ------------------------------------------------------------
create table if not exists public.alerts (
  id            uuid primary key default gen_random_uuid(),
  severity      text not null check (severity in ('info', 'warning', 'critical')),
  message       text not null,
  source_module text not null default 'sistema',
  resolved      boolean not null default false,
  created_at    timestamptz not null default now()
);

create index if not exists alerts_created_at_idx on public.alerts (created_at desc);

-- ------------------------------------------------------------
-- 5) ROW LEVEL SECURITY — políticas públicas permissivas
--    (projeto demonstrativo sem autenticação; para produção,
--     substitua por políticas baseadas em auth.uid())
-- ------------------------------------------------------------
alter table public.devices        enable row level security;
alter table public.automations    enable row level security;
alter table public.telemetry_logs enable row level security;
alter table public.alerts         enable row level security;

drop policy if exists "public_all_devices"     on public.devices;
drop policy if exists "public_all_automations" on public.automations;
drop policy if exists "public_all_telemetry"   on public.telemetry_logs;
drop policy if exists "public_all_alerts"      on public.alerts;

create policy "public_all_devices"     on public.devices        for all to anon, authenticated using (true) with check (true);
create policy "public_all_automations" on public.automations    for all to anon, authenticated using (true) with check (true);
create policy "public_all_telemetry"   on public.telemetry_logs for all to anon, authenticated using (true) with check (true);
create policy "public_all_alerts"      on public.alerts         for all to anon, authenticated using (true) with check (true);

-- ------------------------------------------------------------
-- 6) REALTIME — publica alterações de devices/alerts/telemetry
-- ------------------------------------------------------------
alter publication supabase_realtime add table public.devices;
alter publication supabase_realtime add table public.alerts;
alter publication supabase_realtime add table public.telemetry_logs;
-- Se a linha acima falhar com "already member of publication", ignore:
-- a tabela já está publicada.

-- ------------------------------------------------------------
-- 7) SEEDS — 4 dispositivos (nomes em pt-BR)
--    Os UUIDs são fixos e iguais aos do Modo Demonstração,
--    para que a experiência seja idêntica nos dois modos.
-- ------------------------------------------------------------
insert into public.devices (id, name, type, room, status, is_online) values
  ('a1111111-1111-4111-8111-111111111111', 'Luz da Sala',           'light', 'Sala de Estar',    '{"on": false, "brightness": 70, "color": "#ffd9a0"}', true),
  ('a2222222-2222-4222-8222-222222222222', 'Ar-Condicionado',       'ac',    'Quarto Principal', '{"on": false, "temp": 23}',                            true),
  ('a3333333-3333-4333-8333-333333333333', 'Válvula de Água Geral', 'valve', 'Área Externa',     '{"open": true}',                                        true),
  ('a4444444-4444-4444-8444-444444444444', 'Medidor de Energia',    'meter', 'Cozinha',          '{"watts": 0}',                                         true)
on conflict (id) do nothing;

-- Automações de exemplo (desativadas por padrão)
insert into public.automations (id, name, trigger_condition, action_payload, is_active) values
  ('b1111111-1111-4111-8111-111111111111', 'Desligar AC em pico de energia',
    '{"metric": "energy_watts", "operator": ">", "threshold": 3000}',
    '{"device_id": "a2222222-2222-4222-8222-222222222222", "action": "power", "value": false}', false),
  ('b2222222-2222-4222-8222-222222222222', 'Fechar água com vazamento prolongado',
    '{"metric": "water_flow_lph", "operator": ">", "threshold": 50}',
    '{"device_id": "a3333333-3333-4333-8333-333333333333", "action": "valve", "value": false}', false)
on conflict (id) do nothing;
