-- ============================================================
-- NexusHome OS — 004_rooms_floor_kind.sql
-- Editor de Planta 2.0 (v1.6.0): ANDARES + TIPO DE CÔMODO.
--
--   · floor int  → andar do cômodo (0 = térreo, 1 = 1º andar…)
--   · kind  text → tipo do cômodo (presets do editor: sala_estar,
--     quarto, suite, cozinha, garagem…), orienta o mobiliário 3D
--
-- COMO USAR:
--   · Execute DEPOIS de 003_rooms.sql (SQL Editor → colar → Run).
--   · Idempotente: usa add column if not exists — pode reexecutar.
--   · O backfill classifica os 4 cômodos seed da 003 pelos nomes.
--   · Plantas antigas ganham floor 0 / kind 'personalizado' por
--     default; o app também infere o kind pelo nome ao carregar.
-- ============================================================

alter table public.rooms add column if not exists floor int not null default 0;
alter table public.rooms add column if not exists kind  text not null default 'personalizado';

-- ------------------------------------------------------------
-- Backfill dos 4 cômodos seed (criados pela 003_rooms.sql)
-- ------------------------------------------------------------
update public.rooms set kind = 'sala_estar'   where name = 'Sala de Estar';
update public.rooms set kind = 'quarto'       where name = 'Quarto Principal';
update public.rooms set kind = 'cozinha'      where name = 'Cozinha';
update public.rooms set kind = 'area_externa' where name = 'Área Externa';
