-- ============================================================
-- NexusHome OS — migração 006: paredes da planta (walls)
-- ------------------------------------------------------------
-- Modelo vetorial estilo CAD: cada parede é um segmento de
-- linha de centro (x1,z1)→(x2,z2) com espessura th (m).
-- ============================================================

create table if not exists walls (
  id uuid primary key,
  floor integer not null default 0,
  x1 numeric not null,
  z1 numeric not null,
  x2 numeric not null,
  z2 numeric not null,
  th numeric not null default 0.15,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

alter table walls enable row level security;

create policy "walls_select_auth" on walls
  for select to authenticated using (true);
create policy "walls_insert_auth" on walls
  for insert to authenticated with check (true);
create policy "walls_update_auth" on walls
  for update to authenticated using (true) with check (true);
create policy "walls_delete_auth" on walls
  for delete to authenticated using (true);

alter publication supabase_realtime add table walls;
