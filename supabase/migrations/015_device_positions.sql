-- ============================================================
-- NexusHome OS — 015_device_positions.sql
-- Dispositivos posicionados na planta (v2.7): o ponto exato de cada
-- luz, AC, válvula etc. vira um marcador clicável na cena 3D.
--   pos_x, pos_z  ponto em metros (mesmo sistema das paredes e móveis)
--   pos_floor     andar do marcador (0 = térreo)
-- Nulos = dispositivo ainda não posicionado (continua só na lista).
-- Execute DEPOIS de 014_furniture.sql. Idempotente.
-- ============================================================

alter table public.devices add column if not exists pos_x numeric;
alter table public.devices add column if not exists pos_z numeric;
alter table public.devices add column if not exists pos_floor integer;

notify pgrst, 'reload schema';
