-- ============================================================
-- NexusHome OS — seeds/unificado.sql (v2.16)
-- Projeto de automação unificado: docs/projeto-unificado.md §15.
--   · barramento B (tela T3 "Segurança"): 10 luzes three-way, sensores por cômodo,
--     gás, válvula de gás, exaustores e alarme da casa   → b3000000-…
--   · barramento D (tela T4 "Nobreak"): banco LiFePO4 + inversor → b4000000-…
--   · correções: circuitos de iluminação 25 e 32 viram "só medição" (o liga/desliga
--     passou para o three-way do barramento B) e a hidráulica ganha dono (018).
-- Os UUIDs são FIXOS e já estão nos firmwares (esp32s3_seguranca, esp32s3_nobreak).
-- Precisa das migrações 023/024 (coluna hw e tipos). A 025 é recomendada (histórico
-- de bateria e gás e o comando "armed" do alarme). Idempotente.
-- ============================================================

insert into public.devices (id, name, type, model, room, status, is_online, hw) values
  ('b3000000-0000-4000-8000-000000000001', 'Luz — Sala de Estar', 'light', 'plafon', 'Sala de Estar', '{"on": false}', false, 'esp32-seguranca'),  -- L01 · relé 90/1 · three-way
  ('b3000000-0000-4000-8000-000000000002', 'Luz — Sala de TV', 'light', 'plafon', 'Sala de TV', '{"on": false}', false, 'esp32-seguranca'),  -- L02 · relé 90/2 · three-way
  ('b3000000-0000-4000-8000-000000000003', 'Luz — Cozinha', 'light', 'plafon', 'Cozinha', '{"on": false}', false, 'esp32-seguranca'),  -- L03 · relé 90/3 · three-way
  ('b3000000-0000-4000-8000-000000000004', 'Luz — Quarto Principal', 'light', 'plafon', 'Quarto Principal', '{"on": false}', false, 'esp32-seguranca'),  -- L04 · relé 90/4 · three-way
  ('b3000000-0000-4000-8000-000000000005', 'Luz — Quarto 2', 'light', 'plafon', 'Quarto 2', '{"on": false}', false, 'esp32-seguranca'),  -- L05 · relé 90/5 · three-way
  ('b3000000-0000-4000-8000-000000000006', 'Luz — Quarto 3', 'light', 'plafon', 'Quarto 3', '{"on": false}', false, 'esp32-seguranca'),  -- L06 · relé 90/6 · three-way
  ('b3000000-0000-4000-8000-000000000007', 'Luz — Banheiro 1', 'light', 'plafon', 'Banheiro 1', '{"on": false}', false, 'esp32-seguranca'),  -- L07 · relé 90/7 · three-way
  ('b3000000-0000-4000-8000-000000000008', 'Luz — Banheiro 2', 'light', 'plafon', 'Banheiro 2', '{"on": false}', false, 'esp32-seguranca'),  -- L08 · relé 90/8 · three-way
  ('b3000000-0000-4000-8000-000000000009', 'Luz — Lavanderia', 'light', 'plafon', 'Lavanderia', '{"on": false}', false, 'esp32-seguranca'),  -- L09 · relé 91/1 · three-way
  ('b3000000-0000-4000-8000-000000000010', 'Luz — Área Externa', 'light', 'outdoor_light', 'Área Externa', '{"on": false}', false, 'esp32-seguranca'),  -- L10 · relé 91/2 · three-way
  ('b3000000-0000-4000-8000-000000000021', 'Sensores — Sala de Estar', 'sensor', 'presence', 'Sala de Estar', '{"temp": null, "hum": null, "presence": false, "smoke": false}', false, 'esp32-seguranca'),
  ('b3000000-0000-4000-8000-000000000022', 'Sensores — Sala de TV', 'sensor', 'presence', 'Sala de TV', '{"temp": null, "hum": null, "presence": false, "smoke": false}', false, 'esp32-seguranca'),
  ('b3000000-0000-4000-8000-000000000023', 'Sensores — Cozinha', 'sensor', 'smoke', 'Cozinha', '{"presence": false, "heat": false, "door": true}', false, 'esp32-seguranca'),
  ('b3000000-0000-4000-8000-000000000024', 'Sensores — Quarto Principal', 'sensor', 'presence', 'Quarto Principal', '{"temp": null, "hum": null, "presence": false, "smoke": false}', false, 'esp32-seguranca'),
  ('b3000000-0000-4000-8000-000000000025', 'Sensores — Quarto 2', 'sensor', 'presence', 'Quarto 2', '{"temp": null, "hum": null, "presence": false, "smoke": false}', false, 'esp32-seguranca'),
  ('b3000000-0000-4000-8000-000000000026', 'Sensores — Quarto 3', 'sensor', 'presence', 'Quarto 3', '{"temp": null, "hum": null, "presence": false, "smoke": false}', false, 'esp32-seguranca'),
  ('b3000000-0000-4000-8000-000000000027', 'Sensores — Banheiro 1', 'sensor', 'temp_sensor', 'Banheiro 1', '{"temp": null, "hum": null}', false, 'esp32-seguranca'),
  ('b3000000-0000-4000-8000-000000000028', 'Sensores — Banheiro 2', 'sensor', 'temp_sensor', 'Banheiro 2', '{"temp": null, "hum": null}', false, 'esp32-seguranca'),
  ('b3000000-0000-4000-8000-000000000029', 'Sensores — Lavanderia', 'sensor', 'presence', 'Lavanderia', '{"temp": null, "hum": null, "presence": false}', false, 'esp32-seguranca'),
  ('b3000000-0000-4000-8000-000000000030', 'Sensores — Área Externa', 'sensor', 'presence', 'Área Externa', '{"presence": false}', false, 'esp32-seguranca'),
  ('b3000000-0000-4000-8000-000000000031', 'Gás — Cozinha', 'sensor', 'gas', 'Cozinha', '{"gas_lel": 0}', false, 'esp32-seguranca'),  -- transmissor 50
  ('b3000000-0000-4000-8000-000000000032', 'Gás — Lavanderia', 'sensor', 'gas', 'Lavanderia', '{"gas_lel": 0}', false, 'esp32-seguranca'),  -- transmissor 51
  ('b3000000-0000-4000-8000-000000000033', 'Válvula de gás', 'valve', 'valve', 'Cozinha', '{"open": true}', false, 'esp32-seguranca'),  -- NF, rearme manual · corte 91/CH7
  ('b3000000-0000-4000-8000-000000000041', 'Exaustor — Banheiro 1', 'fan', 'exhaust_fan', 'Banheiro 1', '{"on": false}', false, 'esp32-seguranca'),  -- 91/CH3 · UR > 75 %
  ('b3000000-0000-4000-8000-000000000042', 'Exaustor — Banheiro 2', 'fan', 'exhaust_fan', 'Banheiro 2', '{"on": false}', false, 'esp32-seguranca'),  -- 91/CH4
  ('b3000000-0000-4000-8000-000000000050', 'Alarme da casa', 'alarm', 'alarm_panel', 'Sala de Estar', '{"armed": "off"}', false, 'esp32-seguranca'),
  ('b4000000-0000-4000-8000-000000000001', 'Nobreak — banco LiFePO4', 'solar', 'battery', 'Sala Técnica', '{}', false, 'esp32-nobreak')  -- PZEM-017 41 · PZEM-016 42/43
on conflict (id) do nothing;

-- circuitos 25 (Iluminação — Área Externa) e 32 (Iluminação — Oficina): sem relé no
-- barramento A — o firmware de energia v2.16 já não aciona esses canais
update public.devices set status = status - 'on'
 where id in ('b2000000-0000-4000-8000-000000000025', 'b2000000-0000-4000-8000-000000000032');

-- com a migração 018 (isolamento por dono): o SQL Editor não tem login, então os
-- dispositivos ficariam sem dono e invisíveis no app — vão para a conta mais antiga
-- (a mesma regra da 018). Inclui a hidráulica (b1…) e a válvula geral (a333…).
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'devices' and column_name = 'owner_id') then
    execute $q$update public.devices set owner_id = (select id from auth.users order by created_at limit 1)
                where (id::text like 'b1000000-%' or id::text like 'b3000000-%' or id::text like 'b4000000-%'
                       or id = 'a3333333-3333-4333-8333-333333333333')
                  and owner_id is null$q$;
  end if;
end $$;

-- conferência
select id, name, type, room, hw from public.devices
 where id::text like 'b3000000-%' or id::text like 'b4000000-%' order by id;
