-- Seed da planta "RESIDENCIA" (B9 da auditoria 027): só substitui a planta da conta
-- mais antiga e grava com dono. Rode com tests/sql/run_isolation.sh depois do seed.
\set ON_ERROR_STOP 1
create or replace function pg_temp.fail(msg text) returns void language plpgsql as $$ begin raise exception 'FALHOU: %', msg; end $$;
reset role;
-- a planta da outra conta não foi apagada
select case when (select count(*) from rooms where owner_id = '22222222-0000-4000-8000-000000000002' and name = 'Planta da conta 2') = 1
             and (select count(*) from walls where owner_id = '22222222-0000-4000-8000-000000000002') = 1
            then null else pg_temp.fail('B9 seed apagou a planta de outra conta') end;
-- os cômodos/paredes do seed foram para a conta mais antiga (nada sem dono)
select case when (select count(*) from rooms where owner_id = '11111111-0000-4000-8000-000000000001') = 10
             and (select count(*) from walls where owner_id = '11111111-0000-4000-8000-000000000001') = 129
             and (select count(*) from rooms where owner_id is null) = 0
             and (select count(*) from walls where owner_id is null) = 0
            then null else pg_temp.fail('B9 seed sem dono / contagem errada') end;
select 'OK: seed residencia por dono (B9)' as resultado;
