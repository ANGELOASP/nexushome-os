-- ============================================================
-- NexusHome OS — 017_push_subscriptions.sql
-- Notificações push no celular/computador (v2.7): cada aparelho que
-- ativa "Notificações" no app grava aqui a sua inscrição Web Push.
-- A Edge Function notify-alert (webhook de INSERT em alerts) envia o
-- alerta para todas as inscrições — chega mesmo com o app fechado.
-- Execute DEPOIS de 016_scenes.sql. Idempotente.
-- ============================================================

create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid default auth.uid(),
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;
-- cada usuário vê e mexe só nas próprias inscrições; a notify-alert usa service_role
drop policy if exists "push_select_own" on public.push_subscriptions;
drop policy if exists "push_insert_own" on public.push_subscriptions;
drop policy if exists "push_update_own" on public.push_subscriptions;
drop policy if exists "push_delete_own" on public.push_subscriptions;
create policy "push_select_own" on public.push_subscriptions for select to authenticated using (user_id = auth.uid());
create policy "push_insert_own" on public.push_subscriptions for insert to authenticated with check (user_id = auth.uid());
create policy "push_update_own" on public.push_subscriptions for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "push_delete_own" on public.push_subscriptions for delete to authenticated using (user_id = auth.uid());

notify pgrst, 'reload schema';
