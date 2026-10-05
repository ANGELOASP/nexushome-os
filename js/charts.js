// ============================================================
// NexusHome OS — Sparklines em canvas (histórico de telemetria)
// ============================================================

export class Sparkline {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{stroke?: string, fill?: string, maxPoints?: number, min?: number|null}} opts
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.stroke = opts.stroke || '#22d3ee';
    this.fill = opts.fill ?? this.stroke;
    this.maxPoints = opts.maxPoints || 60;
    this.fixedMin = opts.min ?? null;
    this.data = [];

    const ro = new ResizeObserver(() => this.draw());
    ro.observe(canvas);
  }

  push(value) {
    this.data.push(value);
    if (this.data.length > this.maxPoints) this.data.shift();
    this.draw();
  }

  draw() {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 100;
    const cssH = canvas.clientHeight || 40;
    if (canvas.width !== Math.round(cssW * dpr)) canvas.width = Math.round(cssW * dpr);
    if (canvas.height !== Math.round(cssH * dpr)) canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const d = this.data;
    if (d.length < 2) {
      // linha de base pontilhada enquanto não há dados
      ctx.strokeStyle = 'rgba(148,163,184,0.25)';
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(0, cssH / 2); ctx.lineTo(cssW, cssH / 2);
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }

    let min = this.fixedMin ?? Math.min(...d);
    let max = Math.max(...d);
    if (max === min) { max = min + 1; }
    const pad = 2;
    const x = (i) => pad + (i / (d.length - 1)) * (cssW - pad * 2);
    const y = (v) => cssH - pad - ((v - min) / (max - min)) * (cssH - pad * 2 - 6);

    // preenchimento em gradiente sob a linha
    const grad = ctx.createLinearGradient(0, 0, 0, cssH);
    grad.addColorStop(0, hexToRgba(this.fill, 0.28));
    grad.addColorStop(1, hexToRgba(this.fill, 0.0));
    ctx.beginPath();
    ctx.moveTo(x(0), y(d[0]));
    for (let i = 1; i < d.length; i++) ctx.lineTo(x(i), y(d[i]));
    ctx.lineTo(x(d.length - 1), cssH - pad);
    ctx.lineTo(x(0), cssH - pad);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // linha principal (suavizada)
    ctx.beginPath();
    ctx.moveTo(x(0), y(d[0]));
    for (let i = 1; i < d.length - 1; i++) {
      const xc = (x(i) + x(i + 1)) / 2;
      const yc = (y(d[i]) + y(d[i + 1])) / 2;
      ctx.quadraticCurveTo(x(i), y(d[i]), xc, yc);
    }
    ctx.lineTo(x(d.length - 1), y(d[d.length - 1]));
    ctx.strokeStyle = this.stroke;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowColor = hexToRgba(this.stroke, 0.55);
    ctx.shadowBlur = 6;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // ponto do valor atual
    const lx = x(d.length - 1), ly = y(d[d.length - 1]);
    ctx.beginPath();
    ctx.arc(lx, ly, 2.4, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(lx, ly, 4.5, 0, Math.PI * 2);
    ctx.strokeStyle = hexToRgba(this.stroke, 0.5);
    ctx.stroke();
  }
}

function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return `rgba(34,211,238,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** Anima suavemente a troca de um número exibido (count-up). */
export function animateNumber(el, to, { decimals = 0, suffix = '' } = {}) {
  if (!el) return;
  const from = Number(el.dataset.v ?? to);
  el.dataset.v = to;
  const start = performance.now();
  const dur = 450;
  function frame(t) {
    const p = Math.min(1, (t - start) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    const v = from + (to - from) * eased;
    el.textContent = v.toFixed(decimals) + suffix;
    if (p < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
