-- Migração 025 + seed unificado: métricas novas, comando "armed" e seed idempotente.
create or replace function pg_temp.fail(msg text) returns void language plpgsql as
$$ begin raise exception 'FALHOU: %', msg; end $$;

delete from device_commands;
update automations set is_active = false;

-- 1) métricas do nobreak e da segurança são aceitas; métrica desconhecida continua barrada
insert into telemetry_logs (device_id, metric_type, value) values
  ('b4000000-0000-4000-8000-000000000001', 'battery_soc', 81),
  ('b4000000-0000-4000-8000-000000000001', 'battery_voltage', 26.4),
  ('b4000000-0000-4000-8000-000000000001', 'grid_voltage', 221),
  ('b4000000-0000-4000-8000-000000000001', 'power_backup_w', 0),
  ('b3000000-0000-4000-8000-000000000031', 'gas_lel', 3);
do $$ begin
  insert into telemetry_logs (device_id, metric_type, value) values ('b4000000-0000-4000-8000-000000000001', 'foguete', 1);
  raise exception 'FALHOU: métrica inválida aceita';
exception when check_violation then null;
end $$;

-- 2) alarme da casa (hw): mudar "armed" enfileira o comando para a tela T3
update devices set status = status || '{"armed": "away"}' where id = 'b3000000-0000-4000-8000-000000000050';
select case when (select command from device_commands where device_id = 'b3000000-0000-4000-8000-000000000050'
                   and status = 'pending') = '{"armed": "away"}'::jsonb
            then null else pg_temp.fail('comando armed não enfileirado') end;
-- valor inválido não vira comando
update devices set status = status || '{"armed": "talvez"}' where id = 'b3000000-0000-4000-8000-000000000050';
select case when (select count(*) from device_commands where device_id = 'b3000000-0000-4000-8000-000000000050'
                   and status = 'pending' and command ->> 'armed' = 'talvez') = 0
            then null else pg_temp.fail('armed inválido enfileirado') end;

-- 3) luz three-way (hw): "on" vira comando; o relato do firmware (device_report) não ecoa
update devices set status = status || '{"on": true}' where id = 'b3000000-0000-4000-8000-000000000003';
select case when (select command from device_commands where device_id = 'b3000000-0000-4000-8000-000000000003'
                   and status = 'pending') = '{"on": true}'::jsonb
            then null else pg_temp.fail('comando da luz não enfileirado') end;
select device_report_status('b3000000-0000-4000-8000-000000000004', '{"on": true}'::jsonb);
select case when not exists (select 1 from device_commands where device_id = 'b3000000-0000-4000-8000-000000000004')
            then null else pg_temp.fail('relato do firmware gerou comando (eco)') end;

-- 4) válvula de gás: fechar pelo app vira comando "open": false
update devices set status = status || '{"open": false}' where id = 'b3000000-0000-4000-8000-000000000033';
select case when (select command from device_commands where device_id = 'b3000000-0000-4000-8000-000000000033'
                   and status = 'pending') = '{"open": false}'::jsonb
            then null else pg_temp.fail('fechar válvula de gás não enfileirou') end;

-- 5) seed: circuitos 25 e 32 sem "on"; contagem dos novos dispositivos
select case when (select count(*) from devices where id in ('b2000000-0000-4000-8000-000000000025','b2000000-0000-4000-8000-000000000032')
                   and status ? 'on') = 0 then null else pg_temp.fail('circuitos 25/32 ainda com on') end;
select case when (select count(*) from devices where id::text like 'b3000000-%') = 26
             and (select count(*) from devices where id::text like 'b4000000-%') = 1
            then null else pg_temp.fail('seed unificado incompleto') end;
