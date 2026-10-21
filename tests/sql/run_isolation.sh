#!/usr/bin/env bash
# Testa a migração 018 (isolamento por usuário), a 027 (auditoria) e o seed residencia num Postgres descartável.
# Uso: DATABASE_URL=postgres://... tests/sql/run_isolation.sh   (banco VAZIO de teste,
# NUNCA o de produção: o script cria tabelas, um schema auth falso e insere dados).
set -euo pipefail
: "${DATABASE_URL:?defina DATABASE_URL apontando para um banco de teste vazio}"
cd "$(dirname "$0")/../.."
P="psql $DATABASE_URL -v ON_ERROR_STOP=1 -q"
$P <<'SQL'
create extension if not exists "uuid-ossp";
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role bypassrls; end if;
  if not exists (select 1 from pg_publication where pubname='supabase_realtime') then create publication supabase_realtime; end if;
end $$;
-- auth "falso" (no Supabase real já existe): usuários + auth.uid() pelo claim sub
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text, created_at timestamptz default now());
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated, anon;
grant execute on function auth.uid() to authenticated, anon;
insert into auth.users values ('11111111-0000-4000-8000-000000000001','dono@x', now() - interval '1 day'),
                              ('22222222-0000-4000-8000-000000000002','outro@x', now()) on conflict do nothing;
SQL
# migrações até a 026 (estado de produção em out/2026)
for m in supabase/migrations/0*.sql; do
  [[ "$(basename "$m")" < "027" ]] || continue
  $P -f "$m" 2>&1 | grep -v NOTICE || true
done
# um pino de integrado gravado ANTES da 027 (sem dono): a 027 deve passá-lo à conta mais antiga
$P -c "insert into device_pins (device_id, pos_x, pos_z, pos_floor) values ('st-antigo', 2, 2, 0)"
# 027 (auditoria) DUAS vezes: idempotente; depois as migrações seguintes, se houver
for m in 027_auditoria 027_auditoria; do
  $P -f "supabase/migrations/$m.sql" 2>&1 | grep -v NOTICE || true
done
for m in supabase/migrations/0*.sql; do
  [[ "$(basename "$m")" > "027_auditoria.sql" ]] || continue
  $P -f "$m" 2>&1 | grep -v NOTICE || true
done
$P -f tests/sql/owner_isolation.test.sql | grep -E 'OK|FALHOU'
$P -f tests/sql/auditoria.test.sql | grep -E 'OK|FALHOU'
# seed da planta RESIDENCIA (B9): a conta 2 tem planta própria, que não pode sumir; 2x: idempotente
$P <<'SQL'
insert into rooms (owner_id, name, pos_x, pos_z, size_x, size_z, color)
  values ('22222222-0000-4000-8000-000000000002', 'Planta da conta 2', 0, 0, 3, 3, '#fff');
insert into walls (id, owner_id, floor, x1, z1, x2, z2, th)
  values ('e0000000-0000-4000-8000-0000000000d2', '22222222-0000-4000-8000-000000000002', 0, 0, 0, 3, 0, 0.1);
insert into rooms (owner_id, name, pos_x, pos_z, size_x, size_z, color) values (null, 'Órfão', 0, 0, 1, 1, '#fff');
SQL
for s in residencia residencia; do
  $P -f "supabase/seeds/$s.sql" > /dev/null
done
$P -f tests/sql/residencia.test.sql | grep -E 'OK|FALHOU'
