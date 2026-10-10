-- ============================================================
-- NexusHome OS — 011_openings_repair.sql
-- Repara a tabela openings quando o salvar acusa
--   "Could not find the '<coluna>' column of 'openings' in the schema cache".
-- Garante todas as colunas e recarrega o cache de esquema da API (PostgREST).
-- Idempotente. Pode rodar quantas vezes precisar.
-- ============================================================

alter table public.openings
  add column if not exists kind text not null default 'door',
  add column if not exists offset_m numeric not null default 0,
  add column if not exists width numeric not null default 0.9,
  add column if not exists height numeric not null default 2.1,
  add column if not exists sill numeric not null default 0,
  add column if not exists sort_order integer not null default 0,
  add column if not exists hinge text not null default 'start',
  add column if not exists side smallint not null default 1;

notify pgrst, 'reload schema';
