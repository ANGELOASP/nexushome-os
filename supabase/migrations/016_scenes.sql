-- ============================================================
-- NexusHome OS — 016_scenes.sql
-- Cenas (v2.7): um botão aciona vários dispositivos de uma vez
-- ("Cinema", "Dormir", "Sair de casa"...).
--   room     cômodo da cena (nulo = casa toda)
--   actions  [{ "device_id": uuid, "patch": { "on": true, "brightness": 20 } }]
-- Executar uma cena grava o status de cada dispositivo; válvulas viram
-- comando para o ESP32 pela migração 013, como no botão do app.
-- Execute DEPOIS de 015_device_positions.sql. Idempotente.
-- ============================================================

create table if not exists public.scenes (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  icon        text not null default 'spark',
  room        text,
  actions     jsonb not null default '[]'::jsonb,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

alter table public.scenes enable row level security;
drop policy if exists "scenes_select_auth" on public.scenes;
drop policy if exists "scenes_insert_auth" on public.scenes;
drop policy if exists "scenes_update_auth" on public.scenes;
drop policy if exists "scenes_delete_auth" on public.scenes;
create policy "scenes_select_auth" on public.scenes for select to authenticated using (true);
create policy "scenes_insert_auth" on public.scenes for insert to authenticated with check (true);
create policy "scenes_update_auth" on public.scenes for update to authenticated using (true) with check (true);
create policy "scenes_delete_auth" on public.scenes for delete to authenticated using (true);

do $$
begin
  alter publication supabase_realtime add table public.scenes;
exception when duplicate_object or undefined_object then null;
end $$;

notify pgrst, 'reload schema';
