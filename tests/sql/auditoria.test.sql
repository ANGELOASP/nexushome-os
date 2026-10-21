-- Migração 027 (auditoria do banco): um bloco por item (B1..B9).
-- Rode com tests/sql/run_isolation.sh (banco de TESTE vazio): precisa do auth falso,
-- da 018 e de um pino "st-antigo" gravado ANTES da 027 (o script faz isso).
\set ON_ERROR_STOP 1
create or replace function pg_temp.fail(msg text) returns void language plpgsql as $$ begin raise exception 'FALHOU: %', msg; end $$;
grant select, insert, update, delete on all tables in schema public to authenticated;
reset role;
select set_config('request.jwt.claim.sub', '', false);

-- ============ B1: device_pins com dono ============
select case when (select owner_id from device_pins where device_id = 'st-antigo') = '11111111-0000-4000-8000-000000000001'
            then null else pg_temp.fail('B1 backfill do pino para a conta mais antiga') end;
select case when (select count(*) from pg_policies where schemaname = 'public' and tablename = 'device_pins') = 1
             and (select count(*) from pg_policies where schemaname = 'public' and tablename = 'device_pins'
                   and policyname = 'device_pins_owner' and qual like '%auth.uid()%') = 1
            then null else pg_temp.fail('B1 política aberta continua em device_pins') end;
set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000002', false);
select case when (select count(*) from device_pins) = 0 then null else pg_temp.fail('B1 outra conta vê pinos alheios') end;
delete from device_pins where device_id = 'st-antigo';      -- RLS: 0 linhas
insert into device_pins (device_id, pos_x, pos_z, pos_floor) values ('tuya-conta2', 1, 1, 0);
select case when (select owner_id from device_pins where device_id = 'tuya-conta2') = '22222222-0000-4000-8000-000000000002'
            then null else pg_temp.fail('B1 default auth.uid() no pino') end;
do $$ begin
  begin
    insert into device_pins (device_id, pos_x, pos_z) values ('st-antigo', 9, 9)
      on conflict (device_id) do update set pos_x = excluded.pos_x;
    raise exception 'FALHOU: B1 upsert sobrescreveu pino de outra conta';
  exception when insufficient_privilege then null;   -- RLS bloqueou
  end;
end $$;
select set_config('request.jwt.claim.sub', '11111111-0000-4000-8000-000000000001', false);
select case when (select count(*) from device_pins) = 1 and (select pos_x from device_pins where device_id = 'st-antigo') = 2
            then null else pg_temp.fail('B1 pino do dono apagado/alterado por outra conta') end;
-- o upsert do app (onConflict device_id) continua funcionando para o dono
insert into device_pins (device_id, pos_x, pos_z) values ('st-antigo', 3, 3)
  on conflict (device_id) do update set pos_x = excluded.pos_x;
select case when (select pos_x from device_pins where device_id = 'st-antigo') = 3 then null else pg_temp.fail('B1 upsert do dono') end;
reset role;
select set_config('request.jwt.claim.sub', '', false);

-- ============ B2: alerta do gateway herda o dono do dispositivo ============
-- (há duas casas com dispositivos: a regra "casa única" sozinha deixaria o dono nulo)
select case when (select count(distinct owner_id) from devices where owner_id is not null) >= 2
            then null else pg_temp.fail('B2 cenário precisa de 2 casas') end;
insert into alerts (severity, message, source_module, device_id) values
  ('critical', 'b2-casa2', 'eletrica', 'c9999999-0000-4000-8000-000000000009'),
  ('critical', 'b2-casa1', 'eletrica', 'a4444444-4444-4444-8444-444444444444');
select case when (select owner_id from alerts where message = 'b2-casa2') = '22222222-0000-4000-8000-000000000002'
             and (select owner_id from alerts where message = 'b2-casa1') = '11111111-0000-4000-8000-000000000001'
            then null else pg_temp.fail('B2 alerta não herdou o dono do device_id') end;
-- owner_id explícito (o gateway também passa) prevalece
insert into alerts (severity, message, source_module, device_id, owner_id) values
  ('warning', 'b2-explicito', 'eletrica', 'c9999999-0000-4000-8000-000000000009', '11111111-0000-4000-8000-000000000001');
select case when (select owner_id from alerts where message = 'b2-explicito') = '11111111-0000-4000-8000-000000000001'
            then null else pg_temp.fail('B2 owner_id explícito sobrescrito') end;
-- sem device_id e sem dono, com 2 casas: continua sem dono (comportamento da 018)
insert into alerts (severity, message) values ('warning', 'b2-solto');
select case when (select owner_id from alerts where message = 'b2-solto') is null then null else pg_temp.fail('B2 alerta solto ganhou dono arbitrário') end;
-- GUC nexus.owner (automação na mesma transação) ainda vale quando não há device_id
begin;
select set_config('nexus.owner', '22222222-0000-4000-8000-000000000002', true);
insert into alerts (severity, message) values ('info', 'b2-guc');
commit;
select case when (select owner_id from alerts where message = 'b2-guc') = '22222222-0000-4000-8000-000000000002'
            then null else pg_temp.fail('B2 GUC nexus.owner') end;
-- apagar o dispositivo não apaga o alerta (on delete set null)
insert into devices (id, name, type, room, status, owner_id) values
  ('e0000000-0000-4000-8000-0000000000b2', 'Sensor temporário', 'sensor', 'Cozinha', '{}', '11111111-0000-4000-8000-000000000001');
insert into alerts (severity, message, device_id) values ('info', 'b2-cascata', 'e0000000-0000-4000-8000-0000000000b2');
delete from devices where id = 'e0000000-0000-4000-8000-0000000000b2';
select case when (select device_id from alerts where message = 'b2-cascata') is null
             and (select owner_id from alerts where message = 'b2-cascata') = '11111111-0000-4000-8000-000000000001'
            then null else pg_temp.fail('B2 on delete set null') end;

-- ============ B3: leitura reenviada (antiga) não dispara automação ============
update automations set is_active = false;
update automations set is_active = true, last_met = false, last_fired_at = null where id = 'b1111111-1111-4111-8111-111111111111';
update devices set status = status || '{"on": true}' where id = 'a2222222-2222-4222-8222-222222222222';
insert into telemetry_logs (device_id, metric_type, value, created_at)
  values ('a4444444-4444-4444-8444-444444444444', 'energy_watts', 5000, now() - interval '5 minutes');
select case when (select (status ->> 'on')::boolean from devices where id = 'a2222222-2222-4222-8222-222222222222')
             and (select last_met from automations where id = 'b1111111-1111-4111-8111-111111111111') = false
            then null else pg_temp.fail('B3 leitura antiga disparou a automação / mexeu em last_met') end;
-- a mesma leitura "agora" dispara
insert into telemetry_logs (device_id, metric_type, value) values ('a4444444-4444-4444-8444-444444444444', 'energy_watts', 5000);
select case when (select (status ->> 'on')::boolean from devices where id = 'a2222222-2222-4222-8222-222222222222') = false
            then null else pg_temp.fail('B3 leitura atual não disparou') end;

-- ============ B8: leitura de dispositivo SEM dono só casa com regra SEM dono ============
update devices set status = status || '{"on": true}' where id = 'a2222222-2222-4222-8222-222222222222';
update automations set last_met = false, last_fired_at = null where id = 'b1111111-1111-4111-8111-111111111111';
insert into devices (id, name, type, room, status, owner_id) values
  ('e0000000-0000-4000-8000-0000000000b8', 'Medidor sem dono', 'meter', 'Cozinha', '{}', null),
  ('e0000000-0000-4000-8000-0000000000b9', 'Luz sem dono', 'light', 'Cozinha', '{"on": true}', null);
insert into automations (id, name, trigger_condition, action_payload, is_active, owner_id) values
  ('e0000000-0000-4000-8000-0000000000a8', 'Regra sem dono',
   '{"metric": "energy_watts", "operator": ">", "threshold": 4000, "device_id": "e0000000-0000-4000-8000-0000000000b8"}',
   '{"device_id": "e0000000-0000-4000-8000-0000000000b9", "action": "power", "value": false}', true, null);
insert into telemetry_logs (device_id, metric_type, value) values ('e0000000-0000-4000-8000-0000000000b8', 'energy_watts', 5000);
select case when (select (status ->> 'on')::boolean from devices where id = 'a2222222-2222-4222-8222-222222222222')
            then null else pg_temp.fail('B8 leitura sem dono disparou regra da casa 1') end;
select case when (select (status ->> 'on')::boolean from devices where id = 'e0000000-0000-4000-8000-0000000000b9') = false
            then null else pg_temp.fail('B8 regra sem dono não disparou') end;
delete from automations where id = 'e0000000-0000-4000-8000-0000000000a8';
delete from devices where id in ('e0000000-0000-4000-8000-0000000000b8', 'e0000000-0000-4000-8000-0000000000b9');
update automations set is_active = false;

-- ============ B4: automations no Realtime ============
select case when exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
                          and schemaname = 'public' and tablename = 'automations')
            then null else pg_temp.fail('B4 automations fora da publicação') end;

-- ============ B5: device_patch_status ============
delete from device_commands;
update devices set status = '{"open": false}' where id = 'a3333333-3333-4333-8333-333333333333';
delete from device_commands;
update devices set status = '{"on": true, "brightness": 70, "color": "#ffd9a0"}' where id = 'a1111111-1111-4111-8111-111111111111';
select case when not has_function_privilege('anon', 'public.device_patch_status(uuid, jsonb)', 'execute')
             and has_function_privilege('authenticated', 'public.device_patch_status(uuid, jsonb)', 'execute')
             and has_function_privilege('service_role', 'public.device_patch_status(uuid, jsonb)', 'execute')
            then null else pg_temp.fail('B5 grants') end;
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-0000-4000-8000-000000000001', false);
-- mescla só o patch (não apaga "on" relatado pelo quadro)
select case when public.device_patch_status('a1111111-1111-4111-8111-111111111111', '{"brightness": 40}')
                 = '{"on": true, "brightness": 40, "color": "#ffd9a0"}'::jsonb
            then null else pg_temp.fail('B5 mescla do status') end;
-- o gatilho de comando (013/025) continua disparando
select public.device_patch_status('a3333333-3333-4333-8333-333333333333', '{"open": true}');
select case when (select count(*) from device_commands where device_id = 'a3333333-3333-4333-8333-333333333333'
                   and status = 'pending' and command = '{"open": true}'::jsonb) = 1
            then null else pg_temp.fail('B5 gatilho queue_device_command não enfileirou') end;
-- patch que não é objeto é rejeitado
do $$ begin
  begin
    perform public.device_patch_status('a1111111-1111-4111-8111-111111111111', '[1, 2]');
    raise exception 'FALHOU: B5 aceitou patch que não é objeto';
  exception when invalid_parameter_value then null;
  end;
end $$;
-- outra conta: 0 linhas → null, e nada muda
select set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000002', false);
select case when public.device_patch_status('a1111111-1111-4111-8111-111111111111', '{"on": false}') is null
            then null else pg_temp.fail('B5 outra conta recebeu status') end;
reset role;
select set_config('request.jwt.claim.sub', '', false);
select case when (select status from devices where id = 'a1111111-1111-4111-8111-111111111111')
                 = '{"on": true, "brightness": 40, "color": "#ffd9a0"}'::jsonb
            then null else pg_temp.fail('B5 outra conta alterou dispositivo alheio') end;

-- ============ B6: índice da fila e purge_old_rows ============
select case when exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'device_commands_device_pending_idx'
                          and indexdef like '%(device_id)%' and indexdef like '%pending%')
            then null else pg_temp.fail('B6 índice device_commands(device_id) pendentes') end;
select case when not has_function_privilege('anon', 'public.purge_old_rows(int, int)', 'execute')
             and not has_function_privilege('authenticated', 'public.purge_old_rows(int, int)', 'execute')
            then null else pg_temp.fail('B6 purge_old_rows exposta para anon/authenticated') end;
delete from device_commands;
insert into telemetry_logs (device_id, metric_type, value, created_at) values
  ('a4444444-4444-4444-8444-444444444444', 'energy_watts', 1, now() - interval '100 days'),
  ('a4444444-4444-4444-8444-444444444444', 'energy_watts', 2, now() - interval '100 days');
insert into device_commands (device_id, command, status, created_at) values
  ('a3333333-3333-4333-8333-333333333333', '{"open": true}',  'delivered',  now() - interval '10 days'),
  ('a3333333-3333-4333-8333-333333333333', '{"open": false}', 'superseded', now() - interval '10 days'),
  ('a3333333-3333-4333-8333-333333333333', '{"open": true}',  'pending',    now() - interval '10 days'),
  ('a3333333-3333-4333-8333-333333333333', '{"open": true}',  'delivered',  now() - interval '1 day');
select case when public.purge_old_rows() = '{"telemetry_logs": 2, "device_commands": 2}'::jsonb
            then null else pg_temp.fail('B6 contagens do purge') end;
select case when (select count(*) from device_commands) = 2
             and (select count(*) from device_commands where status = 'pending') = 1
             and (select count(*) from telemetry_logs where created_at < now() - interval '90 days') = 0
             and (select count(*) from telemetry_logs) > 0
            then null else pg_temp.fail('B6 purge apagou demais/de menos') end;
do $$ begin
  begin
    perform public.purge_old_rows(0, 7);
    raise exception 'FALHOU: B6 aceitou prazo 0';
  exception when invalid_parameter_value then null;
  end;
end $$;

-- ============ B7: nome de cômodo único por casa, conferido no commit ============
select case when (select condeferrable and condeferred from pg_constraint where conname = 'rooms_owner_name_key') is true
            then null else pg_temp.fail('B7 constraint não é deferrable') end;
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-0000-4000-8000-000000000001', false);
insert into rooms (id, name, pos_x, pos_z, size_x, size_z, color) values
  ('e0000000-0000-4000-8000-0000000000c1', 'Troca A', 0, 0, 2, 2, '#fff'),
  ('e0000000-0000-4000-8000-0000000000c2', 'Troca B', 3, 0, 2, 2, '#fff');
-- o upsert do Editor de Planta (por id) trocando os nomes entre si
insert into rooms (id, name, pos_x, pos_z, size_x, size_z, color) values
  ('e0000000-0000-4000-8000-0000000000c1', 'Troca B', 0, 0, 2, 2, '#fff'),
  ('e0000000-0000-4000-8000-0000000000c2', 'Troca A', 3, 0, 2, 2, '#fff')
  on conflict (id) do update set name = excluded.name;
select case when (select name from rooms where id = 'e0000000-0000-4000-8000-0000000000c1') = 'Troca B'
            then null else pg_temp.fail('B7 troca de nomes') end;
-- nome repetido na mesma casa continua proibido (no fim da transação)
do $$ begin
  begin
    insert into rooms (name, pos_x, pos_z, size_x, size_z, color) values ('Troca A', 0, 0, 1, 1, '#fff');
    set constraints rooms_owner_name_key immediate;
    raise exception 'FALHOU: B7 nome duplicado aceito';
  exception when unique_violation then null;
  end;
end $$;
-- outra casa pode ter o mesmo nome
select set_config('request.jwt.claim.sub', '22222222-0000-4000-8000-000000000002', false);
insert into rooms (name, pos_x, pos_z, size_x, size_z, color) values ('Troca A', 0, 0, 1, 1, '#fff');
reset role;
select set_config('request.jwt.claim.sub', '', false);
delete from rooms where name in ('Troca A', 'Troca B');

select 'OK: auditoria 027 (B1-B8)' as resultado;
