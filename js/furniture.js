// ============================================================
// NexusHome OS — Catálogo de móveis (layout do usuário, v2.6)
// ------------------------------------------------------------
// Dados puros (sem DOM/Three.js): medidas em METROS, w = largura (eixo x
// local), d = profundidade (eixo z local), h = altura. O editor de planta
// desenha a pegada (w × d) e a cena 3D monta o modelo (scene3d.js).
// ============================================================

export const FURNITURE = [
  // sala
  { kind: 'sofa',          label: 'Sofá',               group: 'Sala',      w: 2.0,  d: 0.9,  h: 0.85 },
  { kind: 'poltrona',      label: 'Poltrona',           group: 'Sala',      w: 0.85, d: 0.85, h: 0.85 },
  { kind: 'mesa_centro',   label: 'Mesa de centro',     group: 'Sala',      w: 1.0,  d: 0.6,  h: 0.4 },
  { kind: 'rack_tv',       label: 'Rack com TV',        group: 'Sala',      w: 1.8,  d: 0.45, h: 1.4 },
  { kind: 'estante',       label: 'Estante',            group: 'Sala',      w: 0.9,  d: 0.35, h: 1.8 },
  { kind: 'luminaria',     label: 'Luminária de piso',  group: 'Sala',      w: 0.4,  d: 0.4,  h: 1.6 },
  { kind: 'planta',        label: 'Planta',             group: 'Sala',      w: 0.45, d: 0.45, h: 1.1 },
  // quarto
  { kind: 'cama_casal',    label: 'Cama de casal',      group: 'Quarto',    w: 1.6,  d: 2.0,  h: 0.55 },
  { kind: 'cama_solteiro', label: 'Cama de solteiro',   group: 'Quarto',    w: 0.9,  d: 1.9,  h: 0.5 },
  { kind: 'criado',        label: 'Criado-mudo',        group: 'Quarto',    w: 0.45, d: 0.4,  h: 0.55 },
  { kind: 'guarda_roupa',  label: 'Guarda-roupa',       group: 'Quarto',    w: 1.8,  d: 0.6,  h: 2.1 },
  { kind: 'comoda',        label: 'Cômoda',             group: 'Quarto',    w: 1.0,  d: 0.5,  h: 0.85 },
  { kind: 'escrivaninha',  label: 'Escrivaninha',       group: 'Quarto',    w: 1.2,  d: 0.6,  h: 0.75 },
  // cozinha / jantar
  { kind: 'mesa_jantar',   label: 'Mesa de jantar (4)', group: 'Cozinha',   w: 1.6,  d: 0.9,  h: 0.76 },
  { kind: 'cadeira',       label: 'Cadeira',            group: 'Cozinha',   w: 0.45, d: 0.45, h: 0.9 },
  { kind: 'geladeira',     label: 'Geladeira',          group: 'Cozinha',   w: 0.7,  d: 0.7,  h: 1.8 },
  { kind: 'fogao',         label: 'Fogão',              group: 'Cozinha',   w: 0.6,  d: 0.6,  h: 0.9 },
  { kind: 'bancada',       label: 'Bancada com pia',    group: 'Cozinha',   w: 1.6,  d: 0.6,  h: 0.9 },
  { kind: 'armario',       label: 'Armário alto',       group: 'Cozinha',   w: 0.8,  d: 0.5,  h: 2.0 },
  // banheiro / serviço
  { kind: 'vaso',          label: 'Vaso sanitário',     group: 'Banheiro',  w: 0.4,  d: 0.65, h: 0.75 },
  { kind: 'pia_banheiro',  label: 'Pia com gabinete',   group: 'Banheiro',  w: 0.6,  d: 0.45, h: 0.85 },
  { kind: 'chuveiro',      label: 'Box com chuveiro',   group: 'Banheiro',  w: 0.9,  d: 0.9,  h: 2.0 },
  { kind: 'maquina_lavar', label: 'Máquina de lavar',   group: 'Banheiro',  w: 0.6,  d: 0.65, h: 0.9 },
  { kind: 'tanque',        label: 'Tanque',             group: 'Banheiro',  w: 0.6,  d: 0.55, h: 0.85 },
  // externo
  { kind: 'carro',         label: 'Carro',              group: 'Externo',   w: 1.8,  d: 4.2,  h: 1.5 },
  { kind: 'mesa_externa',  label: 'Mesa externa',       group: 'Externo',   w: 0.9,  d: 0.9,  h: 0.75 },
];

export const FURNITURE_BY_KIND = Object.fromEntries(FURNITURE.map((f) => [f.kind, f]));

/** Pegada (4 cantos, metros, coordenadas absolutas) de um móvel { kind, x, z, rot } (rot em graus). */
export function furnitureCorners(item) {
  const def = FURNITURE_BY_KIND[item.kind];
  if (!def) return [];
  const a = ((Number(item.rot) || 0) * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  const hw = def.w / 2, hd = def.d / 2;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([lx, lz]) => [
    item.x + lx * c - lz * s,
    item.z + lx * s + lz * c,
  ]);
}

/** O ponto (x, z) está sobre o móvel? (inverte a rotação e testa o retângulo local) */
export function furnitureHit(item, x, z, pad = 0) {
  const def = FURNITURE_BY_KIND[item.kind];
  if (!def) return false;
  const a = ((Number(item.rot) || 0) * Math.PI) / 180;
  const dx = x - item.x, dz = z - item.z;
  const lx = dx * Math.cos(a) + dz * Math.sin(a);
  const lz = -dx * Math.sin(a) + dz * Math.cos(a);
  return Math.abs(lx) <= def.w / 2 + pad && Math.abs(lz) <= def.d / 2 + pad;
}

/** Normaliza uma linha da tabela furniture (números, rotação em 0..359). */
export function normalizeFurniture(row) {
  const rot = ((Math.round(Number(row.rot) || 0) % 360) + 360) % 360;
  return {
    id: row.id, floor: Math.max(0, Math.trunc(Number(row.floor) || 0)), kind: String(row.kind || ''),
    x: Number(row.x) || 0, z: Number(row.z) || 0, rot, sort_order: row.sort_order ?? 0,
  };
}
