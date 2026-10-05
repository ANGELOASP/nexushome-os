-- ============================================================
-- NexusHome OS — 003_rooms.sql
-- Editor de Planta: tabela `rooms` com a planta da residência
-- (cômodos retangulares: nome, posição, tamanho em metros, cor).
--
-- COMO USAR:
--   · Execute DEPOIS de 002_auth_rls.sql (SQL Editor → colar → Run).
--   · Posições/tamanhos em METROS; 1 célula da grade do editor = 0,5 m.
--     A cena 3D converte metros → unidades de cena (× 1.9), mantendo
--     paridade visual com o layout original fixo (cômodos de 5.7
--     unidades centrados em ±3.05 ≈ 3.0 m centrados em ±1.6 m).
--   · RLS segue o padrão da 002: apenas usuários autenticados;
--     a chave anon não lê nem escreve.
--   · O eixo z equivale ao "y para baixo" da planta 2D (frente da
--     casa = z positivo = parte de baixo do editor).
-- ============================================================

create table if not exists public.rooms (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null unique,
  pos_x       numeric not null default 0,
  pos_z       numeric not null default 0,
  size_x      numeric not null default 3.0,
  size_z      numeric not null default 3.0,
  color       text not null default '#818cf8',
  sort_order  int not null default 0,
  created_at  timestamptz not null default now()
);

-- ------------------------------------------------------------
-- RLS — somente usuários autenticados (mesmo padrão da 002)
-- ------------------------------------------------------------
alter table public.rooms enable row level security;

drop policy if exists "auth_all_rooms" on public.rooms;
create policy "auth_all_rooms"
  on public.rooms for all to authenticated
  using (true) with check (true);

-- ------------------------------------------------------------
-- REALTIME
-- ------------------------------------------------------------
alter publication supabase_realtime add table public.rooms;
-- Se falhar com "already member of publication", ignore: já publicada.

-- ------------------------------------------------------------
-- SEEDS — os 4 cômodos originais (paridade com o 3D antigo):
--   3.0 m × 3.0 m, centros em ±1.6 m  →  5.7 un. em ±3.04 na cena
--   (1 célula do editor = 0.5 m)
-- ------------------------------------------------------------
insert into public.rooms (id, name, pos_x, pos_z, size_x, size_z, color, sort_order) values
  ('c1111111-1111-4111-8111-111111111111', 'Sala de Estar',    -1.6,  1.6, 3.0, 3.0, '#818cf8', 1),
  ('c2222222-2222-4222-8222-222222222222', 'Quarto Principal', -1.6, -1.6, 3.0, 3.0, '#38bdf8', 2),
  ('c3333333-3333-4333-8333-333333333333', 'Cozinha',           1.6,  1.6, 3.0, 3.0, '#fbbf24', 3),
  ('c4444444-4444-4444-8444-444444444444', 'Área Externa',      1.6, -1.6, 3.0, 3.0, '#4ade80', 4)
on conflict (id) do nothing;
