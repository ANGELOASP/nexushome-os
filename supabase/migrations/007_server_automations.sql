-- ============================================================
-- NexusHome OS — 007_server_automations.sql
-- Automações no SERVIDOR (v1.10.0): as regras IFTTT de métricas
-- nativas passam a ser avaliadas dentro do Postgres, a cada nova
-- linha em telemetry_logs — funcionam com a aba do navegador
-- fechada, venha a telemetria do ESP32 (iot-gateway) ou do painel
-- Tuya.
--
--   · Mesma semântica do avaliador do navegador: edge trigger
--     (só dispara na transição "condição falsa → verdadeira") e
--     cooldown de 20 s por regra.
--   · Ações suportadas: power (on), valve (open), temp, brightness
--     e color — viram um merge em devices.status, que o frontend
--     já recebe por realtime (a cena 3D reage como sempre).
--   · Cada execução registra um alerta informativo (alerts,
--     source_module = 'automacao').
--   · Regras SmartThings continuam no navegador: o token Samsung
--     fica só no localStorage do usuário (veja o README).
--   · Falha em uma regra (JSON malformado etc.) NUNCA bloqueia a
--     gravação da telemetria: vira WARNING no log do Postgres.
--
-- Execute DEPOIS de 006_walls.sql. Idempotente.
-- ============================================================

alter table public.automations
  add column if not exists last_met       boolean,
  add column if not exists last_fired_at  timestamptz;

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

      update public.devices set status = status || patch where id = dev_id;
      get diagnostics n = row_count;
      if n = 0 then continue; end if;   -- dispositivo removido: não registra execução

      update public.automations set last_fired_at = now() where id = a.id;
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

-- a função só deve ser acionada pelo trigger, nunca via RPC
revoke all on function public.run_automations() from public, anon, authenticated;
