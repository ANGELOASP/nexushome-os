// ============================================================
// NexusHome OS — PDF visual do Projeto de Automação Unificado
// ------------------------------------------------------------
// Junta num só arquivo: capa, sumário, os 11 desenhos (página inteira, em vetor — dá para
// ampliar no leitor de PDF), o passo a passo de montagem, o memorial completo
// (docs/projeto-unificado.md) e as telas do painel.
//
// uso:  node docs/pdf/gerar-pdf.mjs [saida.pdf]        (padrão: docs/projeto-unificado.pdf)
// precisa: Node 18+ e Playwright com Chromium (npm i -g playwright && npx playwright install chromium)
// ============================================================
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] || join(DOCS, 'projeto-unificado.pdf');
const pkg = JSON.parse(readFileSync(join(DOCS, '..', 'package.json'), 'utf8'));

// ---------- desenhos ----------
const DESENHOS = [
  ['01', '01-arquitetura.svg', 'Arquitetura geral', 'Quem fala com quem: as quatro telas da tampa (cada uma mestre do seu RS-485), o painel P4 do corredor, as telas de 7" dos cômodos, o servidor e o NexusHome na nuvem.'],
  ['02', '02-sala-tecnica.svg', 'Sala técnica', 'Posição do QDG, do QDC, do QAU (base a 0,50 m do piso, eixo das telas a 1,50 m), do rack de rede e do banco de baterias com o inversor. Use para marcar a parede e os eletrodutos.'],
  ['03', '03-qau-tampa.svg', 'Tampa do QAU (porta)', 'As quatro telas de 4,3" na porta, os recortes, o chicote PP 6 × 0,5 mm² de cada tela e o laço de dobradiça.'],
  ['04', '04-qau-interior.svg', 'Interior do QAU', 'Placa de montagem: trilhos R1–R6 e canaletas C1–C6 com a cota y de cada um, posição de cada módulo e as zonas 220 V e SELV (24 V e dados).'],
  ['05', '05-alimentacao.svg', 'Alimentação 220 V / 24 V', 'Unifilar do QAU: X0 → Q2 → DPS → fontes F1 (SDR-120-24) e F2 (DRC-100B + baterias) → bornes-fusível FU1–FU18.'],
  ['06', '06-barramentos-rs485.svg', 'Barramentos RS-485 A, B, C e D', 'Endereço Modbus de cada aparelho, hubs isolados, ordem dos aparelhos no cabo e onde vai cada terminação de 120 Ω.'],
  ['07', '07-three-way.svg', 'Luz em three-way com relé e retorno', 'O interruptor da parede continua funcionando: relé (D) em changeover no lugar de um dos interruptores e relé KR que devolve o estado da lâmpada para a tela.'],
  ['08', '08-gas-intertravamento.svg', 'Gás: intertravamento por fio', 'Cadeia NF que fecha a válvula de gás sem depender de software: botoeira → AL2 dos sensores → relé 91 CH7 → válvula NF, e as sirenes.'],
  ['09', '09-reguas-bornes.svg', 'Réguas de bornes X0–X9', 'Borne a borne: número, cor do fio, bitola, origem (QAU) e destino (campo). Ocupa quatro folhas — amplie no leitor para ler cada borne.'],
  ['10', '10-nobreak.svg', 'Banco de baterias, inversor e QDC', 'Banco 2 × 24 V 100 Ah em paralelo, shunt 300 A / 75 mV, cabos de 50 mm², inversor híbrido e o QDC que alimenta a casa e o QAU.'],
  ['11', '11-rede.svg', 'Rede: rack, telas, servidor e IPs', 'Switch PoE, roteador, servidor com o monitor do NexusHome, P4 do corredor, telas dos cômodos e a tabela de IPs.'],
];
const svgDim = (s) => {
  const m = s.match(/<svg[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"/);
  return m ? [Number(m[1]), Number(m[2])] : [1600, 1200];
};
const dataUri = (s) => `data:image/svg+xml;base64,${Buffer.from(s).toString('base64')}`;
/** Recorta um SVG alto em fatias (só troca o viewBox da raiz). */
function fatias(svg, n) {
  const [w, h] = svgDim(svg);
  const passo = Math.ceil(h / n);
  return Array.from({ length: n }, (_, i) => {
    const y = i * passo, hh = Math.min(passo, h - y);
    const raiz = svg.match(/<svg\b[^>]*>/)[0];
    const nova = raiz
      .replace(/\s(width|height|viewBox)="[^"]*"/g, '')
      .replace('<svg', `<svg width="${w}" height="${hh}" viewBox="0 ${y} ${w} ${hh}"`);
    return svg.replace(raiz, nova);
  });
}

// ---------- markdown → html (só o que o memorial usa) ----------
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
function linkDesenho(href) {
  const m = href.match(/(\d\d)-[\w-]+\.svg/);
  return m ? `#des-${m[1]}` : href;
}
function inline(t) {
  const codes = [];
  t = t.replace(/`([^`]+)`/g, (_, c) => {
    const m = c.match(/^(\d\d)-[\w-]+\.svg$/);
    codes.push(m ? `<a href="#des-${m[1]}"><code>${esc(c)}</code></a>` : `<code>${esc(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  t = esc(t)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, txt, href) => `<a href="${linkDesenho(href)}">${txt}</a>`);
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[i]);
}
function md(src) {
  const L = src.split('\n');
  const out = [];
  let i = 0;
  const lista = (ind) => {               // lista (ordenada ou não) a partir da indentação `ind`
    const ord = /^\s*\d+\.\s/.test(L[i]);
    const h = [ord ? '<ol>' : '<ul>'];
    while (i < L.length) {
      const m = L[i].match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
      if (!m || m[1].length < ind) break;
      if (m[1].length > ind) { h.push(lista(m[1].length)); continue; }
      let txt = m[3]; i++;
      while (i < L.length && L[i].trim() && !/^\s*([-*]|\d+\.)\s/.test(L[i]) && /^\s+/.test(L[i])) txt += ' ' + L[i++].trim();
      const sub = [];
      while (i < L.length) {
        const n = L[i].match(/^(\s*)([-*]|\d+\.)\s/);
        if (n && n[1].length > ind) sub.push(lista(n[1].length)); else break;
      }
      h.push(`<li>${inline(txt)}${sub.join('')}</li>`);
    }
    h.push(ord ? '</ol>' : '</ul>');
    return h.join('');
  };
  while (i < L.length) {
    const l = L[i];
    if (!l.trim()) { i++; continue; }
    if (l.startsWith('```')) {
      const b = []; i++;
      while (i < L.length && !L[i].startsWith('```')) b.push(L[i++]);
      i++; out.push(`<pre>${esc(b.join('\n'))}</pre>`); continue;
    }
    const hm = l.match(/^(#{1,4})\s+(.*)$/);
    if (hm) { const n = hm[1].length; out.push(`<h${n} id="m-${slug(hm[2])}">${inline(hm[2])}</h${n}>`); i++; continue; }
    if (/^---+\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (l.startsWith('>')) {
      const b = [];
      while (i < L.length && L[i].startsWith('>')) b.push(L[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${md(b.join('\n'))}</blockquote>`); continue;
    }
    if (l.startsWith('|')) {
      const rows = [];
      while (i < L.length && L[i].startsWith('|')) rows.push(L[i++]);
      const cells = (r) => r.replace(/^\||\|\s*$/g, '').split(/(?<!\\)\|/).map((c) => inline(c.trim().replace(/\\\|/g, '|')));
      const head = cells(rows[0]);
      const body = rows.slice(2).map(cells);
      out.push(`<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s/.test(l)) { out.push(lista(l.match(/^\s*/)[0].length)); continue; }
    const p = [];
    while (i < L.length && L[i].trim() && !/^(#{1,4}\s|```|>|\||---+\s*$)/.test(L[i]) && !/^\s*([-*]|\d+\.)\s/.test(L[i])) p.push(L[i++].trim());
    out.push(`<p>${inline(p.join(' '))}</p>`);
  }
  return out.join('\n');
}

// ---------- conteúdo ----------
const memorial = readFileSync(join(DOCS, 'projeto-unificado.md'), 'utf8');
const corpo = memorial.replace(/^# .*\n/, '');                       // o título vai na capa
const secoes = [...corpo.matchAll(/^## (.*)$/gm)].map((m) => m[1]);

// passo a passo (§17): cada item de 1º nível vira um cartão com os desenhos que ele usa
// os desenhos de cada passo saem do próprio texto do §17 (`04-qau-interior.svg`, "desenho 09")
const desenhosCitados = (txt) => [...new Set([...txt.matchAll(/\b(\d\d)-[\w-]+\.svg|desenhos? (\d\d)\b/g)].map((m) => m[1] || m[2]))];
const p17 = (corpo.match(/## 17\.[^\n]*\n([\s\S]*?)\n---/) || [, ''])[1];
const passos = [];
for (const linha of p17.split('\n')) {
  const m1 = linha.match(/^(\d+)\.\s+(.*)$/);
  const m2 = linha.match(/^\s{2,}(?:\d+\.|-)\s+(.*)$/);
  if (m1) {
    // "**Título:** instrução" → título curto no cartão e a instrução vira o primeiro item
    const t = m1[2].replace(/\*\*/g, '').replace(/\s*\(desenhos? [^)]*\)/, '');
    const k = t.indexOf(':');
    const resto = k > 0 ? t.slice(k + 1).trim() : '';
    passos.push({ n: Number(m1[1]), titulo: k > 0 ? t.slice(0, k) : t, itens: resto && !/faça:?$/i.test(resto) ? [resto] : [] });
    if (resto && /faça:?$/i.test(resto)) passos.at(-1).titulo += ` (${resto.replace(/,?\s*faça:?$/i, '')})`.replace(' ()', '');
  }
  else if (m2 && passos.length) passos.at(-1).itens.push(m2[1]);
  if (passos.length && (m1 || m2)) passos.at(-1).texto = (passos.at(-1).texto || '') + ' ' + linha;
}
const tituloDesenho = Object.fromEntries(DESENHOS.map(([n, , t]) => [n, t]));

const paginasDesenho = DESENHOS.flatMap(([n, arq, titulo, legenda]) => {
  const svg = readFileSync(join(DOCS, 'img', 'unificado', arq), 'utf8');
  const partes = n === '09' ? fatias(svg, 4) : [svg];
  return partes.map((s, k) => `
  <section class="desenho" ${k === 0 ? `id="des-${n}"` : ''}>
    <header><span class="num">${n}${partes.length > 1 ? ` · ${k + 1}/${partes.length}` : ''}</span><h2>${esc(titulo)}</h2></header>
    ${k === 0 ? `<p class="legenda">${esc(legenda)}</p>` : '<p class="legenda">continuação</p>'}
    <div class="folha"><img src="${dataUri(s)}" alt="${esc(titulo)}"></div>
  </section>`);
});

const telas = [
  ['painel-p4-planta.png', 'P4 10,1" do corredor — a planta do app, cômodos coloridos pelo estado'],
  ['painel-p4-alarme.png', 'P4 em alarme (fumaça na Sala de TV)'],
  ['painel-p4-deitado.png', 'P4 deitado (1280 × 800)'],
  ['painel-7-cozinha.png', 'Tela de 7" da Cozinha'],
].filter(([f]) => existsSync(join(DOCS, 'img', f)));
const png = (f) => `data:image/png;base64,${readFileSync(join(DOCS, 'img', f)).toString('base64')}`;
const hoje = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });

const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<title>Projeto de Automação Unificado — NexusHome OS</title>
<style>
  @page { size: A4 portrait; margin: 16mm 14mm 16mm 14mm; }
  @page folha { size: A4 landscape; margin: 9mm 10mm 12mm 10mm; }
  @page capa { size: A4 portrait; margin: 0; }
  :root { --tinta:#16202c; --suave:#5b6878; --linha:#d6dce4; --fundo:#f3f6f9; --acento:#0f766e; --aviso:#b45309; }
  * { box-sizing: border-box; }
  html { font-family: Inter, "Noto Sans", "DejaVu Sans", Arial, sans-serif; color: var(--tinta); font-size: 9.6pt; line-height: 1.45; }
  body { margin: 0; }
  a { color: var(--acento); text-decoration: none; }
  code { font-family: "DejaVu Sans Mono", Consolas, monospace; font-size: .86em; background: var(--fundo); padding: .05em .3em; border-radius: 3px; }
  pre { font-family: "DejaVu Sans Mono", Consolas, monospace; font-size: 7.4pt; line-height: 1.3; background: var(--fundo); border: 1px solid var(--linha); border-radius: 6px; padding: 8px 10px; white-space: pre; overflow: hidden; break-inside: avoid; }
  h1, h2, h3, h4 { line-height: 1.2; break-after: avoid; }
  table { border-collapse: collapse; width: 100%; margin: 6px 0 10px; font-size: 8.2pt; }
  th, td { border: 1px solid var(--linha); padding: 3px 5px; vertical-align: top; text-align: left; }
  th { background: var(--fundo); font-weight: 600; }
  tr { break-inside: avoid; }
  blockquote { margin: 8px 0; padding: 6px 12px; border-left: 3px solid var(--acento); background: #effaf8; }
  hr { border: 0; border-top: 1px solid var(--linha); margin: 14px 0; }

  /* capa */
  .capa { page: capa; height: 297mm; padding: 26mm 20mm 18mm; display: flex; flex-direction: column; background: #0d1620; color: #eef3f7; break-after: page; }
  .capa .marca { letter-spacing: .14em; text-transform: uppercase; font-size: 9pt; color: #5eead4; font-weight: 600; }
  .capa h1 { font-family: "Inter Display", Inter, sans-serif; font-size: 34pt; margin: 10mm 0 4mm; font-weight: 700; }
  .capa .sub { font-size: 12.5pt; color: #b8c4cf; max-width: 150mm; }
  .capa .img { margin: 12mm 0 0; flex: 1; display: flex; align-items: center; justify-content: center; min-height: 0; }
  .capa .img img { max-height: 120mm; max-width: 100%; border-radius: 10px; box-shadow: 0 6px 30px rgba(0,0,0,.5); }
  .capa .meta { display: flex; justify-content: space-between; font-size: 9pt; color: #93a3b1; border-top: 1px solid #263445; padding-top: 5mm; margin-top: 10mm; }

  /* sumário e páginas de texto */
  .bloco { break-before: page; }
  .bloco > h1 { font-family: "Inter Display", Inter, sans-serif; font-size: 20pt; margin: 0 0 4mm; padding-bottom: 3mm; border-bottom: 2px solid var(--acento); }
  .parte { font-size: 8pt; letter-spacing: .14em; text-transform: uppercase; color: var(--acento); font-weight: 600; margin-bottom: 2mm; }
  .sumario { columns: 2; column-gap: 10mm; font-size: 9.2pt; }
  .sumario h3 { font-size: 9pt; letter-spacing: .1em; text-transform: uppercase; color: var(--suave); margin: 0 0 2mm; break-after: avoid; }
  .sumario ol { margin: 0 0 6mm; padding-left: 5mm; }
  .sumario li { margin: 0 0 1.2mm; break-inside: avoid; }
  .como-ler { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4mm; margin: 6mm 0; }
  .como-ler div { background: var(--fundo); border-radius: 6px; padding: 3mm 4mm; font-size: 8.8pt; }
  .como-ler b { display: block; color: var(--acento); margin-bottom: 1mm; }

  /* desenhos */
  .desenho { page: folha; break-before: page; height: 189mm; display: flex; flex-direction: column; }
  .desenho header { display: flex; align-items: baseline; gap: 4mm; }
  .desenho .num { font-weight: 700; color: #fff; background: var(--acento); border-radius: 4px; padding: .5mm 2.4mm; font-size: 10pt; }
  .desenho h2 { margin: 0; font-size: 14pt; }
  .desenho .legenda { margin: 1.5mm 0 2.5mm; color: var(--suave); font-size: 9pt; }
  .desenho .folha { flex: 1; min-height: 0; border: 1px solid var(--linha); border-radius: 4px; display: flex; align-items: center; justify-content: center; padding: 1.5mm; }
  .desenho .folha img { max-width: 100%; max-height: 100%; }

  /* passo a passo */
  .passo { break-inside: avoid; border: 1px solid var(--linha); border-radius: 8px; padding: 3.5mm 4.5mm; margin: 0 0 4mm; display: grid; grid-template-columns: 11mm 1fr; gap: 3mm; }
  .passo .n { width: 9mm; height: 9mm; border-radius: 50%; background: var(--acento); color: #fff; font-weight: 700; display: flex; align-items: center; justify-content: center; font-size: 11pt; }
  .passo h3 { margin: .5mm 0 2mm; font-size: 11pt; }
  .passo ul { list-style: none; margin: 0; padding: 0; }
  .passo li { padding-left: 6.5mm; position: relative; margin: 0 0 1.4mm; }
  .passo li::before { content: ""; position: absolute; left: 0; top: .5mm; width: 3.2mm; height: 3.2mm; border: 1.2px solid var(--tinta); border-radius: 1px; }
  .passo .ref { margin-top: 2mm; font-size: 8.4pt; color: var(--suave); }
  .passo .ref a { display: inline-block; background: #e6f4f2; border-radius: 3px; padding: .2mm 2mm; margin-right: 1.5mm; }
  .alerta { border-left: 3px solid var(--aviso); background: #fff7ed; padding: 3mm 4mm; margin: 0 0 5mm; border-radius: 0 6px 6px 0; font-size: 9pt; }

  /* memorial */
  .memorial h2 { font-size: 13.5pt; margin: 7mm 0 2.5mm; padding-top: 1mm; border-top: 1px solid var(--linha); }
  .memorial h2:first-of-type { border-top: 0; }
  .memorial h3 { font-size: 11pt; margin: 5mm 0 2mm; color: #0b4f4a; }
  .memorial h4 { font-size: 10pt; margin: 4mm 0 1.5mm; }
  .memorial p, .memorial li { orphans: 3; widows: 3; }
  .memorial ul, .memorial ol { padding-left: 5.5mm; margin: 1.5mm 0 3mm; }

  /* telas */
  .telas { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; }
  .telas figure { margin: 0; break-inside: avoid; }
  .telas img { width: 100%; border: 1px solid var(--linha); border-radius: 6px; }
  .telas figcaption { font-size: 8.6pt; color: var(--suave); margin-top: 1.5mm; }
</style></head><body>

<section class="capa">
  <div class="marca">NexusHome OS · v${esc(pkg.version)}</div>
  <h1>Projeto de Automação Unificado</h1>
  <div class="sub">Quadro de Automação Unificado (QAU) com quatro telas na tampa, barramentos RS-485, iluminação em three-way,
    segurança, nobreak e o painel ESP32-P4 do corredor — desenhos, ligações borne a borne, lista de compras e montagem passo a passo.</div>
  <div class="img">${telas.length ? `<img src="${png(telas[0][0])}" alt="">` : ''}</div>
  <div class="meta"><span>Fonte: docs/projeto-unificado.md e docs/img/unificado/</span><span>Gerado em ${esc(hoje)}</span></div>
</section>

<section class="bloco">
  <div class="parte">Sumário</div>
  <h1>Como usar este documento</h1>
  <div class="como-ler">
    <div><b>1. Desenhos</b>Uma folha deitada por desenho. Estão em vetor: amplie no leitor de PDF para ler os números dos bornes.</div>
    <div><b>2. Passo a passo</b>A ordem da montagem, com caixas para marcar e o desenho de cada etapa.</div>
    <div><b>3. Memorial</b>O texto completo: decisões, endereços, bornes, cores, lista de compras, rede e normas.</div>
  </div>
  <div class="alerta"><b>Itens marcados "(verificar)"</b> dependem do datasheet do produto comprado. Confira antes de montar.
    Este projeto não substitui o projeto elétrico de potência (quadro de cargas, unifilar e ART — NBR 5410 / NR-10).</div>
  <div class="sumario">
    <h3>Parte 1 — Desenhos</h3>
    <ol>${DESENHOS.map(([n, , t]) => `<li><a href="#des-${n}">${n} · ${esc(t)}</a></li>`).join('')}</ol>
    <h3>Parte 2 — Montagem</h3>
    <ol><li><a href="#passo-a-passo">Passo a passo com checklist</a></li></ol>
    <h3>Parte 3 — Memorial técnico</h3>
    <ol>${secoes.map((s) => `<li><a href="#m-${slug(s)}">${inline(s.replace(/^\d+\.\s*/, ''))}</a></li>`).join('')}</ol>
    ${telas.length ? '<h3>Parte 4 — Telas</h3><ol><li><a href="#telas">Painel P4 e telas de 7"</a></li></ol>' : ''}
  </div>
</section>

${paginasDesenho.join('\n')}

<section class="bloco" id="passo-a-passo">
  <div class="parte">Parte 2</div>
  <h1>Montagem, passo a passo</h1>
  <div class="alerta">Faça na ordem. Só ligue o 220 V${(() => { const z = passos.find((p) => /220 V/.test(p.titulo)); return z ? ` (passo ${z.n})` : ''; })()} com tudo desligado no QDG e depois que o 24 V e os barramentos estiverem testados.</div>
  ${passos.map((p) => `<div class="passo"><div class="n">${p.n}</div><div>
    <h3>${inline(p.titulo)}</h3>
    ${p.itens.length ? `<ul>${p.itens.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>` : ''}
    ${(p.des = desenhosCitados(p.texto)).length ? `<div class="ref">Desenhos: ${p.des.map((d) => `<a href="#des-${d}">${d} · ${esc(tituloDesenho[d])}</a>`).join('')}</div>` : ''}
  </div></div>`).join('')}
</section>

<section class="bloco memorial">
  <div class="parte">Parte 3</div>
  <h1>Memorial técnico completo</h1>
  ${md(corpo)}
</section>

${telas.length ? `<section class="bloco" id="telas">
  <div class="parte">Parte 4</div>
  <h1>Telas do painel (simulador)</h1>
  <p>Capturas do mesmo firmware que vai para o ESP32-P4 de 10,1" e para as telas de 7". O P4 desenha a planta que está no app
    e redesenha sozinho quando ela muda no Editor de Planta.</p>
  <div class="telas">${telas.map(([f, t]) => `<figure><img src="${png(f)}" alt=""><figcaption>${esc(t)}</figcaption></figure>`).join('')}</div>
</section>` : ''}
</body></html>`;

// ---------- Playwright ----------
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch {
  pw = require(join(execSync('npm root -g').toString().trim(), 'playwright'));
}
const htmlPath = OUT.replace(/\.pdf$/, '.html');
writeFileSync(htmlPath, html);
const browser = await pw.chromium.launch();
const page = await browser.newPage();
await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
await page.pdf({
  path: OUT, preferCSSPageSize: true, printBackground: true, outline: true, tagged: true,
  displayHeaderFooter: true, headerTemplate: '<span></span>',
  footerTemplate: `<div style="font:7pt Inter,Arial,sans-serif;color:#7a8794;width:100%;padding:0 12mm;display:flex;justify-content:space-between">
    <span>NexusHome OS · Projeto de Automação Unificado · v${pkg.version}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
});
await browser.close();
if (!process.env.MANTER_HTML) (await import('node:fs')).unlinkSync(htmlPath);
console.log('PDF:', OUT);
