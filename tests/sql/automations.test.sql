-- Cenário: regra seed "Desligar AC em pico de energia" (> 3000 W → AC off).
create or replace function pg_temp.fail(msg text) returns void language plpgsql as
$$ begin raise exception 'FALHOU: %', msg; end $$;

create or replace function pg_temp.ac_on() returns boolean language sql as
$$ select (status->>'on')::boolean from devices where id='a2222222-2222-4222-8222-222222222222' $$;

create or replace function pg_temp.push(w numeric) returns void language sql as
$$ insert into telemetry_logs(device_id, metric_type, value)
   values ('a4444444-4444-4444-8444-444444444444','energy_watts', w) $$;

update automations set is_active = true where id = 'b1111111-1111-4111-8111-111111111111';
update devices set status = '{"on":true,"temp":23}' where id = 'a2222222-2222-4222-8222-222222222222';

-- 1) abaixo do limiar: nada acontece
select pg_temp.push(1000);
select case when pg_temp.ac_on() then null else pg_temp.fail('AC desligou abaixo do limiar') end;

-- 2) transição acima do limiar: AC desliga e gera alerta
select pg_temp.push(3500);
select case when not pg_temp.ac_on() then null else pg_temp.fail('AC não desligou na transição') end;
select case when (select count(*) from alerts where source_module='automacao') = 1 then null
            else pg_temp.fail('alerta de execução não registrado') end;

-- 3) continua acima: sem redisparo (edge trigger)
-- (cooldown vencido de propósito: só o edge trigger pode impedir o disparo)
update automations set last_fired_at = now() - interval '1 minute';
update devices set status = '{"on":true}' where id = 'a2222222-2222-4222-8222-222222222222';
select pg_temp.push(3600);
select case when pg_temp.ac_on() then null else pg_temp.fail('redisparou sem nova transição') end;

-- 4) desce e sobe de novo, mas dentro do cooldown de 20 s: não dispara
select pg_temp.push(100);
update automations set last_fired_at = now();
select pg_temp.push(4000);
select case when pg_temp.ac_on() then null else pg_temp.fail('cooldown ignorado') end;

-- 5) cooldown vencido + nova transição: dispara
select pg_temp.push(100);
update automations set last_fired_at = now() - interval '1 minute';
select pg_temp.push(4200);
select case when not pg_temp.ac_on() then null else pg_temp.fail('não disparou após cooldown') end;

-- 6) regra inativa não dispara
update automations set is_active = false;
select pg_temp.push(100);
update devices set status = '{"on":true}' where id = 'a2222222-2222-4222-8222-222222222222';
select pg_temp.push(5000);
select case when pg_temp.ac_on() then null else pg_temp.fail('regra inativa disparou') end;

-- 7) regra com dados inválidos não bloqueia a gravação da telemetria
update automations set is_active = true,
  trigger_condition = '{"metric":"energy_watts","operator":">","threshold":"abc"}'
 where id = 'b2222222-2222-4222-8222-222222222222';
select count(*) as antes from telemetry_logs \gset
select pg_temp.push(6000);
select case when (select count(*) from telemetry_logs) = :antes + 1 then null
            else pg_temp.fail('telemetria bloqueada por regra inválida') end;

-- 8) regras SmartThings são ignoradas pelo servidor
update automations set is_active = true,
  trigger_condition = '{"source":"smartthings","stDeviceId":"x","metric":"temperature","op":">","value":1}',
  action_payload = '{"type":"smartthings","stDeviceId":"x","commands":[]}'
 where id = 'b2222222-2222-4222-8222-222222222222';
select count(*) as alertas from alerts \gset
select pg_temp.push(7000);
select case when (select count(*) from alerts) = :alertas then null
            else pg_temp.fail('regra SmartThings executou no servidor') end;
