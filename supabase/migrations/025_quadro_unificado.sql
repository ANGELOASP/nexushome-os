-- ============================================================
-- NexusHome OS — 025_quadro_unificado.sql
-- Projeto de automação unificado (v2.16) — docs/projeto-unificado.md
--
--   · telemetry_logs.metric_type ganha as métricas do nobreak e da segurança:
--       battery_soc (%), battery_voltage (V), grid_voltage (V),
--       power_backup_w (W da saída do inversor em falta de energia), gas_lel (% LEL)
--     (sem esta migração o iot-gateway grava o status e avisa para executar a 025);
--   · fila de comandos (013/023/024): aparelhos com hw também mandam "armed" à tela
--     do quadro (alarme da casa no barramento B), além de "on" e "open".
-- Execute DEPOIS de 024_device_library.sql. Idempotente.
-- ============================================================

alter table public.telemetry_logs drop constraint if exists telemetry_logs_metric_type_check;
alter table public.telemetry_logs add constraint telemetry_logs_metric_type_check check (metric_type in (
  'energy_watts', 'water_flow_lph', 'temperature', 'humidity', 'water_level_pct',
  'battery_soc', 'battery_voltage', 'grid_voltage', 'power_backup_w', 'gas_lel'
));

-- ---- fila de comandos: válvulas (013) + aparelhos com hw (on / open / armed) ----
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
  elsif new.hw is not null
     and (new.status -> 'armed') is distinct from (old.status -> 'armed')
     and (new.status ->> 'armed') in ('off', 'home', 'away') then
    cmd := jsonb_build_object('armed', new.status -> 'armed');
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

notify pgrst, 'reload schema';
