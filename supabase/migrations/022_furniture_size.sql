-- ============================================================
-- NexusHome OS — 022_furniture_size.sql
-- Tamanho personalizado de cada móvel (v2.10): o editor de planta
-- permite aumentar/diminuir o móvel. Medidas em METROS; null = medida
-- padrão do catálogo (js/furniture.js).
--   w  largura      d  profundidade      h  altura
-- Execute DEPOIS de 014_furniture.sql. Idempotente.
-- ============================================================

alter table public.furniture add column if not exists w numeric check (w is null or (w > 0 and w <= 8));
alter table public.furniture add column if not exists d numeric check (d is null or (d > 0 and d <= 8));
alter table public.furniture add column if not exists h numeric check (h is null or (h > 0 and h <= 8));

notify pgrst, 'reload schema';
