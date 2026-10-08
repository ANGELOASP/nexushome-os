// ============================================================
// NexusHome OS — janela "Importar planta CAD" (DXF)
// Fluxo: escolher arquivo → camadas/unidade/opções + prévia → importar.
// O resultado é entregue ao editor via `apply(plan, opts)`; nada é
// gravado no banco aqui (o usuário ainda revisa e clica em Salvar).
// ============================================================

import { parseDxf, dxfToPlan, guessUnitScale, looksLikeWallLayer, DxfError, UNIT_LABELS } from './dxf.js';
import { toast, escapeHtml } from './toasts.js';

const MAX_BYTES = 40 * 1024 * 1024;

let modal, parsed = null, selectedLayers = new Set(), cfg = null, ui = {};

export function initDxfImport({ getContext, apply }) {
  modal = document.getElementById('modal-dxf');
  if (!modal) return;
  cfg = { getContext, apply };
  ui = {
    stepFile: document.getElementById('dxf-step-file'),
    stepCfg: document.getElementById('dxf-step-config'),
    file: document.getElementById('dxf-file'),
    drop: document.getElementById('dxf-drop'),
    error: document.getElementById('dxf-error'),
    dwg: document.getElementById('dxf-dwg-help'),
    layers: document.getElementById('dxf-layers'),
    preview: document.getElementById('dxf-preview'),
    size: document.getElementById('dxf-size'),
    warn: document.getElementById('dxf-warn'),
    unit: document.getElementById('dxf-unit'),
    th: document.getElementById('dxf-th'),
    optWalls: document.getElementById('dxf-opt-walls'),
    optRooms: document.getElementById('dxf-opt-rooms'),
    optCenter: document.getElementById('dxf-opt-center'),
    optReplace: document.getElementById('dxf-opt-replace'),
    apply: document.getElementById('btn-dxf-apply'),
  };

  document.getElementById('btn-fp-import')?.addEventListener('click', open);
  document.getElementById('btn-dxf-close')?.addEventListener('click', close);
  document.getElementById('btn-dxf-back')?.addEventListener('click', showFileStep);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  ui.file.addEventListener('change', () => { const f = ui.file.files?.[0]; if (f) handleFile(f); ui.file.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) => ui.drop.addEventListener(ev, (e) => { e.preventDefault(); ui.drop.classList.add('dxf-drop-over'); }));
  ['dragleave', 'drop'].forEach((ev) => ui.drop.addEventListener(ev, (e) => { e.preventDefault(); ui.drop.classList.remove('dxf-drop-over'); }));
  ui.drop.addEventListener('drop', (e) => { const f = e.dataTransfer?.files?.[0]; if (f) handleFile(f); });

  document.getElementById('dxf-layers-all')?.addEventListener('click', () => setLayers(() => true));
  document.getElementById('dxf-layers-none')?.addEventListener('click', () => setLayers(() => false));
  document.getElementById('dxf-layers-walls')?.addEventListener('click', () => setLayers(looksLikeWallLayer));
  [ui.unit, ui.th, ui.optWalls, ui.optRooms, ui.optCenter].forEach((el) => el.addEventListener('input', refresh));
  ui.apply.addEventListener('click', doApply);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) { e.stopPropagation(); close(); } }, true);
}

function isOpen() { return modal?.classList.contains('modal-open'); }

function open() {
  parsed = null;
  showFileStep();
  modal.classList.add('modal-open');
  modal.setAttribute('aria-hidden', 'false');
}

function close() {
  modal.classList.remove('modal-open');
  modal.setAttribute('aria-hidden', 'true');
  parsed = null;
}

function showFileStep() {
  ui.stepFile.classList.remove('hidden');
  ui.stepCfg.classList.add('hidden');
  ui.error.classList.add('hidden');
  ui.dwg.classList.add('hidden');
}

function fail(msg) {
  ui.error.textContent = msg;
  ui.error.classList.remove('hidden');
}

async function handleFile(file) {
  ui.error.classList.add('hidden');
  ui.dwg.classList.add('hidden');
  const name = file.name.toLowerCase();
  if (name.endsWith('.dwg')) { ui.dwg.classList.remove('hidden'); fail('Este arquivo é .dwg — converta para .dxf antes de importar.'); return; }
  if (!name.endsWith('.dxf')) { fail('Escolha um arquivo .dxf.'); return; }
  if (file.size > MAX_BYTES) { fail('Arquivo muito grande (limite de 40 MB). Exporte só as camadas de paredes.'); return; }
  try {
    const text = await file.text();
    parsed = parseDxf(text);
  } catch (err) {
    fail(err instanceof DxfError ? err.message : 'Não consegui ler este arquivo como DXF.');
    if (!(err instanceof DxfError)) console.error('[dxf]', err);
    return;
  }
  buildLayerList();
  ui.unit.value = 'auto';
  ui.stepFile.classList.add('hidden');
  ui.stepCfg.classList.remove('hidden');
  refresh();
}

function buildLayerList() {
  const names = Object.keys(parsed.layers).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const wallish = names.filter(looksLikeWallLayer);
  selectedLayers = new Set(wallish.length ? wallish : names);
  ui.layers.innerHTML = names.map((n) => {
    const L = parsed.layers[n];
    return `<label class="dxf-layer-row"><input type="checkbox" data-layer="${escapeHtml(n)}" ${selectedLayers.has(n) ? 'checked' : ''} />
      <span class="dxf-layer-name" title="${escapeHtml(n)}">${escapeHtml(n)}</span>
      <span class="dxf-layer-count">${L.items}${L.closed ? ` · ${L.closed} fechad${L.closed === 1 ? 'a' : 'as'}` : ''}</span></label>`;
  }).join('');
  ui.layers.querySelectorAll('input[data-layer]').forEach((cb) => cb.addEventListener('change', () => {
    if (cb.checked) selectedLayers.add(cb.dataset.layer); else selectedLayers.delete(cb.dataset.layer);
    refresh();
  }));
}

function setLayers(pred) {
  selectedLayers = new Set(Object.keys(parsed.layers).filter(pred));
  ui.layers.querySelectorAll('input[data-layer]').forEach((cb) => { cb.checked = selectedLayers.has(cb.dataset.layer); });
  refresh();
}

function currentScale() {
  if (ui.unit.value !== 'auto') return parseFloat(ui.unit.value);
  return parsed.units ?? guessUnitScale(parsed.bounds);
}

function buildPlan() {
  try {
    return dxfToPlan(parsed, {
      layers: selectedLayers,
      scale: currentScale(),
      walls: ui.optWalls.checked,
      rooms: ui.optRooms.checked,
      recenter: ui.optCenter.checked,
    });
  } catch (err) {
    if (err instanceof DxfError) return { error: err.message };
    throw err;
  }
}

function refresh() {
  if (!parsed) return;
  const plan = buildPlan();
  const warn = [];
  const scale = currentScale();
  const auto = ui.unit.value === 'auto';
  const unitName = UNIT_LABELS[scale] || `${scale} m/un`;

  if (plan.error) {
    ui.size.textContent = '';
    ui.warn.textContent = plan.error;
    ui.warn.classList.remove('hidden');
    ui.apply.disabled = true;
    drawPreview(null);
    return;
  }

  if (plan.bounds) {
    const w = plan.bounds.w, d = plan.bounds.d;
    ui.size.innerHTML = `Unidade ${auto ? (parsed.units ? 'do arquivo' : 'estimada') : 'escolhida'}: <strong class="text-slate-200">${unitName}</strong><br>` +
      `Tamanho: <strong class="text-slate-200">${fmt(w)} × ${fmt(d)} m</strong> · ${plan.stats.walls} parede(s) · ${plan.stats.rooms} cômodo(s)`;
    if (Math.max(w, d) > 80) warn.push('A planta ficou com mais de 80 m — a unidade provavelmente está errada (tente milímetros ou centímetros).');
    if (Math.max(w, d) < 3) warn.push('A planta ficou menor que 3 m — a unidade provavelmente está errada (tente metros ou polegadas).');
  } else {
    ui.size.textContent = 'Nenhuma camada selecionada.';
  }
  const skipped = Object.entries(parsed.skipped || {}).filter(([k]) => k !== 'INSERT');
  if (skipped.length) warn.push(`Ignorados: ${skipped.map(([k, v]) => `${v} ${k}`).join(', ')}.`);
  ui.warn.innerHTML = warn.map(escapeHtml).join('<br>');
  ui.warn.classList.toggle('hidden', !warn.length);
  ui.apply.disabled = !plan.walls.length && !plan.rooms.length;
  drawPreview(plan);
}

function drawPreview(plan) {
  const c = ui.preview, g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  if (!plan || (!plan.walls.length && !plan.rooms.length)) return;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const grow = (x, z) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); };
  plan.walls.forEach((w) => { grow(w.x1, w.z1); grow(w.x2, w.z2); });
  plan.rooms.forEach((r) => r.points.forEach(([x, z]) => grow(x, z)));
  const pad = 10;
  const k = Math.min((c.width - pad * 2) / Math.max(0.1, maxX - minX), (c.height - pad * 2) / Math.max(0.1, maxZ - minZ));
  const X = (x) => pad + (x - minX) * k + ((c.width - pad * 2) - (maxX - minX) * k) / 2;
  const Z = (z) => pad + (z - minZ) * k + ((c.height - pad * 2) - (maxZ - minZ) * k) / 2;
  g.fillStyle = 'rgba(242,178,74,0.16)';
  plan.rooms.forEach((r) => {
    g.beginPath();
    r.points.forEach(([x, z], i) => (i ? g.lineTo(X(x), Z(z)) : g.moveTo(X(x), Z(z))));
    g.closePath(); g.fill();
  });
  g.strokeStyle = '#cbd5e1';
  g.lineWidth = 1;
  g.beginPath();
  plan.walls.forEach((w) => { g.moveTo(X(w.x1), Z(w.z1)); g.lineTo(X(w.x2), Z(w.z2)); });
  g.stroke();
}

function doApply() {
  if (!parsed) return;
  const plan = buildPlan();
  if (plan.error || (!plan.walls.length && !plan.rooms.length)) return;
  const th = Math.min(0.6, Math.max(0.03, parseFloat(String(ui.th.value).replace(',', '.')) || 0.12));
  const ctxInfo = cfg.getContext();
  const replace = ui.optReplace.checked;
  if (!replace && (ctxInfo.rooms.length || ctxInfo.walls.length) && ui.optCenter.checked) {
    // avisa: o desenho importado é centralizado na origem e pode cair sobre o que já existe
    toast('Dica', 'O desenho foi centralizado na origem; mova os cômodos se ele cair sobre a planta atual.', 'info');
  }
  cfg.apply(plan, { replace, wallThickness: th });
  close();
}

function fmt(v) { return (Math.round(v * 10) / 10).toLocaleString('pt-BR'); }
