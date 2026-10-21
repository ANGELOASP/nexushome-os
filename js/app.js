// ============================================================
// NexusHome OS — Bootstrap da aplicação (com gate de login)
// ------------------------------------------------------------
// Fluxo:
//   boot() → cria cliente (real/demo) → getSession()
//     · hash #type=recovery (link de e-mail) → showResetView()
//     · sessão válida  → enterApp() direto (pula o login)
//     · sem sessão     → showLogin()
//   onAuthStateChange: SIGNED_IN → enterApp / SIGNED_OUT → leaveApp
//                      PASSWORD_RECOVERY → showResetView
// ============================================================

import { state, on, emit, resetState } from './state.js';
import { createNexusClient } from './supabase-client.js';
import { toast } from './toasts.js';
import { initAuthUI, showLogin, hideLogin, showResetView } from './auth.js';
import { initScene3D, selectRoom, setRenderActive } from './scene3d.js';
import { initFloorplan, loadRooms, subscribeRooms, loadWalls, subscribeWalls, loadOpenings, subscribeOpenings, loadFurniture, subscribeFurniture } from './floorplan.js';
import { initDevicesPanel } from './panels/devices.js';
import { initRoomPanel } from './panels/room-panel.js';
import { initScenesPanel, loadScenes, subscribeScenes } from './panels/scenes.js';
import { initPwa, disablePushOnLogout } from './pwa.js';
import { initMobileNav, isMobileUI, setTab } from './mobile-nav.js';
import { loadDevicePins } from './device-pins-store.js';
import { initMonitorPanel, loadInitialMonitorData, subscribeTelemetry, updateHealthBadge } from './panels/monitor.js';
import { initAutomationsPanel, loadAutomations, subscribeAutomations } from './panels/automations.js';
import { initSmartThingsPanel, teardownSmartThings } from './panels/smartthings.js';
import { initTuyaPanel, teardownTuya } from './panels/tuya.js';
import { version as APP_VERSION } from '../package.json';

let client = null;
let sceneApi = null;
let panelsReady = false;
let sceneReady = false;
let activeChannels = [];      // canais realtime para teardown no logout
let entering = false;
let recoveryPending = false;  // link de recuperação de senha aberto (bloqueia enterApp)

// segredos das integrações gravados neste navegador (smartthings.js / tuya.js): saem no logout
const INTEGRATION_KEYS = ['nh_smartthings_token', 'nh_smartthings_links', 'nh_tuya_creds', 'nh_tuya_links'];

/** Selo do cabeçalho: verde "Supabase Live" com backend real, âmbar "Demo" no modo demonstração. */
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

async function boot() {
  startClock();
  wireCollapsiblePanels();
  initMobileNav();

  // UI de login pronta imediatamente (fica sob o overlay de loading)
  const clientReady = createNexusClient();
  initAuthUI({ getClient: () => clientReady, onPasswordUpdated, beforeLogout: disablePushOnLogout });
  initFloorplan({ getClient: () => clientReady });

  // conexão: Supabase real ou Modo Demonstração (transparente)
  client = await clientReady;
  state.mode = client.nexusMode || 'demo';
  updateConnectionBadge();
  if (state.mode === 'demo') document.getElementById('demo-banner')?.classList.remove('hidden');

  // Link de recuperação de senha abriu o app? (só com Supabase real: no modo
  // demo nenhum e-mail é enviado, então um hash #type=recovery não tem origem
  // válida e é descartado — jamais engole um fluxo live, pois aqui o modo já
  // é conhecido após o probe de conexão)
  if (window.location.hash.includes('type=recovery')) {
    if (state.mode !== 'demo') {
      recoveryPending = true;
    } else {
      try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch { /* noop */ }
    }
  }

  // listener registrado ANTES do getSession: o supabase-js processa o hash de
  // recovery na inicialização e dispara PASSWORD_RECOVERY de forma assíncrona
  client.auth.onAuthStateChange((event, s) => {
    if (event === 'PASSWORD_RECOVERY') { recoveryPending = true; showResetView(); return; }
    if (event === 'SIGNED_IN' && s) {
      if (recoveryPending) { showResetView(); return; } // sessão de recovery: não entrar no app ainda
      enterApp(s.user);
    }
    if (event === 'SIGNED_OUT') { recoveryPending = false; leaveApp(); }
  });

  // sessão persistida? pula a tela de login (exceto em fluxo de recuperação)
  const { data: { session } } = await client.auth.getSession();

  if (recoveryPending) showResetView();
  else if (session) await enterApp(session.user);
  else showLogin();

  document.getElementById('loading')?.classList.add('loading-done');
}

// ------------------------------------------------------------
// Senha redefinida com sucesso (auth.js → após updateUser):
// limpa o estado de recovery e entra na central já autenticado
// ------------------------------------------------------------

function onPasswordUpdated(user) {
  recoveryPending = false;
  if (user) { enterApp(user); return; }
  // fallback: reconsulta a sessão se o retorno não trouxe o usuário
  client.auth.getSession().then(({ data }) => {
    if (data?.session) enterApp(data.session.user);
  });
}

// ------------------------------------------------------------
// Entrada no app (após autenticação)
// ------------------------------------------------------------

async function enterApp(user) {
  if (entering) return;
  // já autenticado (ex.: demo updateUser dispara SIGNED_IN e o fluxo de
  // redefinição também chama onPasswordUpdated → enterApp)
  if (document.body.classList.contains('authenticated')) return;
  entering = true;
  try {
    hideLogin();
    document.body.classList.add('authenticated');
    updateUserChip(user);

    // planta da residência primeiro: painéis e cena 3D dependem dela
    await loadWalls(client);   // antes dos cômodos: a planta padrão só vale para quem não tem nada desenhado
    await loadRooms(client);
    await loadOpenings(client);
    await loadFurniture(client);

    // painéis e cena são inicializados uma única vez (mesmo se um falhar: repetir duplicaria os ouvintes)
    if (!panelsReady) {
      panelsReady = true;
      [initDevicesPanel, initAutomationsPanel, initScenesPanel, initPwa, initRoomPanel, initMonitorPanel, initSmartThingsPanel, initTuyaPanel]
        .forEach((init) => {
          try { init(client); } catch (err) { console.error('[painel] falha ao iniciar', init.name, err); }
        });
    }

    // carga inicial: lista vazia também substitui (nunca herda a casa do login anterior);
    // os integrados (st-/tuya-) que os painéis acabaram de pôr no estado continuam
    const { data: devices, error } = await client.from('devices').select('*');
    if (!error) {
      state.devices = [...(devices || []), ...state.devices.filter((d) => d.virtual)];
      emit('devices-changed', state.devices);
    } else {
      console.warn('[devices] falha na carga inicial', error.message);
    }
    await Promise.all([loadAutomations(), loadScenes(), loadInitialMonitorData(), loadDevicePins(client)]);

    // realtime (re)assinatura
    dropChannels();
    activeChannels = [...subscribeTelemetry(), ...subscribeAutomations(), ...subscribeScenes(), ...subscribeRooms(client), ...subscribeWalls(client), ...subscribeOpenings(client), ...subscribeFurniture(client)];

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
    setRenderActive(true);   // o logout pausa o loop de render
    state.devices.forEach((d) => sceneApi?.applyDeviceState(d));

    // simulador de telemetria (somente no modo demo, e só após o login)
    if (state.mode === 'demo') {
      client.startSimulation?.();
      const why = client.nexusDemoReason === 'no-config'
        ? 'Dados simulados neste navegador.'
        : 'Não foi possível falar com o servidor agora: mostrando dados simulados. Recarregue para tentar de novo.';
      toast('Modo Demonstração ativo', why, client.nexusDemoReason === 'no-config' ? 'info' : 'warning');
    }

    updateHealthBadge();
  } catch (err) {
    // sem isto a classe `authenticated` ficava ligada e o próximo SIGNED_IN parava no guarda do topo
    console.error('[app] falha ao abrir a central', err);
    document.body.classList.remove('authenticated');
    document.getElementById('user-chip')?.classList.add('hidden');
    showLogin();
    toast('Erro ao abrir a central', err?.message || String(err), 'critical');
  } finally {
    entering = false;
  }
}

/** Remove os canais realtime (removeChannel devolve promise: a rejeição não pode escapar). */
function dropChannels() {
  activeChannels.forEach((ch) => {
    try { Promise.resolve(client.removeChannel?.(ch)).catch(() => {}); } catch { /* noop */ }
  });
  activeChannels = [];
}

// ------------------------------------------------------------
// Saída (SIGNED_OUT): teardown limpo e volta ao login
// ------------------------------------------------------------

function leaveApp() {
  const wasIn = document.body.classList.contains('authenticated');
  dropChannels();
  client.stopSimulation?.();
  teardownSmartThings(); // encerra o polling de 30 s do painel SmartThings
  teardownTuya();        // idem: polling e deriva demo do painel Tuya
  disablePushOnLogout(); // logout por outra via (sessão expirada): ao menos este navegador para de receber
  setRenderActive(false);

  // aparelho compartilhado: o próximo login não herda a casa, os alertas nem os segredos do anterior
  if (sceneApi) selectRoom(null); else if (state.selectedRoom) emit('room-selected', null);
  resetState();
  try { INTEGRATION_KEYS.forEach((k) => localStorage.removeItem(k)); } catch { /* storage bloqueado */ }

  document.body.classList.remove('authenticated');
  document.getElementById('user-chip')?.classList.add('hidden');
  setTab('casa');
  showLogin();
  toast('Sessão encerrada', 'Você saiu do NexusHome OS.', 'info');
  // painéis (SmartThings, Tuya, editor, monitor) guardam caches em memória do módulo:
  // recarregar garante que nada do usuário anterior sobreviva na mesma aba
  if (wasIn) setTimeout(() => location.reload(), 800);   // só quem estava dentro (evita laço no boot)
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

const PANEL_IDS = ['panel-devices', 'panel-scenes', 'panel-automations', 'panel-monitor', 'panel-smartthings', 'panel-tuya'];
const PANEL_STATE_KEY = 'nh_panels_collapsed';

function loadPanelState() {
  try { return JSON.parse(localStorage.getItem(PANEL_STATE_KEY) || 'null'); } catch { return null; }
}
function savePanelState() {
  try {
    const st = {};
    PANEL_IDS.forEach((id) => { st[id] = !!document.getElementById(id)?.classList.contains('panel-collapsed'); });
    localStorage.setItem(PANEL_STATE_KEY, JSON.stringify(st));
  } catch { /* storage bloqueado */ }
}

function setPanelCollapsed(panel, collapsed) {
  panel.classList.toggle('panel-collapsed', collapsed);
  const btn = panel.querySelector('[data-collapse-target]');
  btn?.classList.toggle('chevron-up', collapsed);
  btn?.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  // a faixa livre da cena muda com os trilhos: reenquadra só se o usuário não mexeu na câmera
}

function wireCollapsiblePanels() {
  document.querySelectorAll('[data-collapse-target]').forEach((btn) => {
    const panel = document.getElementById(btn.dataset.collapseTarget);
    const header = btn.closest('.panel-header');
    const toggle = (ev) => {
      // cliques em controles dentro do cabeçalho (ex.: selo, "+ Dispositivo") não recolhem; o chevron sim
      const t = ev?.target;
      if (t?.closest?.('a, input, select, textarea, button') && !t.closest('[data-collapse-target]')) return;
      if (!panel || isMobileUI()) return;   // no celular cada aba mostra os painéis abertos
      setPanelCollapsed(panel, !panel.classList.contains('panel-collapsed'));
      savePanelState();
    };
    // o cabeçalho inteiro é a área de clique (antes só o ícone de 16 px funcionava)
    header?.addEventListener('click', toggle);
    if (header) {
      header.setAttribute('role', 'button');
      header.setAttribute('tabindex', '0');
      header.addEventListener('keydown', (e) => {
        // só com o foco no próprio cabeçalho: Enter num botão de dentro dispara o botão
        if (e.target !== header) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e); }
      });
    }
  });

  // estado inicial: o que o usuário deixou da última vez; senão, padrão por tamanho de tela
  const saved = loadPanelState();
  const small = window.matchMedia('(max-width: 899px)').matches;
  PANEL_IDS.forEach((id) => {
    const panel = document.getElementById(id);
    if (!panel) return;
    if (saved && id in saved) setPanelCollapsed(panel, !!saved[id]);
    else setPanelCollapsed(panel, small || id === 'panel-tuya' || id === 'panel-smartthings');
  });
}

// versão do app na barra superior
const verEl = document.getElementById('app-version');
if (verEl) verEl.textContent = `v${APP_VERSION}`;

// seleção de cômodo a partir do painel de dispositivos
on('ui-select-room', (room) => {
  if (sceneApi) selectRoom(state.selectedRoom === room ? null : room);
});

// gancho de desenvolvimento (testes de navegador): estado e seleção de cômodo
if (import.meta.env?.DEV) window.__nh = { state, selectRoom: (r) => selectRoom(r) };

boot().catch((err) => {
  console.error('[boot] erro fatal', err);
  document.getElementById('loading')?.classList.add('loading-done');
  showLogin();
  toast('Erro ao iniciar', err.message, 'critical');
});
