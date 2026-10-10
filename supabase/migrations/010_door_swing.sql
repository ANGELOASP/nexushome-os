-- ============================================================
-- NexusHome OS — 010_door_swing.sql
-- Sentido de abertura das portas (v2.3).
--   hinge  'start' | 'end'  ponta da parede (x1,z1 = start) onde fica a dobradiça
--   side   1 | -1           lado da parede para onde a folha abre (1 = normal (-dz, dx))
-- Execute DEPOIS de 009_openings.sql. Idempotente.
-- Sem esta migração o editor salva as portas sem o sentido e avisa.
-- ============================================================

alter table public.openings
  add column if not exists hinge text not null default 'start',
  add column if not exists side smallint not null default 1;

alter table public.openings drop constraint if exists openings_hinge_chk;
alter table public.openings add constraint openings_hinge_chk check (hinge in ('start', 'end'));
alter table public.openings drop constraint if exists openings_side_chk;
alter table public.openings add constraint openings_side_chk check (side in (-1, 1));
