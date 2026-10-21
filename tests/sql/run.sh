#!/usr/bin/env bash
# Testa as migrações 007 (automações), 023 (circuitos elétricos), 024 (biblioteca ampliada), 025 (quadro unificado), 026 (iluminação) e 027 (auditoria, sem a 018) num Postgres descartável.
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
# 024 (biblioteca ampliada): tipos novos, ações novas e o "open" dos aparelhos com hw; as regras antigas seguem valendo
for m in 024_device_library 024_device_library; do
  $P -f "supabase/migrations/$m.sql" 2>&1 | grep -v NOTICE || true
done
$P -c "delete from alerts; update automations set is_active = false, last_met = null, last_fired_at = null"
$P -f tests/sql/automations.test.sql
$P -f tests/sql/biblioteca.test.sql
# 025 (quadro unificado): métricas do nobreak/gás e o "armed" do alarme; seeds elétrica + unificado (2x: idempotente)
for m in 025_quadro_unificado 025_quadro_unificado; do
  $P -f "supabase/migrations/$m.sql" 2>&1 | grep -v NOTICE || true
done
# 026 (iluminação): coluna lighting nos dispositivos (2x: idempotente)
for m in 026_iluminacao 026_iluminacao; do
  $P -f "supabase/migrations/$m.sql" 2>&1 | grep -v NOTICE || true
done
$P -f tests/sql/iluminacao.test.sql
for s in eletrica unificado unificado; do
  $P -f "supabase/seeds/$s.sql" > /dev/null
done
$P -f tests/sql/unificado.test.sql
$P -c "delete from alerts; update automations set is_active = false, last_met = null, last_fired_at = null"
$P -f tests/sql/automations.test.sql
# 027 (auditoria) sem a 018/020/auth (2x: idempotente): pula o que depende de dono e as regras antigas seguem valendo
for m in 027_auditoria 027_auditoria; do
  $P -f "supabase/migrations/$m.sql" 2>&1 | grep -v NOTICE || true
done
$P -c "delete from alerts; update automations set is_active = false, last_met = null, last_fired_at = null"
$P -f tests/sql/automations.test.sql
$P -f tests/sql/auditoria_sem_dono.test.sql
echo "OK — testes SQL passaram"
