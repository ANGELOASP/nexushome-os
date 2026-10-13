// ============================================================
// NexusHome OS — App instalável (PWA) + notificações (v2.7)
//  · registra o service worker (só no build de produção)
//  · botão "Instalar app" quando o navegador oferece instalação
//  · "Notificações": alertas críticos (vazamento, pânico...) viram
//    notificação do sistema. Com VAPID configurado e Supabase ao
//    vivo, o aparelho também recebe push com o app FECHADO
//    (tabela push_subscriptions — migração 017 — + notify-alert).
// ============================================================

import { state, on } from './state.js';
import { toast } from './toasts.js';

const NOTIFY_KEY = 'nh_notify';
let client = null;
let reg = null;
let deferredInstall = null;

export function initPwa(nexusClient) {
  client = nexusClient;
  const btnInstall = document.getElementById('btn-install');
  const btnNotify = document.getElementById('btn-notify');

  if ('serviceWorker' in navigator && import.meta.env?.PROD) {
    navigator.serviceWorker.register('/sw.js').then((r) => { reg = r; }).catch((err) => console.warn('[pwa] service worker', err));
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    btnInstall?.classList.remove('hidden');
  });
  window.addEventListener('appinstalled', () => {
    btnInstall?.classList.add('hidden');
    toast('App instalado', 'O NexusHome já está na sua tela inicial.', 'success');
  });
  btnInstall?.addEventListener('click', async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice.catch(() => null);
    deferredInstall = null;
    btnInstall.classList.add('hidden');
  });

  syncNotifyBtn();
  btnNotify?.addEventListener('click', toggleNotifications);

  // alerta novo → notificação do sistema quando o app não está em foco
  on('alert-new', (a) => {
    if (!notifyEnabled() || a?.resolved) return;
    if (a.severity !== 'critical' && a.severity !== 'warning') return;
    if (document.visibilityState === 'visible' && document.hasFocus()) return;
    localNotify({
      title: a.severity === 'critical' ? 'NexusHome — CRÍTICO' : 'NexusHome — Atenção',
      body: a.message || 'Novo alerta',
      tag: `nh-alert-${a.id || Date.now()}`,
      severity: a.severity,
    });
  });
}

function notifyEnabled() {
  try { return localStorage.getItem(NOTIFY_KEY) === '1' && 'Notification' in window && Notification.permission === 'granted'; } catch { return false; }
}

function syncNotifyBtn() {
  const btn = document.getElementById('btn-notify');
  if (!btn) return;
  const supported = 'Notification' in window;
  btn.classList.toggle('hidden', !supported);
  const on = notifyEnabled();
  btn.classList.toggle('notify-on', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.title = on ? 'Notificações ativas — clique para desativar' : 'Receber alertas críticos como notificação';
  const lbl = btn.querySelector('[data-notify-label]');
  if (lbl) lbl.textContent = on ? 'Notificações ativas' : 'Ativar notificações';
}

async function localNotify(payload) {
  try {
    const r = reg || (await navigator.serviceWorker?.getRegistration?.());
    if (r) { await r.showNotification(payload.title, { body: payload.body, tag: payload.tag, icon: '/icons/icon-192.png', requireInteraction: payload.severity === 'critical' }); return; }
  } catch { /* cai para a API simples */ }
  try { new Notification(payload.title, { body: payload.body, tag: payload.tag, icon: '/icons/icon-192.png' }); } catch { /* sem suporte */ }
}

async function toggleNotifications() {
  if (notifyEnabled()) {
    try { localStorage.setItem(NOTIFY_KEY, '0'); } catch { /* noop */ }
    await unsubscribePush();
    syncNotifyBtn();
    toast('Notificações desativadas', 'Os alertas continuam aparecendo no app.', 'info');
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    toast('Permissão negada', 'Libere as notificações deste site nas configurações do navegador.', 'warning');
    syncNotifyBtn();
    return;
  }
  try { localStorage.setItem(NOTIFY_KEY, '1'); } catch { /* noop */ }
  syncNotifyBtn();
  const pushed = await subscribePush();
  toast('Notificações ativadas', pushed
    ? 'Você recebe alertas críticos mesmo com o app fechado.'
    : 'Alertas críticos aparecem como notificação enquanto o app estiver aberto (em segundo plano). Para receber com o app fechado, configure o push (docs).', 'success');
  localNotify({ title: 'NexusHome', body: 'Teste: as notificações estão funcionando.', tag: 'nh-test', severity: 'info' });
}

function vapidKey() {
  try { return (localStorage.getItem('nh_vapid_public_key') || window.NEXUSHOME_CONFIG?.VAPID_PUBLIC_KEY || '').trim(); } catch { return ''; }
}

function b64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Inscreve o aparelho no Web Push e grava em push_subscriptions (só modo ao vivo). */
async function subscribePush() {
  const key = vapidKey();
  if (!key || state.mode !== 'live' || !('PushManager' in window)) return false;
  try {
    const r = reg || (await navigator.serviceWorker.ready);
    const sub = (await r.pushManager.getSubscription()) || (await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) }));
    const j = sub.toJSON();
    const { error } = await client.from('push_subscriptions').upsert({
      endpoint: j.endpoint, p256dh: j.keys?.p256dh, auth: j.keys?.auth, user_agent: navigator.userAgent.slice(0, 200),
    }, { onConflict: 'endpoint' });
    if (error) throw new Error(error.message);
    return true;
  } catch (err) {
    console.warn('[pwa] push', err);
    toast('Push indisponível', `${err.message} — confira a migração 017_push_subscriptions.sql e a chave VAPID.`, 'warning');
    return false;
  }
}

async function unsubscribePush() {
  try {
    const r = reg || (await navigator.serviceWorker?.getRegistration?.());
    const sub = await r?.pushManager?.getSubscription();
    if (!sub) return;
    if (state.mode === 'live') await client.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
    await sub.unsubscribe();
  } catch { /* noop */ }
}
