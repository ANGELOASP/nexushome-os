#!/usr/bin/env bash
# Testa as migrações 007 (trigger de automações) e 023 (circuitos elétricos) num Postgres descartável.
# Uso: DATABASE_URL=postgres://... tests/sql/run.sh   (use um banco VAZIO de teste,
# NUNCA o de produção: o script cria tabelas e insere dados).
set -euo pipefail
: "${DATABASE_URL:?defina DATABASE_URL apontando para um banco de teste vazio}"
cd "$(dirname "$0")/../.."
P="psql $DATABASE_URL -v ON_ERROR_STOP=1 -q"
$P <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role bypassrls; end if;
  if not exists (select 1 from pg_publication where pubname='supabase_realtime') then create publication supabase_realtime; end if;
end $$;
SQL
for m in 001_init 005_water_level_metric 007_server_automations 007_server_automations; do
  $P -f "supabase/migrations/$m.sql" 2>&1 | grep -v NOTICE || true
done
$P -f tests/sql/automations.test.sql
# 023 sobre a 007 (sem a 018): as regras antigas continuam valendo + circuitos e filtro de medidor
for m in 013_device_commands 021_device_catalog 023_eletrica 023_eletrica; do
  $P -f "supabase/migrations/$m.sql" 2>&1 | grep -v NOTICE || true
done
$P -c "delete from alerts; update automations set is_active = false, last_met = null, last_fired_at = null"
$P -f tests/sql/automations.test.sql
$P -f tests/sql/eletrica.test.sql
echo "OK — testes SQL passaram"
