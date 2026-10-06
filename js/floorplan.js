// ============================================================
// NexusHome OS — Editor de Planta 2.0 (v1.6.0)
// ------------------------------------------------------------
// Editor 2D top-down em canvas: a planta da residência deixa de
// ser fixa no código e passa a vir da tabela `rooms` (Supabase)
// ou do localStorage (Modo Demonstração).
//
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
//   · PAINEL DE PRECISÃO: X, Y, Largura, Profundidade (0,1 m) e
//     área ao vivo; área total por andar na barra de ferramentas
//   · Duplicar (Ctrl+D), setas movem 0,5 m (Shift = 0,1 m)
//   · sobreposição (no mesmo andar) é revertida com flash vermelho
//   · Salvar → persiste (live: delete + insert/update; demo: localStorage)
//   · 'rooms-changed' reconstrói a cena 3D e o painel de dispositivos
// ============================================================

import {
  state, setRooms, DEFAULT_ROOMS,
  ROOM_PRESETS, MAX_FLOORS, floorLabel, presetByKind, normalizeRoom,
} from './state.js';
import { toast } from './toasts.js';

const CELL_M = 0.5;        // 1 célula da grade = 0,5 m
const MIN_SIZE = 1.0;      // tamanho mínimo do cômodo (m)
const MAX_SIZE = 12.0;     // tamanho máximo (m)
const HANDLE_M = 0.45;     // alça de resize, em metros de tela-mundo
const SNAP_PX = 6;         // raio de atração das guias de alinhamento (px de tela)
const HISTORY_CAP = 50;    // passos de undo/redo
const ZOOM_MIN = 10;       // px por metro
const ZOOM_MAX = 160;

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
  document.getElementById('btn-fp-fit')?.addEventListener('click', () => { fitView(); draw(); });
  document.getElementById('fp-snap')?.addEventListener('change', (e) => { snapEnabled = !!e.target.checked; });

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

// ------------------------------------------------------------
// Abrir / fechar
// ------------------------------------------------------------

function isOpen() { return modal?.classList.contains('modal-open'); }

function openEditor() {
  baseline = (state.rooms.length ? state.rooms : DEFAULT_ROOMS).map(normalizeRoom);
  draft = baseline.map((r) => ({ ...r }));
  currentFloor = Math.min(maxFloorUsed(), currentFloor);
  if (!draft.some((r) => r.floor === currentFloor)) currentFloor = 0;
  selectedId = null;
  history.past = [];
  history.future = [];
  formSnap = null;
  hideForm();
  hidePresets();
  modal.classList.add('modal-open');
  sizeCanvas();
  fitView();
  renderFloorTabs();
  syncToolbar();
  startLoop();
}

function closeEditor() {
  if (saving) return;
  modal.classList.remove('modal-open');
  stopLoop();
  draft = [];
  selectedId = null;
  hideForm();
  hidePresets();
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
  return JSON.stringify({ rooms: draft, floor: currentFloor });
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
    const { rooms, floor } = JSON.parse(snapStr);
    draft = rooms;
    currentFloor = Math.min(floor ?? 0, maxFloorUsed());
    select(null);
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

/** Enquadra os cômodos do andar corrente com margem. */
function fitView() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const rooms = floorRooms();
  if (!rooms.length) { view = { scale: 48, cx: 0, cz: 0 }; return; }
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  rooms.forEach((r) => {
    minX = Math.min(minX, r.pos_x - r.size_x / 2); maxX = Math.max(maxX, r.pos_x + r.size_x / 2);
    minZ = Math.min(minZ, r.pos_z - r.size_z / 2); maxZ = Math.max(maxZ, r.pos_z + r.size_z / 2);
  });
  const margin = 2.2; // metros de respiro
  const sx = w / Math.max(1, (maxX - minX) + margin);
  const sz = h / Math.max(1, (maxZ - minZ) + margin);
  view = { scale: clamp(Math.min(sx, sz), ZOOM_MIN, 90), cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 };
}

function w2sx(x) { return (x - view.cx) * view.scale + canvas.clientWidth / 2; }
function w2sz(z) { return (z - view.cz) * view.scale + canvas.clientHeight / 2; }
function s2wx(px) { return (px - canvas.clientWidth / 2) / view.scale + view.cx; }
function s2wz(py) { return (py - canvas.clientHeight / 2) / view.scale + view.cz; }

function startLoop() {
  stopLoop();
  const loop = () => { draw(); rafId = requestAnimationFrame(loop); };
  loop();
}
function stopLoop() { if (rafId) cancelAnimationFrame(rafId); rafId = 0; }

function draw() {
  if (!ctx) return;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);

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

  drawGuides(w, h);
}

function drawGrid(w, h) {
  const step = CELL_M * view.scale;
  const x0 = w2sx(0), z0 = w2sz(0);

  ctx.lineWidth = 1;
  for (let x = x0 % step, i = Math.round((x - x0) / step); x < w; x += step, i++) {
    ctx.strokeStyle = i % 2 === 0 ? 'rgba(56,72,110,0.55)' : 'rgba(36,49,79,0.35)';
    line(x, 0, x, h);
  }
  for (let y = z0 % step, i = Math.round((y - z0) / step); y < h; y += step, i++) {
    ctx.strokeStyle = i % 2 === 0 ? 'rgba(56,72,110,0.55)' : 'rgba(36,49,79,0.35)';
    line(0, y, w, y);
  }

  // eixos do mundo
  ctx.strokeStyle = 'rgba(94,120,170,0.5)';
  ctx.lineWidth = 1.5;
  line(x0, 0, x0, h);
  line(0, z0, w, z0);
}

function line(x1, y1, x2, y2) {
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
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

  // alça de resize no canto inferior direito do cômodo selecionado
  if (isSel && !flashing) {
    const hx = x + w, hy = y + h;
    const s = HANDLE_M * view.scale;
    ctx.fillStyle = '#22d3ee';
    ctx.strokeStyle = '#0b1120';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(hx, hy - s); ctx.lineTo(hx, hy); ctx.lineTo(hx - s, hy);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
  }
}

// ------------------------------------------------------------
// Zoom (roda do mouse, ancorado no cursor) + status da toolbar
// ------------------------------------------------------------

function onWheel(e) {
  if (!isOpen()) return;
  e.preventDefault();
  const { px, py } = canvasPos(e);
  const wx = s2wx(px), wz = s2wz(py); // ponto do mundo sob o cursor
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  const next = clamp(view.scale * factor, ZOOM_MIN, ZOOM_MAX);
  if (next === view.scale) return;
  view.scale = next;
  // mantém o ponto do mundo sob o cursor
  view.cx = wx - (px - canvas.clientWidth / 2) / view.scale;
  view.cz = wz - (py - canvas.clientHeight / 2) / view.scale;
  draw();
}

function syncToolbar() {
  const undoBtn = document.getElementById('btn-fp-undo');
  const redoBtn = document.getElementById('btn-fp-redo');
  if (undoBtn) undoBtn.disabled = !history.past.length;
  if (redoBtn) redoBtn.disabled = !history.future.length;

  const el = document.getElementById('fp-area-status');
  if (el) {
    const rooms = floorRooms();
    const area = rooms.reduce((s, r) => s + r.size_x * r.size_z, 0);
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
    if (Math.abs(wx - r.pos_x) <= r.size_x / 2 && Math.abs(wz - r.pos_z) <= r.size_z / 2) return r;
  }
  return null;
}

function onHandle(r, wx, wz) {
  const hx = r.pos_x + r.size_x / 2, hz = r.pos_z + r.size_z / 2;
  return Math.abs(wx - hx) <= HANDLE_M && Math.abs(wz - hz) <= HANDLE_M;
}

function onPointerDown(e) {
  hidePresets();
  const { px, py } = canvasPos(e);
  const wx = s2wx(px), wz = s2wz(py);
  const r = roomAt(wx, wz);

  // botão do meio OU espaço vazio → pan da vista
  if (e.button === 1 || !r) {
    if (e.button === 0) select(null);
    drag = { mode: 'pan', startPX: px, startPY: py, origCX: view.cx, origCZ: view.cz };
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
    e.preventDefault();
    return;
  }

  const mode = (r.id === selectedId && onHandle(r, wx, wz)) ? 'resize' : 'move';
  select(r.id);
  drag = {
    mode, id: r.id, startWX: wx, startWZ: wz,
    orig: { pos_x: r.pos_x, pos_z: r.pos_z, size_x: r.size_x, size_z: r.size_z },
    snapBefore: snapshot(),
    changed: false,
  };
  canvas.setPointerCapture(e.pointerId);
  canvas.style.cursor = mode === 'resize' ? 'nwse-resize' : 'grabbing';
}

function onPointerMove(e) {
  const { px, py } = canvasPos(e);

  if (drag?.mode === 'pan') {
    view.cx = drag.origCX - (px - drag.startPX) / view.scale;
    view.cz = drag.origCZ - (py - drag.startPY) / view.scale;
    draw();
    return;
  }

  const wx = s2wx(px), wz = s2wz(py);

  if (!drag) {
    // cursor de contexto
    const r = roomAt(wx, wz);
    canvas.style.cursor = !r ? 'default' : (r.id === selectedId && onHandle(r, wx, wz)) ? 'nwse-resize' : 'grab';
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
    // resize pela alça inferior direita: move as arestas direita/inferior
    let rx = drag.orig.pos_x + drag.orig.size_x / 2 + (wx - drag.startWX);
    let rz = drag.orig.pos_z + drag.orig.size_z / 2 + (wz - drag.startWZ);
    const snapped = alignSnapEdges(r, rx, rz, thr);
    rx = snapped.x; rz = snapped.z;
    if (!snapped.xSnap && snapEnabled) rx = snap(rx);
    if (!snapped.zSnap && snapEnabled) rz = snap(rz);
    r.size_x = clamp(2 * (rx - r.pos_x), MIN_SIZE, MAX_SIZE);
    r.size_z = clamp(2 * (rz - r.pos_z), MIN_SIZE, MAX_SIZE);
    syncForm(r);
  }
  drag.changed = true;
  syncToolbar();
  draw();
}

function onPointerUp(e) {
  if (!drag) return;
  const { mode } = drag;
  if (mode === 'pan') {
    drag = null;
    canvas.style.cursor = 'default';
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* noop */ }
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

  if (e.key === 'Escape') {
    if (!presetsEl?.classList.contains('hidden')) { hidePresets(); return; }
    if (!formEl?.classList.contains('hidden')) hideForm();
    else closeEditor();
    return;
  }

  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && !typing) {
    e.preventDefault();
    deleteSelected();
    return;
  }

  // setas: nudge de 0,5 m (Shift = 0,1 m) no cômodo selecionado
  const NUDGE = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
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
  syncArea(r);
}

function syncArea(r) {
  const el = document.getElementById('fp-area');
  if (el) el.textContent = `${fmt1(r.size_x * r.size_z)} m²`;
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
  if (!draft.length) {
    toast('Planta vazia', 'Adicione ao menos um cômodo antes de salvar.', 'warning');
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

    // insert dos novos / update dos existentes (com floor + kind, v1.6.0)
    for (const r of draft) {
      const row = {
        id: r.id, name: r.name.trim(),
        pos_x: r.pos_x, pos_z: r.pos_z,
        size_x: r.size_x, size_z: r.size_z,
        color: r.color, sort_order: r.sort_order ?? 0,
        floor: r.floor ?? 0,
        kind: r.kind || 'personalizado',
      };
      const q = existingIds.has(r.id)
        ? client.from('rooms').update(row).eq('id', r.id)
        : client.from('rooms').insert(row);
      const { error: e3 } = await q;
      if (e3) throw new Error(e3.message);
    }

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
