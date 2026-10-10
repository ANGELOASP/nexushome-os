-- ============================================================
-- NexusHome OS — 012_wall_height.sql
-- Altura de cada parede (v2.4), em metros. Padrão 2,5 m; 0,3 a 3 m no editor
-- (valores baixos = muretas / guarda-corpos). Idempotente.
-- Sem esta migração o editor salva as paredes sem a altura e avisa.
-- ============================================================

alter table public.walls
  add column if not exists height numeric not null default 2.5;

alter table public.walls drop constraint if exists walls_height_chk;
alter table public.walls add constraint walls_height_chk check (height > 0 and height <= 6);

notify pgrst, 'reload schema';
