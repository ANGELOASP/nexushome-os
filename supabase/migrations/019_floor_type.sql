-- ============================================================
-- NexusHome OS — 019_floor_type.sql
-- Tipo de piso por cômodo (v2.8): madeira, porcelanato, mármore,
-- cimento queimado, grama... (catálogo em js/floors.js).
-- Nulo = automático (o piso padrão do tipo de cômodo).
-- Execute DEPOIS de 018 (ou de 017, se não usar o isolamento). Idempotente.
-- ============================================================

alter table public.rooms add column if not exists floor_type text;

notify pgrst, 'reload schema';
