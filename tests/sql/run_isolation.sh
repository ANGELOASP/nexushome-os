#!/usr/bin/env bash
# Testa a migração 018 (isolamento por usuário) num Postgres descartável.
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
for m in supabase/migrations/0*.sql; do $P -f "$m" 2>&1 | grep -v NOTICE || true; done
$P -f tests/sql/owner_isolation.test.sql | grep -E 'OK|FALHOU'
