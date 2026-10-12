-- ============================================================
-- NexusHome OS — seeds/hidraulica.sql
-- Dispositivos da automação hidráulica (ESP32-S3 / Modbus RTU).
-- Os UUIDs são FIXOS e já estão no firmware
-- (firmware/esp32s3_hidraulica/esp32s3_hidraulica.ino): rode este script e
-- não é preciso copiar nenhum código.
-- Idempotente: rodar de novo não duplica nada.
-- Os cômodos ("room") seguem o memorial; se na sua planta o nome for outro,
-- use o menu ⋯ do dispositivo no app → "Mover de cômodo".
-- ============================================================

insert into public.devices (id, name, type, room, status, is_online) values
  ('b1000000-0000-4000-8000-000000000001', 'Água — Ramal 1 (Cozinha)',        'valve',  'Cozinha',          '{"open": true}', false),
  ('b1000000-0000-4000-8000-000000000002', 'Água — Ramal 2 (Banheiro 1)',     'valve',  'Banheiro 1',       '{"open": true}', false),
  ('b1000000-0000-4000-8000-000000000003', 'Água — Ramal 3 (Banheiro 2)',     'valve',  'Banheiro 2',       '{"open": true}', false),
  ('b1000000-0000-4000-8000-000000000004', 'Água — Ramal 4 (Área de Serviço)','valve',  'Área de Serviço',  '{"open": true}', false),
  ('b1000000-0000-4000-8000-000000000005', 'Água — Ramal 5',                  'valve',  'Laje',             '{"open": true}', false),
  ('b1000000-0000-4000-8000-000000000006', 'Água — Ramal 6',                  'valve',  'Laje',             '{"open": true}', false),
  ('b1000000-0000-4000-8000-000000000007', 'Água — Área Externa',             'valve',  'Área Externa',     '{"open": true}', false),
  ('b1000000-0000-4000-8000-000000000008', 'Reservatórios (2 × 500 L)',       'sensor', 'Laje',             '{}',                false)
on conflict (id) do nothing;

-- A válvula geral de emergência usa o dispositivo que já existe:
--   a3333333-3333-4333-8333-333333333333  "Válvula de Água Geral"

-- conferência
select id, name, type, room from public.devices where id::text like 'b1000000-%' order by id;
