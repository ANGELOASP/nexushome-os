// ============================================================
// NexusHome OS — Biblioteca de dispositivos (v2.9)
// ------------------------------------------------------------
// Dados puros: cada modelo diz o TIPO gravado em devices.type, como é
// FIXADO na casa e a altura padrão (metros, até a base do aparelho):
//   wall      na parede (o ar-condicionado sobe para cima da janela)
//   ceiling   no teto
//   floor     no piso
//   furniture sobre um móvel compatível (TV no painel/rack/cômoda...)
//   window    sobre a janela (cortina motorizada)
//   door      no batente da porta (fechadura, sensor de porta)
// O Editor de Planta usa isso para "grudar" o aparelho no lugar certo
// (js/device-mount.js) e a cena 3D monta o modelo (js/scene-devices.js).
// ============================================================

export const DEVICE_CATALOG = [
  // clima
  { model: 'split',        label: 'Ar-condicionado split',   group: 'Clima',          type: 'ac',      mount: 'wall',      y: 2.1,  aboveWindow: true },
  { model: 'ac_portatil',  label: 'Ar-condicionado portátil', group: 'Clima',         type: 'ac',      mount: 'floor',     y: 0 },
  { model: 'ceiling_fan',  label: 'Ventilador de teto',      group: 'Clima',          type: 'fan',     mount: 'ceiling',   y: 2.5 },
  // iluminação
  { model: 'plafon',       label: 'Plafon / luz de teto',    group: 'Iluminação',     type: 'light',   mount: 'ceiling',   y: 2.5 },
  { model: 'pendant',      label: 'Pendente',                group: 'Iluminação',     type: 'light',   mount: 'ceiling',   y: 2.5 },
  { model: 'led_strip',    label: 'Fita LED (sanca)',        group: 'Iluminação',     type: 'light',   mount: 'wall',      y: 2.35 },
  { model: 'lamp',         label: 'Abajur com lâmpada smart', group: 'Iluminação',    type: 'light',   mount: 'furniture', y: 0.55, furniture: ['criado', 'mesa_lateral', 'aparador', 'comoda', 'escrivaninha', 'penteadeira'] },
  { model: 'switch',       label: 'Interruptor inteligente', group: 'Iluminação',     type: 'switch',  mount: 'wall',      y: 1.1 },
  // entretenimento
  { model: 'smart_tv',     label: 'Smart TV',                group: 'Entretenimento', type: 'tv',      mount: 'furniture', y: 1.0, furniture: ['painel_tv', 'rack_tv', 'comoda', 'aparador', 'estante', 'cristaleira'] },
  { model: 'tv_wall',      label: 'TV na parede',            group: 'Entretenimento', type: 'tv',      mount: 'wall',      y: 1.0 },
  { model: 'speaker',      label: 'Assistente / caixa de som', group: 'Entretenimento', type: 'speaker', mount: 'furniture', y: 0.75, furniture: ['rack_tv', 'painel_tv', 'criado', 'mesa_lateral', 'aparador', 'comoda', 'escrivaninha', 'estante', 'bancada', 'ilha'] },
  // água
  { model: 'valve',        label: 'Válvula motorizada',      group: 'Água',           type: 'valve',   mount: 'wall',      y: 0.3 },
  { model: 'leak',         label: 'Sensor de vazamento',     group: 'Água',           type: 'sensor',  mount: 'floor',     y: 0 },
  { model: 'level',        label: 'Sensor de nível (caixa)', group: 'Água',           type: 'sensor',  mount: 'floor',     y: 0 },
  // energia
  { model: 'meter',        label: 'Medidor de energia',      group: 'Energia',        type: 'meter',   mount: 'wall',      y: 1.25 },
  { model: 'plug',         label: 'Tomada inteligente',      group: 'Energia',        type: 'plug',    mount: 'wall',      y: 0.3 },
  { model: 'solar',        label: 'Inversor solar',          group: 'Energia',        type: 'solar',   mount: 'wall',      y: 1.25 },
  // segurança
  { model: 'lock',         label: 'Fechadura digital',       group: 'Segurança',      type: 'lock',    mount: 'door',      y: 1.0 },
  { model: 'camera',       label: 'Câmera',                  group: 'Segurança',      type: 'camera',  mount: 'wall',      y: 2.3 },
  { model: 'door_sensor',  label: 'Sensor de porta/janela',  group: 'Segurança',      type: 'sensor',  mount: 'door',      y: 2.0 },
  { model: 'presence',     label: 'Sensor de presença',      group: 'Segurança',      type: 'sensor',  mount: 'wall',      y: 2.3 },
  // conforto / sensores
  { model: 'curtain',      label: 'Cortina motorizada',      group: 'Conforto',       type: 'curtain', mount: 'window',    y: 2.2 },
  { model: 'temp_sensor',  label: 'Sensor de temperatura',   group: 'Conforto',       type: 'sensor',  mount: 'wall',      y: 1.5 },
  { model: 'hub',          label: 'Hub / gateway',           group: 'Conforto',       type: 'hub',     mount: 'furniture', y: 0.75, furniture: ['rack_tv', 'painel_tv', 'estante', 'aparador', 'escrivaninha', 'criado'] },
];

export const CATALOG_BY_MODEL = Object.fromEntries(DEVICE_CATALOG.map((c) => [c.model, c]));

/** Tipos aceitos em devices.type (migração 021). */
export const DEVICE_TYPES = [...new Set(DEVICE_CATALOG.map((c) => c.type))];

/** Modelo padrão quando o dispositivo não tem `model` (nativos antigos e integrados). */
const DEFAULT_BY_TYPE = { ac: 'split', light: 'plafon', tv: 'smart_tv', valve: 'valve', meter: 'meter', solar: 'solar', fan: 'ceiling_fan', plug: 'plug', switch: 'switch', lock: 'lock', camera: 'camera', curtain: 'curtain', speaker: 'speaker', hub: 'hub', sensor: 'temp_sensor' };

/** Entrada da biblioteca para um dispositivo (pelo model; senão pelo tipo / modelo do fabricante). */
export function catalogFor(d) {
  if (d?.model && CATALOG_BY_MODEL[d.model]) return CATALOG_BY_MODEL[d.model];
  const m = String(d?.model || '').toLowerCase();       // integrados: kind do fabricante (Tuya/SmartThings)
  if (m.includes('leak')) return CATALOG_BY_MODEL.leak;
  if (m.includes('level') || m.includes('tank')) return CATALOG_BY_MODEL.level;
  if (m.includes('valve')) return CATALOG_BY_MODEL.valve;
  if (m === 'tv') return CATALOG_BY_MODEL.smart_tv;
  if (m === 'ac') return CATALOG_BY_MODEL.split;
  return CATALOG_BY_MODEL[DEFAULT_BY_TYPE[d?.type]] || CATALOG_BY_MODEL.temp_sensor;
}
