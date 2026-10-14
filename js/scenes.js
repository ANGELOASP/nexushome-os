// ============================================================
// NexusHome OS — Cenas (v2.7): um botão aciona vários dispositivos
// Módulo puro (sem DOM). Uma cena guarda ações
//   [{ device_id, patch: { on?, brightness?, color?, temp?, open? } }]
// e pode pertencer a um cômodo (room) ou à casa toda (room = null).
// ============================================================

export const SCENE_ICONS = {
  film:  { label: 'Cinema',  svg: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M17 5v14M3 9.5h4M3 14.5h4M17 9.5h4M17 14.5h4"/>' },
  moon:  { label: 'Dormir',  svg: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>' },
  door:  { label: 'Sair',    svg: '<path d="M14 3h5v18h-5"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/>' },
  sun:   { label: 'Manhã',   svg: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>' },
  home:  { label: 'Chegar',  svg: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>' },
  spark: { label: 'Festa',   svg: '<path d="m12 3 1.9 4.8L19 9l-4 3.4L16.2 18 12 15.3 7.8 18 9 12.4 5 9l5.1-1.2z"/>' },
};

/** Patch que um tipo de dispositivo aceita numa cena (o resto é descartado). */
const ALLOWED = {
  light: ['on', 'brightness', 'color'],
  ac: ['on', 'temp'],
  tv: ['on', 'volume', 'source'],
  valve: ['open'],
  // v2.13 — biblioteca ampliada: cena "Cinema" liga projetor, desce a tela, escolhe a entrada...
  audio: ['on', 'volume', 'muted', 'source'],
  projector: ['on', 'source'],
  media: ['on', 'source'],
  computer: ['on'], appliance: ['on'], fan: ['on'], plug: ['on'], switch: ['on'], speaker: ['on'],
  curtain: ['open'],
  gate: ['open'],
  alarm: ['armed'],
  vacuum: ['state'],
};

/** Estado "aberto" por tipo: válvula e cortina abertas por padrão; portão fechado. */
const isOpen = (type, s) => (type === 'gate' ? s?.open === true : s?.open !== false);

export function sceneableType(type) { return !!ALLOWED[type]; }

export function cleanPatch(type, patch = {}) {
  const keys = ALLOWED[type] || [];
  const out = {};
  keys.forEach((k) => { if (patch[k] !== undefined && patch[k] !== null) out[k] = patch[k]; });
  if (out.brightness !== undefined) out.brightness = Math.max(1, Math.min(100, Math.round(Number(out.brightness) || 0)));
  if (out.temp !== undefined) out.temp = Math.max(16, Math.min(30, Math.round(Number(out.temp) || 23)));
  if (out.on !== undefined) out.on = !!out.on;
  if (out.open !== undefined) out.open = !!out.open;
  if (out.muted !== undefined) out.muted = !!out.muted;
  if (out.volume !== undefined) out.volume = Math.max(0, Math.min(100, Math.round(Number(out.volume) || 0)));
  if (out.source !== undefined) out.source = String(out.source);
  if (out.armed !== undefined && !['off', 'home', 'away'].includes(out.armed)) delete out.armed;
  if (out.state !== undefined && !['cleaning', 'docked'].includes(out.state)) delete out.state;
  return out;
}

/** Ações a partir do estado ATUAL dos dispositivos escolhidos ("usar estado atual"). */
export function captureActions(devices, ids) {
  return devices
    .filter((d) => ids.includes(d.id) && sceneableType(d.type))
    .map((d) => {
      const s = d.status || {};
      const patch = { ...s, on: !!s.on, open: isOpen(d.type, s) };   // cleanPatch fica só com as chaves do tipo
      return { device_id: d.id, patch: cleanPatch(d.type, patch) };
    })
    .filter((a) => Object.keys(a.patch).length);
}

export function normalizeScene(row) {
  const icon = SCENE_ICONS[row?.icon] ? row.icon : 'spark';
  const actions = Array.isArray(row?.actions) ? row.actions.filter((a) => a && a.device_id && a.patch && typeof a.patch === 'object') : [];
  return { ...row, name: String(row?.name || 'Cena').trim() || 'Cena', icon, room: row?.room || null, actions };
}

/** Cenas que valem para o cômodo: as dele + as da casa toda que mexem em algo dele. */
export function scenesForRoom(scenes, room, devices) {
  const inRoom = new Set(devices.filter((d) => d.room === room).map((d) => d.id));
  return scenes.filter((s) => s.room === room || (!s.room && s.actions.some((a) => inRoom.has(a.device_id))));
}

/** A cena já está "ativa" (todos os dispositivos no estado pedido)? */
export function sceneMatches(scene, devices) {
  if (!scene.actions.length) return false;
  return scene.actions.every((a) => {
    const d = devices.find((x) => x.id === a.device_id);
    if (!d) return false;
    const s = d.status || {};
    return Object.entries(a.patch).every(([k, v]) => {
      if (k === 'open') return isOpen(d.type, s) === v;
      if (k === 'muted') return !!s.muted === v;
      if (k === 'on') return !!s.on === v;
      if (a.patch.on === false) return true;            // desligado: brilho/temperatura não importam
      if (k === 'brightness' || k === 'temp' || k === 'volume') return Number(s[k]) === Number(v);
      return String(s[k] ?? '').toLowerCase() === String(v).toLowerCase();
    });
  });
}

export const DEMO_SCENES = [
  { id: 'e1111111-1111-4111-8111-111111111111', name: 'Cinema', icon: 'film', room: 'Sala de Estar', sort_order: 1,
    actions: [{ device_id: 'a1111111-1111-4111-8111-111111111111', patch: { on: true, brightness: 15, color: '#ffb46b' } }] },
  { id: 'e2222222-2222-4222-8222-222222222222', name: 'Dormir', icon: 'moon', room: null, sort_order: 2,
    actions: [
      { device_id: 'a1111111-1111-4111-8111-111111111111', patch: { on: false } },
      { device_id: 'a2222222-2222-4222-8222-222222222222', patch: { on: true, temp: 22 } },
    ] },
  { id: 'e3333333-3333-4333-8333-333333333333', name: 'Sair de casa', icon: 'door', room: null, sort_order: 3,
    actions: [
      { device_id: 'a1111111-1111-4111-8111-111111111111', patch: { on: false } },
      { device_id: 'a2222222-2222-4222-8222-222222222222', patch: { on: false } },
      { device_id: 'a3333333-3333-4333-8333-333333333333', patch: { open: false } },
    ] },
];
