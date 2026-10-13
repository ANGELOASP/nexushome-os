-- ============================================================
-- NexusHome OS — 020_device_pins.sql
-- Posição na planta dos dispositivos INTEGRADOS (v2.8): aparelhos Samsung
-- SmartThings ("st-…") e Tuya ("tuya-…") não são linhas da tabela devices,
-- então o ponto deles no Editor de Planta fica aqui (os nativos usam as
-- colunas pos_x/pos_z/pos_floor de devices — migração 015).
-- Execute DEPOIS de 019_floor_type.sql. Idempotente.
-- ============================================================

create table if not exists public.device_pins (
  device_id   text primary key,
  pos_x       numeric,
  pos_z       numeric,
  pos_floor   integer,
  updated_at  timestamptz not null default now()
);

alter table public.device_pins enable row level security;
drop policy if exists "device_pins_auth" on public.device_pins;
create policy "device_pins_auth" on public.device_pins for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
