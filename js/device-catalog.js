// ============================================================
// NexusHome OS — Biblioteca de dispositivos (v2.9 · ampliada na v2.13)
// ------------------------------------------------------------
// Dados puros: cada modelo diz o TIPO gravado em devices.type, como é
// FIXADO na casa e a altura padrão (metros, até a base do aparelho):
//   wall      na parede (o ar-condicionado sobe para cima da janela)
//   ceiling   no teto
//   floor     no piso
//   furniture sobre um móvel compatível (TV no painel/rack/cômoda...);
//             onFloor: true → sem móvel por perto, fica no piso (ex.: geladeira
//             smart sem o móvel "Geladeira" desenhado)
//   window    sobre a janela (cortina, persiana)
//   door      no batente da porta (fechadura, sensor de porta)
// O Editor de Planta usa isso para "grudar" o aparelho no lugar certo
// (js/device-mount.js) e a cena 3D monta o modelo (js/scene-devices.js).
// O TIPO define os controles do app (liga/desliga, volume, entrada,
// armar alarme, abrir portão...). Tipos novos da v2.13 precisam da migração 024.
// ============================================================

// móveis onde cada família de aparelho pode ficar
const DESK = ['escrivaninha', 'mesa_escritorio', 'aparador', 'bancada', 'ilha', 'mesa_jantar', 'mesa_jantar_6', 'mesa_redonda', 'comoda'];
const SIDE = ['criado', 'mesa_lateral', 'mesa_centro', 'aparador', 'comoda', 'escrivaninha', 'mesa_escritorio', 'bancada', 'ilha', 'penteadeira'];
const RACK = ['rack_tv', 'painel_tv', 'aparador', 'estante', 'comoda', 'cristaleira', 'estante_livros'];
const SHELF = ['rack_tv', 'estante', 'estante_livros', 'aparador', 'escrivaninha', 'mesa_escritorio', 'arquivo', 'comoda'];
const COUNTER = ['bancada', 'ilha', 'aparador', 'mesa_jantar'];

export const DEVICE_CATALOG = [
  // ---- clima ----
  { model: 'split',        label: 'Ar-condicionado split',   group: 'Clima',          type: 'ac',      mount: 'wall',      y: 2.1,  aboveWindow: true },
  { model: 'ac_portatil',  label: 'Ar-condicionado portátil', group: 'Clima',         type: 'ac',      mount: 'floor',     y: 0 },
  { model: 'ceiling_fan',  label: 'Ventilador de teto',      group: 'Clima',          type: 'fan',     mount: 'ceiling',   y: 2.5 },
  { model: 'floor_fan',    label: 'Ventilador de pé / coluna', group: 'Clima',        type: 'fan',     mount: 'floor',     y: 0 },
  { model: 'exhaust_fan',  label: 'Exaustor',                group: 'Clima',          type: 'fan',     mount: 'wall',      y: 2.0 },
  { model: 'thermostat',   label: 'Termostato / controle de clima', group: 'Clima',   type: 'ac',      mount: 'wall',      y: 1.4 },
  { model: 'air_purifier', label: 'Purificador de ar',       group: 'Clima',          type: 'appliance', mount: 'floor',   y: 0 },
  { model: 'humidifier',   label: 'Umidificador / desumidificador', group: 'Clima',   type: 'appliance', mount: 'furniture', y: 0.55, furniture: SIDE, onFloor: true },
  { model: 'heater',       label: 'Aquecedor elétrico',      group: 'Clima',          type: 'appliance', mount: 'floor',   y: 0 },
  // ---- iluminação ----
  { model: 'plafon',       label: 'Plafon / luz de teto',    group: 'Iluminação',     type: 'light',   mount: 'ceiling',   y: 2.5 },
  { model: 'pendant',      label: 'Pendente',                group: 'Iluminação',     type: 'light',   mount: 'ceiling',   y: 2.5 },
  { model: 'spot',         label: 'Spot / embutido no forro', group: 'Iluminação',    type: 'light',   mount: 'ceiling',   y: 2.5 },
  { model: 'led_strip',    label: 'Fita LED (sanca)',        group: 'Iluminação',     type: 'light',   mount: 'wall',      y: 2.35 },
  { model: 'sconce',       label: 'Arandela',                group: 'Iluminação',     type: 'light',   mount: 'wall',      y: 1.8 },
  { model: 'lamp',         label: 'Abajur com lâmpada smart', group: 'Iluminação',    type: 'light',   mount: 'furniture', y: 0.55, furniture: ['criado', 'mesa_lateral', 'aparador', 'comoda', 'escrivaninha', 'penteadeira'] },
  { model: 'floor_lamp',   label: 'Luminária de piso smart', group: 'Iluminação',     type: 'light',   mount: 'floor',     y: 0 },
  { model: 'outdoor_light', label: 'Refletor / luz externa', group: 'Iluminação',     type: 'light',   mount: 'wall',      y: 2.4 },
  { model: 'garden_light', label: 'Balizador de jardim',     group: 'Iluminação',     type: 'light',   mount: 'floor',     y: 0 },
  { model: 'switch',       label: 'Interruptor inteligente', group: 'Iluminação',     type: 'switch',  mount: 'wall',      y: 1.1 },
  { model: 'dimmer',       label: 'Dimmer / teclado de cenas', group: 'Iluminação',   type: 'switch',  mount: 'wall',      y: 1.1 },
  // ---- áudio ----
  { model: 'speaker',      label: 'Assistente de voz (smart speaker)', group: 'Áudio', type: 'speaker', mount: 'furniture', y: 0.75, furniture: ['rack_tv', 'painel_tv', 'criado', 'mesa_lateral', 'aparador', 'comoda', 'escrivaninha', 'estante', 'bancada', 'ilha'] },
  { model: 'smart_display', label: 'Smart display (Echo Show / Nest Hub)', group: 'Áudio', type: 'speaker', mount: 'furniture', y: 0.75, furniture: SIDE },
  { model: 'soundbar',     label: 'Soundbar',                group: 'Áudio',          type: 'audio',   mount: 'furniture', y: 0.5,  furniture: RACK },
  { model: 'av_receiver',  label: 'Receiver / amplificador AV', group: 'Áudio',       type: 'audio',   mount: 'furniture', y: 0.5,  furniture: RACK },
  { model: 'streamer',     label: 'Streamer multiroom (Sonos / WiiM)', group: 'Áudio', type: 'audio',  mount: 'furniture', y: 0.5,  furniture: [...RACK, ...SIDE] },
  { model: 'bookshelf_speaker', label: 'Caixa acústica de estante', group: 'Áudio',   type: 'audio',   mount: 'furniture', y: 0.5,  furniture: [...RACK, 'mesa_lateral', 'escrivaninha', 'mesa_escritorio'] },
  { model: 'floor_speaker', label: 'Caixa acústica de chão (torre)', group: 'Áudio',  type: 'audio',   mount: 'floor',     y: 0 },
  { model: 'subwoofer',    label: 'Subwoofer',               group: 'Áudio',          type: 'audio',   mount: 'floor',     y: 0 },
  { model: 'ceiling_speaker', label: 'Caixa de som de embutir (teto)', group: 'Áudio', type: 'audio',  mount: 'ceiling',   y: 2.5 },
  { model: 'wall_speaker', label: 'Caixa de som de parede',  group: 'Áudio',          type: 'audio',   mount: 'wall',      y: 2.0 },
  { model: 'outdoor_speaker', label: 'Caixa de som externa', group: 'Áudio',          type: 'audio',   mount: 'wall',      y: 2.2 },
  { model: 'turntable',    label: 'Toca-discos',             group: 'Áudio',          type: 'audio',   mount: 'furniture', y: 0.5,  furniture: RACK },
  // ---- vídeo ----
  { model: 'smart_tv',     label: 'Smart TV',                group: 'Vídeo',          type: 'tv',      mount: 'furniture', y: 1.0,  furniture: ['painel_tv', 'rack_tv', 'comoda', 'aparador', 'estante', 'cristaleira'] },
  { model: 'tv_wall',      label: 'TV na parede',            group: 'Vídeo',          type: 'tv',      mount: 'wall',      y: 1.0 },
  { model: 'projector',    label: 'Projetor de teto',        group: 'Vídeo',          type: 'projector', mount: 'ceiling', y: 2.5 },
  { model: 'projector_table', label: 'Projetor de mesa / laser', group: 'Vídeo',      type: 'projector', mount: 'furniture', y: 0.4, furniture: [...RACK, 'mesa_centro'] },
  { model: 'projection_screen', label: 'Tela de projeção motorizada', group: 'Vídeo', type: 'projector', mount: 'wall',    y: 2.4 },
  { model: 'media_player', label: 'Streaming (Apple TV / Chromecast / Fire TV)', group: 'Vídeo', type: 'media', mount: 'furniture', y: 0.5, furniture: RACK },
  { model: 'console',      label: 'Videogame (PlayStation / Xbox / Switch)', group: 'Vídeo', type: 'media', mount: 'furniture', y: 0.5, furniture: RACK },
  { model: 'hdmi_matrix',  label: 'Matriz / switch HDMI',    group: 'Vídeo',          type: 'media',   mount: 'furniture', y: 0.5,  furniture: RACK },
  // ---- computadores e rede ----
  { model: 'desktop_pc',   label: 'Computador (gabinete)',   group: 'Computadores e rede', type: 'computer', mount: 'floor', y: 0 },
  { model: 'all_in_one',   label: 'Computador all-in-one (iMac)', group: 'Computadores e rede', type: 'computer', mount: 'furniture', y: 0.75, furniture: DESK },
  { model: 'monitor',      label: 'Monitor',                 group: 'Computadores e rede', type: 'computer', mount: 'furniture', y: 0.75, furniture: DESK },
  { model: 'notebook',     label: 'Notebook',                group: 'Computadores e rede', type: 'computer', mount: 'furniture', y: 0.75, furniture: [...DESK, 'mesa_centro', 'criado', 'mesa_lateral'] },
  { model: 'tablet',       label: 'Tablet',                  group: 'Computadores e rede', type: 'tablet', mount: 'furniture', y: 0.55, furniture: [...SIDE, 'mesa_jantar', 'mesa_jantar_6', 'mesa_redonda'] },
  { model: 'tablet_wall',  label: 'Tablet de parede (painel de controle)', group: 'Computadores e rede', type: 'tablet', mount: 'wall', y: 1.35 },
  { model: 'touch_panel',  label: 'Tela touch NexusHome (ESP32-S3 4.3")', group: 'Computadores e rede', type: 'hub', mount: 'wall', y: 1.35 },
  { model: 'phone',        label: 'Celular (base de carga)', group: 'Computadores e rede', type: 'tablet', mount: 'furniture', y: 0.55, furniture: SIDE },
  { model: 'printer',      label: 'Impressora',              group: 'Computadores e rede', type: 'computer', mount: 'furniture', y: 0.75, furniture: [...SHELF, 'mesa_lateral'] },
  { model: 'nas',          label: 'Servidor / NAS',          group: 'Computadores e rede', type: 'computer', mount: 'furniture', y: 0.75, furniture: SHELF, onFloor: true },
  { model: 'router',       label: 'Roteador Wi-Fi',          group: 'Computadores e rede', type: 'network', mount: 'furniture', y: 0.5, furniture: [...SHELF, ...RACK], onFloor: true },
  { model: 'mesh_ap',      label: 'Ponto de acesso / mesh (teto)', group: 'Computadores e rede', type: 'network', mount: 'ceiling', y: 2.5 },
  { model: 'network_rack', label: 'Rack de rede (switch, patch panel)', group: 'Computadores e rede', type: 'network', mount: 'wall', y: 1.5 },
  { model: 'hub',          label: 'Hub / gateway (Zigbee, Matter)', group: 'Computadores e rede', type: 'hub', mount: 'furniture', y: 0.75, furniture: ['rack_tv', 'painel_tv', 'estante', 'aparador', 'escrivaninha', 'criado'] },
  { model: 'ir_blaster',   label: 'Controle IR universal',   group: 'Computadores e rede', type: 'hub',   mount: 'furniture', y: 0.5, furniture: [...RACK, ...SIDE] },
  // ---- eletrodomésticos (sobre o móvel do mesmo nome: vira um módulo inteligente) ----
  { model: 'fridge',       label: 'Geladeira smart',         group: 'Eletrodomésticos', type: 'appliance', mount: 'furniture', y: 0, furniture: ['geladeira'], onFloor: true },
  { model: 'washer',       label: 'Máquina de lavar / lava e seca', group: 'Eletrodomésticos', type: 'appliance', mount: 'furniture', y: 0, furniture: ['maquina_lavar'], onFloor: true },
  { model: 'dryer',        label: 'Secadora',                group: 'Eletrodomésticos', type: 'appliance', mount: 'furniture', y: 0, furniture: ['secadora'], onFloor: true },
  { model: 'dishwasher',   label: 'Lava-louças',             group: 'Eletrodomésticos', type: 'appliance', mount: 'furniture', y: 0, furniture: ['lava_loucas'], onFloor: true },
  { model: 'oven',         label: 'Forno / fogão',           group: 'Eletrodomésticos', type: 'appliance', mount: 'furniture', y: 0, furniture: ['fogao'], onFloor: true },
  { model: 'microwave',    label: 'Micro-ondas',             group: 'Eletrodomésticos', type: 'appliance', mount: 'furniture', y: 0.9, furniture: ['micro_ondas', ...COUNTER] },
  { model: 'coffee',       label: 'Cafeteira',               group: 'Eletrodomésticos', type: 'appliance', mount: 'furniture', y: 0.9, furniture: COUNTER },
  { model: 'air_fryer',    label: 'Air fryer',               group: 'Eletrodomésticos', type: 'appliance', mount: 'furniture', y: 0.9, furniture: COUNTER },
  { model: 'range_hood',   label: 'Coifa / depurador',       group: 'Eletrodomésticos', type: 'appliance', mount: 'wall',    y: 1.65 },
  { model: 'robot_vacuum', label: 'Robô aspirador',          group: 'Eletrodomésticos', type: 'vacuum',    mount: 'floor',   y: 0 },
  // ---- água ----
  { model: 'valve',        label: 'Válvula motorizada',      group: 'Água',           type: 'valve',   mount: 'wall',      y: 0.3 },
  { model: 'irrigation',   label: 'Irrigação (zona / solenoide)', group: 'Água',      type: 'valve',   mount: 'wall',      y: 1.2 },
  { model: 'leak',         label: 'Sensor de vazamento',     group: 'Água',           type: 'sensor',  mount: 'floor',     y: 0 },
  { model: 'level',        label: 'Sensor de nível (caixa)', group: 'Água',           type: 'sensor',  mount: 'floor',     y: 0 },
  { model: 'water_heater', label: 'Aquecedor a gás / boiler', group: 'Água',          type: 'appliance', mount: 'wall',    y: 1.3 },
  { model: 'pump',         label: 'Bomba / pressurizador',   group: 'Água',           type: 'plug',    mount: 'floor',     y: 0 },
  // ---- energia ----
  { model: 'meter',        label: 'Medidor de energia',      group: 'Energia',        type: 'meter',   mount: 'wall',      y: 1.25 },
  { model: 'plug',         label: 'Tomada inteligente',      group: 'Energia',        type: 'plug',    mount: 'wall',      y: 0.3 },
  { model: 'solar',        label: 'Inversor solar',          group: 'Energia',        type: 'solar',   mount: 'wall',      y: 1.25 },
  { model: 'battery',      label: 'Bateria / inversor híbrido', group: 'Energia',     type: 'solar',   mount: 'floor',     y: 0 },
  { model: 'ev_charger',   label: 'Carregador de carro elétrico', group: 'Energia',   type: 'plug',    mount: 'wall',      y: 1.1 },
  { model: 'ups',          label: 'Nobreak',                 group: 'Energia',        type: 'plug',    mount: 'floor',     y: 0 },
  // ---- segurança ----
  { model: 'lock',         label: 'Fechadura digital',       group: 'Segurança',      type: 'lock',    mount: 'door',      y: 1.0 },
  { model: 'camera',       label: 'Câmera',                  group: 'Segurança',      type: 'camera',  mount: 'wall',      y: 2.3 },
  { model: 'ptz_camera',   label: 'Câmera dome / PTZ',       group: 'Segurança',      type: 'camera',  mount: 'ceiling',   y: 2.5 },
  { model: 'doorbell',     label: 'Campainha com vídeo',     group: 'Segurança',      type: 'camera',  mount: 'wall',      y: 1.4 },
  { model: 'intercom',     label: 'Interfone / porteiro com vídeo', group: 'Segurança', type: 'camera', mount: 'wall',     y: 1.45 },
  { model: 'nvr',          label: 'Gravador NVR / DVR',      group: 'Segurança',      type: 'network', mount: 'furniture', y: 0.5, furniture: [...SHELF, ...RACK], onFloor: true },
  { model: 'alarm_panel',  label: 'Central / teclado de alarme', group: 'Segurança',  type: 'alarm',   mount: 'wall',      y: 1.4 },
  { model: 'siren',        label: 'Sirene',                  group: 'Segurança',      type: 'alarm',   mount: 'wall',      y: 2.4 },
  { model: 'door_sensor',  label: 'Sensor de porta/janela',  group: 'Segurança',      type: 'sensor',  mount: 'door',      y: 2.0 },
  { model: 'presence',     label: 'Sensor de presença',      group: 'Segurança',      type: 'sensor',  mount: 'wall',      y: 2.3 },
  { model: 'smoke',        label: 'Detector de fumaça',      group: 'Segurança',      type: 'sensor',  mount: 'ceiling',   y: 2.5 },
  { model: 'gas',          label: 'Detector de gás',         group: 'Segurança',      type: 'sensor',  mount: 'wall',      y: 0.3 },
  { model: 'panic',        label: 'Botão de pânico',         group: 'Segurança',      type: 'sensor',  mount: 'wall',      y: 1.0 },
  // ---- conforto e acesso ----
  { model: 'curtain',      label: 'Cortina motorizada',      group: 'Conforto e acesso', type: 'curtain', mount: 'window',  y: 2.2 },
  { model: 'blind',        label: 'Persiana motorizada',     group: 'Conforto e acesso', type: 'curtain', mount: 'window',  y: 2.2 },
  { model: 'awning',       label: 'Toldo motorizado',        group: 'Conforto e acesso', type: 'curtain', mount: 'wall',    y: 2.5 },
  { model: 'gate',         label: 'Portão automático (motor)', group: 'Conforto e acesso', type: 'gate',  mount: 'floor',   y: 0 },
  { model: 'garage_door',  label: 'Porta de garagem',        group: 'Conforto e acesso', type: 'gate',    mount: 'wall',    y: 0 },
  { model: 'temp_sensor',  label: 'Sensor de temperatura',   group: 'Conforto e acesso', type: 'sensor',  mount: 'wall',    y: 1.5 },
];

export const CATALOG_BY_MODEL = Object.fromEntries(DEVICE_CATALOG.map((c) => [c.model, c]));

/** Tipos aceitos em devices.type (migração 021 + 024). */
export const DEVICE_TYPES = [...new Set(DEVICE_CATALOG.map((c) => c.type))];

/** Tipos que o banco aceitava antes da migração 024 (sem ela, os novos caem em "hub"). */
export const LEGACY_TYPES = ['light', 'ac', 'sensor', 'valve', 'solar', 'meter', 'tv', 'plug', 'switch', 'lock', 'camera', 'curtain', 'fan', 'speaker', 'hub'];

/** Nome de cada tipo (cadastro, cartão do cômodo). */
export const TYPE_LABELS = {
  light: 'Luz', ac: 'Ar-condicionado', tv: 'TV', valve: 'Válvula', meter: 'Medidor', sensor: 'Sensor', solar: 'Solar',
  fan: 'Ventilador', plug: 'Tomada', switch: 'Interruptor', lock: 'Fechadura', camera: 'Câmera', curtain: 'Cortina',
  speaker: 'Assistente', hub: 'Hub', audio: 'Áudio', projector: 'Projetor', media: 'Mídia', computer: 'Computador',
  tablet: 'Tablet / celular', network: 'Rede', appliance: 'Eletrodoméstico', vacuum: 'Robô aspirador', alarm: 'Alarme',
  gate: 'Portão',
};

/** Entradas de sinal (seletor de fonte) de áudio/vídeo. */
export const SOURCES = {
  audio: ['TV (HDMI ARC)', 'Bluetooth', 'Streaming', 'Óptica', 'Phono / Aux'],
  tv: ['HDMI 1', 'HDMI 2', 'HDMI 3', 'TV aberta', 'Apps'],
  projector: ['HDMI 1', 'HDMI 2', 'USB-C', 'Apps'],
  media: ['HDMI 1', 'HDMI 2', 'HDMI 3', 'HDMI 4'],
};

/** Estado inicial de um aparelho novo, pelo tipo. */
export function defaultStatus(type) {
  switch (type) {
    case 'valve': return { open: true };
    case 'audio': return { on: false, volume: 30, muted: false, source: SOURCES.audio[0] };
    case 'tv': return { on: false, volume: 20, source: SOURCES.tv[0] };
    case 'projector': return { on: false, source: SOURCES.projector[0] };
    case 'media': return { on: false, source: SOURCES.media[0] };
    case 'computer': case 'appliance': case 'plug': case 'switch': case 'fan': case 'light': case 'ac': return { on: false };
    case 'vacuum': return { state: 'docked', battery: 100 };
    case 'alarm': return { armed: 'off' };
    case 'gate': return { open: false };
    case 'curtain': return { open: true };
    default: return {};
  }
}

/** Modelo padrão quando o dispositivo não tem `model` (nativos antigos e integrados). */
const DEFAULT_BY_TYPE = {
  ac: 'split', light: 'plafon', tv: 'smart_tv', valve: 'valve', meter: 'meter', solar: 'solar', fan: 'ceiling_fan', plug: 'plug',
  switch: 'switch', lock: 'lock', camera: 'camera', curtain: 'curtain', speaker: 'speaker', hub: 'hub', sensor: 'temp_sensor',
  audio: 'soundbar', projector: 'projector', media: 'media_player', computer: 'desktop_pc', tablet: 'tablet', network: 'router',
  appliance: 'fridge', vacuum: 'robot_vacuum', alarm: 'alarm_panel', gate: 'gate',
};

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
