// ============================================================
// NexusHome OS — Bootstrap da aplicação
// ============================================================

import { state, on, emit, upsertDevice } from './state.js';
import { createNexusClient } from './supabase-client.js';
import { toast } from './toasts.js';
import { initScene3D, selectRoom } from './scene3d.js';
import { initDevicesPanel } from './panels/devices.js';
import { initMonitorPanel, loadInitialMonitorData, subscribeTelemetry, updateHealthBadge } from './panels/monitor.js';
import { initAutomationsPanel, loadAutomations, subscribeAutomations } from './panels/automations.js';

let client = null;
let sceneApi = null;

async function boot() {
  startClock();
  wireCollapsiblePanels();

  // conexão: Supabase real ou Modo Demonstração (transparente)
  client = await createNexusClient();
  state.mode = client.nexusMode || 'demo';
  updateConnectionBadge();

  // painéis sobem já com o cliente (real ou mock)
  initDevicesPanel(client);
  initAutomationsPanel(client);
  initMonitorPanel(client);

  // carga inicial
  const { data: devices, error } = await client.from('devices').select('*');
  if (error || !devices?.length) {
    console.warn('[boot] sem dispositivos; permanecendo com estado vazio');
  } else {
    state.devices = devices;
    emit('devices-changed', state.devices);
  }
  await Promise.all([loadAutomations(), loadInitialMonitorData()]);

  // realtime
  subscribeTelemetry();
  subscribeAutomations();

  // cena 3D
  try {
    sceneApi = initScene3D(
      document.getElementById('scene-container'),
      document.getElementById('room-labels'),
      (room) => emit('room-selected', room)
    );
    state.devices.forEach((d) => sceneApi.applyDeviceState(d));
  } catch (err) {
    console.error('[3d] falha ao iniciar cena', err);
    toast('Visualização 3D indisponível', 'O painel de controle continua funcional.', 'warning');
  }

  // seleção de cômodo a partir do painel de dispositivos
  on('ui-select-room', (room) => {
    if (sceneApi) selectRoom(state.selectedRoom === room ? null : room);
  });

  // simulador de telemetria (somente no modo demo)
  if (state.mode === 'demo') {
    client.startSimulation();
    toast('Modo Demonstração ativo', 'Configure js/config.js para conectar ao seu Supabase.', 'info');
  } else {
    toast('Conectado ao Supabase', 'Dados em tempo real ativos.', 'success');
  }

  updateHealthBadge();
  document.getElementById('loading')?.classList.add('loading-done');
}

// ------------------------------------------------------------
// Badge de conexão: ● Demo (âmbar) vs ● Supabase Live (verde)
// ------------------------------------------------------------

function updateConnectionBadge() {
  const el = document.getElementById('conn-badge');
  if (!el) return;
  if (state.mode === 'live') {
    el.className = 'conn-badge conn-live';
    el.innerHTML = '<span class="conn-dot"></span> Supabase Live';
    el.title = 'Conectado ao Supabase em tempo real';
  } else {
    el.className = 'conn-badge conn-demo';
    el.innerHTML = '<span class="conn-dot"></span> Demo';
    el.title = 'Modo Demonstração: dados simulados localmente no navegador';
  }
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

boot().catch((err) => {
  console.error('[boot] erro fatal', err);
  document.getElementById('loading')?.classList.add('loading-done');
  toast('Erro ao iniciar', err.message, 'critical');
});
