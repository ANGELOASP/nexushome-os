// ============================================================
// NexusHome OS — Tela de Login (Supabase Auth ou Modo Demo)
// ------------------------------------------------------------
// initAuthUI({ getClient }) liga os handlers do formulário.
// O app (app.js) escuta auth.onAuthStateChange para abrir
// (SIGNED_IN) ou fechar (SIGNED_OUT) a central de controle.
// ============================================================

import { toast } from './toasts.js';

let deps = null;
let mode = 'login'; // 'login' | 'signup'

export function initAuthUI(options) {
  deps = options;

  document.getElementById('tab-login')?.addEventListener('click', () => setMode('login'));
  document.getElementById('tab-signup')?.addEventListener('click', () => setMode('signup'));
  document.getElementById('toggle-password')?.addEventListener('click', togglePassword);
  document.getElementById('form-login')?.addEventListener('submit', onSubmit);
  document.getElementById('btn-logout')?.addEventListener('click', onLogout);
}

export function showLogin() {
  document.getElementById('login-screen')?.classList.remove('login-hidden');
  setTimeout(() => document.getElementById('login-email')?.focus(), 350);
}

export function hideLogin() {
  document.getElementById('login-screen')?.classList.add('login-hidden');
}

// ------------------------------------------------------------
// Alternância Entrar / Criar conta
// ------------------------------------------------------------

function setMode(next) {
  mode = next;
  const isLogin = mode === 'login';
  document.getElementById('tab-login')?.classList.toggle('login-tab-active', isLogin);
  document.getElementById('tab-signup')?.classList.toggle('login-tab-active', !isLogin);
  const label = document.getElementById('login-submit-label');
  if (label) label.textContent = isLogin ? 'Entrar' : 'Criar conta';
  document.getElementById('login-password')?.setAttribute('autocomplete', isLogin ? 'current-password' : 'new-password');
  clearMessages();
}

// ------------------------------------------------------------
// Mostrar/ocultar senha
// ------------------------------------------------------------

function togglePassword() {
  const input = document.getElementById('login-password');
  if (!input) return;
  const visible = input.type === 'text';
  input.type = visible ? 'password' : 'text';
  document.getElementById('eye-open')?.classList.toggle('hidden', !visible);
  document.getElementById('eye-closed')?.classList.toggle('hidden', visible);
}

// ------------------------------------------------------------
// Submit (entrar / criar conta)
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
      if (error) { showError(translateError(error.message)); return; }
      if (!data?.session) {
        // Supabase com "Confirm email" ativado: sem sessão imediata
        showInfo('Conta criada! Verifique seu e-mail para confirmar o acesso.');
        setMode('login');
        return;
      }
      // sessão imediata: o evento SIGNED_IN abre o app
    } else {
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) { showError(translateError(error.message)); return; }
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
// Mensagens e estado de carregamento
// ------------------------------------------------------------

function showError(msg) {
  const el = document.getElementById('login-error');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  el.classList.remove('shake');
  void el.offsetWidth; // reinicia a animação
  el.classList.add('shake');
}

function showInfo(msg) {
  const el = document.getElementById('login-info');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}

function clearMessages() {
  document.getElementById('login-error')?.classList.add('hidden');
  document.getElementById('login-info')?.classList.add('hidden');
}

function setLoading(loading) {
  const btn = document.getElementById('btn-login-submit');
  const spinner = document.getElementById('login-spinner');
  if (btn) {
    btn.disabled = loading;
    btn.classList.toggle('opacity-70', loading);
  }
  spinner?.classList.toggle('hidden', !loading);
}

// Erros comuns do Supabase Auth → pt-BR (mensagens do mock demo
// já vêm em pt-BR e passam inalteradas)
function translateError(msg) {
  const m = String(msg || '').toLowerCase();
  if (m.includes('invalid login credentials')) return 'E-mail ou senha incorretos';
  if (m.includes('email not confirmed')) return 'Confirme seu e-mail antes de entrar';
  if (m.includes('already registered') || m.includes('already been registered')) return 'Este e-mail já está cadastrado';
  if (m.includes('unable to validate email') || m.includes('invalid email')) return 'Informe um e-mail válido';
  if (m.includes('password')) return 'Senha deve ter ao menos 6 caracteres';
  return msg || 'Falha na autenticação';
}
