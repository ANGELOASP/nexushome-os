-- ============================================================
-- NexusHome OS — 021_device_catalog.sql
-- Biblioteca de dispositivos (v2.9):
--   · amplia os tipos aceitos em devices.type (TV, tomada, fechadura,
--     câmera, cortina, ventilador, alto-falante...) — o cadastro de
--     "TV" falhava com devices_type_check;
--   · model     modelo da biblioteca (js/device-catalog.js): split, smart_tv, plafon...
--   · pos_y     altura de fixação em metros (ar acima da janela, TV no painel)
--   · pos_rot   giro em graus (fixado na parede: virado para dentro do cômodo)
--   · os mesmos campos para os integrados em device_pins (migração 020).
-- Execute DEPOIS de 020_device_pins.sql. Idempotente.
-- ============================================================

alter table public.devices drop constraint if exists devices_type_check;
alter table public.devices add constraint devices_type_check check (type in (
  'light', 'ac', 'sensor', 'valve', 'solar', 'meter',
  'tv', 'plug', 'switch', 'lock', 'camera', 'curtain', 'fan', 'speaker', 'hub'
));

alter table public.devices add column if not exists model text;
alter table public.devices add column if not exists pos_y numeric;
alter table public.devices add column if not exists pos_rot numeric;

do $$
begin
  if to_regclass('public.device_pins') is not null then
    alter table public.device_pins add column if not exists model text;
    alter table public.device_pins add column if not exists pos_y numeric;
    alter table public.device_pins add column if not exists pos_rot numeric;
  end if;
end $$;

notify pgrst, 'reload schema';
