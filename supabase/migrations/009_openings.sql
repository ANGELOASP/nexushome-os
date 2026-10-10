-- ============================================================
-- NexusHome OS — 009_openings.sql
-- Portas e janelas (v2.2): cada abertura pertence a uma parede.
--
--   offset_m  distância do CENTRO da abertura até o início da parede (x1,z1), em metros
--   width     largura do vão (m)
--   height    altura do vão (m)
--   sill      altura do peitoril (m): 0 para porta, ~1,0 para janela
--
-- Excluir a parede apaga suas aberturas (on delete cascade).
-- Execute DEPOIS de 008_room_polygons.sql. Idempotente.
-- Sem esta migração o editor salva a planta normalmente e avisa que as aberturas não foram gravadas.
-- ============================================================

create table if not exists public.openings (
  id uuid primary key,
  wall_id uuid not null references public.walls(id) on delete cascade,
  kind text not null default 'door' check (kind in ('door', 'window')),
  offset_m numeric not null,
  width numeric not null default 0.9 check (width > 0 and width <= 6),
  height numeric not null default 2.1 check (height > 0 and height <= 4),
  sill numeric not null default 0 check (sill >= 0 and sill <= 3),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists openings_wall_idx on public.openings (wall_id);

alter table public.openings enable row level security;

drop policy if exists "openings_select_auth" on public.openings;
drop policy if exists "openings_insert_auth" on public.openings;
drop policy if exists "openings_update_auth" on public.openings;
drop policy if exists "openings_delete_auth" on public.openings;
create policy "openings_select_auth" on public.openings for select to authenticated using (true);
create policy "openings_insert_auth" on public.openings for insert to authenticated with check (true);
create policy "openings_update_auth" on public.openings for update to authenticated using (true) with check (true);
create policy "openings_delete_auth" on public.openings for delete to authenticated using (true);

do $$
begin
  alter publication supabase_realtime add table public.openings;
exception when duplicate_object then null;
end $$;
