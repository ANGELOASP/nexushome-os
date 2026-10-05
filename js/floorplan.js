// ============================================================
// NexusHome OS — Editor de Planta (v1.3.0)
// ------------------------------------------------------------
// Editor 2D top-down em canvas: a planta da residência deixa de
// ser fixa no código e passa a vir da tabela `rooms` (Supabase)
// ou do localStorage (Modo Demonstração).
//
//   · grade de 0,5 m (1 célula = 0,5 metro), eixo z = "y para baixo"
//   · clique seleciona · arrasto move · alça no canto redimensiona
//   · duplo-clique abre o formulário (nome, cor, largura, profundidade)
//   · snap na grade · sobreposição é revertida com flash vermelho
//   · Salvar → persiste (live: delete + insert/update; demo: localStorage)
//   · 'rooms-changed' reconstrói a cena 3D e o painel de dispositivos
// ============================================================

import { state, setRooms, DEFAULT_ROOMS } from './state.js';
import { toast } from './toasts.js';

const CELL_M = 0.5;        // 1 célula da grade = 0,5 m
const MIN_SIZE = 1.0;      // tamanho mínimo do cômodo (m)
const MAX_SIZE = 12.0;     // tamanho máximo (m)
const HANDLE_M = 0.45;     // alça de resize, em metros de tela-mundo
const PALETTE = ['#818cf8', '#38bdf8', '#fbbf24', '#4ade80', '#f472b6', '#fb923c', '#2dd4bf', '#c084fc'];

let getClient = null;
let modal, canvas, ctx, formEl;
let draft = [];            // cópia de trabalho de state.rooms
let baseline = [];         // planta no momento em que o modal abriu
let selectedId = null;
let view = { scale: 48, cx: 0, cz: 0 };   // px por metro + centro do mundo visível
let drag = null;           // { mode:'move'|'resize', id, startWX, startWZ, orig:{...} }
let flashUntil = 0;        // timestamp do flash vermelho de sobreposição
let rafId = 0;
let saving = false;

// ------------------------------------------------------------
// API pública
// ------------------------------------------------------------

export function initFloorplan({ getClient: gc } = {}) {
  getClient = gc;
  modal = document.getElementById('editor-planta');
  canvas = document.getElementById('fp-canvas');
  formEl = document.getElementById('fp-form');
  if (!modal || !canvas) return;
  ctx = canvas.getContext('2d');

  document.getElementById('btn-floorplan')?.addEventListener('click', openEditor);
  document.getElementById('btn-fp-close')?.addEventListener('click', closeEditor);
  document.getElementById('btn-fp-save')?.addEventListener('click', savePlan);
  document.getElementById('btn-fp-reset')?.addEventListener('click', resetDefault);
  document.getElementById('btn-fp-add')?.addEventListener('click', addRoom);
  document.getElementById('btn-fp-delete')?.addEventListener('click', deleteSelected);

  // formulário lateral: edição em tempo real do rascunho
  document.getElementById('fp-in-name')?.addEventListener('input', (e) => {
    const r = sel(); if (!r) return;
    r.name = e.target.value.slice(0, 40);
    draw();
  });
  document.getElementById('fp-in-color')?.addEventListener('input', (e) => {
    const r = sel(); if (!r) return;
    r.color = e.target.value;
    draw();
  });
  ['fp-in-sx', 'fp-in-sz'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', (e) => {
      const r = sel(); if (!r) return;
      const key = id === 'fp-in-sx' ? 'size_x' : 'size_z';
      const prev = r[key];
      r[key] = snap(clamp(parseFloat(e.target.value) || prev, MIN_SIZE, MAX_SIZE));
      e.target.value = fmt1(r[key]);
      if (hasOverlap(r.id)) {
        r[key] = prev;
        e.target.value = fmt1(prev);
        flash();
        toast('Sobreposição evitada', 'O cômodo ficaria sobre outro — tamanho revertido.', 'warning');
      }
      draw();
    });
  });

  // interações no canvas
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('dblclick', onDblClick);

  window.addEventListener('resize', () => { if (isOpen()) { sizeCanvas(); draw(); } });
  window.addEventListener('keydown', (e) => {
    if (!isOpen()) return;
    if (e.key === 'Escape') {
      if (!formEl?.classList.contains('hidden')) hideForm();
      else closeEditor();
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && formEl?.classList.contains('hidden')) {
      e.preventDefault();
      deleteSelected();
    }
  });
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
  baseline = state.rooms.length ? state.rooms : DEFAULT_ROOMS;
  draft = baseline.map((r) => ({ ...r }));
  selectedId = null;
  hideForm();
  modal.classList.add('modal-open');
  sizeCanvas();
  fitView();
  startLoop();
}

function closeEditor() {
  if (saving) return;
  modal.classList.remove('modal-open');
  stopLoop();
  draft = [];
  selectedId = null;
  hideForm();
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

/** Enquadra todos os cômodos com margem. */
function fitView() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!draft.length) { view = { scale: 48, cx: 0, cz: 0 }; return; }
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  draft.forEach((r) => {
    minX = Math.min(minX, r.pos_x - r.size_x / 2); maxX = Math.max(maxX, r.pos_x + r.size_x / 2);
    minZ = Math.min(minZ, r.pos_z - r.size_z / 2); maxZ = Math.max(maxZ, r.pos_z + r.size_z / 2);
  });
  const margin = 2.2; // metros de respiro
  const sx = w / Math.max(1, (maxX - minX) + margin);
  const sz = h / Math.max(1, (maxZ - minZ) + margin);
  view = { scale: Math.min(sx, sz, 90), cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 };
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
  draft.forEach((r) => drawRoom(r, flashing && r.id === selectedId));
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

function drawRoom(r, flashing) {
  const x = w2sx(r.pos_x - r.size_x / 2);
  const y = w2sz(r.pos_z - r.size_z / 2);
  const w = r.size_x * view.scale;
  const h = r.size_z * view.scale;
  const isSel = r.id === selectedId;

  // preenchimento translúcido na cor do cômodo
  ctx.fillStyle = hexA(r.color, isSel ? 0.30 : 0.18);
  ctx.fillRect(x, y, w, h);

  ctx.lineWidth = isSel ? 2.5 : 1.5;
  ctx.strokeStyle = flashing ? '#ef4444' : (isSel ? '#22d3ee' : hexA(r.color, 0.9));
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
// Interações de ponteiro
// ------------------------------------------------------------

function canvasPos(e) {
  const rect = canvas.getBoundingClientRect();
  return { px: e.clientX - rect.left, py: e.clientY - rect.top };
}

function roomAt(wx, wz) {
  // varre de cima para baixo (último desenhado primeiro)
  for (let i = draft.length - 1; i >= 0; i--) {
    const r = draft[i];
    if (Math.abs(wx - r.pos_x) <= r.size_x / 2 && Math.abs(wz - r.pos_z) <= r.size_z / 2) return r;
  }
  return null;
}

function onHandle(r, wx, wz) {
  const hx = r.pos_x + r.size_x / 2, hz = r.pos_z + r.size_z / 2;
  return Math.abs(wx - hx) <= HANDLE_M && Math.abs(wz - hz) <= HANDLE_M;
}

function onPointerDown(e) {
  const { px, py } = canvasPos(e);
  const wx = s2wx(px), wz = s2wz(py);
  const r = roomAt(wx, wz);

  if (!r) { select(null); return; }

  const mode = (r.id === selectedId && onHandle(r, wx, wz)) ? 'resize' : 'move';
  select(r.id);
  drag = {
    mode, id: r.id, startWX: wx, startWZ: wz,
    orig: { pos_x: r.pos_x, pos_z: r.pos_z, size_x: r.size_x, size_z: r.size_z },
  };
  canvas.setPointerCapture(e.pointerId);
  canvas.style.cursor = mode === 'resize' ? 'nwse-resize' : 'grabbing';
}

function onPointerMove(e) {
  const { px, py } = canvasPos(e);
  const wx = s2wx(px), wz = s2wz(py);

  if (!drag) {
    // cursor de contexto
    const r = roomAt(wx, wz);
    canvas.style.cursor = !r ? 'default' : (r.id === selectedId && onHandle(r, wx, wz)) ? 'nwse-resize' : 'grab';
    return;
  }

  const r = draft.find((d) => d.id === drag.id);
  if (!r) { drag = null; return; }

  if (drag.mode === 'move') {
    r.pos_x = snap(drag.orig.pos_x + (wx - drag.startWX));
    r.pos_z = snap(drag.orig.pos_z + (wz - drag.startWZ));
  } else {
    r.size_x = clamp(snap(drag.orig.size_x + 2 * (wx - drag.startWX)), MIN_SIZE, MAX_SIZE);
    r.size_z = clamp(snap(drag.orig.size_z + 2 * (wz - drag.startWZ)), MIN_SIZE, MAX_SIZE);
    syncForm(r);
  }
  draw();
}

function onPointerUp(e) {
  if (!drag) return;
  const r = draft.find((d) => d.id === drag.id);
  const { mode, orig } = drag;
  drag = null;
  canvas.style.cursor = 'default';
  try { canvas.releasePointerCapture(e.pointerId); } catch { /* noop */ }

  if (r && hasOverlap(r.id)) {
    // sobreposição: reverte e pisca em vermelho
    Object.assign(r, orig);
    flash();
    draw();
    toast('Sobreposição evitada', `“${r.name || 'Cômodo'}” ficaria sobre outro cômodo — ${mode === 'move' ? 'posição' : 'tamanho'} revertido.`, 'warning');
  }
  if (r) syncForm(r);
}

function onDblClick(e) {
  const { px, py } = canvasPos(e);
  const r = roomAt(s2wx(px), s2wz(py));
  if (r) { select(r.id); showForm(r); }
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
  syncForm(r);
}

function hideForm() { formEl?.classList.add('hidden'); }

function syncForm(r) {
  if (formEl.classList.contains('hidden')) return;
  const nameEl = document.getElementById('fp-in-name');
  if (document.activeElement !== nameEl) nameEl.value = r.name || '';
  document.getElementById('fp-in-color').value = normHex(r.color);
  document.getElementById('fp-in-sx').value = fmt1(r.size_x);
  document.getElementById('fp-in-sz').value = fmt1(r.size_z);
}

// ------------------------------------------------------------
// Ações da barra de ferramentas
// ------------------------------------------------------------

function addRoom() {
  // procura o primeiro espaço livre em espiral a partir da origem
  const size = 3.0;
  let px = 0, pz = 0, found = false;
  outer:
  for (let ring = 0; ring <= 6 && !found; ring++) {
    for (let ix = -ring; ix <= ring; ix++) {
      for (let iz = -ring; iz <= ring; iz++) {
        if (Math.max(Math.abs(ix), Math.abs(iz)) !== ring) continue;
        px = ix * (size + 0.5); pz = iz * (size + 0.5);
        const cand = { id: '__probe', pos_x: px, pos_z: pz, size_x: size, size_z: size };
        if (!draft.some((r) => overlaps(cand, r))) { found = true; break outer; }
      }
    }
  }
  const maxSort = draft.reduce((m, r) => Math.max(m, r.sort_order ?? 0), 0);
  const room = {
    id: genUuid(),
    name: `Novo Cômodo ${draft.length + 1}`,
    pos_x: px, pos_z: pz,
    size_x: size, size_z: size,
    color: PALETTE[draft.length % PALETTE.length],
    sort_order: maxSort + 1,
  };
  draft.push(room);
  select(room.id);
  showForm(room);
  fitView();
  draw();
}

function deleteSelected() {
  const r = sel();
  if (!r) return;
  if (!window.confirm(`Excluir o cômodo “${r.name}”?`)) return;
  draft = draft.filter((d) => d.id !== r.id);
  select(null);
  hideForm();
  draw();
}

function resetDefault() {
  if (!window.confirm('Restaurar a planta padrão (4 cômodos)? Alterações não salvas serão perdidas.')) return;
  draft = DEFAULT_ROOMS.map((r) => ({ ...r }));
  select(null);
  hideForm();
  fitView();
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
      select(r.id);
      flash();
      draw();
      toast('Sobreposição na planta', `“${r.name}” está sobre outro cômodo.`, 'critical');
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

    // insert dos novos / update dos existentes
    for (const r of draft) {
      const row = {
        id: r.id, name: r.name.trim(),
        pos_x: r.pos_x, pos_z: r.pos_z,
        size_x: r.size_x, size_z: r.size_z,
        color: r.color, sort_order: r.sort_order ?? 0,
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

function overlaps(a, b) {
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

function normHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  return m ? `#${m[1].toLowerCase()}` : '#818cf8';
}

function genUuid() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16));
}
