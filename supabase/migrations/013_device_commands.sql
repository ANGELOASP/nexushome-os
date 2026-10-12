-- ============================================================
-- NexusHome OS — 013_device_commands.sql
-- Canal de comandos app → ESP32 (v2.5).
--
--   · Quando o status "open" de uma VÁLVULA muda por qualquer caminho que
--     não seja o próprio ESP32 (botão do app, automação do servidor, SQL),
--     um gatilho grava o pedido em device_commands.
--   · O ESP32 busca os pendentes em GET /iot-gateway/commands (x-device-key)
--     e os aplica. O gateway grava o que o ESP32 reporta pela função
--     device_report_status(), que NÃO gera comando (evita eco).
--   · Só o pedido mais recente por dispositivo vale: os anteriores ainda
--     pendentes viram "superseded".
-- Execute DEPOIS de 012_wall_height.sql. Idempotente.
-- ============================================================

create table if not exists public.device_commands (
  id            uuid primary key default gen_random_uuid(),
  device_id     uuid not null references public.devices(id) on delete cascade,
  command       jsonb not null,
  status        text not null default 'pending'
                check (status in ('pending', 'delivered', 'superseded')),
  created_at    timestamptz not null default now(),
  delivered_at  timestamptz
);
create index if not exists device_commands_pending_idx
  on public.device_commands (created_at) where status = 'pending';

alter table public.device_commands enable row level security;
drop policy if exists "device_commands_select_auth" on public.device_commands;
drop policy if exists "device_commands_insert_auth" on public.device_commands;
create policy "device_commands_select_auth" on public.device_commands for select to authenticated using (true);
create policy "device_commands_insert_auth" on public.device_commands for insert to authenticated with check (true);

-- Gatilho: válvula mudou de estado fora do ESP32 → comando pendente
create or replace function public.queue_valve_command()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.type = 'valve'
     and (new.status -> 'open') is distinct from (old.status -> 'open')
     and (new.status -> 'open') is not null
     and coalesce(current_setting('nexus.device_report', true), '') <> '1' then
    update public.device_commands set status = 'superseded'
     where device_id = new.id and status = 'pending';
    insert into public.device_commands (device_id, command)
    values (new.id, jsonb_build_object('open', new.status -> 'open'));
  end if;
  return new;
end;
$$;

drop trigger if exists devices_queue_valve_command on public.devices;
create trigger devices_queue_valve_command
  after update of status on public.devices
  for each row execute function public.queue_valve_command();

-- Escrita do estado REPORTADO pelo ESP32 (usada pelo iot-gateway): não gera comando
create or replace function public.device_report_status(p_device uuid, p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform set_config('nexus.device_report', '1', true);
  update public.devices
     set status = coalesce(status, '{}'::jsonb) || p_patch, is_online = true
   where id = p_device;
  perform set_config('nexus.device_report', '', true);
end;
$$;

revoke all on function public.queue_valve_command() from public, anon, authenticated;
revoke all on function public.device_report_status(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.device_report_status(uuid, jsonb) to service_role;

notify pgrst, 'reload schema';
