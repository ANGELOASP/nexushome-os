// ============================================================
// NexusHome OS — tipos de piso (v2.8)
// Módulo puro: catálogo dos revestimentos de piso que o usuário escolhe
// por cômodo no Editor de Planta (coluna rooms.floor_type — migração 019).
// A cena 3D gera a textura procedural de cada tipo (scene3d.js).
//   tile = metros por repetição da textura no 3D
// ============================================================

export const FLOOR_TYPES = [
  // madeiras
  { key: 'wood',          label: 'Madeira clara (réguas)',   group: 'Madeira',   tile: 1.6 },
  { key: 'wood_dark',     label: 'Madeira escura (réguas)',  group: 'Madeira',   tile: 1.6 },
  { key: 'herringbone',   label: 'Taco espinha de peixe',    group: 'Madeira',   tile: 1.2 },
  { key: 'laminate',      label: 'Laminado / vinílico cinza', group: 'Madeira',  tile: 1.8 },
  { key: 'deck',          label: 'Deck de madeira',          group: 'Madeira',   tile: 1.6 },
  // cerâmicos e pedras
  { key: 'tile',          label: 'Porcelanato claro 60×60',  group: 'Cerâmica e pedra', tile: 1.2 },
  { key: 'porcelain_dark', label: 'Porcelanato escuro 60×60', group: 'Cerâmica e pedra', tile: 1.2 },
  { key: 'marble',        label: 'Mármore branco',           group: 'Cerâmica e pedra', tile: 1.6 },
  { key: 'ceramic',       label: 'Cerâmica bege 30×30',      group: 'Cerâmica e pedra', tile: 0.9 },
  { key: 'hydraulic',     label: 'Ladrilho hidráulico',      group: 'Cerâmica e pedra', tile: 0.8 },
  { key: 'slate',         label: 'Pedra ardósia',            group: 'Cerâmica e pedra', tile: 1.6 },
  { key: 'granite',       label: 'Granito',                  group: 'Cerâmica e pedra', tile: 1.6 },
  // contínuos
  { key: 'burnt_cement',  label: 'Cimento queimado',         group: 'Contínuo',  tile: 3.0 },
  { key: 'epoxy',         label: 'Epóxi / resina',           group: 'Contínuo',  tile: 3.0 },
  { key: 'carpet',        label: 'Carpete',                  group: 'Contínuo',  tile: 1.0 },
  // externos
  { key: 'grass',         label: 'Grama',                    group: 'Externo',   tile: 2.5 },
  { key: 'concrete',      label: 'Concreto',                 group: 'Externo',   tile: 2.0 },
  { key: 'pavers',        label: 'Bloquete / intertravado',  group: 'Externo',   tile: 1.2 },
  { key: 'gravel',        label: 'Pedrisco / cascalho',      group: 'Externo',   tile: 1.5 },
];

export const FLOOR_BY_KEY = Object.fromEntries(FLOOR_TYPES.map((f) => [f.key, f]));

/** Piso padrão de cada tipo de cômodo (quando o usuário não escolheu). */
const DEFAULT_BY_KIND = {
  sala_estar: 'wood', quarto: 'wood', suite: 'wood', escritorio: 'wood', closet: 'wood', sala_jantar: 'wood', corredor: 'wood',
  cozinha: 'tile', banheiro: 'tile', lavanderia: 'tile', despensa: 'tile',
  area_externa: 'grass', varanda: 'deck', garagem: 'concrete',
};

/** Piso efetivo do cômodo: o escolhido (se válido) ou o padrão do tipo. */
export function floorTypeOf(room) {
  if (room?.floor_type && FLOOR_BY_KEY[room.floor_type]) return room.floor_type;
  return DEFAULT_BY_KIND[room?.kind] || 'wood';
}

/** Normaliza o valor salvo: chave conhecida ou null (= automático pelo tipo). */
export function normalizeFloorType(v) {
  return v && FLOOR_BY_KEY[v] ? v : null;
}
