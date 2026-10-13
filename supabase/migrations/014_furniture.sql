-- ============================================================
-- NexusHome OS — 014_furniture.sql
-- Layout de móveis do usuário (v2.6): cada móvel é um item do catálogo
-- (js/furniture.js) posicionado na planta.
--   kind   tipo do catálogo (sofa, cama_casal, geladeira, ...)
--   x, z   centro do móvel em metros (mesmo sistema das paredes)
--   rot    rotação em graus (0–359), sentido horário visto de cima
-- Cômodos com móveis próprios deixam de receber a mobília automática na cena 3D.
-- Execute DEPOIS de 013_device_commands.sql. Idempotente.
-- ============================================================

create table if not exists public.furniture (
  id          uuid primary key,
  floor       integer not null default 0,
  kind        text not null,
  x           numeric not null,
  z           numeric not null,
  rot         numeric not null default 0 check (rot >= 0 and rot < 360),
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

alter table public.furniture enable row level security;
drop policy if exists "furniture_select_auth" on public.furniture;
drop policy if exists "furniture_insert_auth" on public.furniture;
drop policy if exists "furniture_update_auth" on public.furniture;
drop policy if exists "furniture_delete_auth" on public.furniture;
create policy "furniture_select_auth" on public.furniture for select to authenticated using (true);
create policy "furniture_insert_auth" on public.furniture for insert to authenticated with check (true);
create policy "furniture_update_auth" on public.furniture for update to authenticated using (true) with check (true);
create policy "furniture_delete_auth" on public.furniture for delete to authenticated using (true);

do $$
begin
  alter publication supabase_realtime add table public.furniture;
exception when duplicate_object or undefined_object then null;
end $$;

notify pgrst, 'reload schema';
