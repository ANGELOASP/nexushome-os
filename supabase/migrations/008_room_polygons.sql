-- ============================================================
-- NexusHome OS — 008_room_polygons.sql
-- Cômodos poligonais (v2.0): coluna `points` (jsonb) em rooms.
--
--   · NULL  → cômodo retangular (pos_x/pos_z + size_x/size_z), como antes.
--   · array → polígono: [[x,z], ...] em METROS, RELATIVO ao centro
--             da caixa (pos_x/pos_z). size_x/size_z guardam a caixa
--             envolvente (usada pela cena 3D, rótulos e dispositivos).
--
-- Execute DEPOIS de 007_server_automations.sql. Idempotente.
-- Sem esta migração, salvar um cômodo poligonal falha com "column does not exist"
-- (o editor avisa e salva como retângulo).
-- ============================================================

alter table public.rooms
  add column if not exists points jsonb;

alter table public.rooms
  drop constraint if exists rooms_points_is_array;
alter table public.rooms
  add constraint rooms_points_is_array
  check (points is null or (jsonb_typeof(points) = 'array' and jsonb_array_length(points) between 3 and 500));
