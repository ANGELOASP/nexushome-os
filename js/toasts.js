// ============================================================
// NexusHome OS — Notificações toast (canto inferior direito)
// ============================================================

const ICONS = {
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  critical: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
};

const COLORS = {
  success: 'text-emerald-300',
  info: 'text-cyan-300',
  warning: 'text-amber-300',
  critical: 'text-rose-300',
};

/**
 * Exibe um toast.
 * @param {string} title  Título em negrito
 * @param {string} message Texto secundário
 * @param {'success'|'info'|'warning'|'critical'} type
 */
export function toast(title, message = '', type = 'info') {
  const root = document.getElementById('toasts');
  if (!root) return;

  const el = document.createElement('div');
  el.className = 'toast glass rounded-xl px-4 py-3 flex items-start gap-3 shadow-2xl max-w-xs w-full pointer-events-auto';
  el.innerHTML = `
    <span class="toast-icon ${COLORS[type] || COLORS.info}">${ICONS[type] || ICONS.info}</span>
    <div class="min-w-0">
      <p class="text-sm font-semibold text-slate-100 leading-tight">${escapeHtml(title)}</p>
      ${message ? `<p class="text-xs text-slate-400 mt-0.5 leading-snug">${escapeHtml(message)}</p>` : ''}
    </div>`;
  root.appendChild(el);

  requestAnimationFrame(() => el.classList.add('toast-in'));
  setTimeout(() => {
    el.classList.remove('toast-in');
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 350);
  }, 4200);

  // no máximo 5 toasts empilhados
  while (root.children.length > 5) root.firstChild.remove();
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
