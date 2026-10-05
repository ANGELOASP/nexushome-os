// ============================================================
// NexusHome OS — Bootstrap da aplicação (com gate de login)
// ------------------------------------------------------------
// Fluxo:
//   boot() → cria cliente (real/demo) → getSession()
//     · sessão válida  → enterApp() direto (pula o login)
//     · sem sessão     → showLogin()
//   onAuthStateChange: SIGNED_IN → enterApp / SIGNED_OUT → leaveApp
// ============================================================

import { state, on, emit } from './state.js';
import { createNexusClient } from './supabase-client.js';
import { toast } from './toasts.js';
import { initAuthUI, showLogin, hideLogin } from './auth.js';
import { initScene3D, selectRoom } from './scene3d.js';
import { initDevicesPanel } from './panels/devices.js';
import { initMonitorPanel, loadInitialMonitorData, subscribeTelemetry, updateHealthBadge } from './panels/monitor.js';
import { initAutomationsPanel, loadAutomations, subscribeAutomations } from './panels/automations.js';

let client = null;
let sceneApi = null;
let panelsReady = false;
let sceneReady = false;
let activeChannels = [];      // canais realtime para teardown no logout
let entering = false;

async function boot() {
  startClock();
  wireCollapsiblePanels();

  // UI de login pronta imediatamente (fica sob o overlay de loading)
  const clientReady = createNexusClient();
  initAuthUI({ getClient: () => clientReady });

  // conexão: Supabase real ou Modo Demonstração (transparente)
  client = await clientReady;
  state.mode = client.nexusMode || 'demo';
  if (state.mode === 'demo') document.getElementById('demo-banner')?.classList.remove('hidden');

  // sessão persistida? pula a tela de login
  const { data: { session } } = await client.auth.getSession();

  client.auth.onAuthStateChange((event, s) => {
    if (event === 'SIGNED_IN' && s) enterApp(s.user);
    if (event === 'SIGNED_OUT') leaveApp();
  });

  if (session) await enterApp(session.user);
  else showLogin();

  document.getElementById('loading')?.classList.add('loading-done');
}

// ------------------------------------------------------------
// Entrada no app (após autenticação)
// ------------------------------------------------------------

async function enterApp(user) {
  if (entering) return;
  entering = true;
  try {
    hideLogin();
    document.body.classList.add('authenticated');
    updateUserChip(user);

    // painéis e cena são inicializados uma única vez
    if (!panelsReady) {
      initDevicesPanel(client);
      initAutomationsPanel(client);
      initMonitorPanel(client);
      panelsReady = true;
    }

    // carga inicial
    const { data: devices, error } = await client.from('devices').select('*');
    if (!error && devices?.length) {
      state.devices = devices;
      emit('devices-changed', state.devices);
    }
    await Promise.all([loadAutomations(), loadInitialMonitorData()]);

    // realtime (re)assinatura
    activeChannels.forEach((ch) => { try { client.removeChannel?.(ch); } catch { /* noop */ } });
    activeChannels = [...subscribeTelemetry(), ...subscribeAutomations()];

    // cena 3D
    if (!sceneReady) {
      try {
        sceneApi = initScene3D(
          document.getElementById('scene-container'),
          document.getElementById('room-labels'),
          (room) => emit('room-selected', room)
        );
        sceneReady = true;
      } catch (err) {
        console.error('[3d] falha ao iniciar cena', err);
        toast('Visualização 3D indisponível', 'O painel de controle continua funcional.', 'warning');
      }
    }
    state.devices.forEach((d) => sceneApi?.applyDeviceState(d));

    // simulador de telemetria (somente no modo demo, e só após o login)
    if (state.mode === 'demo') {
      client.startSimulation?.();
      toast('Modo Demonstração ativo', 'Configure js/config.js para conectar ao seu Supabase.', 'info');
    }

    updateHealthBadge();
  } finally {
    entering = false;
  }
}

// ------------------------------------------------------------
// Saída (SIGNED_OUT): teardown limpo e volta ao login
// ------------------------------------------------------------

function leaveApp() {
  activeChannels.forEach((ch) => { try { client.removeChannel?.(ch); } catch { /* noop */ } });
  activeChannels = [];
  client.stopSimulation?.();

  document.body.classList.remove('authenticated');
  document.getElementById('user-chip')?.classList.add('hidden');
  showLogin();
  toast('Sessão encerrada', 'Você saiu do NexusHome OS.', 'info');
}

// ------------------------------------------------------------
// Chip de usuário na barra superior
// ------------------------------------------------------------

function updateUserChip(user) {
  const chip = document.getElementById('user-chip');
  const email = user?.email || 'usuário';
  const emailEl = document.getElementById('user-email');
  const avatarEl = document.getElementById('user-avatar');
  if (emailEl) emailEl.textContent = email;
  if (avatarEl) avatarEl.textContent = (email[0] || 'U').toUpperCase();
  chip?.classList.remove('hidden');
}

// ------------------------------------------------------------
// Relógio do topo (pt-BR)
// ------------------------------------------------------------

function startClock() {
  const el = document.getElementById('clock');
  const tick = () => {
    const now = new Date();
    if (el) {
      el.querySelector('[data-clock-time]').textContent = now.toLocaleTimeString('pt-BR');
      el.querySelector('[data-clock-date]').textContent = now.toLocaleDateString('pt-BR', {
        weekday: 'short', day: '2-digit', month: 'short',
      });
    }
  };
  tick();
  setInterval(tick, 1000);
}

// ------------------------------------------------------------
// Painéis recolhíveis (mobile e desktop)
// ------------------------------------------------------------

function wireCollapsiblePanels() {
  document.querySelectorAll('[data-collapse-target]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.collapseTarget);
      target?.classList.toggle('panel-collapsed');
      btn.classList.toggle('chevron-up');
    });
  });
  // em telas pequenas, painéis laterais começam recolhidos
  if (window.matchMedia('(max-width: 767px)').matches) {
    ['panel-devices', 'panel-monitor', 'panel-automations'].forEach((id) =>
      document.getElementById(id)?.classList.add('panel-collapsed'));
  }
}

// seleção de cômodo a partir do painel de dispositivos
on('ui-select-room', (room) => {
  if (sceneApi) selectRoom(state.selectedRoom === room ? null : room);
});

boot().catch((err) => {
  console.error('[boot] erro fatal', err);
  document.getElementById('loading')?.classList.add('loading-done');
  showLogin();
  toast('Erro ao iniciar', err.message, 'critical');
});
