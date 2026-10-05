// ============================================================
// NexusHome OS — Tela de Login (Supabase Auth ou Modo Demo)
// ------------------------------------------------------------
// initAuthUI({ getClient, onPasswordUpdated }) liga os handlers.
// O app (app.js) escuta auth.onAuthStateChange para abrir
// (SIGNED_IN) ou fechar (SIGNED_OUT) a central de controle.
//
// Views do card de login:
//   auth           Entrar / Criar conta (+ link "Esqueci minha senha")
//   recovery       pedir link de redefinição por e-mail
//   recovery-done  confirmação neutra (anti-enumeration)
//   reset          definir nova senha — exibida pelo app.js quando o
//                  link do e-mail abre o app (evento PASSWORD_RECOVERY
//                  ou hash #type=recovery)
// ============================================================

import { toast } from './toasts.js';

let deps = null;
let mode = 'login'; // 'login' | 'signup'
let view = 'auth';  // 'auth' | 'recovery' | 'recovery-done' | 'reset'

const VIEWS = ['auth', 'recovery', 'recovery-done', 'reset'];

export function initAuthUI(options) {
  deps = options;

  document.getElementById('tab-login')?.addEventListener('click', () => setMode('login'));
  document.getElementById('tab-signup')?.addEventListener('click', () => setMode('signup'));

  wirePasswordToggle('toggle-password', 'login-password', 'eye-open', 'eye-closed');
  wirePasswordToggle('toggle-reset-password', 'reset-password', 'eye-reset-open', 'eye-reset-closed');
  wirePasswordToggle('toggle-reset-confirm', 'reset-confirm', 'eye-confirm-open', 'eye-confirm-closed');

  document.getElementById('form-login')?.addEventListener('submit', onSubmit);
  document.getElementById('btn-logout')?.addEventListener('click', onLogout);

  // recuperação de senha (pedido de link por e-mail)
  document.getElementById('link-forgot')?.addEventListener('click', openRecovery);
  document.getElementById('form-recovery')?.addEventListener('submit', onRecoverySubmit);
  document.getElementById('link-back-login')?.addEventListener('click', backToLogin);
  document.getElementById('link-back-login-2')?.addEventListener('click', backToLogin);

  // redefinição de senha (landing do link enviado por e-mail)
  document.getElementById('form-reset')?.addEventListener('submit', onResetSubmit);
  document.getElementById('link-reset-new')?.addEventListener('click', openRecovery);
}

export function showLogin() {
  setView('auth');
  document.getElementById('login-screen')?.classList.remove('login-hidden');
  setTimeout(() => document.getElementById('login-email')?.focus(), 350);
}

export function hideLogin() {
  document.getElementById('login-screen')?.classList.add('login-hidden');
}

// Chamada pelo app.js quando o link de recuperação do e-mail abre o app
export function showResetView() {
  showLogin();      // garante a tela visível (view auth)…
  setView('reset'); // …e troca para a definição de nova senha
  setTimeout(() => document.getElementById('reset-password')?.focus(), 400);
}

// ------------------------------------------------------------
// Alternância de views do card
// ------------------------------------------------------------

function setView(next) {
  view = next;
  VIEWS.forEach((v) => document.getElementById(`login-view-${v}`)?.classList.toggle('hidden', v !== next));
  clearMessages();
}

// ------------------------------------------------------------
// Alternância Entrar / Criar conta (view auth)
// ------------------------------------------------------------

function setMode(next) {
  mode = next;
  const isLogin = mode === 'login';
  document.getElementById('tab-login')?.classList.toggle('login-tab-active', isLogin);
  document.getElementById('tab-signup')?.classList.toggle('login-tab-active', !isLogin);
  const label = document.getElementById('login-submit-label');
  if (label) label.textContent = isLogin ? 'Entrar' : 'Criar conta';
  document.getElementById('login-password')?.setAttribute('autocomplete', isLogin ? 'current-password' : 'new-password');
  document.getElementById('forgot-wrap')?.classList.toggle('hidden', !isLogin);
  clearMessages();
}

// ------------------------------------------------------------
// Mostrar/ocultar senha (genérico: login, nova senha, confirmação)
// ------------------------------------------------------------

function wirePasswordToggle(btnId, inputId, eyeOpenId, eyeClosedId) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.addEventListener('click', () => {
    const input = document.getElementById(inputId);
    if (!input) return;
    const visible = input.type === 'text';
    input.type = visible ? 'password' : 'text';
    document.getElementById(eyeOpenId)?.classList.toggle('hidden', !visible);
    document.getElementById(eyeClosedId)?.classList.toggle('hidden', visible);
  });
}

// ------------------------------------------------------------
// Submit: entrar / criar conta
// ------------------------------------------------------------

async function onSubmit(e) {
  e.preventDefault();
  clearMessages();

  const email = (document.getElementById('login-email')?.value || '').trim();
  const password = document.getElementById('login-password')?.value || '';

  if (!email || !email.includes('@')) return showError('Informe um e-mail válido');
  if (password.length < 6) return showError('Senha deve ter ao menos 6 caracteres');

  setLoading(true);
  try {
    const client = await deps.getClient();

    if (mode === 'signup') {
      const { data, error } = await client.auth.signUp({ email, password });
      if (error) { showError(translateError(error.message, error.status)); return; }
      if (!data?.session) {
        // Supabase com "Confirm email" ativado: sem sessão imediata
        showInfo('Conta criada! Verifique seu e-mail para confirmar o acesso.');
        setMode('login');
        return;
      }
      // sessão imediata: o evento SIGNED_IN abre o app
    } else {
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) { showError(translateError(error.message, error.status)); return; }
      // sessão aberta: o evento SIGNED_IN abre o app
    }
  } catch (err) {
    showError('Falha na autenticação. Tente novamente.');
    console.error('[auth]', err);
  } finally {
    setLoading(false);
  }
}

async function onLogout() {
  const btn = document.getElementById('btn-logout');
  if (btn) btn.disabled = true;
  try {
    const client = await deps.getClient();
    const { error } = await client.auth.signOut();
    if (error) throw new Error(error.message);
    // o evento SIGNED_OUT (app.js) faz o teardown e exibe o login
  } catch (err) {
    toast('Falha ao sair', err.message, 'critical');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ------------------------------------------------------------
// Recuperação de senha: pedido do link por e-mail
// ------------------------------------------------------------

async function openRecovery() {
  setView('recovery');
  // pré-preenche com o e-mail digitado na tela de login
  const loginEmail = (document.getElementById('login-email')?.value || '').trim();
  const recInput = document.getElementById('recovery-email');
  if (recInput && loginEmail && !recInput.value) recInput.value = loginEmail;
  setTimeout(() => recInput?.focus(), 100);
  // no Modo Demonstração, avisa que nenhum e-mail é enviado de verdade
  try {
    const client = await deps.getClient();
    document.getElementById('recovery-demo-note')?.classList.toggle('hidden', client.nexusMode !== 'demo');
  } catch { /* nota opcional */ }
}

function backToLogin() {
  setView('auth');
  setMode('login');
}

async function onRecoverySubmit(e) {
  e.preventDefault();
  clearMessages();

  const email = (document.getElementById('recovery-email')?.value || '').trim();
  if (!email || !email.includes('@')) return showError('Informe um e-mail válido', 'recovery-error');

  setLoading(true, 'btn-recovery-submit', 'recovery-spinner');
  try {
    const client = await deps.getClient();
    // origem dinâmica: funciona em localhost (dev) e no domínio da Vercel (prod)
    const redirectTo = window.location.origin + window.location.pathname;
    const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) { showError(translateError(error.message, error.status), 'recovery-error'); return; }
    // resposta neutra proposital: não revela se o e-mail existe (anti-enumeration)
    setView('recovery-done');
  } catch (err) {
    showError('Falha ao enviar o link. Tente novamente.', 'recovery-error');
    console.error('[auth recovery]', err);
  } finally {
    setLoading(false, 'btn-recovery-submit', 'recovery-spinner');
  }
}

// ------------------------------------------------------------
// Redefinição de senha (landing do link enviado por e-mail)
// ------------------------------------------------------------

async function onResetSubmit(e) {
  e.preventDefault();
  clearMessages();

  const password = document.getElementById('reset-password')?.value || '';
  const confirm = document.getElementById('reset-confirm')?.value || '';

  if (password.length < 6) return showError('Senha deve ter ao menos 6 caracteres', 'reset-error');
  if (password !== confirm) return showError('As senhas não coincidem', 'reset-error');

  setLoading(true, 'btn-reset-submit', 'reset-spinner');
  try {
    const client = await deps.getClient();
    const { data, error } = await client.auth.updateUser({ password });
    if (error) { showError(translateError(error.message, error.status), 'reset-error'); return; }
    // limpa o hash de recovery (#access_token=...&type=recovery) da URL
    try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch { /* noop */ }
    toast('Senha atualizada com sucesso!', 'Você já está autenticado com a nova senha.', 'success');
    // devolve ao app.js o usuário autenticado para entrar na central
    deps.onPasswordUpdated?.(data?.user);
  } catch (err) {
    showError('Falha ao salvar a nova senha. Tente novamente.', 'reset-error');
    console.error('[auth reset]', err);
  } finally {
    setLoading(false, 'btn-reset-submit', 'reset-spinner');
  }
}

// ------------------------------------------------------------
// Mensagens e estado de carregamento
// ------------------------------------------------------------

function showError(msg, elId = 'login-error') {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  el.classList.remove('shake');
  void el.offsetWidth; // reinicia a animação
  el.classList.add('shake');
}

function showInfo(msg, elId = 'login-info') {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}

function clearMessages() {
  ['login-error', 'login-info', 'recovery-error', 'reset-error'].forEach((id) =>
    document.getElementById(id)?.classList.add('hidden'));
}

function setLoading(loading, btnId = 'btn-login-submit', spinnerId = 'login-spinner') {
  const btn = document.getElementById(btnId);
  const spinner = document.getElementById(spinnerId);
  if (btn) {
    btn.disabled = loading;
    btn.classList.toggle('opacity-70', loading);
  }
  spinner?.classList.toggle('hidden', !loading);
}

// Erros comuns do Supabase Auth → pt-BR (mensagens do mock demo
// já vêm em pt-BR e passam inalteradas). HTTP 429 = rate limit.
function translateError(msg, status) {
  const m = String(msg || '').toLowerCase();
  if (status === 429 || m.includes('rate limit') || m.includes('too many requests') || m.includes('429')) {
    return 'Muitas tentativas. Aguarde alguns minutos e tente novamente.';
  }
  if (m.includes('invalid login credentials')) return 'E-mail ou senha incorretos';
  if (m.includes('email not confirmed')) return 'Confirme seu e-mail antes de entrar';
  if (m.includes('already registered') || m.includes('already been registered')) return 'Este e-mail já está cadastrado';
  if (m.includes('unable to validate email') || m.includes('invalid email')) return 'Informe um e-mail válido';
  if ((m.includes('token') && (m.includes('expired') || m.includes('invalid'))) || m.includes('otp expired')) {
    return 'Link de recuperação inválido ou expirado. Solicite um novo link.';
  }
  if (m.includes('auth session missing') || m.includes('session not found')) {
    return 'Sessão de recuperação não encontrada. Solicite um novo link.';
  }
  if (m.includes('password')) return 'Senha deve ter ao menos 6 caracteres';
  return msg || 'Falha na autenticação';
}
