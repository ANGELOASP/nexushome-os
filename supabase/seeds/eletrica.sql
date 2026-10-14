-- ============================================================
-- NexusHome OS — seeds/eletrica.sql
-- Circuitos da automação elétrica (ESP32-S3 / Modbus RTU / PZEM-016).
-- Os UUIDs são FIXOS e já estão no firmware
-- (firmware/esp32s3_eletrica/esp32s3_eletrica.ino): rode este script e
-- não é preciso copiar nenhum código.
--
-- ⚠ PROVISÓRIO: o memorial não traz o quadro de cargas. Nomes, cômodos,
--   canais e disjuntores seguem a distribuição dos subquadros do memorial
--   (10 + 5 + 18 medidores). Ajuste no firmware (tabela CIRCUITS) e aqui,
--   ou renomeie/mova pelo app (menu ⋯ do dispositivo).
-- Precisa da migração 023 (coluna hw). Idempotente: rodar de novo não duplica.
-- ============================================================

insert into public.devices (id, name, type, model, room, status, is_online, hw) values
  ('b2000000-0000-4000-8000-000000000000', 'Quadro elétrico — consumo total', 'meter', 'meter', 'Lavanderia', '{"in_total": false}', false, 'esp32-eletrica'),
  ('b2000000-0000-4000-8000-000000000001', 'Chuveiro — Banheiro 1', 'meter', 'meter', 'Banheiro 1', '{"on": true, "in_total": true}', false, 'esp32-eletrica'),  -- PZEM 7 · relé 5/1 · 40 A · Íntimo
  ('b2000000-0000-4000-8000-000000000002', 'Chuveiro — Banheiro 2', 'meter', 'meter', 'Banheiro 2', '{"on": true, "in_total": true}', false, 'esp32-eletrica'),  -- PZEM 8 · relé 5/2 · 40 A · Íntimo
  ('b2000000-0000-4000-8000-000000000003', 'Ar-condicionado — Quarto Principal', 'meter', 'meter', 'Quarto Principal', '{"on": true, "in_total": true}', false, 'esp32-eletrica'),  -- PZEM 9 · relé 5/3 · 16 A · Íntimo
  ('b2000000-0000-4000-8000-000000000004', 'Ar-condicionado — Quarto 2', 'meter', 'meter', 'Quarto 2', '{"on": true, "in_total": true}', false, 'esp32-eletrica'),  -- PZEM 10 · relé 5/4 · 16 A · Íntimo
  ('b2000000-0000-4000-8000-000000000005', 'Ar-condicionado — Quarto 3 (Home Office)', 'meter', 'meter', 'Quarto 3', '{"on": true, "in_total": true}', false, 'esp32-eletrica'),  -- PZEM 11 · relé 5/5 · 16 A · Íntimo
  ('b2000000-0000-4000-8000-000000000006', 'Tomadas 10 A — Quarto Principal', 'meter', 'meter', 'Quarto Principal', '{"on": true, "in_total": true}', false, 'esp32-eletrica'),  -- PZEM 12 · relé 5/6 · 16 A · Íntimo
  ('b2000000-0000-4000-8000-000000000007', 'Tomadas 10 A — Quartos 2 e 3', 'meter', 'meter', 'Quarto 2', '{"on": true, "in_total": true}', false, 'esp32-eletrica'),  -- PZEM 13 · relé 5/7 · 16 A · Íntimo
  ('b2000000-0000-4000-8000-000000000008', 'Tomadas 10 A — Banheiros', 'meter', 'meter', 'Banheiro 1', '{"on": true, "in_total": true}', false, 'esp32-eletrica'),  -- PZEM 14 · relé 5/8 · 16 A · Íntimo
  ('b2000000-0000-4000-8000-000000000009', 'Iluminação — Quartos', 'meter', 'meter', 'Quarto Principal', '{"in_total": true}', false, 'esp32-eletrica'),  -- PZEM 15 · sem relé · 10 A · Íntimo
  ('b2000000-0000-4000-8000-000000000010', 'Iluminação — Banheiros e Corredor', 'meter', 'meter', 'Banheiro 2', '{"in_total": true}', false, 'esp32-eletrica'),  -- PZEM 16 · sem relé · 10 A · Íntimo
  ('b2000000-0000-4000-8000-000000000011', 'Tomadas 10 A — Sala de Estar', 'meter', 'meter', 'Sala de Estar', '{"on": true, "in_total": true}', false, 'esp32-eletrica'),  -- PZEM 17 · relé 6/1 · 16 A · Social
  ('b2000000-0000-4000-8000-000000000012', 'Tomadas 10 A — Sala de TV', 'meter', 'meter', 'Sala de TV', '{"on": true, "in_total": true}', false, 'esp32-eletrica'),  -- PZEM 18 · relé 6/2 · 16 A · Social
  ('b2000000-0000-4000-8000-000000000013', 'Tomadas 10 A — Copa', 'meter', 'meter', 'Cozinha', '{"on": true, "in_total": true}', false, 'esp32-eletrica'),  -- PZEM 19 · relé 6/3 · 16 A · Social
  ('b2000000-0000-4000-8000-000000000014', 'Iluminação — Salas', 'meter', 'meter', 'Sala de Estar', '{"in_total": true}', false, 'esp32-eletrica'),  -- PZEM 20 · sem relé · 10 A · Social
  ('b2000000-0000-4000-8000-000000000015', 'Iluminação — Copa e Corredor Social', 'meter', 'meter', 'Sala de TV', '{"in_total": true}', false, 'esp32-eletrica'),  -- PZEM 21 · sem relé · 10 A · Social
  ('b2000000-0000-4000-8000-000000000016', 'Tomadas 20 A — Cozinha (forno/micro-ondas)', 'meter', 'meter', 'Cozinha', '{"on": true, "in_total": true}', false, 'esp32-eletrica'),  -- PZEM 23 · relé 22/1 · 25 A · Serviços
  ('b2000000-0000-4000-8000-000000000017', 'Tomadas 10 A — Cozinha (bancada)', 'meter', 'meter', 'Cozinha', '{"on": true, "in_total": true}', false, 'esp32-eletrica'),  -- PZEM 24 · relé 22/2 · 16 A · Serviços
  ('b2000000-0000-4000-8000-000000000018', 'Geladeira', 'meter', 'meter', 'Cozinha', '{"in_total": true}', false, 'esp32-eletrica'),  -- PZEM 25 · sem relé · 16 A · Serviços
  ('b2000000-0000-4000-8000-000000000019', 'Lava-louças', 'meter', 'meter', 'Cozinha', '{"on": true, "in_total": true}', false, 'esp32-eletrica'),  -- PZEM 26 · relé 22/3 · 16 A · Serviços
  ('b2000000-0000-4000-8000-000000000020', 'Iluminação — Cozinha', 'meter', 'meter', 'Cozinha', '{"in_total": true}', false, 'esp32-eletrica'),  -- PZEM 27 · sem relé · 10 A · Serviços
  ('b2000000-0000-4000-8000-000000000021', 'Máquina de lavar — Lavanderia', 'meter', 'meter', 'Lavanderia', '{"on": true, "in_total": true}', false, 'esp32-eletrica'),  -- PZEM 28 · relé 22/4 · 16 A · Serviços
  ('b2000000-0000-4000-8000-000000000022', 'Tomadas 10 A — Lavanderia', 'meter', 'meter', 'Lavanderia', '{"on": true, "in_total": true}', false, 'esp32-eletrica'),  -- PZEM 29 · relé 22/5 · 16 A · Serviços
  ('b2000000-0000-4000-8000-000000000023', 'Iluminação — Lavanderia', 'meter', 'meter', 'Lavanderia', '{"in_total": true}', false, 'esp32-eletrica'),  -- PZEM 30 · sem relé · 10 A · Serviços
  ('b2000000-0000-4000-8000-000000000024', 'Tomadas — Área Externa', 'meter', 'meter', 'Área Externa', '{"on": true, "in_total": true}', false, 'esp32-eletrica'),  -- PZEM 31 · relé 22/6 · 16 A · Serviços
  ('b2000000-0000-4000-8000-000000000025', 'Iluminação — Área Externa', 'meter', 'meter', 'Área Externa', '{"on": true, "in_total": true}', false, 'esp32-eletrica'),  -- PZEM 32 · relé 22/7 · 10 A · Serviços
  ('b2000000-0000-4000-8000-000000000026', 'Portão eletrônico', 'meter', 'meter', 'Área Externa', '{"in_total": true}', false, 'esp32-eletrica'),  -- PZEM 33 · sem relé · 10 A · Serviços
  ('b2000000-0000-4000-8000-000000000027', 'Bomba / pressurizador', 'meter', 'meter', 'Área Externa', '{"on": true, "in_total": true}', false, 'esp32-eletrica'),  -- PZEM 34 · relé 22/8 · 16 A · Serviços
  ('b2000000-0000-4000-8000-000000000028', 'Tomadas 20 A — Oficina (bancada 1)', 'meter', 'meter', 'Oficina', '{"on": true, "in_total": true}', false, 'esp32-eletrica'),  -- PZEM 35 · relé 22/9 · 25 A · Serviços
  ('b2000000-0000-4000-8000-000000000029', 'Tomadas 20 A — Oficina (bancada 2)', 'meter', 'meter', 'Oficina', '{"on": true, "in_total": true}', false, 'esp32-eletrica'),  -- PZEM 36 · relé 22/10 · 25 A · Serviços
  ('b2000000-0000-4000-8000-000000000030', 'Compressor — Oficina', 'meter', 'meter', 'Oficina', '{"on": true, "in_total": true}', false, 'esp32-eletrica'),  -- PZEM 37 · relé 22/11 · 25 A · Serviços
  ('b2000000-0000-4000-8000-000000000031', 'Tomadas 10 A — Oficina', 'meter', 'meter', 'Oficina', '{"on": true, "in_total": true}', false, 'esp32-eletrica'),  -- PZEM 38 · relé 22/12 · 16 A · Serviços
  ('b2000000-0000-4000-8000-000000000032', 'Iluminação — Oficina', 'meter', 'meter', 'Oficina', '{"on": true, "in_total": true}', false, 'esp32-eletrica'),  -- PZEM 39 · relé 22/13 · 10 A · Serviços
  ('b2000000-0000-4000-8000-000000000033', 'Circuito reserva — Subquadro 3', 'meter', 'meter', 'Lavanderia', '{"in_total": true}', false, 'esp32-eletrica')  -- PZEM 40 · sem relé · 16 A · Serviços
on conflict (id) do nothing;

-- com a migração 018 (isolamento por dono): o SQL Editor não tem login, então os
-- circuitos ficariam sem dono e invisíveis no app — vão para a conta mais antiga
-- (a mesma regra da 018). Sem a 018 este bloco não faz nada.
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'devices' and column_name = 'owner_id') then
    execute $q$update public.devices set owner_id = (select id from auth.users order by created_at limit 1)
                where id::text like 'b2000000-%' and owner_id is null$q$;
  end if;
end $$;

-- conferência
select id, name, room, status from public.devices where id::text like 'b2000000-%' order by id;
