-- ============================================================
-- NexusHome OS — 018_owner_isolation.sql   (OPCIONAL · v2.7)
-- Isolamento por usuário (multi-residência): cada conta passa a ver e
-- editar SÓ a própria casa. Sem esta migração o app é single-tenant
-- (qualquer usuário autenticado lê/escreve tudo — veja o README).
--
-- O que faz:
--   1. coluna owner_id (dono) em todas as tabelas da casa, preenchida
--      automaticamente com auth.uid() em cada inserção feita pelo app;
--   2. os dados que JÁ EXISTEM ficam com a PRIMEIRA conta criada no
--      projeto (Authentication → Users, a mais antiga);
--   3. leituras do ESP32 (iot-gateway, service_role), comandos de
--      válvula e alertas herdam o dono do dispositivo;
--   4. as automações do servidor (007) só disparam dentro da mesma casa;
--   5. troca as políticas "qualquer autenticado" por "owner_id = auth.uid()";
--   6. nomes de cômodo passam a ser únicos POR casa.
--
-- ⚠ Antes de rodar: confira que a conta mais antiga do projeto é a SUA.
--   Depois de rodar, outra conta que entrar começa com a casa vazia.
--   Vários ESP32 de casas diferentes com o mesmo IOT_DEVICE_SECRET
--   continuam funcionando (cada leitura vai para o dono do device_id).
-- Execute DEPOIS de 017_push_subscriptions.sql. Idempotente.
-- ============================================================

do $$
declare
  t text;
  first_owner uuid;
  pol record;
begin
  select id into first_owner from auth.users order by created_at limit 1;

  foreach t in array array['devices','automations','telemetry_logs','alerts','rooms','walls','openings','furniture','scenes','device_commands'] loop
    if to_regclass('public.' || t) is null then
      raise notice '018: tabela % não existe (migração anterior pendente) — pulando', t;
      continue;
    end if;
    execute format('alter table public.%I add column if not exists owner_id uuid default auth.uid() references auth.users(id) on delete cascade', t);
    execute format('create index if not exists %I on public.%I (owner_id)', t || '_owner_idx', t);
    if first_owner is not null then
      execute format('update public.%I set owner_id = $1 where owner_id is null', t) using first_owner;
    end if;
    -- políticas: remove todas as antigas da tabela e cria a do dono
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', pol.policyname, t);
    end loop;
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid())', t || '_owner', t);
  end loop;

  -- cômodos: nome único por casa (antes era único no projeto inteiro)
  if to_regclass('public.rooms') is not null then
    alter table public.rooms drop constraint if exists rooms_name_key;
    if not exists (select 1 from pg_constraint where conname = 'rooms_owner_name_key') then
      alter table public.rooms add constraint rooms_owner_name_key unique (owner_id, name);
    end if;
  end if;
end $$;

-- ---- dono herdado do dispositivo (escritas sem login: ESP32 / gatilhos) ----
create or replace function public.owner_from_device()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- o dono é SEMPRE o do dispositivo (uma conta não grava leitura/comando na casa de outra)
  new.owner_id := coalesce((select owner_id from public.devices where id = new.device_id), new.owner_id);
  -- alertas gerados no mesmo comando (automação do servidor) herdam o dono
  perform set_config('nexus.owner', coalesce(new.owner_id::text, ''), true);
  return new;
end;
$$;

drop trigger if exists telemetry_owner on public.telemetry_logs;
create trigger telemetry_owner before insert on public.telemetry_logs
  for each row execute function public.owner_from_device();

do $$
begin
  if to_regclass('public.device_commands') is not null then
    drop trigger if exists device_commands_owner on public.device_commands;
    create trigger device_commands_owner before insert on public.device_commands
      for each row execute function public.owner_from_device();
  end if;
end $$;

create or replace function public.alerts_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  owners uuid[];
begin
  if new.owner_id is null then
    new.owner_id := nullif(current_setting('nexus.owner', true), '')::uuid;
  end if;
  if new.owner_id is null then
    -- casa única no projeto: o alerta é dela
    select array_agg(distinct owner_id) into owners from public.devices where owner_id is not null;
    if array_length(owners, 1) = 1 then new.owner_id := owners[1]; end if;
  end if;
  return new;
end;
$$;

drop trigger if exists alerts_owner on public.alerts;
create trigger alerts_owner before insert on public.alerts
  for each row execute function public.alerts_owner();

revoke all on function public.owner_from_device() from public, anon, authenticated;
revoke all on function public.alerts_owner() from public, anon, authenticated;

-- ---- automações do servidor (007) restritas à casa da leitura ----
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
begin
  for a in
    select *
      from public.automations
     where is_active
       and trigger_condition ->> 'metric' = new.metric_type
       -- 018: só as regras da MESMA casa da leitura
       and (new.owner_id is null or owner_id is null or owner_id = new.owner_id)
       and coalesce(trigger_condition ->> 'source', '') <> 'smartthings'
       and coalesce(action_payload ->> 'type', '') <> 'smartthings'
     order by created_at
       for update
  loop
    begin
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

      update public.devices set status = status || patch
       where id = dev_id and (a.owner_id is null or owner_id is null or owner_id = a.owner_id);
      get diagnostics n = row_count;
      if n = 0 then continue; end if;   -- dispositivo removido: não registra execução

      update public.automations set last_fired_at = now() where id = a.id;
      insert into public.alerts (severity, message, source_module, owner_id)
      values ('info', 'Automação executada no servidor: ' || a.name, 'automacao', coalesce(a.owner_id, new.owner_id));
    exception when others then
      raise warning 'run_automations: regra % falhou: %', a.id, sqlerrm;
    end;
  end loop;
  return new;
end;
$$;


revoke all on function public.run_automations() from public, anon, authenticated;

notify pgrst, 'reload schema';
