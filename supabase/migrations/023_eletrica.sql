-- ============================================================
-- NexusHome OS — 023_eletrica.sql
-- Automação elétrica (v2.11): circuitos dos subquadros (relés Waveshare +
-- medidores PZEM-016) comandados pelo ESP32-S3 "esp32s3_eletrica".
--
--   · devices.hw   quem comanda o aparelho no mundo físico (ex.: 'esp32-eletrica').
--                  Só dispositivos com hw geram comando de LIGA/DESLIGA para o ESP32 —
--                  luzes de demonstração e integrados (Tuya/SmartThings) não.
--   · fila de comandos (013) ampliada: além do "open" das válvulas, o "on" dos
--     dispositivos com hw vira {"on": true|false} em device_commands.
--   · automações do servidor (007/018): filtro opcional de MEDIDOR no gatilho
--     (trigger_condition.device_id) — com 33 medidores, "Energia > 3000 W" sem
--     filtro dispararia com o chuveiro sozinho. Funciona com e sem a 018.
-- Execute DEPOIS de 022_furniture_size.sql. Idempotente.
-- ============================================================

alter table public.devices add column if not exists hw text;

-- ---- fila de comandos: válvulas (como na 013) + circuitos com hw ----
create or replace function public.queue_device_command()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cmd jsonb;
begin
  -- estado REPORTADO pelo ESP32 (device_report_status): nunca vira comando (eco)
  if coalesce(current_setting('nexus.device_report', true), '') = '1' then
    return new;
  end if;

  if new.type = 'valve'
     and (new.status -> 'open') is distinct from (old.status -> 'open')
     and (new.status -> 'open') is not null then
    cmd := jsonb_build_object('open', new.status -> 'open');
  elsif new.hw is not null
     and (new.status -> 'on') is distinct from (old.status -> 'on')
     and (new.status -> 'on') is not null then
    cmd := jsonb_build_object('on', new.status -> 'on');
  end if;

  if cmd is not null then
    -- só o pedido mais recente por dispositivo vale
    update public.device_commands set status = 'superseded'
     where device_id = new.id and status = 'pending';
    insert into public.device_commands (device_id, command) values (new.id, cmd);
  end if;
  return new;
end;
$$;

drop trigger if exists devices_queue_valve_command on public.devices;
drop trigger if exists devices_queue_command on public.devices;
create trigger devices_queue_command
  after update of status on public.devices
  for each row execute function public.queue_device_command();
drop function if exists public.queue_valve_command();
revoke all on function public.queue_device_command() from public, anon, authenticated;

-- ---- automações do servidor: filtro opcional de medidor ----
-- Lê owner_id por to_jsonb(): a mesma função serve com a 018 (isolamento por dono)
-- aplicada ou não — sem a coluna, o dono fica nulo e nada é filtrado.
create or replace function public.run_automations()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  a        record;
  th       numeric;
  met      boolean;
  patch    jsonb;
  dev_id   uuid;
  act      text;
  val      text;
  n        integer;
  r_owner  text := to_jsonb(new) ->> 'owner_id';   -- dono da leitura (018) ou nulo
  a_owner  text;
begin
  for a in
    select au.*, to_jsonb(au) ->> 'owner_id' as owner_txt
      from public.automations au
     where au.is_active
       and au.trigger_condition ->> 'metric' = new.metric_type
       -- 023: regra presa a um medidor só olha as leituras dele
       and coalesce(au.trigger_condition ->> 'device_id', '') in ('', new.device_id::text)
       -- 018: só as regras da MESMA casa da leitura
       and (r_owner is null or coalesce(to_jsonb(au) ->> 'owner_id', '') in ('', r_owner))
       and coalesce(au.trigger_condition ->> 'source', '') <> 'smartthings'
       and coalesce(au.action_payload ->> 'type', '') <> 'smartthings'
     order by au.created_at
       for update of au
  loop
    begin
      a_owner := a.owner_txt;
      th := (a.trigger_condition ->> 'threshold')::numeric;
      met := case a.trigger_condition ->> 'operator'
        when '>'  then new.value >  th
        when '>=' then new.value >= th
        when '<'  then new.value <  th
        when '<=' then new.value <= th
        when '==' then new.value =  th
        else false
      end;

      -- só grava quando o estado da condição muda (evita write por leitura)
      if met is distinct from a.last_met then
        update public.automations set last_met = met where id = a.id;
      end if;

      -- edge trigger + cooldown
      if not met or a.last_met is true then continue; end if;
      if a.last_fired_at is not null and a.last_fired_at > now() - interval '20 seconds' then
        continue;
      end if;

      dev_id := (a.action_payload ->> 'device_id')::uuid;
      act    := a.action_payload ->> 'action';
      val    := a.action_payload ->> 'value';

      patch := case act
        when 'power'      then jsonb_build_object('on',         val::boolean)
        when 'valve'      then jsonb_build_object('open',       val::boolean)
        when 'temp'       then jsonb_build_object('temp',       val::numeric)
        when 'brightness' then jsonb_build_object('brightness', val::numeric)
        when 'color'      then jsonb_build_object('color',      val)
        else null
      end;
      if patch is null then continue; end if;

      update public.devices d set status = d.status || patch
       where d.id = dev_id
         and (a_owner is null or coalesce(to_jsonb(d) ->> 'owner_id', '') in ('', a_owner));
      get diagnostics n = row_count;
      if n = 0 then continue; end if;   -- dispositivo removido: não registra execução

      update public.automations set last_fired_at = now() where id = a.id;
      -- com a 018, o gatilho alerts_owner pega o dono desta configuração
      perform set_config('nexus.owner', coalesce(a_owner, r_owner, ''), true);
      insert into public.alerts (severity, message, source_module)
      values ('info', 'Automação executada no servidor: ' || a.name, 'automacao');
    exception when others then
      raise warning 'run_automations: regra % falhou: %', a.id, sqlerrm;
    end;
  end loop;
  return new;
end;
$$;

drop trigger if exists telemetry_run_automations on public.telemetry_logs;
create trigger telemetry_run_automations
  after insert on public.telemetry_logs
  for each row execute function public.run_automations();

revoke all on function public.run_automations() from public, anon, authenticated;

notify pgrst, 'reload schema';
