-- Migração 024: tipos novos da biblioteca, ações novas nas automações e comando "open" de aparelhos com hw.
create or replace function pg_temp.fail(msg text) returns void language plpgsql as
$$ begin raise exception 'FALHOU: %', msg; end $$;

delete from device_commands;
delete from alerts;
update automations set is_active = false;

-- 1) tipos novos são aceitos
insert into devices (id, name, type, room, status, model) values
  ('c1000000-0000-4000-8000-000000000001', 'Soundbar', 'audio', 'Sala de Estar', '{"on": false, "volume": 30}', 'soundbar'),
  ('c1000000-0000-4000-8000-000000000002', 'Alarme', 'alarm', 'Sala de Estar', '{"armed": "off"}', 'alarm_panel'),
  ('c1000000-0000-4000-8000-000000000003', 'Robô', 'vacuum', 'Sala de Estar', '{"state": "docked"}', 'robot_vacuum'),
  ('c1000000-0000-4000-8000-000000000004', 'Notebook', 'computer', 'Sala de Estar', '{}', 'notebook')
on conflict (id) do nothing;
insert into devices (id, name, type, room, status, model, hw) values
  ('c1000000-0000-4000-8000-000000000005', 'Portão', 'gate', 'Área Externa', '{"open": false}', 'gate', 'esp32-portao')
on conflict (id) do nothing;
select case when (select count(*) from devices where id::text like 'c1000000-%') = 5 then null
            else pg_temp.fail('tipos novos recusados') end;

-- 2) tipo inválido continua barrado
do $$ begin
  insert into devices (name, type, room) values ('x', 'foguete', 'Sala de Estar');
  raise exception 'FALHOU: tipo inválido aceito';
exception when check_violation then null;
end $$;

-- 3) automações: volume (limitado a 0–100), alarme e aspirador
insert into automations (id, name, trigger_condition, action_payload, is_active) values
  ('c2000000-0000-4000-8000-000000000001', 'Volume', '{"metric":"temperature","operator":">","threshold":30}',
   '{"device_id":"c1000000-0000-4000-8000-000000000001","action":"volume","value":150}', true),
  ('c2000000-0000-4000-8000-000000000002', 'Armar', '{"metric":"temperature","operator":">","threshold":30}',
   '{"device_id":"c1000000-0000-4000-8000-000000000002","action":"armed","value":"away"}', true),
  ('c2000000-0000-4000-8000-000000000003', 'Limpar', '{"metric":"temperature","operator":">","threshold":30}',
   '{"device_id":"c1000000-0000-4000-8000-000000000003","action":"vacuum","value":"cleaning"}', true),
  ('c2000000-0000-4000-8000-000000000004', 'Abrir portão', '{"metric":"temperature","operator":">","threshold":30}',
   '{"device_id":"c1000000-0000-4000-8000-000000000005","action":"open","value":true}', true),
  ('c2000000-0000-4000-8000-000000000005', 'Valor inválido', '{"metric":"temperature","operator":">","threshold":30}',
   '{"device_id":"c1000000-0000-4000-8000-000000000002","action":"armed","value":"talvez"}', true)
on conflict (id) do nothing;
insert into telemetry_logs (device_id, metric_type, value) values ('c1000000-0000-4000-8000-000000000004', 'temperature', 35);

select case when (select status->>'volume' from devices where id = 'c1000000-0000-4000-8000-000000000001') = '100'
            then null else pg_temp.fail('volume não aplicado/limitado') end;
select case when (select status->>'armed' from devices where id = 'c1000000-0000-4000-8000-000000000002') = 'away'
            then null else pg_temp.fail('alarme não armado') end;
select case when (select status->>'state' from devices where id = 'c1000000-0000-4000-8000-000000000003') = 'cleaning'
            then null else pg_temp.fail('aspirador não iniciou') end;

-- 4) portão com hw: a ação "open" vira comando para o ESP32
select case when (select command from device_commands where device_id = 'c1000000-0000-4000-8000-000000000005'
                   and status = 'pending') = '{"open": true}'::jsonb
            then null else pg_temp.fail('comando de abrir portão não enfileirado') end;

-- 5) válvula e circuito (013/023) continuam iguais
-- (inverte o estado atual: o teste anterior pode ter deixado a válvula fechada)
update devices set status = status || jsonb_build_object('open', not coalesce((status->>'open')::boolean, true))
 where id = 'a3333333-3333-4333-8333-333333333333';
select case when (select command from device_commands where device_id = 'a3333333-3333-4333-8333-333333333333'
                   and status = 'pending') = jsonb_build_object('open', (select status->'open' from devices
                                                                         where id = 'a3333333-3333-4333-8333-333333333333'))
            then null else pg_temp.fail('comando de válvula sumiu') end;
