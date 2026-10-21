-- ============================================================
-- NexusHome OS — 027_auditoria.sql
-- Correções da auditoria do banco (out/2026): segurança e consistência.
--
--   B1 · device_pins (020) ganha dono: owner_id + política "owner_id = auth.uid()"
--        (antes qualquer conta logada lia/apagava os pinos de todas as casas).
--        Os pinos que já existem vão para a conta MAIS ANTIGA (mesma regra da 018).
--   B2 · alerts.device_id (opcional): alerta gravado pelo iot-gateway (sem login)
--        herda o dono do dispositivo, mesmo com várias casas no projeto.
--   B3 · run_automations ignora leituras com mais de 2 min (reenvio da fila
--        offline do ESP32 não dispara automação "agora").
--   B8 · leitura de dispositivo SEM dono só casa com regras SEM dono.
--   B4 · automations entra na publicação supabase_realtime (a lista atualiza
--        sozinha quando uma regra dispara no servidor).
--   B5 · RPC device_patch_status(p_device, p_patch): mescla atômica no status
--        (o app não regrava mais o JSON inteiro). SECURITY INVOKER: RLS vale.
--   B6 · índice device_commands (device_id) dos pendentes e a função
--        purge_old_rows() para limpar telemetria/comandos velhos (rodar à mão
--        ou agendar com pg_cron — nada é agendado aqui).
--   B7 · rooms_owner_name_key vira DEFERRABLE INITIALLY DEFERRED (trocar o nome
--        de dois cômodos entre si no mesmo salvamento deixa de falhar).
--
-- O app continua funcionando sem esta migração (usa o caminho antigo e avisa).
-- Execute DEPOIS de 026_iluminacao.sql. Idempotente (pode rodar de novo).
-- ============================================================

-- ---- B1: device_pins com dono --------------------------------------------
do $$
declare
  first_owner uuid;
  pol record;
begin
  if to_regclass('public.device_pins') is null then
    raise notice '027: tabela device_pins não existe (020 pendente) — pulando B1';
    return;
  end if;
  if to_regclass('auth.users') is null then
    raise notice '027: schema auth ausente — pulando B1';
    return;
  end if;

  execute 'alter table public.device_pins add column if not exists owner_id uuid default auth.uid() references auth.users(id) on delete cascade';
  execute 'create index if not exists device_pins_owner_idx on public.device_pins (owner_id)';

  -- pinos que já existem: conta mais antiga do projeto (a mesma regra da 018)
  execute 'select id from auth.users order by created_at limit 1' into first_owner;
  if first_owner is not null then
    execute 'update public.device_pins set owner_id = $1 where owner_id is null' using first_owner;
  end if;

  -- troca a política aberta (using true) pela do dono
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'device_pins' loop
    execute format('drop policy %I on public.device_pins', pol.policyname);
  end loop;
  execute 'alter table public.device_pins enable row level security';
  execute 'create policy device_pins_owner on public.device_pins for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid())';
  -- a PK continua sendo device_id (o app faz upsert onConflict 'device_id')
end $$;

-- ---- B2: alerts.device_id + dono derivado do dispositivo ------------------
alter table public.alerts add column if not exists device_id uuid references public.devices(id) on delete set null;
create index if not exists alerts_device_idx on public.alerts (device_id) where device_id is not null;

create or replace function public.alerts_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  owners uuid[];
  dev    uuid := (to_jsonb(new) ->> 'device_id')::uuid;
begin
  -- 1) dono do dispositivo do alerta (gateway / firmware passam device_id)
  if new.owner_id is null and dev is not null then
    select d.owner_id into new.owner_id from public.devices d where d.id = dev;
  end if;
  -- 2) dono da leitura que gerou o alerta (mesma transação da telemetria)
  if new.owner_id is null then
    new.owner_id := nullif(current_setting('nexus.owner', true), '')::uuid;
  end if;
  -- 3) casa única no projeto: o alerta é dela
  if new.owner_id is null then
    select array_agg(distinct owner_id) into owners from public.devices where owner_id is not null;
    if array_length(owners, 1) = 1 then new.owner_id := owners[1]; end if;
  end if;
  return new;
end;
$$;

-- o gatilho é da 018; só (re)cria se a tabela já tiver dono
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'alerts' and column_name = 'owner_id') then
    drop trigger if exists alerts_owner on public.alerts;
    create trigger alerts_owner before insert on public.alerts
      for each row execute function public.alerts_owner();
  end if;
end $$;
revoke all on function public.alerts_owner() from public, anon, authenticated;

-- ---- B3 + B8: automações do servidor (versão da 024 + guardas) -----------
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
  -- 027: leitura reenviada pela fila offline (created_at antigo) não dispara regra
  if new.created_at < now() - interval '2 minutes' then
    return new;
  end if;

  for a in
    select au.*, to_jsonb(au) ->> 'owner_id' as owner_txt
      from public.automations au
     where au.is_active
       and au.trigger_condition ->> 'metric' = new.metric_type
       and coalesce(au.trigger_condition ->> 'device_id', '') in ('', new.device_id::text)
       -- 027: leitura sem dono só casa com regra sem dono (antes casava com todas as casas)
       and (case when r_owner is null then to_jsonb(au) ->> 'owner_id' is null
                 else coalesce(to_jsonb(au) ->> 'owner_id', '') in ('', r_owner) end)
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

-- ---- B4: automations no Realtime -----------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice '027: publicação supabase_realtime não existe — pulando B4';
  elsif exists (select 1 from pg_publication where pubname = 'supabase_realtime' and puballtables) then
    null;   -- publicação "for all tables": automations já está nela
  elsif not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'automations') then
    begin
      alter publication supabase_realtime add table public.automations;
    exception when duplicate_object then null;
    end;
  end if;
end $$;

-- ---- B5: mescla atômica do status pelo app (RLS vale) --------------------
create or replace function public.device_patch_status(p_device uuid, p_patch jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  st jsonb;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'device_patch_status: p_patch precisa ser um objeto JSON'
      using errcode = '22023';
  end if;
  -- o gatilho queue_device_command (013/025) enfileira o comando normalmente
  update public.devices
     set status = coalesce(status, '{}'::jsonb) || p_patch
   where id = p_device
  returning status into st;
  return st;   -- null: dispositivo inexistente ou de outra conta (RLS)
end;
$$;

revoke all on function public.device_patch_status(uuid, jsonb) from public, anon;
grant execute on function public.device_patch_status(uuid, jsonb) to authenticated, service_role;

-- ---- B6: índice da fila e limpeza de linhas velhas -----------------------
create index if not exists device_commands_device_pending_idx
  on public.device_commands (device_id) where status = 'pending';

create or replace function public.purge_old_rows(p_telemetry_days int default 90, p_command_days int default 7)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n_tel integer;
  n_cmd integer;
begin
  if p_telemetry_days is null or p_telemetry_days < 1 or p_command_days is null or p_command_days < 1 then
    raise exception 'purge_old_rows: os prazos precisam ser de pelo menos 1 dia'
      using errcode = '22023';
  end if;
  delete from public.telemetry_logs
   where created_at < now() - make_interval(days => p_telemetry_days);
  get diagnostics n_tel = row_count;
  -- comandos pendentes nunca são apagados (a placa ainda vai buscá-los)
  delete from public.device_commands
   where status <> 'pending'
     and created_at < now() - make_interval(days => p_command_days);
  get diagnostics n_cmd = row_count;
  return jsonb_build_object('telemetry_logs', n_tel, 'device_commands', n_cmd);
end;
$$;

revoke all on function public.purge_old_rows(int, int) from public, anon, authenticated;
grant execute on function public.purge_old_rows(int, int) to service_role;

-- ---- B7: nome único por casa, conferido no fim da transação --------------
-- (nenhum upsert usa esta constraint como árbitro: o app faz upsert por id)
do $$
begin
  if to_regclass('public.rooms') is null
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'rooms' and column_name = 'owner_id') then
    raise notice '027: rooms sem owner_id (018 pendente) — pulando B7';
    return;
  end if;
  if exists (select 1 from pg_constraint
              where conname = 'rooms_owner_name_key' and conrelid = 'public.rooms'::regclass
                and condeferrable and condeferred) then
    return;   -- já é deferrable
  end if;
  alter table public.rooms drop constraint if exists rooms_owner_name_key;
  alter table public.rooms add constraint rooms_owner_name_key
    unique (owner_id, name) deferrable initially deferred;
end $$;

notify pgrst, 'reload schema';
