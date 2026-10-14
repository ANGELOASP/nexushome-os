-- ============================================================
-- NexusHome OS — 024_device_library.sql
-- Biblioteca de dispositivos ampliada (v2.13): computadores, tablets, rede,
-- áudio, vídeo, eletrodomésticos, alarme, portões...
--
--   · devices.type passa a aceitar: audio, projector, media, computer, tablet,
--     network, appliance, vacuum, alarm, gate (sem esta migração o app grava esses
--     aparelhos como "hub", mantendo o modelo 3D, e avisa);
--   · automações do servidor (007/018/023) ganham as ações:
--       volume  {volume: 0–100}      source {source: "HDMI 1"}
--       armed   {armed: off|home|away}  open {open: true|false} (portão, persiana)
--       vacuum  {state: cleaning|docked}
--   · fila de comandos (013/023): aparelhos com hw também enviam "open" ao ESP32
--     (portão/persiana comandados por uma placa), além de "on".
-- Execute DEPOIS de 023_eletrica.sql. Idempotente.
-- ============================================================

alter table public.devices drop constraint if exists devices_type_check;
alter table public.devices add constraint devices_type_check check (type in (
  'light', 'ac', 'sensor', 'valve', 'solar', 'meter',
  'tv', 'plug', 'switch', 'lock', 'camera', 'curtain', 'fan', 'speaker', 'hub',
  'audio', 'projector', 'media', 'computer', 'tablet', 'network', 'appliance', 'vacuum', 'alarm', 'gate'
));

-- ---- fila de comandos: válvulas (013) + aparelhos com hw (on / open) ----
create or replace function public.queue_device_command()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cmd jsonb;
begin
  if coalesce(current_setting('nexus.device_report', true), '') = '1' then
    return new;
  end if;

  if new.type = 'valve'
     and (new.status -> 'open') is distinct from (old.status -> 'open')
     and (new.status -> 'open') is not null then
    cmd := jsonb_build_object('open', new.status -> 'open');
  elsif new.hw is not null
     and (new.status -> 'open') is distinct from (old.status -> 'open')
     and (new.status -> 'open') is not null then
    cmd := jsonb_build_object('open', new.status -> 'open');
  elsif new.hw is not null
     and (new.status -> 'on') is distinct from (old.status -> 'on')
     and (new.status -> 'on') is not null then
    cmd := jsonb_build_object('on', new.status -> 'on');
  end if;

  if cmd is not null then
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
revoke all on function public.queue_device_command() from public, anon, authenticated;

-- ---- automações do servidor: mesmas regras da 023 + ações novas ----
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
  r_owner  text := to_jsonb(new) ->> 'owner_id';
  a_owner  text;
begin
  for a in
    select au.*, to_jsonb(au) ->> 'owner_id' as owner_txt
      from public.automations au
     where au.is_active
       and au.trigger_condition ->> 'metric' = new.metric_type
       and coalesce(au.trigger_condition ->> 'device_id', '') in ('', new.device_id::text)
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

      if met is distinct from a.last_met then
        update public.automations set last_met = met where id = a.id;
      end if;

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
        when 'open'       then jsonb_build_object('open',       val::boolean)
        when 'temp'       then jsonb_build_object('temp',       val::numeric)
        when 'brightness' then jsonb_build_object('brightness', val::numeric)
        when 'color'      then jsonb_build_object('color',      val)
        when 'volume'     then jsonb_build_object('volume',     greatest(0, least(100, val::numeric)))
        when 'source'     then jsonb_build_object('source',     val)
        when 'armed'      then case when val in ('off', 'home', 'away') then jsonb_build_object('armed', val) end
        when 'vacuum'     then case when val in ('cleaning', 'docked') then jsonb_build_object('state', val) end
        else null
      end;
      if patch is null then continue; end if;

      update public.devices d set status = d.status || patch
       where d.id = dev_id
         and (a_owner is null or coalesce(to_jsonb(d) ->> 'owner_id', '') in ('', a_owner));
      get diagnostics n = row_count;
      if n = 0 then continue; end if;

      update public.automations set last_fired_at = now() where id = a.id;
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
