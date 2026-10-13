-- Cenário da migração 018 (isolamento por usuário): duas contas, ESP32 sem login, automações por casa.
-- Rode com tests/sql/run_isolation.sh (banco de TESTE vazio).
\set ON_ERROR_STOP 1
create or replace function pg_temp.fail(msg text) returns void language plpgsql as $$ begin raise exception 'FALHOU: %', msg; end $$;
grant select, insert, update, delete on all tables in schema public to authenticated;
-- backfill
select case when (select count(*) from devices where owner_id = '11111111-0000-4000-8000-000000000001') = 4 then null else pg_temp.fail('backfill devices') end;
select case when (select count(*) from rooms where owner_id is null) = 0 then null else pg_temp.fail('backfill rooms') end;
-- ativa regra de energia do dono
update automations set is_active = true where id = 'b1111111-1111-4111-8111-111111111111';
update devices set status = '{"on":true,"temp":23}' where id = 'a2222222-2222-4222-8222-222222222222';
-- leitura do ESP32 (sem login): herda dono e dispara a automação da casa
insert into telemetry_logs(device_id, metric_type, value) values ('a4444444-4444-4444-8444-444444444444','energy_watts', 1000);
insert into telemetry_logs(device_id, metric_type, value) values ('a4444444-4444-4444-8444-444444444444','energy_watts', 3500);
select case when (select owner_id from telemetry_logs order by created_at desc limit 1) = '11111111-0000-4000-8000-000000000001' then null else pg_temp.fail('telemetria sem dono') end;
select case when (select (status->>'on')::boolean from devices where id='a2222222-2222-4222-8222-222222222222') = false then null else pg_temp.fail('automação não disparou') end;
select case when (select owner_id from alerts where source_module='automacao' limit 1) = '11111111-0000-4000-8000-000000000001' then null else pg_temp.fail('alerta sem dono') end;
-- comando de válvula herda dono
update devices set status = status || '{"open":false}' where id = 'a3333333-3333-4333-8333-333333333333';
select case when (select owner_id from device_commands limit 1) = '11111111-0000-4000-8000-000000000001' then null else pg_temp.fail('comando sem dono') end;
-- alerta solto (sem dispositivo) numa casa única
insert into alerts(severity, message) values ('critical','teste');
select case when (select owner_id from alerts where message='teste') = '11111111-0000-4000-8000-000000000001' then null else pg_temp.fail('alerta solto sem dono') end;

-- RLS: outra conta não vê nada e cria a própria casa
set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000002', false);
select case when (select count(*) from devices) = 0 and (select count(*) from rooms) = 0 and (select count(*) from alerts) = 0 then null else pg_temp.fail('vazou dados para outra conta') end;
insert into rooms(name, pos_x, pos_z, size_x, size_z, color) values ('Sala de Estar', 0, 0, 3, 3, '#fff');
insert into devices(name, type, room, status) values ('Luz 2', 'light', 'Sala de Estar', '{}');
select case when (select owner_id from devices limit 1) = '22222222-0000-4000-8000-000000000002' then null else pg_temp.fail('default auth.uid()') end;
do $$ begin
  begin
    insert into devices(name, type, room, status, owner_id) values ('Intruso', 'light', 'x', '{}', '11111111-0000-4000-8000-000000000001');
    raise exception 'FALHOU: inseriu com dono alheio';
  exception when insufficient_privilege then null;   -- RLS bloqueou
  end;
end $$;
select case when (select count(*) from scenes) = 0 then null else pg_temp.fail('cenas vazaram') end;
-- dono vê os dele
select set_config('request.jwt.claim.sub', '11111111-0000-4000-8000-000000000001', false);
select case when (select count(*) from devices) = 4 then null else pg_temp.fail('dono não vê os próprios') end;
reset role;
-- automação do dono NÃO reage a leitura da outra casa
update devices set status = '{"on":true}' where id = 'a2222222-2222-4222-8222-222222222222';
update automations set last_met = false, last_fired_at = null;
insert into devices(id, name, type, room, status, owner_id) values ('c9999999-0000-4000-8000-000000000009','Medidor 2','meter','Sala de Estar','{}','22222222-0000-4000-8000-000000000002');
insert into telemetry_logs(device_id, metric_type, value) values ('c9999999-0000-4000-8000-000000000009','energy_watts', 5000);
select case when (select (status->>'on')::boolean from devices where id='a2222222-2222-4222-8222-222222222222') then null else pg_temp.fail('automação cruzou casas') end;
select 'OK: isolamento por usuário' as resultado;
