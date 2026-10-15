-- ============================================================
-- NexusHome OS — 026: circuitos de iluminação (v2.17)
-- ------------------------------------------------------------
-- Um dispositivo "light" passa a ser um CIRCUITO: várias luminárias que acendem
-- juntas e os pontos de onde ele é acionado (ferramenta Iluminação do Editor de Planta).
--   devices.lighting = {
--     "fixtures": [{ "model": "spot", "x": 1.2, "z": -3.4, "y": 2.5, "rot": null, "floor": 0 }, ...],
--     "switches": [{ "kind": "paralelo", "x": 0.1, "z": -2.0, "y": 1.1, "rot": 90, "floor": 0 }, ...],
--     "control":  { "mode": "parede" | "quadro" | "inteligente" }
--   }
-- A 1ª luminária continua em pos_x/pos_z/model (o app sem esta migração, o painel P4 e
-- as integrações seguem usando só esse ponto). Sem a 026, o app grava a planta sem o
-- campo e avisa "execute a migração 026".
-- Idempotente: pode rodar mais de uma vez.
-- ============================================================

alter table public.devices add column if not exists lighting jsonb;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'devices_lighting_object') then
    alter table public.devices add constraint devices_lighting_object
      check (lighting is null or jsonb_typeof(lighting) = 'object');
  end if;
end $$;

comment on column public.devices.lighting is
  'v2.17: circuito de iluminação — luminárias (fixtures), pontos de comando (switches) e modo de acionamento (control.mode)';

notify pgrst, 'reload schema';
