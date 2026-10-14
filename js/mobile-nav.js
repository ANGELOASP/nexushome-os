// ============================================================
// NexusHome OS — Navegação do celular (v2.15)
// ------------------------------------------------------------
// Abaixo de 900 px a interface vira um app de abas, como os apps de
// casa inteligente (Home Assistant, Apple Casa, SmartThings):
//   Casa (planta 3D + resumo) · Aparelhos · Rotinas · Monitor · Mais
// Os painéis continuam os mesmos do desktop: cada um diz a sua aba em
// data-mtab e esta camada só decide qual aparece. body.m-ui liga o CSS.
// ============================================================

import { state, on, emit } from './state.js';

export const MOBILE_QUERY = '(max-width: 899px)';
export const TABS = ['casa', 'dispositivos', 'rotinas', 'energia', 'mais'];
const TITLES = { dispositivos: 'Aparelhos', rotinas: 'Rotinas', energia: 'Monitor', mais: 'Mais' };
const HEALTH = { safe: 'Seguro', warning: 'Atenção', critical: 'Crítico' };

let current = 'casa';
let mq = null;

export function isMobileUI() { return document.body.classList.contains('m-ui'); }
export function currentTab() { return current; }

/** Qual aba mostra cada painel (data-mtab) — exportado para os testes. */
export function panelsForTab(tab, panels) {
  return panels.filter((p) => (p.dataset?.mtab || '').split(/\s+/).includes(tab));
}

export function setTab(tab, { focus = false } = {}) {
  if (!TABS.includes(tab)) tab = 'casa';
  current = tab;
  document.body.dataset.mtab = tab;
  document.querySelectorAll('.m-tab').forEach((b) => {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  const all = [...document.querySelectorAll('[data-mtab]')].filter((el) => el.classList.contains('panel'));
  const show = new Set(panelsForTab(tab, all));
  all.forEach((p) => p.classList.toggle('m-hide', !show.has(p)));
  // o trilho que tem algo para mostrar vira a "folha" da aba; o outro some
  document.querySelectorAll('.rail').forEach((rail) => {
    const has = [...rail.children].some((c) => show.has(c));
    rail.classList.toggle('m-sheet', has);
    const title = rail.querySelector('.m-sheet-title');
    if (title) title.textContent = TITLES[tab] || '';
    if (has) rail.scrollTop = 0;
    if (has && focus) title?.focus({ preventScroll: true });
  });
  emit('mobile-tab', isMobileUI() ? tab : 'casa');
}

function applyMode() {
  const mobile = mq.matches;
  document.body.classList.toggle('m-ui', mobile);
  if (mobile) setTab(current);
  else {
    document.querySelectorAll('.m-hide').forEach((p) => p.classList.remove('m-hide'));
    document.querySelectorAll('.rail').forEach((r) => r.classList.remove('m-sheet'));
    emit('mobile-tab', 'casa');
  }
}

/** Copia o texto dos números do painel Monitor para os chips do resumo. */
function mirrorStats() {
  document.querySelectorAll('[data-m-mirror]').forEach((dst) => {
    const src = document.getElementById(dst.dataset.mMirror);
    if (!src) return;
    const copy = () => { if (dst.textContent !== src.textContent) dst.textContent = src.textContent; };
    copy();
    new MutationObserver(copy).observe(src, { childList: true, characterData: true, subtree: true });
  });

  const badge = document.getElementById('health-badge');
  const chip = document.querySelector('[data-m-health]');
  const label = document.querySelector('[data-m-health-label]');
  const dot = document.querySelector('.m-tab[data-tab="energia"]');
  const sync = () => {
    const h = state.health && HEALTH[state.health] ? state.health : 'safe';
    if (chip) chip.dataset.level = h;
    if (label) label.textContent = HEALTH[h];
    dot?.classList.toggle('m-tab-alert', h !== 'safe');
    dot?.classList.toggle('m-tab-crit', h === 'critical');
  };
  sync();
  if (badge) new MutationObserver(sync).observe(badge, { attributes: true, attributeFilter: ['class'] });
}

/** Aba "Mais": conta, conexão e atalhos para o que no desktop fica na barra superior. */
function wireMore() {
  const email = document.getElementById('user-email');
  const avatar = document.getElementById('user-avatar');
  const conn = document.getElementById('conn-badge');
  const install = document.getElementById('btn-install');
  const sync = () => {
    const e = document.querySelector('[data-m-email]');
    const a = document.querySelector('[data-m-avatar]');
    const c = document.querySelector('[data-m-conn]');
    if (e && email) e.textContent = email.textContent || '—';
    if (a && avatar) a.textContent = avatar.textContent || 'U';
    if (c) {
      const live = state.mode === 'live';
      c.textContent = live ? 'Conectado ao servidor · tempo real' : 'Modo Demonstração · dados simulados';
      c.classList.toggle('m-conn-live', live);
    }
    document.querySelector('[data-m-action="install"]')?.classList.toggle('hidden', !install || install.classList.contains('hidden'));
  };
  sync();
  [email, avatar, conn, install].forEach((el) => el && new MutationObserver(sync).observe(el, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] }));

  const click = (id) => document.getElementById(id)?.click();
  document.querySelector('.m-more')?.addEventListener('click', (ev) => {
    const act = ev.target.closest('[data-m-action]')?.dataset.mAction;
    if (act === 'floorplan') click('btn-floorplan');
    else if (act === 'install') click('btn-install');
    else if (act === 'logout') click('btn-logout');
  });
}

export function initMobileNav() {
  // título grande no topo de cada folha (como os apps nativos)
  document.querySelectorAll('.rail').forEach((rail) => {
    if (rail.querySelector('.m-sheet-title')) return;
    const h = document.createElement('h2');
    h.className = 'm-sheet-title';
    h.tabIndex = -1;
    rail.prepend(h);
  });

  document.getElementById('m-tabbar')?.addEventListener('click', (ev) => {
    const tab = ev.target.closest('.m-tab')?.dataset.tab;
    if (tab) setTab(tab, { focus: true });
  });
  document.getElementById('m-summary')?.addEventListener('click', (ev) => {
    const tab = ev.target.closest('[data-goto]')?.dataset.goto;
    if (tab) setTab(tab, { focus: true });
  });

  // tocar num cômodo (na lista de aparelhos ou na cena) leva à planta
  on('room-selected', (room) => { if (room && isMobileUI() && current !== 'casa') setTab('casa'); });
  on('ui-select-room', () => { if (isMobileUI()) setTab('casa'); });

  mirrorStats();
  wireMore();

  mq = window.matchMedia(MOBILE_QUERY);
  mq.addEventListener?.('change', applyMode);
  applyMode();
}
