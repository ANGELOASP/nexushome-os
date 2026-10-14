-- Migração 023: comandos de liga/desliga dos circuitos (hw) e filtro de medidor nas automações.
create or replace function pg_temp.fail(msg text) returns void language plpgsql as
$$ begin raise exception 'FALHOU: %', msg; end $$;

delete from device_commands;
delete from alerts;
delete from automations;
insert into devices (id, name, type, room, status, hw) values
  ('b2000000-0000-4000-8000-000000000001', 'Chuveiro', 'meter', 'Banheiro 1', '{"on": true, "watts": 0}', 'esp32-eletrica'),
  ('b2000000-0000-4000-8000-000000000002', 'Tomadas',  'meter', 'Cozinha',    '{"on": true, "watts": 0}', 'esp32-eletrica')
on conflict (id) do nothing;

-- 1) app desliga um circuito com hw → comando {"on": false}
update devices set status = status || '{"on": false}' where id = 'b2000000-0000-4000-8000-000000000001';
select case when (select command from device_commands where status = 'pending'
                   and device_id = 'b2000000-0000-4000-8000-000000000001') = '{"on": false}'::jsonb
            then null else pg_temp.fail('comando de circuito não enfileirado') end;

-- 2) novo pedido substitui o anterior ainda pendente
update devices set status = status || '{"on": true}' where id = 'b2000000-0000-4000-8000-000000000001';
select case when (select count(*) from device_commands where status = 'pending') = 1
             and (select count(*) from device_commands where status = 'superseded') = 1
            then null else pg_temp.fail('pedido antigo não foi substituído') end;

-- 3) mudança de leitura (watts) não gera comando
update devices set status = status || '{"watts": 123}' where id = 'b2000000-0000-4000-8000-000000000001';
select case when (select count(*) from device_commands) = 2 then null else pg_temp.fail('watts gerou comando') end;

-- 4) dispositivo sem hw (luz de demonstração) não gera comando
update devices set status = status || '{"on": true}' where id = 'a1111111-1111-4111-8111-111111111111';
select case when (select count(*) from device_commands where device_id = 'a1111111-1111-4111-8111-111111111111') = 0
            then null else pg_temp.fail('luz sem hw gerou comando') end;

-- 5) estado reportado pelo ESP32 não volta como comando (eco)
select device_report_status('b2000000-0000-4000-8000-000000000002', '{"on": false, "trip": true}');
select case when (select count(*) from device_commands where device_id = 'b2000000-0000-4000-8000-000000000002') = 0
            then null else pg_temp.fail('relato do ESP32 virou comando') end;

-- 6) válvula continua como na 013
update devices set status = status || '{"open": false}' where id = 'a3333333-3333-4333-8333-333333333333';
select case when (select command from device_commands where device_id = 'a3333333-3333-4333-8333-333333333333'
                   and status = 'pending') = '{"open": false}'::jsonb
            then null else pg_temp.fail('comando de válvula sumiu') end;

-- 7) automação presa a um medidor ignora leituras de outro medidor
insert into automations (id, name, trigger_condition, action_payload, is_active) values
  ('b3333333-3333-4333-8333-333333333333', 'Chuveiro alto → desliga tomadas',
   '{"metric":"energy_watts","operator":">","threshold":5000,"device_id":"b2000000-0000-4000-8000-000000000001"}',
   '{"device_id":"b2000000-0000-4000-8000-000000000002","action":"power","value":false}', true);
update devices set status = status || '{"on": true}' where id = 'b2000000-0000-4000-8000-000000000002';
insert into telemetry_logs (device_id, metric_type, value) values ('b2000000-0000-4000-8000-000000000002', 'energy_watts', 9000);
select case when (select (status->>'on')::boolean from devices where id = 'b2000000-0000-4000-8000-000000000002')
            then null else pg_temp.fail('regra com filtro disparou com outro medidor') end;

-- 8) leitura do medidor certo dispara, e a ação num circuito com hw vira comando
insert into telemetry_logs (device_id, metric_type, value) values ('b2000000-0000-4000-8000-000000000001', 'energy_watts', 7600);
select case when not (select (status->>'on')::boolean from devices where id = 'b2000000-0000-4000-8000-000000000002')
            then null else pg_temp.fail('regra com filtro não disparou') end;
select case when (select command from device_commands where status = 'pending'
                   and device_id = 'b2000000-0000-4000-8000-000000000002') = '{"on": false}'::jsonb
            then null else pg_temp.fail('ação da automação não virou comando') end;
select case when (select count(*) from alerts where source_module = 'automacao') = 1 then null
            else pg_temp.fail('execução não registrada em alerts') end;
