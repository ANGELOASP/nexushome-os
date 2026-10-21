-- Migração 027 num banco SEM a 018 (sem owner_id, sem auth): o que não depende de dono
-- continua valendo. Rode com tests/sql/run.sh.
\set ON_ERROR_STOP 1
create or replace function pg_temp.fail(msg text) returns void language plpgsql as $$ begin raise exception 'FALHOU: %', msg; end $$;

-- B3: leitura antiga não dispara; atual dispara (sem dono: todas as regras valem — B8 não se aplica)
update automations set is_active = false;
update automations set is_active = true, last_met = false, last_fired_at = null where id = 'b1111111-1111-4111-8111-111111111111';
update devices set status = status || '{"on": true}' where id = 'a2222222-2222-4222-8222-222222222222';
insert into telemetry_logs (device_id, metric_type, value, created_at)
  values ('a4444444-4444-4444-8444-444444444444', 'energy_watts', 5000, now() - interval '3 minutes');
select case when (select (status ->> 'on')::boolean from devices where id = 'a2222222-2222-4222-8222-222222222222')
            then null else pg_temp.fail('B3 (sem 018) leitura antiga disparou') end;
insert into telemetry_logs (device_id, metric_type, value) values ('a4444444-4444-4444-8444-444444444444', 'energy_watts', 5000);
select case when (select (status ->> 'on')::boolean from devices where id = 'a2222222-2222-4222-8222-222222222222') = false
            then null else pg_temp.fail('B3 (sem 018) leitura atual não disparou') end;
update automations set is_active = false;

-- B2: alerta com device_id sem gatilho de dono (sem a 018) grava normalmente
insert into alerts (severity, message, device_id) values ('info', 'sem-dono', 'a4444444-4444-4444-8444-444444444444');

-- B4
select case when exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'automations')
            then null else pg_temp.fail('B4 (sem 018) automations fora da publicação') end;

-- B5: mescla + gatilho de comando
delete from device_commands;
update devices set status = '{"open": false}' where id = 'a3333333-3333-4333-8333-333333333333';
delete from device_commands;
select case when public.device_patch_status('a3333333-3333-4333-8333-333333333333', '{"open": true, "flow": 0}')
                 = '{"open": true, "flow": 0}'::jsonb
            then null else pg_temp.fail('B5 (sem 018) mescla') end;
select case when (select count(*) from device_commands where status = 'pending' and command = '{"open": true}'::jsonb) = 1
            then null else pg_temp.fail('B5 (sem 018) comando não enfileirado') end;
select case when public.device_patch_status('00000000-0000-4000-8000-000000000000', '{"on": true}') is null
            then null else pg_temp.fail('B5 (sem 018) dispositivo inexistente') end;

-- B6
insert into telemetry_logs (device_id, metric_type, value, created_at)
  values ('a4444444-4444-4444-8444-444444444444', 'energy_watts', 1, now() - interval '91 days');
update device_commands set status = 'delivered', created_at = now() - interval '8 days';
select case when public.purge_old_rows() = '{"telemetry_logs": 1, "device_commands": 1}'::jsonb
            then null else pg_temp.fail('B6 (sem 018) purge') end;

select 'OK: auditoria 027 sem a 018' as resultado;
