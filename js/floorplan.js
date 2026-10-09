// ============================================================
// NexusHome OS — Editor de Planta 3.2 (v1.9.2)
// ------------------------------------------------------------
// Editor 2D top-down em canvas, agora com modelo vetorial de
// PAREDES estilo CAD (AutoCAD/SketchUp/Promob): cada parede é
// um segmento de linha de centro com espessura, desenhado com
// ferramenta própria (clique-clique), trava de eixo 0°/90°/45°,
// atração magnética a endpoints e medida ao vivo.
//
//   · FERRAMENTAS: Selecionar (V) · Parede (W) · Cômodo (R) · Apagar (E)
//     — Cômodo (R): clique-clique (como a Parede) ou arrasto, com
//       snap magnético às paredes (endpoints e corpo do segmento);
//       presets continuam no botão "Adicionar cômodo"
//   · PAREDES: tabela `walls` (Supabase), espessura 0,15 m,
//     render branco CAD com contorno; endpoint arrastável
//   · PRESETS de cômodo (kind): paleta com nome/cor/ícone/tamanho
//     padrão — sala, quarto, suíte, banheiro, garagem, varanda…
//   · ANDARES (floor): abas Térreo / 1º / 2º andar; cada cômodo
//     pertence a um andar; a cena 3D empilha os andares
//   · UNDO/REDO: Ctrl+Z / Ctrl+Shift+Z + botões (50 passos)
//   · ZOOM & PAN: roda do mouse (zoom no cursor), arrastar o
//     espaço vazio ou botão do meio para mover a vista
//   · GUIAS DE ALINHAMENTO: bordas/centros de outros cômodos do
//     mesmo andar atraem com linhas ciano (6 px); snap na grade
//     de 0,5 m é opcional (checkbox "Snap")
//   · FUNDO DE REFERÊNCIA: imagem da planta CAD sob a grade,
//     com calibração de escala, transparência e deslocamento
//   · PAINEL DE PRECISÃO: X, Y, Largura, Profundidade (0,1 m) e
//     área ao vivo; área total por andar na barra de ferramentas
//   · Duplicar (Ctrl+D), setas movem 0,5 m (Shift = 0,1 m)
//   · sobreposição (no mesmo andar) é revertida com flash vermelho
//   · Salvar → persiste (live: delete + insert/update; demo: localStorage)
//   · 'rooms-changed' reconstrói a cena 3D e o painel de dispositivos
// ============================================================

import {
  state, setRooms, DEFAULT_ROOMS, emit,
  ROOM_PRESETS, MAX_FLOORS, floorLabel, presetByKind, normalizeRoom,
} from './state.js';
import { toast } from './toasts.js';
import {
  isPoly, polyAbs, setPolyAbs, pointInPoly, polyArea, polyCentroid, distToSegment,
  cleanPoly, isSimplePoly, rectToPoints, roomArea, MIN_POLY_AREA,
} from './geometry.js';
import { initDxfImport } from './dxf-import.js';

const CELL_M = 0.5;        // 1 célula da grade = 0,5 m
const MIN_SIZE = 1.0;      // tamanho mínimo do cômodo (m)
const MAX_SIZE = 12.0;     // tamanho máximo (m)
const HANDLE_M = 0.45;     // alça de resize, em metros de tela-mundo
const SNAP_PX = 6;         // raio de atração das guias de alinhamento (px de tela)
const HISTORY_CAP = 50;    // passos de undo/redo
const ZOOM_MIN = 4;        // px por metro (plantas grandes)
const ZOOM_MAX = 400;
const ZOOM_REF = 48;       // 100% = 48 px por metro
const HIT_PX = 9;          // raio de captura de alças/vértices/paredes, em px de tela
const BG_KEY = 'nh_floorplan_bg';   // fundo de referência (localStorage)

// fundo de referência: imagem da planta CAD sob a grade
let bg = { img: null, dataUrl: '', opacity: 0.4, widthM: 14, offX: 0, offZ: 0, visible: true };

// paredes (modelo vetorial CAD): { id, floor, x1,z1,x2,z2, th, sort_order }
let wallsLive = [];        // paredes salvas (Supabase / demo)
let wallsDraft = [];       // cópia de trabalho enquanto o editor está aberto
let wallsBaseline = [];    // paredes no momento em que o modal abriu
const selWalls = new Set();   // ids das paredes selecionadas (várias: Shift+clique ou caixa)
let hoverWallId = null;
let marquee = null;         // { x0, z0, x1, z1 } em metros — caixa de seleção (Shift+arrasto)
let zoomAnim = null;        // animação de zoom/enquadramento
let spaceDown = false;      // Espaço segurado: arrastar = mover a vista
const pointers = new Map(); // ponteiros ativos (pinça com dois dedos)
let pinch = null;
let wallFormSnap = null;
let drawQueued = false;
let tool = 'select';       // 'select' | 'wall' | 'erase' | 'room'
let wallDraw = null;       // { x1, z1 } — primeiro clique da ferramenta Parede
let wallHover = null;      // { x, z } — ponto sob o cursor (preview da parede)
let roomDraw = null;       // { x1, z1, x2, z2, armed, snapBefore } — borracha da ferramenta Cômodo
let polyDraw = null;       // { pts:[[x,z],...], hover:[x,z]|null, snapBefore } — ferramenta Polígono (P)
const VERTEX_R = 0.35;     // raio de captura de vértice (m)
let polyHover = null;      // [x,z] sob o cursor na ferramenta Polígono
const WALL_TH = 0.15;      // espessura padrão da parede (m)
const WALL_SNAP = 0.05;    // snap fino de endpoints de parede (m)
const AXIS_LOCK_DEG = 8;   // trava de eixo 0°/90°/45° (SketchUp-style)

let getClient = null;
let modal, canvas, ctx, formEl, presetsEl;
let draft = [];            // cópia de trabalho de state.rooms (todos os andares)
let baseline = [];         // planta no momento em que o modal abriu
let selectedId = null;
let currentFloor = 0;
let snapEnabled = true;
let view = { scale: 48, cx: 0, cz: 0 };   // px por metro + centro do mundo visível
let drag = null;           // { mode:'move'|'resize'|'pan', ... , snapBefore }
let guides = [];           // guias de alinhamento ativas [{axis:'x'|'z', pos}]
let flashUntil = 0;        // timestamp do flash vermelho de sobreposição
let rafId = 0;
let saving = false;

// histórico snapshot-based (JSON do rascunho + andar corrente)
const history = { past: [], future: [] };
let formSnap = null;       // snapshot ao focar um campo do formulário
let nudgeSnap = null;      // snapshot do primeiro nudge de uma rajada de setas
let nudgeTimer = 0;

// ------------------------------------------------------------
// API pública
// ------------------------------------------------------------

export function initFloorplan({ getClient: gc } = {}) {
  getClient = gc;
  modal = document.getElementById('editor-planta');
  canvas = document.getElementById('fp-canvas');
  formEl = document.getElementById('fp-form');
  presetsEl = document.getElementById('fp-presets');
  if (!modal || !canvas) return;
  ctx = canvas.getContext('2d');

  document.getElementById('btn-floorplan')?.addEventListener('click', openEditor);
  document.getElementById('btn-fp-close')?.addEventListener('click', closeEditor);
  document.getElementById('btn-fp-save')?.addEventListener('click', savePlan);
  document.getElementById('btn-fp-reset')?.addEventListener('click', resetDefault);
  document.getElementById('btn-fp-add')?.addEventListener('click', togglePresets);
  document.getElementById('btn-fp-delete')?.addEventListener('click', deleteSelected);
  document.getElementById('btn-fp-dup')?.addEventListener('click', duplicateSelected);
  document.getElementById('btn-fp-undo')?.addEventListener('click', undo);
  document.getElementById('btn-fp-redo')?.addEventListener('click', redo);
  document.getElementById('btn-fp-fit')?.addEventListener('click', fitAllAnimated);
  document.getElementById('fp-snap')?.addEventListener('change', (e) => { snapEnabled = !!e.target.checked; });

  // ferramentas estilo CAD: Selecionar (V) · Parede (W) · Cômodo (R) · Apagar (E)
  document.getElementById('btn-fp-tool-select')?.addEventListener('click', () => setTool('select'));
  document.getElementById('btn-fp-tool-wall')?.addEventListener('click', () => setTool('wall'));
  document.getElementById('btn-fp-tool-room')?.addEventListener('click', () => setTool('room'));
  document.getElementById('btn-fp-tool-erase')?.addEventListener('click', () => setTool('erase'));
  document.getElementById('btn-fp-tool-poly')?.addEventListener('click', () => setTool('poly'));
  document.getElementById('btn-fp-topoly')?.addEventListener('click', convertToPolygon);
  initDxfImport({
    getContext: () => ({ floor: currentFloor, rooms: draft, walls: wallsDraft }),
    apply: applyDxfImport,
  });

  // fundo de referência (imagem da planta CAD)
  document.getElementById('btn-fp-bg')?.addEventListener('click', toggleBgPanel);
  document.getElementById('fp-bg-file')?.addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) setBgFromFile(f);
    e.target.value = '';
  });
  document.getElementById('btn-fp-bg-remove')?.addEventListener('click', removeBg);
  document.getElementById('fp-bg-opacity')?.addEventListener('input', (e) => {
    bg.opacity = clamp(Number(e.target.value) / 100, 0.05, 1); saveBg(); draw();
  });
  document.getElementById('fp-bg-width')?.addEventListener('input', (e) => {
    const v = parseFloat(String(e.target.value).replace(',', '.'));
    if (!Number.isFinite(v)) return;
    bg.widthM = clamp(v, 1, 60); saveBg(); draw();
  });
  document.getElementById('fp-bg-ox')?.addEventListener('input', (e) => {
    const v = parseFloat(String(e.target.value).replace(',', '.'));
    if (!Number.isFinite(v)) return;
    bg.offX = clamp(v, -60, 60); saveBg(); draw();
  });
  document.getElementById('fp-bg-oz')?.addEventListener('input', (e) => {
    const v = parseFloat(String(e.target.value).replace(',', '.'));
    if (!Number.isFinite(v)) return;
    bg.offZ = clamp(v, -60, 60); saveBg(); draw();
  });
  document.getElementById('fp-bg-visible')?.addEventListener('change', (e) => {
    bg.visible = !!e.target.checked; saveBg(); draw();
  });
  loadBg();

  buildPresetsPanel();

  // select de tipo do cômodo no formulário lateral
  const kindSel = document.getElementById('fp-in-kind');
  if (kindSel && !kindSel.options.length) {
    kindSel.innerHTML = ROOM_PRESETS
      .map((p) => `<option value="${p.kind}">${p.label}</option>`)
      .join('');
  }

  // formulário lateral: edição em tempo real do rascunho
  formEl?.addEventListener('focusin', () => { if (!formSnap) formSnap = snapshot(); });
  document.getElementById('fp-in-name')?.addEventListener('input', (e) => {
    const r = sel(); if (!r) return;
    r.name = e.target.value.slice(0, 40);
    draw();
  });
  document.getElementById('fp-in-name')?.addEventListener('change', commitFormChange);
  document.getElementById('fp-in-color')?.addEventListener('input', (e) => {
    const r = sel(); if (!r) return;
    r.color = e.target.value;
    draw();
  });
  document.getElementById('fp-in-color')?.addEventListener('change', commitFormChange);
  document.getElementById('fp-in-kind')?.addEventListener('change', (e) => {
    const r = sel(); if (!r) return;
    const preset = presetByKind(e.target.value);
    r.kind = preset.kind;
    if (preset.kind !== 'personalizado') r.color = preset.color; // o preset dita a cor inicial
    commitFormChange();
    draw();
  });
  document.getElementById('fp-in-floor')?.addEventListener('change', (e) => {
    const r = sel(); if (!r) return;
    const target = clamp(Math.trunc(Number(e.target.value) || 0), 0, MAX_FLOORS - 1);
    if (target === r.floor) return;
    const prev = r.floor;
    r.floor = target;
    if (hasOverlap(r.id)) {
      r.floor = prev;
      e.target.value = String(prev);
      flash(); draw();
      toast('Sobreposição evitada', `“${r.name}” ficaria sobre outro cômodo no ${floorLabel(target)}.`, 'warning');
      return;
    }
    commitFormChange();
    currentFloor = target; // segue o cômodo para o andar de destino
    renderFloorTabs();
    syncToolbar();
    draw();
  });

  // campos de precisão: X, Y, Largura, Profundidade (0,1 m)
  const precMap = { 'fp-in-px': 'pos_x', 'fp-in-pz': 'pos_z', 'fp-in-sx': 'size_x', 'fp-in-sz': 'size_z' };
  Object.entries(precMap).forEach(([id, key]) => {
    document.getElementById(id)?.addEventListener('input', (e) => {
      const r = sel(); if (!r) return;
      const v = parseFloat(String(e.target.value).replace(',', '.'));
      if (!Number.isFinite(v)) return;
      const prev = r[key];
      const isSize = key.startsWith('size');
      r[key] = isSize ? clamp(v, MIN_SIZE, MAX_SIZE) : clamp(v, -40, 40);
      if (hasOverlap(r.id)) {
        r[key] = prev;
        flash();
      }
      syncArea(r);
      draw();
    });
    document.getElementById(id)?.addEventListener('change', (e) => {
      const r = sel(); if (!r) { commitFormChange(); return; }
      e.target.value = fmt1(r[key]);
      commitFormChange();
      draw();
    });
  });

  // interações no canvas
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('dblclick', onDblClick);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('resize', () => { if (isOpen()) { sizeCanvas(); draw(); } });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ' && spaceDown) { spaceDown = false; if (canvas && !drag) canvas.style.cursor = 'default'; }
  });
  window.addEventListener('blur', () => { spaceDown = false; });

  // controles de zoom
  document.getElementById('btn-fp-zoom-in')?.addEventListener('click', () => zoomCenter(1.25));
  document.getElementById('btn-fp-zoom-out')?.addEventListener('click', () => zoomCenter(1 / 1.25));
  document.getElementById('btn-fp-zoom-pct')?.addEventListener('click', () => {
    zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, ZOOM_REF / view.scale, 200);   // volta a 100%
  });
  document.getElementById('btn-fp-zoom-fit')?.addEventListener('click', fitAllAnimated);
  document.getElementById('btn-fp-zoom-sel')?.addEventListener('click', fitSelection);
  initWallPanel();
  // gancho de depuração/teste (só no `vite dev`; some do build de produção)
  if (import.meta.env?.DEV) window.__fp = { w2sx, w2sz, s2wx, s2wz, get view() { return view; }, get walls() { return wallsDraft; }, get rooms() { return draft; }, get sel() { return [...selWalls]; } };
}

/** Carrega a planta da tabela rooms (live) ou do mock (demo). */
export async function loadRooms(client) {
  try {
    const { data, error } = await client.from('rooms').select('*').order('sort_order');
    if (error) throw new Error(error.message);
    setRooms(data?.length ? data : DEFAULT_ROOMS);
  } catch (err) {
    console.error('[planta] falha ao carregar rooms', err);
    setRooms(DEFAULT_ROOMS);
    toast('Planta padrão carregada', 'Não foi possível ler a tabela rooms.', 'warning');
  }
}

/** Assina mudanças da tabela rooms em tempo real. Retorna [canal]. */
export function subscribeRooms(client) {
  const ch = client
    .channel('rooms-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms' }, () => loadRooms(client))
    .subscribe();
  return [ch];
}

/** Carrega as paredes da tabela walls (live). Demo: lista vazia. */
export async function loadWalls(client) {
  try {
    const { data, error } = await client.from('walls').select('*').order('sort_order');
    if (error) throw new Error(error.message);
    wallsLive = (data || []).map(normalizeWall);
  } catch (err) {
    console.error('[planta] falha ao carregar walls', err);
    wallsLive = [];
  }
  state.walls = wallsLive;
  emit('walls-changed', state.walls);   // a cena 3D reconstrói as paredes
}

/** Assina mudanças da tabela walls em tempo real. Retorna [canal]. */
export function subscribeWalls(client) {
  const ch = client
    .channel('walls-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'walls' }, () => loadWalls(client))
    .subscribe();
  return [ch];
}

function normalizeWall(w) {
  return {
    id: w.id, floor: Number(w.floor) || 0,
    x1: Number(w.x1), z1: Number(w.z1), x2: Number(w.x2), z2: Number(w.z2),
    th: Number(w.th) || WALL_TH, sort_order: w.sort_order ?? 0,
  };
}

// ------------------------------------------------------------
// Abrir / fechar
// ------------------------------------------------------------

function isOpen() { return modal?.classList.contains('modal-open'); }

function openEditor() {
  baseline = (state.rooms.length ? state.rooms : DEFAULT_ROOMS).map(normalizeRoom);
  draft = baseline.map((r) => ({ ...r }));
  wallsBaseline = wallsLive.map((w) => ({ ...w }));
  wallsDraft = wallsBaseline.map((w) => ({ ...w }));
  currentFloor = Math.min(maxFloorUsed(), currentFloor);
  if (!draft.some((r) => r.floor === currentFloor)) currentFloor = 0;
  selectedId = null;
  selWalls.clear();
  wallDraw = null;
  wallHover = null;
  roomDraw = null;
  polyDraw = null;
  setTool('select');
  history.past = [];
  history.future = [];
  formSnap = null;
  hideForm();
  hidePresets();
  modal.classList.add('modal-open');
  emit('editor-open', true);   // a cena 3D pausa (o editor ocupa a tela e disputa a GPU)
  sizeCanvas();
  fitView();
  renderFloorTabs();
  syncToolbar();
  startLoop();
  if (state.mode === 'demo') {
    toast('Modo Demonstração', 'A planta salva fica apenas neste navegador. Conecte ao Supabase em Conexões para sincronizar.', 'warning');
  }
}

function closeEditor() {
  if (saving) return;
  modal.classList.remove('modal-open');
  emit('editor-open', false);
  stopLoop();
  draft = [];
  wallsDraft = [];
  selectedId = null;
  selWalls.clear();
  wallDraw = null;
  wallHover = null;
  roomDraw = null;
  polyDraw = null;
  hideForm();
  hidePresets();
  hideBgPanel();
}

// ------------------------------------------------------------
// Ferramentas (Selecionar / Parede / Cômodo / Apagar)
// ------------------------------------------------------------

function setTool(t) {
  tool = t;
  wallDraw = null;
  wallHover = null;
  roomDraw = null;
  polyDraw = null;
  if (t !== 'select') { select(null); selWalls.clear(); }
  const map = { select: 'btn-fp-tool-select', wall: 'btn-fp-tool-wall', erase: 'btn-fp-tool-erase', room: 'btn-fp-tool-room', poly: 'btn-fp-tool-poly' };
  Object.entries(map).forEach(([k, id]) => {
    document.getElementById(id)?.classList.toggle('fp-tool-active', k === t);
  });
  if (canvas) canvas.style.cursor = (t === 'wall' || t === 'room' || t === 'poly') ? 'crosshair' : (t === 'erase' ? 'pointer' : 'default');
  draw();
}

// ------------------------------------------------------------
// Andares (abas)
// ------------------------------------------------------------

function maxFloorUsed() {
  return draft.reduce((m, r) => Math.max(m, Number(r.floor) || 0), 0);
}

function floorRooms(f = currentFloor) {
  return draft.filter((r) => (Number(r.floor) || 0) === f);
}

function renderFloorTabs() {
  const tabs = document.getElementById('fp-floor-tabs');
  if (!tabs) return;
  tabs.innerHTML = '';
  // inclui o andar corrente mesmo vazio (recém-criado, ainda sem cômodos)
  const top = Math.max(maxFloorUsed(), currentFloor);
  for (let f = 0; f <= top; f++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `fp-tab ${f === currentFloor ? 'fp-tab-active' : ''}`;
    btn.textContent = floorLabel(f);
    btn.addEventListener('click', () => setFloor(f));
    tabs.appendChild(btn);
  }
  if (top < MAX_FLOORS - 1) {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'fp-tab fp-tab-add';
    add.textContent = '+ Novo andar';
    add.title = 'Criar o próximo andar (máx. 3)';
    add.addEventListener('click', () => {
      setFloor(top + 1);
      toast(`${floorLabel(top + 1)} criado`, 'Desenhe os cômodos do novo andar e salve a planta.', 'info');
    });
    tabs.appendChild(add);
  }
}

function setFloor(f) {
  currentFloor = clamp(f, 0, MAX_FLOORS - 1);
  const r = sel();
  if (r && r.floor !== currentFloor) { select(null); hideForm(); }
  hidePresets();
  renderFloorTabs();
  syncToolbar();
  draw();
}

// ------------------------------------------------------------
// Undo / redo (snapshots JSON)
// ------------------------------------------------------------

function snapshot() {
  return JSON.stringify({ rooms: draft, walls: wallsDraft, floor: currentFloor });
}

/** Empilha o estado ATUAL como passo de undo (chame ANTES de mutar). */
function pushHistory() {
  history.past.push(snapshot());
  if (history.past.length > HISTORY_CAP) history.past.shift();
  history.future = [];
  syncToolbar();
}

/** Empilha um snapshot específico (início de um arrasto, por ex.). */
function pushHistorySnap(snapStr) {
  if (!snapStr || snapStr === snapshot()) return;
  history.past.push(snapStr);
  if (history.past.length > HISTORY_CAP) history.past.shift();
  history.future = [];
  syncToolbar();
}

function restore(snapStr) {
  try {
    const { rooms, walls, floor } = JSON.parse(snapStr);
    draft = rooms;
    wallsDraft = walls || [];
    currentFloor = Math.min(floor ?? 0, maxFloorUsed());
    select(null);
    selWalls.clear();
    wallDraw = null;
    hideForm();
    hidePresets();
    renderFloorTabs();
    syncToolbar();
    draw();
  } catch { /* snapshot corrompido: ignora */ }
}

function undo() {
  if (!history.past.length) { toast('Nada para desfazer', '', 'info'); return; }
  history.future.push(snapshot());
  restore(history.past.pop());
}

function redo() {
  if (!history.future.length) { toast('Nada para refazer', '', 'info'); return; }
  history.past.push(snapshot());
  restore(history.future.pop());
}

function commitFormChange() {
  if (formSnap) { pushHistorySnap(formSnap); formSnap = null; }
}

// ------------------------------------------------------------
// Paleta de presets (popover do botão "Adicionar cômodo")
// ------------------------------------------------------------

function buildPresetsPanel() {
  if (!presetsEl) return;
  presetsEl.innerHTML = '<p class="fp-presets-title">Escolha o tipo de cômodo</p>';
  const grid = document.createElement('div');
  grid.className = 'fp-presets-grid';
  ROOM_PRESETS.forEach((p) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fp-preset-btn';
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="color:${p.color}">${p.icon}</svg>
      <span>${p.label}</span>
      <small>${fmt1(p.sx)} × ${fmt1(p.sz)} m</small>`;
    btn.addEventListener('click', () => { addRoomFromPreset(p); hidePresets(); });
    grid.appendChild(btn);
  });
  presetsEl.appendChild(grid);
}

function togglePresets() {
  hideBgPanel();
  presetsEl?.classList.toggle('hidden');
}
function hidePresets() {
  presetsEl?.classList.add('hidden');
}

// ------------------------------------------------------------
// Render do canvas
// ------------------------------------------------------------

function sizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || canvas.parentElement.clientWidth;
  const h = canvas.clientHeight || canvas.parentElement.clientHeight;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/** Alvo de enquadramento (cômodos e paredes dados) com margem. */
function fitTarget(rooms, walls) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!rooms.length && !walls.length) return { scale: ZOOM_REF, cx: 0, cz: 0 };
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  rooms.forEach((r) => {
    minX = Math.min(minX, r.pos_x - r.size_x / 2); maxX = Math.max(maxX, r.pos_x + r.size_x / 2);
    minZ = Math.min(minZ, r.pos_z - r.size_z / 2); maxZ = Math.max(maxZ, r.pos_z + r.size_z / 2);
  });
  walls.forEach((wl) => {
    minX = Math.min(minX, wl.x1, wl.x2); maxX = Math.max(maxX, wl.x1, wl.x2);
    minZ = Math.min(minZ, wl.z1, wl.z2); maxZ = Math.max(maxZ, wl.z1, wl.z2);
  });
  const margin = 2.2; // metros de respiro
  const sx = w / Math.max(1, (maxX - minX) + margin);
  const sz = h / Math.max(1, (maxZ - minZ) + margin);
  return { scale: clamp(Math.min(sx, sz), ZOOM_MIN, 120), cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 };
}

/** Enquadra tudo do andar corrente (instantâneo: abrir, trocar de andar, importar). */
function fitView() {
  zoomAnim = null;
  view = fitTarget(floorRooms(), floorWalls());
}

/** Voa até um alvo de vista (animado). */
function flyTo(t) {
  zoomAnim = { mode: 'fly', s0: view.scale, s1: t.scale, cx0: view.cx, cz0: view.cz, cx1: t.cx, cz1: t.cz, t0: performance.now(), dur: 260 };
  draw();
}

function fitAllAnimated() { flyTo(fitTarget(floorRooms(), floorWalls())); }

/** Enquadra a seleção (cômodo ou paredes); sem seleção, enquadra tudo. */
function fitSelection() {
  const r = sel();
  if (r) { flyTo(fitTarget([r], [])); return; }
  if (selWalls.size) { flyTo(fitTarget([], wallsDraft.filter((w) => selWalls.has(w.id)))); return; }
  fitAllAnimated();
}

/** Zoom ancorado num ponto da tela (cursor / centro). */
function zoomAt(px, py, factor, dur = 120) {
  const base = zoomAnim?.mode === 'anchor' ? zoomAnim.s1 : view.scale;
  const s1 = clamp(base * factor, ZOOM_MIN, ZOOM_MAX);
  if (s1 === base) return;
  zoomAnim = { mode: 'anchor', s0: view.scale, s1, px, py, wx: s2wx(px), wz: s2wz(py), t0: performance.now(), dur };
  draw();
}

function zoomCenter(factor) { zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, factor, 160); }

/** Avança a animação de zoom; true enquanto ainda houver quadros a desenhar. */
function stepZoom() {
  const z = zoomAnim;
  if (!z) return false;
  const t = z.dur ? Math.min(1, (performance.now() - z.t0) / z.dur) : 1;
  const e = 1 - Math.pow(1 - t, 3);
  const s = z.s0 * Math.pow(z.s1 / z.s0, e);
  view.scale = s;
  if (z.mode === 'anchor') {
    view.cx = z.wx - (z.px - canvas.clientWidth / 2) / s;
    view.cz = z.wz - (z.py - canvas.clientHeight / 2) / s;
  } else {
    view.cx = z.cx0 + (z.cx1 - z.cx0) * e;
    view.cz = z.cz0 + (z.cz1 - z.cz0) * e;
  }
  if (t >= 1) { zoomAnim = null; return false; }
  return true;
}

function w2sx(x) { return (x - view.cx) * view.scale + canvas.clientWidth / 2; }
function w2sz(z) { return (z - view.cz) * view.scale + canvas.clientHeight / 2; }
function s2wx(px) { return (px - canvas.clientWidth / 2) / view.scale + view.cx; }
function s2wz(py) { return (py - canvas.clientHeight / 2) / view.scale + view.cz; }

// Desenho sob demanda: vários draw() no mesmo quadro viram um só render()
// (antes havia um loop contínuo + um draw por movimento de mouse = travamento).
function startLoop() { stopLoop(); draw(); }
function stopLoop() { if (rafId) cancelAnimationFrame(rafId); rafId = 0; drawQueued = false; }

function draw() {
  if (drawQueued || !ctx) return;
  drawQueued = true;
  rafId = requestAnimationFrame(() => { drawQueued = false; rafId = 0; render(); });
}

function render() {
  if (!ctx || !isOpen()) return;
  const animating = stepZoom();
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);

  drawBackground();
  drawGrid(w, h);

  // origem do mundo (0,0)
  ctx.fillStyle = 'rgba(148,163,184,0.55)';
  ctx.beginPath();
  ctx.arc(w2sx(0), w2sz(0), 3, 0, Math.PI * 2);
  ctx.fill();

  const flashing = performance.now() < flashUntil;
  const rooms = floorRooms();
  rooms.filter((r) => r.id !== selectedId).forEach((r) => drawRoom(r, false));
  const selRoom = rooms.find((r) => r.id === selectedId);
  if (selRoom) drawRoom(selRoom, flashing);

  drawWalls();
  drawWallPreview();
  drawRoomPreview();
  drawPolyPreview();
  drawGuides(w, h);
  drawMarquee();
  drawScaleBar(w, h);
  syncZoomUi();
  syncWallPanel();
  if (animating || performance.now() < flashUntil) draw();
}

// ------------------------------------------------------------
// Paredes (modelo vetorial CAD)
// ------------------------------------------------------------

function floorWalls(f = currentFloor) {
  return wallsDraft.filter((w) => (Number(w.floor) || 0) === f);
}

/** Distância de ponto ao segmento de parede (em metros de mundo). */
function distToWall(wx, wz, wl) {
  const dx = wl.x2 - wl.x1, dz = wl.z2 - wl.z1;
  const len2 = dx * dx + dz * dz;
  if (!len2) return Math.hypot(wx - wl.x1, wz - wl.z1);
  let t = ((wx - wl.x1) * dx + (wz - wl.z1) * dz) / len2;
  t = clamp(t, 0, 1);
  return Math.hypot(wx - (wl.x1 + t * dx), wz - (wl.z1 + t * dz));
}

/** Parede sob o cursor: a mais próxima dentro de ~9 px de tela (ou da espessura). */
function wallAt(wx, wz) {
  const walls = floorWalls();
  let best = null, bestD = Infinity;
  for (let i = walls.length - 1; i >= 0; i--) {
    const wl = walls[i];
    const thr = Math.max(wl.th / 2 + 0.02, HIT_PX / view.scale);
    const d = distToWall(wx, wz, wl);
    if (d <= thr && d < bestD) { best = wl; bestD = d; }
  }
  return best;
}

/** Raio (m) de captura de alças e vértices: sempre ≥ 9 px, qualquer que seja o zoom. */
function hitR() { return HIT_PX / view.scale; }
function vtxR() { return Math.max(VERTEX_R * 0.5, hitR()); }

function wallLen(wl) { return Math.hypot(wl.x2 - wl.x1, wl.z2 - wl.z1); }

/** Parede em destaque (selecionada / sob o cursor), com alças e medida. */
function drawWallSeg(wl, hover = false) {
  const isSel = selWalls.has(wl.id);
  const x1 = w2sx(wl.x1), y1 = w2sz(wl.z1), x2 = w2sx(wl.x2), y2 = w2sz(wl.z2);
  const thick = Math.max(2.5, wl.th * view.scale);
  ctx.save();
  ctx.lineCap = 'square';
  ctx.strokeStyle = isSel ? 'rgba(242,178,74,0.4)' : 'rgba(242,178,74,0.25)';
  ctx.lineWidth = thick + 6;
  line(x1, y1, x2, y2);
  ctx.strokeStyle = isSel ? '#f2b24a' : '#f6cf8a';
  ctx.lineWidth = thick;
  line(x1, y1, x2, y2);
  ctx.restore();

  if (isSel && selWalls.size === 1) {
    // alças de ponta (arrastar estica/encurta; quem divide a ponta acompanha)
    const s = 10;
    ctx.fillStyle = '#f2b24a';
    ctx.strokeStyle = '#0c1017';
    ctx.lineWidth = 2;
    [[x1, y1], [x2, y2]].forEach(([px, py]) => {
      ctx.fillRect(px - s / 2, py - s / 2, s, s);
      ctx.strokeRect(px - s / 2, py - s / 2, s, s);
    });
    // medida ao centro
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const label = `${fmt1(wallLen(wl))} m`;
    ctx.font = "600 12px 'IBM Plex Sans', sans-serif";
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(12,16,23,0.92)';
    ctx.fillRect(mx - tw / 2 - 6, my - 24, tw + 12, 18);
    ctx.fillStyle = '#f6cf8a';
    ctx.fillText(label, mx, my - 15);
  }
}

/** Todas as paredes em poucos traçados (agrupadas por espessura) e só as visíveis. */
function drawWalls() {
  const walls = floorWalls();
  if (!walls.length) return;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const groups = new Map();
  for (const wl of walls) {
    if (selWalls.has(wl.id) || wl.id === hoverWallId) continue;
    const x1 = w2sx(wl.x1), y1 = w2sz(wl.z1), x2 = w2sx(wl.x2), y2 = w2sz(wl.z2);
    if (Math.max(x1, x2) < -20 || Math.min(x1, x2) > W + 20 || Math.max(y1, y2) < -20 || Math.min(y1, y2) > H + 20) continue;
    const key = Math.round(wl.th * 1000);
    let g = groups.get(key);
    if (!g) groups.set(key, g = { th: wl.th, segs: [] });
    g.segs.push(x1, y1, x2, y2);
  }
  ctx.save();
  ctx.lineCap = 'square';
  groups.forEach((g) => {
    const lw = Math.max(1.5, g.th * view.scale);
    const path = (extra) => {
      ctx.lineWidth = lw + extra;
      ctx.beginPath();
      for (let i = 0; i < g.segs.length; i += 4) { ctx.moveTo(g.segs[i], g.segs[i + 1]); ctx.lineTo(g.segs[i + 2], g.segs[i + 3]); }
      ctx.stroke();
    };
    ctx.strokeStyle = 'rgba(12,16,23,0.9)'; path(view.scale > 12 ? 4 : 2);
    ctx.strokeStyle = '#cbd5e1'; path(0);
  });
  ctx.restore();
  walls.forEach((wl) => { if (selWalls.has(wl.id)) drawWallSeg(wl); });
  const hov = hoverWallId && !selWalls.has(hoverWallId) ? walls.find((w) => w.id === hoverWallId) : null;
  if (hov) drawWallSeg(hov, true);
}

/** Preview elástico da ferramenta Parede (com medida ao vivo). */
function drawWallPreview() {
  if (tool !== 'wall' || !wallDraw || !wallHover) return;
  const x1 = w2sx(wallDraw.x1), y1 = w2sz(wallDraw.z1);
  const x2 = w2sx(wallHover.x), y2 = w2sz(wallHover.z);
  ctx.save();
  ctx.strokeStyle = 'rgba(34,211,238,0.9)';
  ctx.lineWidth = Math.max(2, WALL_TH * view.scale);
  ctx.setLineDash([8, 5]);
  line(x1, y1, x2, y2);
  ctx.setLineDash([]);
  // ponto de partida
  ctx.fillStyle = '#22d3ee';
  ctx.beginPath(); ctx.arc(x1, y1, 4, 0, Math.PI * 2); ctx.fill();
  // medida ao vivo
  const len = Math.hypot(wallHover.x - wallDraw.x1, wallHover.z - wallDraw.z1);
  ctx.font = '600 12px Inter, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  const label = `${fmt1(len)} m`;
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(11,17,32,0.85)';
  ctx.fillRect(mx - tw / 2 - 6, my - 24, tw + 12, 18);
  ctx.fillStyle = '#a5f3fc';
  ctx.fillText(label, mx, my - 8);
  ctx.restore();
}

/** Preview elástico da ferramenta Cômodo (retângulo tracejado + medida). */
function drawRoomPreview() {
  if (!roomDraw) return;
  if (drag && drag.mode !== 'room-draw') return;
  const x1 = w2sx(Math.min(roomDraw.x1, roomDraw.x2));
  const y1 = w2sz(Math.min(roomDraw.z1, roomDraw.z2));
  const rw = Math.abs(roomDraw.x2 - roomDraw.x1) * view.scale;
  const rh = Math.abs(roomDraw.z2 - roomDraw.z1) * view.scale;
  ctx.save();
  ctx.fillStyle = 'rgba(129,140,248,0.18)';
  ctx.fillRect(x1, y1, rw, rh);
  ctx.strokeStyle = 'rgba(129,140,248,0.95)';
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 5]);
  ctx.strokeRect(x1, y1, rw, rh);
  ctx.setLineDash([]);
  // canto de origem
  ctx.fillStyle = '#818cf8';
  ctx.beginPath(); ctx.arc(w2sx(roomDraw.x1), w2sz(roomDraw.z1), 4, 0, Math.PI * 2); ctx.fill();
  // medida ao vivo (L × P)
  const label = `${fmt1(Math.abs(roomDraw.x2 - roomDraw.x1))} × ${fmt1(Math.abs(roomDraw.z2 - roomDraw.z1))} m`;
  ctx.font = '600 12px Inter, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  const mx = x1 + rw / 2, my = y1 + rh / 2;
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(11,17,32,0.85)';
  ctx.fillRect(mx - tw / 2 - 6, my - 24, tw + 12, 18);
  ctx.fillStyle = '#c7d2fe';
  ctx.fillText(label, mx, my - 8);
  ctx.restore();
}

/** Snap de endpoint de parede: grade fina 0,05 m + atração a endpoints existentes. */
function snapWallPoint(wx, wz, exclude = null) {
  let best = null;
  const thr = SNAP_PX / view.scale;
  const skip = exclude instanceof Set ? (id) => exclude.has(id) : (id) => id === exclude;
  floorWalls().forEach((wl) => {
    if (skip(wl.id)) return;
    [[wl.x1, wl.z1], [wl.x2, wl.z2]].forEach(([ex, ez]) => {
      const d = Math.hypot(wx - ex, wz - ez);
      if (d <= thr && (!best || d < best.d)) best = { d, x: ex, z: ez };
    });
  });
  if (best) return { x: best.x, z: best.z };
  return {
    x: Math.round(wx / WALL_SNAP) * WALL_SNAP,
    z: Math.round(wz / WALL_SNAP) * WALL_SNAP,
  };
}

/** Snap de canto de cômodo: atração magnética a endpoints E ao corpo das paredes. */
function snapRoomPoint(wx, wz) {
  const thr = SNAP_PX / view.scale;
  let best = null;
  floorWalls().forEach((wl) => {
    [[wl.x1, wl.z1], [wl.x2, wl.z2]].forEach(([ex, ez]) => {
      const d = Math.hypot(wx - ex, wz - ez);
      if (d <= thr && (!best || d < best.d)) best = { d, x: ex, z: ez };
    });
    const dx = wl.x2 - wl.x1, dz = wl.z2 - wl.z1;
    const len2 = dx * dx + dz * dz;
    if (len2) {
      let t = ((wx - wl.x1) * dx + (wz - wl.z1) * dz) / len2;
      t = clamp(t, 0, 1);
      const px = wl.x1 + t * dx, pz = wl.z1 + t * dz;
      const d = Math.hypot(wx - px, wz - pz);
      if (d <= thr && (!best || d < best.d)) best = { d, x: px, z: pz };
    }
  });
  if (best) return { x: best.x, z: best.z };
  return { x: snapEnabled ? snap(wx) : wx, z: snapEnabled ? snap(wz) : wz };
}

/** Trava de eixo estilo SketchUp: 0° / 90° / 45° quando perto desses ângulos. */
function axisLock(x1, z1, x2, z2) {
  const dx = x2 - x1, dz = z2 - z1;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return { x: x2, z: z2 };
  const ang = Math.atan2(dz, dx);
  const step = Math.PI / 4; // 45°
  const nearest = Math.round(ang / step) * step;
  const diff = Math.abs(ang - nearest);
  if (diff > AXIS_LOCK_DEG * Math.PI / 180) return { x: x2, z: z2 };
  return { x: x1 + len * Math.cos(nearest), z: z1 + len * Math.sin(nearest) };
}

function drawGrid(w, h) {
  // passo da grade adapta ao zoom: nunca mais denso que ~8 px entre linhas
  let cell = CELL_M;
  while (cell * view.scale < 8) cell *= 2;
  const step = cell * view.scale;
  const x0 = w2sx(0), z0 = w2sz(0);
  const major = 2;   // a cada 2 células a linha é mais forte
  const first = (o) => ((o % step) + step) % step;
  const iFirst = (o, f) => Math.round((f - o) / step);

  const minor = new Path2D(), strong = new Path2D();
  for (let x = first(x0), i = iFirst(x0, first(x0)); x < w; x += step, i++) (i % major === 0 ? strong : minor).rect(Math.round(x) - 0.5, 0, 1, h);
  for (let y = first(z0), i = iFirst(z0, first(z0)); y < h; y += step, i++) (i % major === 0 ? strong : minor).rect(0, Math.round(y) - 0.5, w, 1);
  ctx.fillStyle = 'rgba(36,49,79,0.35)'; ctx.fill(minor);
  ctx.fillStyle = 'rgba(56,72,110,0.55)'; ctx.fill(strong);

  // eixos do mundo
  ctx.strokeStyle = 'rgba(94,120,170,0.5)';
  ctx.lineWidth = 1.5;
  line(x0, 0, x0, h);
  line(0, z0, w, z0);
}

/** Barra de escala (canto inferior esquerdo): comprimento "redondo" em metros. */
function drawScaleBar(w, h) {
  const nice = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50];
  const m = nice.find((n) => n * view.scale >= 70) || 50;
  const len = m * view.scale;
  const x = 14, y = h - 14;
  ctx.save();
  ctx.strokeStyle = 'rgba(203,213,225,0.85)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + len, y); ctx.lineTo(x + len, y - 5); ctx.stroke();
  ctx.fillStyle = 'rgba(203,213,225,0.9)';
  ctx.font = "600 11px 'IBM Plex Mono', monospace";
  ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
  ctx.fillText(`${m < 1 ? m.toLocaleString('pt-BR') : m} m`, x + 4, y - 7);
  ctx.restore();
}

/** Caixa de seleção (Shift + arrastar no espaço vazio). */
function drawMarquee() {
  if (!marquee) return;
  const x = w2sx(Math.min(marquee.x0, marquee.x1)), y = w2sz(Math.min(marquee.z0, marquee.z1));
  const rw = Math.abs(marquee.x1 - marquee.x0) * view.scale, rh = Math.abs(marquee.z1 - marquee.z0) * view.scale;
  ctx.save();
  ctx.fillStyle = 'rgba(242,178,74,0.10)';
  ctx.fillRect(x, y, rw, rh);
  ctx.strokeStyle = 'rgba(242,178,74,0.9)';
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(x + 0.5, y + 0.5, rw, rh);
  ctx.restore();
}

/** Atualiza % de zoom e o estado dos botões (só mexe no DOM quando muda). */
let lastZoomPct = -1;
function syncZoomUi() {
  const pct = Math.round(view.scale / ZOOM_REF * 100);
  if (pct === lastZoomPct) return;
  lastZoomPct = pct;
  const el = document.getElementById('btn-fp-zoom-pct');
  if (el) el.textContent = `${pct}%`;
  const out = document.getElementById('btn-fp-zoom-out'), inn = document.getElementById('btn-fp-zoom-in');
  if (out) out.disabled = view.scale <= ZOOM_MIN + 1e-6;
  if (inn) inn.disabled = view.scale >= ZOOM_MAX - 1e-6;
}

function line(x1, y1, x2, y2) {
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
}

// ------------------------------------------------------------
// Fundo de referência (imagem da planta CAD sob a grade)
// ------------------------------------------------------------

/** Desenha a imagem de fundo calibrada em metros, sob a grade. */
function drawBackground() {
  if (!bg.visible || !bg.img || !bg.img.complete || !bg.img.naturalWidth) return;
  const wM = bg.widthM;
  const hM = wM * (bg.img.naturalHeight / bg.img.naturalWidth);
  // a imagem é centrada em (offX, offZ) do mundo
  const x = w2sx(bg.offX - wM / 2), y = w2sz(bg.offZ - hM / 2);
  ctx.save();
  ctx.globalAlpha = bg.opacity;
  ctx.drawImage(bg.img, x, y, wM * view.scale, hM * view.scale);
  ctx.restore();
}

function toggleBgPanel() {
  hidePresets();
  const p = document.getElementById('fp-bg-panel');
  p?.classList.toggle('hidden');
  syncBgPanel();
}

function hideBgPanel() {
  document.getElementById('fp-bg-panel')?.classList.add('hidden');
}

function syncBgPanel() {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set('fp-bg-opacity', Math.round(bg.opacity * 100));
  set('fp-bg-width', bg.widthM);
  set('fp-bg-ox', bg.offX);
  set('fp-bg-oz', bg.offZ);
  const vis = document.getElementById('fp-bg-visible');
  if (vis) vis.checked = bg.visible;
  const rm = document.getElementById('btn-fp-bg-remove');
  if (rm) rm.disabled = !bg.dataUrl;
}

function loadBg() {
  try {
    const raw = localStorage.getItem(BG_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    bg = { ...bg, ...saved, img: null };
    if (bg.dataUrl) setBgImage(bg.dataUrl, false);
  } catch { /* modo restrito */ }
}

function saveBg() {
  try {
    localStorage.setItem(BG_KEY, JSON.stringify({
      dataUrl: bg.dataUrl, opacity: bg.opacity, widthM: bg.widthM,
      offX: bg.offX, offZ: bg.offZ, visible: bg.visible,
    }));
  } catch {
    toast('Imagem muito grande', 'Não foi possível guardar o fundo neste navegador. Tente uma imagem menor.', 'warning');
  }
}

/** Carrega um dataURL na imagem de fundo e redesenha. */
function setBgImage(dataUrl, persist = true) {
  const img = new Image();
  img.onload = () => {
    bg.img = img;
    bg.dataUrl = dataUrl;
    if (persist) saveBg();
    syncBgPanel();
    if (isOpen()) draw();
  };
  img.onerror = () => toast('Imagem inválida', 'Não foi possível ler o arquivo escolhido.', 'critical');
  img.src = dataUrl;
}

/** Lê o arquivo escolhido, reduz para no máx. 1800 px e guarda como JPEG. */
function setBgFromFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const MAX = 1800;
      const k = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k);
      c.height = Math.round(img.naturalHeight * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      setBgImage(c.toDataURL('image/jpeg', 0.85));
      toast('Fundo aplicado', 'Calibre a escala informando a largura real da imagem em metros.', 'success');
    };
    img.onerror = () => toast('Imagem inválida', 'Não foi possível ler o arquivo escolhido.', 'critical');
    img.src = reader.result;
  };
  reader.onerror = () => toast('Imagem inválida', 'Não foi possível ler o arquivo escolhido.', 'critical');
  reader.readAsDataURL(file);
}

function removeBg() {
  bg = { img: null, dataUrl: '', opacity: 0.4, widthM: 14, offX: 0, offZ: 0, visible: true };
  try { localStorage.removeItem(BG_KEY); } catch { /* modo restrito */ }
  syncBgPanel();
  draw();
  toast('Fundo removido', 'A grade voltou ao padrão.', 'info');
}

/** Guias de alinhamento ciano (enquanto arrasta/redimensiona). */
function drawGuides(w, h) {
  if (!guides.length) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(34,211,238,0.85)';
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 4]);
  guides.forEach((g) => {
    if (g.axis === 'x') line(w2sx(g.pos), 0, w2sx(g.pos), h);
    else line(0, w2sz(g.pos), w, w2sz(g.pos));
  });
  ctx.restore();
}

function drawRoom(r, flashing) {
  if (isPoly(r)) { drawPolyRoom(r, flashing); return; }
  const x = w2sx(r.pos_x - r.size_x / 2);
  const y = w2sz(r.pos_z - r.size_z / 2);
  const w = r.size_x * view.scale;
  const h = r.size_z * view.scale;
  const isSel = r.id === selectedId;

  // preenchimento translúcido na cor do cômodo
  ctx.fillStyle = hexA(r.color, isSel ? 0.30 : 0.18);
  ctx.fillRect(x, y, w, h);

  // borda de 2 px mais escura que o preenchimento — lê como "parede"
  ctx.lineWidth = isSel ? 2.5 : 2;
  ctx.strokeStyle = flashing ? '#ef4444' : (isSel ? '#22d3ee' : shade(r.color, 0.45));
  ctx.strokeRect(x, y, w, h);

  if (flashing) {
    ctx.fillStyle = 'rgba(239,68,68,0.22)';
    ctx.fillRect(x, y, w, h);
  }

  // nome + dimensões
  ctx.fillStyle = '#e2e8f0';
  ctx.font = `600 ${Math.max(11, Math.min(14, view.scale * 0.28))}px Inter, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const cx = x + w / 2, cy = y + h / 2;
  if (w > 60 && h > 30) ctx.fillText(r.name || '(sem nome)', cx, cy - 8, w - 10);
  if (w > 60 && h > 44) {
    ctx.fillStyle = 'rgba(148,163,184,0.9)';
    ctx.font = `500 ${Math.max(9, Math.min(11, view.scale * 0.22))}px Inter, sans-serif`;
    ctx.fillText(`${fmt1(r.size_x)} × ${fmt1(r.size_z)} m`, cx, cy + 9, w - 10);
  }

  // 8 alças (4 cantos + 4 lados) no cômodo selecionado
  if (isSel && !flashing) {
    const hs = 9;
    ctx.fillStyle = '#22d3ee';
    ctx.strokeStyle = '#0b1120';
    ctx.lineWidth = 1.5;
    [[x, y], [x + w / 2, y], [x + w, y], [x + w, y + h / 2], [x + w, y + h], [x + w / 2, y + h], [x, y + h], [x, y + h / 2]].forEach(([hx, hy]) => {
      ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
      ctx.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs);
    });
  }
}

// ------------------------------------------------------------
// Painel da parede selecionada: comprimento, espessura, apagar
// ------------------------------------------------------------

let wallPanelKey = '';

function selectedWalls() { return wallsDraft.filter((w) => selWalls.has(w.id)); }

function initWallPanel() {
  const lenEl = document.getElementById('fp-wall-len'), thEl = document.getElementById('fp-wall-th');
  const panel = document.getElementById('fp-wall-panel');
  if (!panel) return;
  panel.addEventListener('focusin', () => { if (!wallFormSnap) wallFormSnap = snapshot(); });
  const commit = () => { if (wallFormSnap) { pushHistorySnap(wallFormSnap); wallFormSnap = null; } syncToolbar(); wallPanelKey = ''; draw(); };
  lenEl?.addEventListener('input', () => {
    const v = parseFloat(String(lenEl.value).replace(',', '.'));
    const ws = selectedWalls();
    if (ws.length !== 1 || !Number.isFinite(v) || v < 0.1 || v > 60) return;
    const w = ws[0];
    const cur = wallLen(w);
    if (cur < 1e-6) return;
    // ponta 2 se afasta/aproxima mantendo a direção; vizinhas coladas acompanham
    const links = endpointLinks(w, w.x2, w.z2);
    w.x2 = r4(w.x1 + (w.x2 - w.x1) * v / cur);
    w.z2 = r4(w.z1 + (w.z2 - w.z1) * v / cur);
    links.forEach((l) => { l.w[`x${l.k}`] = w.x2; l.w[`z${l.k}`] = w.z2; });
    draw();
  });
  thEl?.addEventListener('input', () => {
    const v = parseFloat(String(thEl.value).replace(',', '.'));
    if (!Number.isFinite(v) || v < 0.03 || v > 0.6) return;
    selectedWalls().forEach((w) => { w.th = Math.round(v * 1000) / 1000; });
    draw();
  });
  [lenEl, thEl].forEach((el) => {
    el?.addEventListener('change', commit);
    el?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
  });
  document.getElementById('fp-wall-del')?.addEventListener('click', () => {
    if (!selWalls.size) return;
    pushHistory();
    wallsDraft = wallsDraft.filter((w) => !selWalls.has(w.id));
    selWalls.clear();
    syncToolbar();
    draw();
  });
}

/** Mostra/atualiza o painel (só mexe no DOM quando algo mudou e sem pisar no campo em edição). */
function syncWallPanel() {
  const panel = document.getElementById('fp-wall-panel');
  if (!panel) return;
  const ws = selectedWalls();
  const key = ws.map((w) => `${w.id}:${w.x1},${w.z1},${w.x2},${w.z2},${w.th}`).join('|');
  if (key === wallPanelKey) return;
  wallPanelKey = key;
  panel.classList.toggle('hidden', !ws.length);
  if (!ws.length) return;
  const lenEl = document.getElementById('fp-wall-len'), thEl = document.getElementById('fp-wall-th');
  document.getElementById('fp-wall-title').textContent = ws.length === 1 ? 'Parede' : `${ws.length} paredes`;
  if (lenEl) {
    lenEl.disabled = ws.length !== 1;
    if (document.activeElement !== lenEl) lenEl.value = ws.length === 1 ? (Math.round(wallLen(ws[0]) * 100) / 100).toString() : '';
  }
  if (thEl && document.activeElement !== thEl) {
    const t = ws[0].th;
    thEl.value = ws.every((w) => w.th === t) ? (Math.round(t * 1000) / 1000).toString() : '';
  }
}

// ------------------------------------------------------------
// Cômodos poligonais (v2.0)
// ------------------------------------------------------------

/** Snap de ponto de polígono: vértices/cantos de outros cômodos, depois paredes e grade. */
function snapPolyPoint(wx, wz, excludeRoomId = null) {
  const thr = SNAP_PX / view.scale;
  let best = null;
  const consider = (x, z) => {
    const d = Math.hypot(wx - x, wz - z);
    if (d <= thr && (!best || d < best.d)) best = { d, x, z };
  };
  floorRooms().forEach((o) => {
    if (o.id === excludeRoomId) return;
    if (isPoly(o)) polyAbs(o).forEach(([x, z]) => consider(x, z));
    else {
      const hx = o.size_x / 2, hz = o.size_z / 2;
      [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]].forEach(([dx, dz]) => consider(o.pos_x + dx, o.pos_z + dz));
    }
  });
  if (polyDraw?.pts.length) consider(polyDraw.pts[0][0], polyDraw.pts[0][1]);
  if (best) return [best.x, best.z];
  const q = snapRoomPoint(wx, wz);
  return [q.x, q.z];
}

/** Shift: trava o próximo vértice no múltiplo de 45° mais próximo. */
function forceAxis(from, p) {
  const dx = p[0] - from[0], dz = p[1] - from[1];
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return p;
  const step = Math.PI / 4;
  const a = Math.round(Math.atan2(dz, dx) / step) * step;
  return [from[0] + len * Math.cos(a), from[1] + len * Math.sin(a)];
}

function commitPoly() {
  if (!polyDraw) return;
  const abs = cleanPoly(polyDraw.pts);
  const snapBefore = polyDraw.snapBefore;
  if (abs.length < 3) {
    toast('Polígono incompleto', 'Marque ao menos 3 vértices (clique no 1º vértice, Enter ou duplo clique para fechar).', 'warning');
    return;
  }
  if (!isSimplePoly(abs)) {
    toast('Forma inválida', 'As arestas se cruzam. Use Backspace para desfazer o último vértice.', 'warning');
    return;
  }
  if (polyArea(abs) < MIN_POLY_AREA) {
    toast('Cômodo pequeno demais', `Área mínima: ${fmt1(MIN_POLY_AREA)} m².`, 'warning');
    return;
  }
  const room = setPolyAbs({
    id: genUuid(),
    name: uniqueName('Cômodo'),
    color: '#818cf8',
    kind: 'personalizado',
    floor: currentFloor,
    sort_order: draft.reduce((m, r) => Math.max(m, r.sort_order ?? 0), 0) + 1,
  }, abs);
  pushHistorySnap(snapBefore);
  draft.push(room);
  polyDraw = null;
  setTool('select');
  select(room.id);
  showForm(room);
  renderFloorTabs();
  syncToolbar();
  draw();
  toast('Cômodo poligonal criado', `${fmt1(polyArea(abs))} m² · arraste os vértices para ajustar a forma.`, 'success');
}

function deleteVertex(r, idx) {
  const abs = polyAbs(r);
  if (abs.length <= 3) {
    toast('Mínimo de 3 vértices', 'Um polígono precisa de ao menos 3 pontos.', 'warning');
    return;
  }
  pushHistory();
  abs.splice(idx, 1);
  setPolyAbs(r, abs);
  syncForm(r);
  syncToolbar();
  draw();
}

function convertToPolygon() {
  const r = sel();
  if (!r || isPoly(r)) return;
  pushHistory();
  r.points = rectToPoints(r);
  syncForm(r);
  draw();
  toast('Convertido em polígono', 'Arraste os vértices; clique no “+” de uma aresta para criar mais um.', 'info');
}

function drawPolyPath(abs) {
  ctx.beginPath();
  abs.forEach(([x, z], i) => {
    const sx = w2sx(x), sz = w2sz(z);
    if (i) ctx.lineTo(sx, sz); else ctx.moveTo(sx, sz);
  });
  ctx.closePath();
}

function drawPolyRoom(r, flashing) {
  const abs = polyAbs(r);
  const isSel = r.id === selectedId;
  drawPolyPath(abs);
  ctx.fillStyle = hexA(r.color, isSel ? 0.30 : 0.18);
  ctx.fill();
  ctx.lineWidth = isSel ? 2.5 : 2;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = flashing ? '#ef4444' : (isSel ? '#f2b24a' : shade(r.color, 0.45));
  ctx.stroke();

  // nome + área no centroide (cai dentro do polígono mesmo em L)
  const [cx, cz] = polyCentroid(r.points);
  const inside = pointInPoly(r.pos_x + cx, r.pos_z + cz, abs);
  const lx = w2sx(inside ? r.pos_x + cx : r.pos_x), ly = w2sz(inside ? r.pos_z + cz : r.pos_z);
  ctx.fillStyle = '#e2e8f0';
  ctx.font = `600 ${Math.max(11, Math.min(14, view.scale * 0.28))}px 'IBM Plex Sans', sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (view.scale * Math.sqrt(polyArea(r.points)) > 50) {
    ctx.fillText(r.name || '(sem nome)', lx, ly - 8, 160);
    ctx.fillStyle = 'rgba(148,163,184,0.9)';
    ctx.font = `500 ${Math.max(9, Math.min(11, view.scale * 0.22))}px 'IBM Plex Sans', sans-serif`;
    ctx.fillText(`${fmt1(polyArea(r.points))} m²`, lx, ly + 9, 160);
  }

  if (isSel && !flashing) {
    // pontos médios das arestas ("+" insere vértice) e vértices (arrastáveis)
    abs.forEach((a, i) => {
      const b = abs[(i + 1) % abs.length];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) <= 0.6) return;
      const mx = w2sx((a[0] + b[0]) / 2), mz = w2sz((a[1] + b[1]) / 2);
      ctx.fillStyle = 'rgba(12,16,23,0.9)';
      ctx.strokeStyle = 'rgba(242,178,74,0.8)';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(mx, mz, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(mx - 2.5, mz); ctx.lineTo(mx + 2.5, mz); ctx.moveTo(mx, mz - 2.5); ctx.lineTo(mx, mz + 2.5); ctx.stroke();
    });
    abs.forEach(([x, z]) => {
      ctx.fillStyle = '#f2b24a';
      ctx.strokeStyle = '#0c1017';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(w2sx(x), w2sz(z), 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    });
  }
}

function drawPolyPreview() {
  if (tool !== 'poly') return;
  const pts = polyDraw?.pts || [];
  if (pts.length) {
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#f2b24a';
    ctx.fillStyle = 'rgba(242,178,74,0.10)';
    ctx.beginPath();
    pts.forEach(([x, z], i) => { const sx = w2sx(x), sz = w2sz(z); if (i) ctx.lineTo(sx, sz); else ctx.moveTo(sx, sz); });
    if (polyHover) ctx.lineTo(w2sx(polyHover[0]), w2sz(polyHover[1]));
    ctx.closePath();
    ctx.fill();
    ctx.setLineDash([]);
    ctx.beginPath();
    pts.forEach(([x, z], i) => { const sx = w2sx(x), sz = w2sz(z); if (i) ctx.lineTo(sx, sz); else ctx.moveTo(sx, sz); });
    ctx.stroke();
    if (polyHover) {
      const l = pts[pts.length - 1];
      ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.moveTo(w2sx(l[0]), w2sz(l[1])); ctx.lineTo(w2sx(polyHover[0]), w2sz(polyHover[1])); ctx.stroke();
      ctx.setLineDash([]);
      const len = Math.hypot(polyHover[0] - l[0], polyHover[1] - l[1]);
      ctx.fillStyle = '#f2b24a';
      ctx.font = "600 11px 'IBM Plex Sans', sans-serif";
      ctx.textAlign = 'left';
      ctx.fillText(`${fmt1(len)} m`, w2sx(polyHover[0]) + 12, w2sz(polyHover[1]) - 10);
    }
    pts.forEach(([x, z], i) => {
      ctx.fillStyle = i === 0 ? '#fff' : '#f2b24a';
      ctx.strokeStyle = '#0c1017';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(w2sx(x), w2sz(z), i === 0 ? 6.5 : 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    });
    ctx.restore();
  } else if (polyHover) {
    ctx.save();
    ctx.strokeStyle = '#f2b24a';
    ctx.lineWidth = 1.5;
    const sx = w2sx(polyHover[0]), sz = w2sz(polyHover[1]);
    ctx.beginPath(); ctx.moveTo(sx - 8, sz); ctx.lineTo(sx + 8, sz); ctx.moveTo(sx, sz - 8); ctx.lineTo(sx, sz + 8); ctx.stroke();
    ctx.restore();
  }
}

/** Aplica o resultado da importação DXF ao rascunho (desfazível com Ctrl+Z). */
function applyDxfImport(plan, opts = {}) {
  pushHistory();
  if (opts.replace) {
    draft = draft.filter((r) => (r.floor ?? 0) !== currentFloor);
    wallsDraft = wallsDraft.filter((w) => (w.floor ?? 0) !== currentFloor);
  }
  const maxWallSort = wallsDraft.reduce((m, w) => Math.max(m, w.sort_order ?? 0), 0);
  plan.walls.forEach((w, i) => wallsDraft.push({
    id: genUuid(), floor: currentFloor,
    x1: w.x1, z1: w.z1, x2: w.x2, z2: w.z2,
    th: opts.wallThickness || WALL_TH, sort_order: maxWallSort + i + 1,
  }));
  const palette = ['#818cf8', '#38bdf8', '#fbbf24', '#4ade80', '#f472b6', '#fb923c', '#a78bfa', '#2dd4bf'];
  let n = 0;
  plan.rooms.forEach((rm) => {
    const room = setPolyAbs({
      id: genUuid(), name: uniqueName('Cômodo'), color: palette[n++ % palette.length],
      kind: 'personalizado', floor: currentFloor,
      sort_order: draft.reduce((m, r) => Math.max(m, r.sort_order ?? 0), 0) + 1,
    }, rm.points);
    draft.push(room);
  });
  select(null);
  selWalls.clear();
  renderFloorTabs();
  syncToolbar();
  fitView();
  draw();
  toast('Planta importada', `${plan.walls.length} parede(s) e ${plan.rooms.length} cômodo(s) adicionados. Revise e clique em Salvar planta.` + (plan.rooms.length ? '' : ' Nenhum cômodo fechado foi detectado: use a ferramenta Polígono sobre as paredes.'), 'success');
}

// ------------------------------------------------------------
// Zoom (roda do mouse, ancorado no cursor) + status da toolbar
// ------------------------------------------------------------

function syncToolbar() {
  const undoBtn = document.getElementById('btn-fp-undo');
  const redoBtn = document.getElementById('btn-fp-redo');
  if (undoBtn) undoBtn.disabled = !history.past.length;
  if (redoBtn) redoBtn.disabled = !history.future.length;

  const el = document.getElementById('fp-area-status');
  if (el) {
    const rooms = floorRooms();
    const area = rooms.reduce((s, r) => s + roomArea(r), 0);
    el.textContent = `${floorLabel(currentFloor)} · ${rooms.length} cômodo${rooms.length === 1 ? '' : 's'} · ${fmt1(area)} m²`;
  }
}

// ------------------------------------------------------------
// Interações de ponteiro
// ------------------------------------------------------------

function canvasPos(e) {
  const rect = canvas.getBoundingClientRect();
  return { px: e.clientX - rect.left, py: e.clientY - rect.top };
}

function roomAt(wx, wz) {
  // varre de cima para baixo (último desenhado primeiro), só o andar corrente
  const rooms = floorRooms();
  for (let i = rooms.length - 1; i >= 0; i--) {
    const r = rooms[i];
    if (isPoly(r)) { if (pointInPoly(wx, wz, polyAbs(r))) return r; continue; }
    if (Math.abs(wx - r.pos_x) <= r.size_x / 2 && Math.abs(wz - r.pos_z) <= r.size_z / 2) return r;
  }
  return null;
}

/** Confirma o retângulo em roomDraw e cria o cômodo (arrasto ou 2º clique). */
function commitRoomDraw(snapBefore) {
  if (!roomDraw) return;
  const rd = roomDraw;
  const sx = Math.abs(rd.x2 - rd.x1);
  const sz = Math.abs(rd.z2 - rd.z1);
  if (sx < MIN_SIZE || sz < MIN_SIZE) {
    draw();
    toast('Cômodo pequeno demais', `Desenhe ao menos ${fmt1(MIN_SIZE)} × ${fmt1(MIN_SIZE)} m.`, 'warning');
    return;
  }
  const room = {
    id: genUuid(),
    name: uniqueName('Cômodo'),
    pos_x: (rd.x1 + rd.x2) / 2,
    pos_z: (rd.z1 + rd.z2) / 2,
    size_x: clamp(sx, MIN_SIZE, MAX_SIZE),
    size_z: clamp(sz, MIN_SIZE, MAX_SIZE),
    color: '#818cf8',
    kind: 'personalizado',
    floor: currentFloor,
    sort_order: draft.reduce((m, r) => Math.max(m, r.sort_order ?? 0), 0) + 1,
  };
  if (draft.some((o) => overlaps(room, o))) {
    flash();
    draw();
    toast('Sobreposição evitada', 'O retângulo desenhado cobre outro cômodo — nada foi criado.', 'warning');
    return;
  }
  pushHistorySnap(snapBefore);
  draft.push(room);
  select(room.id);
  showForm(room);
  renderFloorTabs();
  syncToolbar();
  draw();
}

// ---- ponteiro: seleção, mover/esticar paredes, 8 alças de cômodo, pan e pinça ----

const r4 = (v) => Math.round(v * 10000) / 10000;

/** Paredes arrastadas + pontas de paredes vizinhas coladas nelas (acompanham, como no CAD). */
function wallDragSet(ids, detach) {
  const items = wallsDraft.filter((w) => ids.has(w.id)).map((w) => ({ w, o: { x1: w.x1, z1: w.z1, x2: w.x2, z2: w.z2 } }));
  const links = [];
  if (!detach) {
    const EPS = 0.02;
    const pts = [];
    items.forEach(({ o }) => pts.push([o.x1, o.z1], [o.x2, o.z2]));
    floorWalls().forEach((w) => {
      if (ids.has(w.id)) return;
      ['1', '2'].forEach((k) => {
        const x = w[`x${k}`], z = w[`z${k}`];
        if (pts.some(([px, pz]) => Math.abs(px - x) < EPS && Math.abs(pz - z) < EPS)) links.push({ w, k, ox: x, oz: z });
      });
    });
  }
  return { items, links };
}

function applyWallDelta(set, fx, fz) {
  set.items.forEach(({ w, o }) => {
    w.x1 = r4(o.x1 + fx); w.z1 = r4(o.z1 + fz); w.x2 = r4(o.x2 + fx); w.z2 = r4(o.z2 + fz);
  });
  set.links.forEach(({ w, k, ox, oz }) => { w[`x${k}`] = r4(ox + fx); w[`z${k}`] = r4(oz + fz); });
}

/** Pontas de OUTRAS paredes que coincidem com (x,z): acompanham o arrasto da ponta. */
function endpointLinks(wl, x, z) {
  const EPS = 0.02, out = [];
  floorWalls().forEach((w) => {
    if (w.id === wl.id) return;
    ['1', '2'].forEach((k) => {
      if (Math.abs(w[`x${k}`] - x) < EPS && Math.abs(w[`z${k}`] - z) < EPS) out.push({ w, k });
    });
  });
  return out;
}

function segHitsRect(w, x0, z0, x1, z1) {
  // Liang–Barsky: o segmento toca o retângulo?
  let t0 = 0, t1 = 1;
  const dx = w.x2 - w.x1, dz = w.z2 - w.z1;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  return clip(-dx, w.x1 - x0) && clip(dx, x1 - w.x1) && clip(-dz, w.z1 - z0) && clip(dz, z1 - w.z1);
}

const HANDLE_CURSOR = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' };

/** Alça (n, ne, e, se, s, sw, w, nw) do cômodo retangular selecionado sob o cursor. */
function roomHandleAt(r, wx, wz) {
  if (!r || isPoly(r)) return null;
  const hr = hitR() * 1.15;
  const x0 = r.pos_x - r.size_x / 2, x1 = r.pos_x + r.size_x / 2, z0 = r.pos_z - r.size_z / 2, z1 = r.pos_z + r.size_z / 2;
  const hs = [['nw', x0, z0], ['ne', x1, z0], ['se', x1, z1], ['sw', x0, z1], ['n', r.pos_x, z0], ['s', r.pos_x, z1], ['w', x0, r.pos_z], ['e', x1, r.pos_z]];
  for (const [k, x, z] of hs) if (Math.abs(wx - x) <= hr && Math.abs(wz - z) <= hr) return k;
  return null;
}

/** Captura o ponteiro (ignora ponteiros sintéticos/já soltos). */
function capture(e) {
  try { canvas.setPointerCapture(e.pointerId); } catch { /* noop */ }
}

function startPan(e, px, py) {
  zoomAnim = null;
  drag = { mode: 'pan', startPX: px, startPY: py, origCX: view.cx, origCZ: view.cz };
  capture(e);
  canvas.style.cursor = 'grabbing';
  e.preventDefault();
}

/** Cancela o arrasto em curso (ex.: um segundo dedo virou pinça) desfazendo o que ele mexeu. */
function cancelDrag() {
  if (!drag) return;
  if (drag.snapBefore && drag.changed) restore(drag.snapBefore);
  drag = null; roomDraw = null; marquee = null; guides = [];
}

function onWheel(e) {
  if (!isOpen()) return;
  e.preventDefault();
  const { px, py } = canvasPos(e);
  let dy = e.deltaY;
  if (e.deltaMode === 1) dy *= 16; else if (e.deltaMode === 2) dy *= 400;
  dy = clamp(dy, -240, 240);
  // roda do mouse: ~17% por "clique"; trackpad (pinça chega com ctrlKey): proporcional e suave
  zoomAt(px, py, Math.exp(-dy * (e.ctrlKey ? 0.012 : 0.0016)), 110);
}

function onPointerDown(e) {
  hidePresets();
  const { px, py } = canvasPos(e);

  // dois dedos: pinça (zoom) + arrastar (pan)
  pointers.set(e.pointerId, { x: px, y: py });
  if (pointers.size === 2) {
    cancelDrag();
    const [a, b] = [...pointers.values()];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    zoomAnim = null;
    pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, s0: view.scale, wx: s2wx(mx), wz: s2wz(my) };
    capture(e);
    e.preventDefault();
    return;
  }
  if (pointers.size > 2) return;

  let wx = s2wx(px), wz = s2wz(py);

  // vértices do polígono selecionado: arrastar move; Alt/botão direito apaga; "+" na aresta insere
  {
    const selR = sel();
    if (tool === 'select' && selR && isPoly(selR) && e.button !== 1 && !spaceDown) {
      const abs = polyAbs(selR);
      const vr = vtxR();
      const vi = abs.findIndex(([x, z]) => Math.hypot(wx - x, wz - z) <= vr);
      if (vi >= 0) {
        if (e.button === 2 || e.altKey) { deleteVertex(selR, vi); e.preventDefault(); return; }
        drag = { mode: 'vertex', id: selR.id, index: vi, snapBefore: snapshot(), changed: false };
        capture(e);
        canvas.style.cursor = 'move';
        e.preventDefault();
        return;
      }
      for (let i = 0; i < abs.length; i++) {
        const a = abs[i], b = abs[(i + 1) % abs.length];
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (e.button === 0 && Math.hypot(wx - mid[0], wz - mid[1]) <= vr * 0.9 && Math.hypot(b[0] - a[0], b[1] - a[1]) > 0.6) {
          const snapBefore = snapshot();
          abs.splice(i + 1, 0, mid);
          setPolyAbs(selR, abs);
          drag = { mode: 'vertex', id: selR.id, index: i + 1, snapBefore, changed: true };
          capture(e);
          canvas.style.cursor = 'move';
          syncForm(selR);
          draw();
          e.preventDefault();
          return;
        }
      }
    }
  }

  // botão do meio / direito / Espaço: mover a vista em qualquer ferramenta
  if (e.button === 1 || e.button === 2 || spaceDown) { startPan(e, px, py); return; }

  // ferramenta POLÍGONO: um clique por vértice; fecha clicando no 1º vértice, Enter ou duplo clique
  if (tool === 'poly') {
    if (e.button !== 0) return;
    let p = snapPolyPoint(wx, wz);
    if (!polyDraw) polyDraw = { pts: [], snapBefore: snapshot() };
    const last = polyDraw.pts[polyDraw.pts.length - 1];
    if (e.shiftKey && last) p = forceAxis(last, p);
    if (polyDraw.pts.length >= 3 && Math.hypot(p[0] - polyDraw.pts[0][0], p[1] - polyDraw.pts[0][1]) <= vtxR()) {
      commitPoly();
    } else if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.05) {
      polyDraw.pts.push(p);
    }
    draw();
    e.preventDefault();
    return;
  }

  // ferramenta PAREDE: clique-clique com encadeamento (como SketchUp)
  if (tool === 'wall') {
    if (e.button !== 0) return;
    const p = snapWallPoint(wx, wz);
    if (!wallDraw) {
      wallDraw = { x1: p.x, z1: p.z };
    } else {
      const q = axisLock(wallDraw.x1, wallDraw.z1, p.x, p.z);
      const len = Math.hypot(q.x - wallDraw.x1, q.z - wallDraw.z1);
      if (len >= 0.1) {
        pushHistory();
        const maxSort = wallsDraft.reduce((m, w) => Math.max(m, w.sort_order ?? 0), 0);
        wallsDraft.push({
          id: genUuid(), floor: currentFloor,
          x1: wallDraw.x1, z1: wallDraw.z1, x2: q.x, z2: q.z,
          th: WALL_TH, sort_order: maxSort + 1,
        });
      }
      wallDraw = { x1: q.x, z1: q.z }; // encadeia o próximo segmento
    }
    draw();
    e.preventDefault();
    return;
  }

  // ferramenta APAGAR: remove a parede clicada
  if (tool === 'erase') {
    if (e.button !== 0) return;
    const wl = wallAt(wx, wz);
    if (wl) {
      pushHistory();
      wallsDraft = wallsDraft.filter((w) => w.id !== wl.id);
      selWalls.delete(wl.id);
      toast('Parede removida', `${fmt1(wallLen(wl))} m apagados. Ctrl+Z desfaz.`, 'info');
      syncToolbar();
      draw();
    }
    e.preventDefault();
    return;
  }

  // ferramenta CÔMODO: clique-clique (como a Parede) ou arrasto — gruda nas paredes
  if (tool === 'room') {
    if (e.button !== 0) return;
    const p = snapRoomPoint(wx, wz);
    if (roomDraw?.armed) {
      // 2º clique: fecha o retângulo e cria o cômodo
      roomDraw.x2 = p.x;
      roomDraw.z2 = p.z;
      commitRoomDraw(roomDraw.snapBefore);
      roomDraw = null;
      e.preventDefault();
      return;
    }
    roomDraw = { x1: p.x, z1: p.z, x2: p.x, z2: p.z, armed: false, snapBefore: snapshot() };
    drag = { mode: 'room-draw', moved: false };
    capture(e);
    e.preventDefault();
    return;
  }

  // ---- ferramenta SELECIONAR ----
  const hr = hitR();

  // 1) alças de ponta da parede única selecionada: esticar / encurtar
  if (selWalls.size === 1) {
    const wl0 = wallsDraft.find((w) => selWalls.has(w.id));
    if (wl0) {
      const n1 = Math.hypot(wx - wl0.x1, wz - wl0.z1) <= hr * 1.15;
      const n2 = Math.hypot(wx - wl0.x2, wz - wl0.z2) <= hr * 1.15;
      if (n1 || n2) {
        const end = n1 ? '1' : '2';
        drag = {
          mode: 'wall-end', id: wl0.id, end,
          links: e.altKey ? [] : endpointLinks(wl0, wl0[`x${end}`], wl0[`z${end}`]),
          snapBefore: snapshot(), changed: false,
        };
        capture(e);
        canvas.style.cursor = 'move';
        e.preventDefault();
        return;
      }
    }
  }

  // 2) alças do cômodo retangular selecionado: 4 cantos + 4 lados
  const selRoom = sel();
  const handle = selRoom ? roomHandleAt(selRoom, wx, wz) : null;
  if (handle) {
    drag = {
      mode: 'resize', handle, id: selRoom.id, startWX: wx, startWZ: wz,
      orig: { pos_x: selRoom.pos_x, pos_z: selRoom.pos_z, size_x: selRoom.size_x, size_z: selRoom.size_z },
      snapBefore: snapshot(), changed: false,
    };
    capture(e);
    canvas.style.cursor = HANDLE_CURSOR[handle];
    e.preventDefault();
    return;
  }

  const r = roomAt(wx, wz);
  const wl = wallAt(wx, wz);
  const additive = e.shiftKey || e.ctrlKey || e.metaKey;

  // espaço vazio: Shift+arrasto = caixa de seleção; senão limpa a seleção e move a vista
  if (!r && !wl) {
    if (e.shiftKey && e.button === 0) {
      select(null);
      marquee = { x0: wx, z0: wz, x1: wx, z1: wz };
      drag = { mode: 'marquee' };
      capture(e);
      e.preventDefault();
      return;
    }
    select(null); selWalls.clear();
    startPan(e, px, py);
    return;
  }

  // parede tem prioridade de clique (é desenhada sobre o cômodo)
  if (wl) {
    select(null);
    if (additive) {
      if (selWalls.has(wl.id)) { selWalls.delete(wl.id); draw(); e.preventDefault(); return; }
      selWalls.add(wl.id);
    } else if (!selWalls.has(wl.id)) {
      selWalls.clear();
      selWalls.add(wl.id);
    }
    drag = {
      mode: 'wall-move', set: wallDragSet(selWalls, e.altKey), primary: wl.id,
      startWX: wx, startWZ: wz, startPX: px, startPY: py,
      snapBefore: snapshot(), changed: false, live: false,
    };
    capture(e);
    canvas.style.cursor = 'grabbing';
    draw();
    e.preventDefault();
    return;
  }

  selWalls.clear();
  select(r.id);
  drag = {
    mode: 'move', id: r.id, startWX: wx, startWZ: wz,
    orig: { pos_x: r.pos_x, pos_z: r.pos_z, size_x: r.size_x, size_z: r.size_z },
    snapBefore: snapshot(),
    changed: false,
  };
  capture(e);
  canvas.style.cursor = 'grabbing';
}

function onPointerMove(e) {
  const { px, py } = canvasPos(e);

  // pinça: zoom + pan com dois dedos
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: px, y: py });
  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const s = clamp(pinch.s0 * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d0), ZOOM_MIN, ZOOM_MAX);
    view.scale = s;
    view.cx = pinch.wx - (mx - canvas.clientWidth / 2) / s;
    view.cz = pinch.wz - (my - canvas.clientHeight / 2) / s;
    draw();
    return;
  }

  if (drag?.mode === 'pan') {
    view.cx = drag.origCX - (px - drag.startPX) / view.scale;
    view.cz = drag.origCZ - (py - drag.startPY) / view.scale;
    draw();
    return;
  }

  const wx = s2wx(px), wz = s2wz(py);

  if (drag?.mode === 'marquee') {
    marquee.x1 = wx; marquee.z1 = wz;
    draw();
    return;
  }

  // borracha da ferramenta Cômodo: arrasto OU aguardando o 2º clique
  if (roomDraw && (drag?.mode === 'room-draw' || roomDraw.armed)) {
    const p = snapRoomPoint(wx, wz);
    roomDraw.x2 = p.x;
    roomDraw.z2 = p.z;
    if (drag?.mode === 'room-draw' && Math.hypot(roomDraw.x2 - roomDraw.x1, roomDraw.z2 - roomDraw.z1) > 0.2) drag.moved = true;
    draw();
    return;
  }
  if (tool === 'room' && !drag) { draw(); return; }
  if (tool === 'poly') {
    let p = snapPolyPoint(wx, wz);
    const last = polyDraw?.pts[polyDraw.pts.length - 1];
    if (e.shiftKey && last) p = forceAxis(last, p);
    polyHover = p;
    draw();
    return;
  }

  // ferramenta Parede: acompanha o cursor para o preview elástico
  if (tool === 'wall') {
    let p = snapWallPoint(wx, wz);
    if (wallDraw) p = { ...p, ...axisLock(wallDraw.x1, wallDraw.z1, p.x, p.z) };
    wallHover = p;
    draw();
    return;
  }
  if (tool === 'erase') {
    const h = wallAt(wx, wz);
    canvas.style.cursor = h ? 'pointer' : 'default';
    if ((h?.id || null) !== hoverWallId) { hoverWallId = h?.id || null; draw(); }
    return;
  }

  if (!drag) {
    // cursor de contexto + realce da parede sob o cursor
    if (spaceDown) { canvas.style.cursor = 'grab'; return; }
    const hr = hitR();
    const sr = sel();
    const hd = sr ? roomHandleAt(sr, wx, wz) : null;
    if (hd) { setHover(null); canvas.style.cursor = HANDLE_CURSOR[hd]; return; }
    if (selWalls.size === 1) {
      const w0 = wallsDraft.find((w) => selWalls.has(w.id));
      if (w0 && (Math.hypot(wx - w0.x1, wz - w0.z1) <= hr * 1.15 || Math.hypot(wx - w0.x2, wz - w0.z2) <= hr * 1.15)) { setHover(null); canvas.style.cursor = 'move'; return; }
    }
    if (sr && isPoly(sr) && polyAbs(sr).some(([x, z]) => Math.hypot(wx - x, wz - z) <= vtxR())) { setHover(null); canvas.style.cursor = 'move'; return; }
    const wl = wallAt(wx, wz);
    setHover(wl?.id || null);
    if (wl) { canvas.style.cursor = 'grab'; return; }
    const r = roomAt(wx, wz);
    canvas.style.cursor = r ? 'grab' : 'default';
    return;
  }

  // arrasto de parede(s): corpo inteiro
  if (drag.mode === 'wall-move') {
    if (!drag.live) {
      if (Math.hypot(px - drag.startPX, py - drag.startPY) < 4) return;   // clique sem arrastar não move nada
      drag.live = true;
    }
    const prim = wallsDraft.find((w) => w.id === drag.primary);
    if (!prim) { drag = null; return; }
    let dx = wx - drag.startWX, dz = wz - drag.startWZ;
    if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dz)) dz = 0; else dx = 0; }   // Shift trava o eixo
    const o = drag.set.items.find((it) => it.w.id === drag.primary)?.o || { x1: prim.x1, z1: prim.z1 };
    const sp = snapWallPoint(o.x1 + dx, o.z1 + dz, selWalls);
    let fx = sp.x - o.x1, fz = sp.z - o.z1;
    if (e.shiftKey) { if (dz === 0) fz = 0; else fx = 0; }
    applyWallDelta(drag.set, fx, fz);
    drag.changed = true;
    syncToolbar();
    draw();
    return;
  }

  // arrasto da ponta de uma parede (esticar / encurtar)
  if (drag.mode === 'wall-end') {
    const wl = wallsDraft.find((w) => w.id === drag.id);
    if (!wl) { drag = null; return; }
    const k = drag.end, ok = k === '1' ? '2' : '1';
    const excl = new Set([wl.id, ...drag.links.map((l) => l.w.id)]);
    let p = snapWallPoint(wx, wz, excl);
    p = { ...p, ...axisLock(wl[`x${ok}`], wl[`z${ok}`], p.x, p.z) };
    wl[`x${k}`] = r4(p.x); wl[`z${k}`] = r4(p.z);
    drag.links.forEach((l) => { l.w[`x${l.k}`] = r4(p.x); l.w[`z${l.k}`] = r4(p.z); });
    drag.changed = true;
    syncToolbar();
    draw();
    return;
  }

  if (drag.mode === 'vertex') {
    const rv = draft.find((d) => d.id === drag.id);
    if (!rv || !isPoly(rv)) { drag = null; return; }
    const abs = polyAbs(rv);
    abs[drag.index] = snapPolyPoint(wx, wz, rv.id);
    setPolyAbs(rv, abs);
    drag.changed = true;
    syncForm(rv);
    syncToolbar();
    draw();
    return;
  }

  const r = draft.find((d) => d.id === drag.id);
  if (!r) { drag = null; return; }

  guides = [];
  const thr = SNAP_PX / view.scale; // limiar de atração em metros

  if (drag.mode === 'move') {
    let nx = drag.orig.pos_x + (wx - drag.startWX);
    let nz = drag.orig.pos_z + (wz - drag.startWZ);
    const snapped = alignSnapMove(r, nx, nz, thr);
    nx = snapped.x; nz = snapped.z;
    if (!snapped.xSnap && snapEnabled) nx = snap(nx);
    if (!snapped.zSnap && snapEnabled) nz = snap(nz);
    r.pos_x = nx; r.pos_z = nz;
  } else {
    // resize pelas 8 alças: move só as arestas do lado puxado
    const o = drag.orig, h = drag.handle;
    const dx = wx - drag.startWX, dz = wz - drag.startWZ;
    let L = o.pos_x - o.size_x / 2, R = o.pos_x + o.size_x / 2, T = o.pos_z - o.size_z / 2, B = o.pos_z + o.size_z / 2;
    const { xs, zs } = guideLines(r.id);
    const edge = (v, lines, axis) => {
      const b = bestSnap([v], lines, thr);
      if (b) { guides.push({ axis, pos: b.ln }); return v + b.d; }
      return snapEnabled ? snap(v) : v;
    };
    if (h.includes('w')) L = edge(L + dx, xs, 'x');
    if (h.includes('e')) R = edge(R + dx, xs, 'x');
    if (h.includes('n')) T = edge(T + dz, zs, 'z');
    if (h.includes('s')) B = edge(B + dz, zs, 'z');
    if (h.includes('w')) L = clamp(L, R - MAX_SIZE, R - MIN_SIZE);
    if (h.includes('e')) R = clamp(R, L + MIN_SIZE, L + MAX_SIZE);
    if (h.includes('n')) T = clamp(T, B - MAX_SIZE, B - MIN_SIZE);
    if (h.includes('s')) B = clamp(B, T + MIN_SIZE, T + MAX_SIZE);
    r.pos_x = r4((L + R) / 2); r.size_x = r4(R - L);
    r.pos_z = r4((T + B) / 2); r.size_z = r4(B - T);
    syncForm(r);
  }
  drag.changed = true;
  syncToolbar();
  draw();
}

function setHover(id) {
  if (id !== hoverWallId) { hoverWallId = id; draw(); }
}

function onPointerUp(e) {
  pointers.delete(e.pointerId);
  if (pinch) {
    if (pointers.size < 2) pinch = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    return;
  }
  if (!drag) return;
  const { mode } = drag;
  if (mode === 'pan') {
    drag = null;
    canvas.style.cursor = spaceDown ? 'grab' : 'default';
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    return;
  }

  // caixa de seleção: seleciona as paredes que ela toca
  if (mode === 'marquee') {
    const m = marquee;
    drag = null; marquee = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    if (m && (Math.abs(m.x1 - m.x0) * view.scale > 4 || Math.abs(m.z1 - m.z0) * view.scale > 4)) {
      const x0 = Math.min(m.x0, m.x1), x1 = Math.max(m.x0, m.x1), z0 = Math.min(m.z0, m.z1), z1 = Math.max(m.z0, m.z1);
      floorWalls().forEach((w) => { if (segHitsRect(w, x0, z0, x1, z1)) selWalls.add(w.id); });
    }
    draw();
    return;
  }

  // desenho de cômodo: arrasto concluído OU 1º clique do clique-clique
  if (mode === 'room-draw') {
    const { moved } = drag;
    const snapBefore = roomDraw?.snapBefore ?? snapshot();
    drag = null;
    canvas.style.cursor = 'crosshair';
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    if (!roomDraw) { draw(); return; }
    if (!moved) {
      // clique simples: entra no modo clique-clique — o 2º clique confirma
      roomDraw.armed = true;
      roomDraw.snapBefore = snapBefore;
      draw();
      return;
    }
    commitRoomDraw(snapBefore);
    roomDraw = null;
    return;
  }

  // arrasto de parede(s) concluído
  if (mode === 'wall-move' || mode === 'wall-end') {
    const { snapBefore, changed, id } = drag;
    const wl = wallsDraft.find((w) => w.id === id);
    drag = null;
    canvas.style.cursor = 'default';
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    if (!changed) { draw(); return; }
    // ponta solta praticamente no mesmo lugar → descarta a parede
    if (mode === 'wall-end' && wl && wallLen(wl) < 0.1) {
      restore(snapBefore);
      toast('Parede curta demais', 'Segmento menor que 0,1 m não é válido — voltou ao tamanho anterior.', 'warning');
      draw();
      return;
    }
    pushHistorySnap(snapBefore);
    syncToolbar();
    draw();
    return;
  }

  if (mode === 'vertex') {
    const rv = draft.find((d) => d.id === drag.id);
    const { snapBefore, changed } = drag;
    drag = null;
    canvas.style.cursor = 'default';
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    if (!rv || !changed) return;
    if (!isSimplePoly(polyAbs(rv))) {
      restore(snapBefore);
      flash();
      draw();
      toast('Forma inválida', 'As arestas do cômodo se cruzariam — o vértice voltou ao lugar.', 'warning');
      return;
    }
    pushHistorySnap(snapBefore);
    syncForm(rv);
    syncToolbar();
    draw();
    return;
  }

  const r = draft.find((d) => d.id === drag.id);
  const { orig, snapBefore, changed } = drag;
  drag = null;
  guides = [];
  canvas.style.cursor = 'default';
  try { canvas.releasePointerCapture(e.pointerId); } catch { /* noop */ }
  if (!r || !changed) return;

  if (hasOverlap(r.id)) {
    // sobreposição: reverte e pisca em vermelho (sem registrar histórico)
    Object.assign(r, orig);
    flash();
    draw();
    toast('Sobreposição evitada', `“${r.name || 'Cômodo'}” ficaria sobre outro cômodo — ${mode === 'move' ? 'posição' : 'tamanho'} revertido.`, 'warning');
    return;
  }
  pushHistorySnap(snapBefore);
  syncForm(r);
  syncToolbar();
  draw();
}

function onDblClick(e) {
  if (tool === 'poly') { if (polyDraw?.pts.length >= 3) commitPoly(); return; }
  const { px, py } = canvasPos(e);
  const r = roomAt(s2wx(px), s2wz(py));
  if (r) { select(r.id); showForm(r); }
}

// ------------------------------------------------------------
// Guias de alinhamento (arestas/centros de outros cômodos do andar)
// ------------------------------------------------------------

/** Linhas de referência dos outros cômodos do andar corrente. */
function guideLines(excludeId) {
  const xs = [], zs = [];
  floorRooms().forEach((o) => {
    if (o.id === excludeId) return;
    xs.push(o.pos_x - o.size_x / 2, o.pos_x, o.pos_x + o.size_x / 2);
    zs.push(o.pos_z - o.size_z / 2, o.pos_z, o.pos_z + o.size_z / 2);
  });
  return { xs, zs };
}

function bestSnap(values, lines, thr) {
  let best = null;
  for (const v of values) {
    for (const ln of lines) {
      const d = ln - v;
      if (Math.abs(d) <= thr && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, ln };
    }
  }
  return best; // { d: delta a aplicar, ln: linha guia }
}

/** Snap de MOVE: testa as 3 linhas verticais/horizontais do cômodo. */
function alignSnapMove(r, nx, nz, thr) {
  const { xs, zs } = guideLines(r.id);
  const hx = r.size_x / 2, hz = r.size_z / 2;
  const bx = bestSnap([nx - hx, nx, nx + hx], xs, thr);
  const bz = bestSnap([nz - hz, nz, nz + hz], zs, thr);
  if (bx) guides.push({ axis: 'x', pos: bx.ln });
  if (bz) guides.push({ axis: 'z', pos: bz.ln });
  return {
    x: bx ? nx + bx.d : nx, xSnap: !!bx,
    z: bz ? nz + bz.d : nz, zSnap: !!bz,
  };
}

/** Snap de RESIZE: testa a aresta direita (x) e a inferior (z). */
function alignSnapEdges(r, rx, rz, thr) {
  const { xs, zs } = guideLines(r.id);
  const bx = bestSnap([rx], xs, thr);
  const bz = bestSnap([rz], zs, thr);
  if (bx) guides.push({ axis: 'x', pos: bx.ln });
  if (bz) guides.push({ axis: 'z', pos: bz.ln });
  return {
    x: bx ? rx + bx.d : rx, xSnap: !!bx,
    z: bz ? rz + bz.d : rz, zSnap: !!bz,
  };
}

// ------------------------------------------------------------
// Teclado: undo/redo, duplicar, nudge com setas, delete, escape
// ------------------------------------------------------------

function onKeyDown(e) {
  if (!isOpen()) return;
  const typing = e.target.closest?.('input, select, textarea');
  const mod = e.ctrlKey || e.metaKey;

  // atalhos de ferramenta (estilo CAD): V seleciona, W parede, R cômodo, E apagar
  if (!mod && !typing) {
    const k = e.key.toLowerCase();
    if (k === 'v') { setTool('select'); return; }
    if (k === 'w') { setTool('wall'); return; }
    if (k === 'r') { setTool('room'); return; }
    if (k === 'e') { setTool('erase'); return; }
    if (k === 'p') { setTool('poly'); return; }
    // zoom e vista: + − 0 (tudo) F (seleção) Espaço (mover a vista)
    if (k === '+' || k === '=') { e.preventDefault(); zoomCenter(1.25); return; }
    if (k === '-' || k === '_') { e.preventDefault(); zoomCenter(1 / 1.25); return; }
    if (k === '0') { e.preventDefault(); fitAllAnimated(); return; }
    if (k === 'f') { e.preventDefault(); fitSelection(); return; }
    if (k === ' ') { e.preventDefault(); if (!spaceDown) { spaceDown = true; if (!drag) canvas.style.cursor = 'grab'; } return; }
  }
  if (mod && !typing && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    selectedId = null; hideForm();
    selWalls.clear(); floorWalls().forEach((w) => selWalls.add(w.id));
    draw();
    return;
  }

  if (mod && !e.shiftKey && e.key.toLowerCase() === 'z' && !typing) {
    e.preventDefault(); undo(); return;
  }
  if ((mod && e.shiftKey && e.key.toLowerCase() === 'z') || (mod && e.key.toLowerCase() === 'y')) {
    if (!typing) { e.preventDefault(); redo(); }
    return;
  }
  if (mod && e.key.toLowerCase() === 'd' && !typing) {
    e.preventDefault(); duplicateSelected(); return;
  }

  if (tool === 'poly' && polyDraw && !typing) {
    if (e.key === 'Enter') { e.preventDefault(); commitPoly(); return; }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      polyDraw.pts.pop();
      if (!polyDraw.pts.length) polyDraw = null;
      draw();
      return;
    }
  }

  if (e.key === 'Escape') {
    if (polyDraw) { polyDraw = null; draw(); return; }          // cancela o polígono em andamento
    if (roomDraw?.armed) { roomDraw = null; draw(); return; } // cancela o clique-clique do cômodo
    if (drag?.mode === 'room-draw') { drag = null; roomDraw = null; draw(); return; } // cancela o arrasto do cômodo
    if (wallDraw) { wallDraw = null; draw(); return; } // encerra o encadeamento de paredes
    if (!presetsEl?.classList.contains('hidden')) { hidePresets(); return; }
    if (marquee) { marquee = null; drag = null; draw(); return; }
    if (selWalls.size) { selWalls.clear(); draw(); return; }
    if (!formEl?.classList.contains('hidden')) hideForm();
    else closeEditor();
    return;
  }

  if ((e.key === 'Delete' || e.key === 'Backspace') && !typing) {
    if (selWalls.size) {
      e.preventDefault();
      pushHistory();
      wallsDraft = wallsDraft.filter((w) => !selWalls.has(w.id));
      selWalls.clear();
      syncToolbar();
      draw();
      return;
    }
    if (selectedId) {
      e.preventDefault();
      deleteSelected();
      return;
    }
  }

  // setas: nudge de 0,5 m (Shift = 0,1 m) no cômodo selecionado
  const NUDGE = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  // setas nas paredes selecionadas: 0,1 m (Shift = 0,5 m); vizinhas coladas acompanham (Alt solta)
  if (NUDGE[e.key] && selWalls.size && !selectedId && !typing) {
    e.preventDefault();
    if (!nudgeSnap) nudgeSnap = snapshot();
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(commitNudge, 700);
    const step = e.shiftKey ? 0.5 : 0.1;
    const [dx, dz] = NUDGE[e.key];
    applyWallDelta(wallDragSet(selWalls, e.altKey), dx * step, dz * step);   // delta relativo às coords atuais
    syncToolbar();
    draw();
    return;
  }
  if (NUDGE[e.key] && selectedId && !typing) {
    e.preventDefault();
    const r = sel(); if (!r) return;
    const step = e.shiftKey ? 0.1 : 0.5;
    if (!nudgeSnap) nudgeSnap = snapshot(); // um passo de undo por rajada
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(commitNudge, 700);
    const [dx, dz] = NUDGE[e.key];
    const prev = { pos_x: r.pos_x, pos_z: r.pos_z };
    r.pos_x = Math.round((r.pos_x + dx * step) * 10) / 10;
    r.pos_z = Math.round((r.pos_z + dz * step) * 10) / 10;
    if (hasOverlap(r.id)) {
      Object.assign(r, prev);
      commitNudge();
      flash();
      toast('Sobreposição evitada', 'O cômodo encostaria em outro — movimento revertido.', 'warning');
    }
    syncForm(r);
    syncToolbar();
    draw();
  }
}

function commitNudge() {
  clearTimeout(nudgeTimer);
  if (nudgeSnap) { pushHistorySnap(nudgeSnap); nudgeSnap = null; }
}

// ------------------------------------------------------------
// Seleção + formulário lateral
// ------------------------------------------------------------

function sel() { return draft.find((d) => d.id === selectedId) || null; }

function select(id) {
  selectedId = id;
  if (!id) hideForm();
  else {
    const r = sel();
    if (r && !formEl.classList.contains('hidden')) syncForm(r);
  }
  draw();
}

function showForm(r) {
  formEl.classList.remove('hidden');
  formSnap = snapshot();
  syncForm(r);
}

function hideForm() { formEl?.classList.add('hidden'); formSnap = null; }

function syncForm(r) {
  if (formEl.classList.contains('hidden')) return;
  const nameEl = document.getElementById('fp-in-name');
  if (document.activeElement !== nameEl) nameEl.value = r.name || '';
  const setIfIdle = (id, v) => {
    const el = document.getElementById(id);
    if (el && document.activeElement !== el) el.value = v;
  };
  setIfIdle('fp-in-color', normHex(r.color));
  setIfIdle('fp-in-kind', r.kind || 'personalizado');
  setIfIdle('fp-in-floor', String(r.floor ?? 0));
  setIfIdle('fp-in-px', fmt1(r.pos_x));
  setIfIdle('fp-in-pz', fmt1(r.pos_z));
  setIfIdle('fp-in-sx', fmt1(r.size_x));
  setIfIdle('fp-in-sz', fmt1(r.size_z));
  const poly = isPoly(r);
  ['fp-in-sx', 'fp-in-sz'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) { el.disabled = poly; el.title = poly ? 'Polígono: arraste os vértices para mudar a forma' : ''; }
  });
  document.getElementById('btn-fp-topoly')?.classList.toggle('hidden', poly);
  document.getElementById('fp-poly-note')?.classList.toggle('hidden', !poly);
  syncArea(r);
}

function syncArea(r) {
  const el = document.getElementById('fp-area');
  if (el) el.textContent = `${fmt1(roomArea(r))} m²`;
}

// ------------------------------------------------------------
// Ações da barra de ferramentas
// ------------------------------------------------------------

/** Nome único na planta inteira (a tabela tem UNIQUE em name). */
function uniqueName(base) {
  const names = new Set(draft.map((r) => (r.name || '').trim()));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) {
    const cand = `${base} ${i}`;
    if (!names.has(cand)) return cand;
  }
}

/** Procura o primeiro espaço livre em espiral a partir da origem do andar. */
function findFreeSpot(sx, sz) {
  let px = 0, pz = 0, found = false;
  outer:
  for (let ring = 0; ring <= 8 && !found; ring++) {
    for (let ix = -ring; ix <= ring; ix++) {
      for (let iz = -ring; iz <= ring; iz++) {
        if (Math.max(Math.abs(ix), Math.abs(iz)) !== ring) continue;
        px = ix * (Math.max(sx, 3) + 0.5); pz = iz * (Math.max(sz, 3) + 0.5);
        const cand = { id: '__probe', pos_x: px, pos_z: pz, size_x: sx, size_z: sz, floor: currentFloor };
        if (!draft.some((r) => overlaps(cand, r))) { found = true; break outer; }
      }
    }
  }
  return { px, pz };
}

function addRoomFromPreset(preset) {
  pushHistory();
  const { px, pz } = findFreeSpot(preset.sx, preset.sz);
  const maxSort = draft.reduce((m, r) => Math.max(m, r.sort_order ?? 0), 0);
  const room = {
    id: genUuid(),
    name: uniqueName(preset.label),
    pos_x: px, pos_z: pz,
    size_x: preset.sx, size_z: preset.sz,
    color: preset.color,
    kind: preset.kind,
    floor: currentFloor,
    sort_order: maxSort + 1,
  };
  draft.push(room);
  select(room.id);
  showForm(room);
  fitView();
  renderFloorTabs();
  syncToolbar();
  draw();
}

function duplicateSelected() {
  const r = sel();
  if (!r) { toast('Selecione um cômodo para duplicar', '', 'info'); return; }
  pushHistory();
  // espiral fina (0,5 m) ao redor do original até achar espaço livre no andar
  let px = r.pos_x + r.size_x / 2 + 0.5 + r.size_x / 2, pz = r.pos_z; // tentativa inicial: ao lado
  let found = false;
  outer:
  for (let ring = 1; ring <= 10; ring++) {
    for (let ix = -ring; ix <= ring; ix++) {
      for (let iz = -ring; iz <= ring; iz++) {
        if (Math.max(Math.abs(ix), Math.abs(iz)) !== ring) continue;
        const cand = {
          pos_x: r.pos_x + ix * CELL_M, pos_z: r.pos_z + iz * CELL_M,
          size_x: r.size_x, size_z: r.size_z, floor: r.floor,
        };
        if (!draft.some((o) => overlaps(cand, o))) {
          px = cand.pos_x; pz = cand.pos_z;
          found = true;
          break outer;
        }
      }
    }
  }
  if (!found) { // fallback absoluto: primeiro espaço livre do andar
    const spot = findFreeSpot(r.size_x, r.size_z);
    px = spot.px; pz = spot.pz;
  }
  const maxSort = draft.reduce((m, x) => Math.max(m, x.sort_order ?? 0), 0);
  const copy = {
    ...r,
    id: genUuid(),
    name: uniqueName(`${r.name} (cópia)`),
    pos_x: px, pos_z: pz,
    points: r.points ? r.points.map((q) => [...q]) : null,
    sort_order: maxSort + 1,
  };
  draft.push(copy);
  select(copy.id);
  showForm(copy);
  syncToolbar();
  draw();
  toast('Cômodo duplicado', `“${copy.name}” criado ao lado do original.`, 'success');
}

function deleteSelected() {
  const r = sel();
  if (!r) return;
  if (!window.confirm(`Excluir o cômodo “${r.name}”?`)) return;
  pushHistory();
  draft = draft.filter((d) => d.id !== r.id);
  select(null);
  hideForm();
  if (currentFloor > maxFloorUsed()) setFloor(maxFloorUsed());
  renderFloorTabs();
  syncToolbar();
  draw();
}

function resetDefault() {
  if (!window.confirm('Restaurar a planta padrão (4 cômodos no térreo)? Alterações não salvas serão perdidas.')) return;
  pushHistory();
  draft = DEFAULT_ROOMS.map((r) => ({ ...r }));
  currentFloor = 0;
  select(null);
  hideForm();
  fitView();
  renderFloorTabs();
  syncToolbar();
  draw();
}

async function savePlan() {
  if (saving) return;

  // validações
  if (!draft.length && !wallsDraft.length) {
    toast('Planta vazia', 'Adicione ao menos um cômodo ou uma parede antes de salvar.', 'warning');
    return;
  }
  const names = draft.map((r) => (r.name || '').trim());
  if (names.some((n) => !n)) {
    toast('Nome obrigatório', 'Todo cômodo precisa de um nome.', 'warning');
    return;
  }
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) {
    toast('Nome duplicado', `Já existe outro cômodo chamado “${dup}”.`, 'warning');
    return;
  }
  for (const r of draft) {
    if (hasOverlap(r.id)) {
      setFloor(r.floor ?? 0);
      select(r.id);
      flash();
      draw();
      toast('Sobreposição na planta', `“${r.name}” está sobre outro cômodo no ${floorLabel(r.floor ?? 0)}.`, 'critical');
      return;
    }
  }

  const client = await getClient?.();
  if (!client) return;
  saving = true;
  setBusy(true);
  try {
    const { data: existing, error } = await client.from('rooms').select('id, name');
    if (error) throw new Error(error.message);
    const existingIds = new Set((existing || []).map((r) => r.id));

    // remove cômodos excluídos
    const removed = (existing || []).filter((r) => !draft.some((d) => d.id === r.id));
    for (const r of removed) {
      const { error: e2 } = await client.from('rooms').delete().eq('id', r.id);
      if (e2) throw new Error(e2.message);
    }

    let pointsDropped = false;
    // insert dos novos / update dos existentes (com floor + kind, v1.6.0)
    for (const r of draft) {
      const row = {
        id: r.id, name: r.name.trim(),
        pos_x: r.pos_x, pos_z: r.pos_z,
        size_x: r.size_x, size_z: r.size_z,
        color: r.color, sort_order: r.sort_order ?? 0,
        floor: r.floor ?? 0,
        kind: r.kind || 'personalizado',
        points: isPoly(r) ? r.points : null,
      };
      const send = (rw) => (existingIds.has(r.id)
        ? client.from('rooms').update(rw).eq('id', r.id)
        : client.from('rooms').insert(rw));
      let { error: e3 } = await send(row);
      if (e3 && /points/i.test(e3.message || '')) {
        // migração 008 ainda não aplicada: salva como retângulo (caixa) e avisa
        const { points: _p, ...rowNoPoints } = row;
        ({ error: e3 } = await send(rowNoPoints));
        if (!e3) pointsDropped = true;
      }
      if (e3) throw new Error(e3.message);
    }

    // paredes (v1.9.0): remove apagadas, insere novas, atualiza existentes
    const { data: existingWalls, error: ew } = await client.from('walls').select('id');
    if (ew) throw new Error(ew.message);
    const existingWallIds = new Set((existingWalls || []).map((w) => w.id));
    const removedWalls = (existingWalls || []).filter((w) => !wallsDraft.some((d) => d.id === w.id));
    for (const w of removedWalls) {
      const { error: e4 } = await client.from('walls').delete().eq('id', w.id);
      if (e4) throw new Error(e4.message);
    }
    for (const wl of wallsDraft) {
      const row = {
        id: wl.id, floor: wl.floor ?? 0,
        x1: wl.x1, z1: wl.z1, x2: wl.x2, z2: wl.z2,
        th: wl.th || WALL_TH, sort_order: wl.sort_order ?? 0,
      };
      const q = existingWallIds.has(wl.id)
        ? client.from('walls').update(row).eq('id', wl.id)
        : client.from('walls').insert(row);
      const { error: e5 } = await q;
      if (e5) throw new Error(e5.message);
    }
    await loadWalls(client);
    wallsBaseline = wallsLive.map((w) => ({ ...w }));
    wallsDraft = wallsBaseline.map((w) => ({ ...w }));

    // avisa sobre dispositivos órfãos de cômodo (rename/exclusão)
    const baseById = new Map(baseline.map((r) => [r.id, r.name]));
    const affected = new Set();
    removed.forEach((r) => affected.add(r.name));
    draft.forEach((r) => {
      const old = baseById.get(r.id);
      if (old && old !== r.name.trim()) affected.add(old);
    });
    const orphanDevs = state.devices.filter((d) => affected.has(d.room));
    if (orphanDevs.length) {
      toast(
        'Dispositivos mantiveram o cômodo antigo',
        `Verifique: ${orphanDevs.map((d) => d.name).join(', ')}.`,
        'warning'
      );
    }

    await loadRooms(client);
    baseline = state.rooms.map((r) => ({ ...r }));
    draft = baseline.map((r) => ({ ...r }));
    history.past = [];
    history.future = [];
    if (pointsDropped) {
      toast('Cômodos poligonais salvos como retângulos', 'Execute a migração 008_room_polygons.sql no Supabase para guardar a forma exata.', 'warning');
    }
    toast('Planta salva com sucesso!', 'A cena 3D e os painéis já refletem a nova planta.', 'success');
    closeEditor();
  } catch (err) {
    console.error('[planta] falha ao salvar', err);
    toast('Falha ao salvar a planta', err.message, 'critical');
  } finally {
    saving = false;
    setBusy(false);
  }
}

function setBusy(b) {
  const btn = document.getElementById('btn-fp-save');
  if (!btn) return;
  btn.disabled = b;
  btn.textContent = b ? 'Salvando…' : 'Salvar planta';
}

// ------------------------------------------------------------
// Geometria: snap, clamp, sobreposição, flash
// ------------------------------------------------------------

function snap(v) { return Math.round(v / CELL_M) * CELL_M; }
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function fmt1(v) { return (Math.round(v * 10) / 10).toLocaleString('pt-BR'); }

/** Sobreposição só conta dentro do MESMO andar. */
function overlaps(a, b) {
  if ((Number(a.floor) || 0) !== (Number(b.floor) || 0)) return false;
  if (isPoly(a) || isPoly(b)) return false;   // a caixa de um polígono engana (ex.: planta em L)
  return (
    Math.abs(a.pos_x - b.pos_x) * 2 < a.size_x + b.size_x - 1e-9 &&
    Math.abs(a.pos_z - b.pos_z) * 2 < a.size_z + b.size_z - 1e-9
  );
}

function hasOverlap(id) {
  const r = draft.find((d) => d.id === id);
  return !!r && draft.some((o) => o.id !== id && overlaps(r, o));
}

function flash() {
  flashUntil = performance.now() + 650;
  const wrap = canvas?.closest('.fp-canvas-wrap');
  if (wrap) {
    wrap.classList.remove('room-overlap-flash');
    void wrap.offsetWidth; // reinicia a animação CSS
    wrap.classList.add('room-overlap-flash');
    setTimeout(() => wrap.classList.remove('room-overlap-flash'), 700);
  }
}

// ------------------------------------------------------------
// Utilitários
// ------------------------------------------------------------

function hexA(hex, alpha) {
  const { r, g, b } = hexRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

function hexRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return { r: 129, g: 140, b: 248 }; // fallback índigo
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Mistura a cor com preto (fator 0..1) — borda "parede" mais escura. */
function shade(hex, factor) {
  const { r, g, b } = hexRgb(hex);
  const f = 1 - clamp(factor, 0, 1);
  return `rgb(${Math.round(r * f)},${Math.round(g * f)},${Math.round(b * f)})`;
}

function normHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  return m ? `#${m[1].toLowerCase()}` : '#818cf8';
}

function genUuid() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16));
}
