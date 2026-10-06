// ============================================================
// NexusHome OS — Motor 3D (Three.js r128 via CDN)
// A casa é construída a partir da planta em state.rooms
// (tabela rooms / localStorage no demo) — nada é fixo no código.
// Editou a planta no Editor de Planta? O evento 'rooms-changed'
// reconstrói os cômodos dinamicamente, sem recarregar a página.
//
// v1.6.0 — ANDARES: cômodos com floor > 0 são empilhados
// (FLOOR_H de altura por andar) e o filtro #floor-filter isola
// um andar ou mostra todos (andares superiores com transparência).
// O mobiliário segue o `kind` do cômodo (presets do editor), com
// fallback genérico para tipos desconhecidos.
// ============================================================

import { state, on, emit, floorLabel, inferRoomKind } from './state.js';

const METER = 1.9;          // unidades de cena por metro (3.0 m → 5.7 un., paridade com o layout original)
const WALL_H = 2.5;
const WALL_T = 0.16;
const FLOOR_H = 3.0;        // altura de um andar na pilha (laje + pé direito)

let scene, camera, renderer, controls, raycaster, pointer;
let container, labelRoot;
let onRoomSelectCb = null;
let planGroup = null;        // grupo reconstruível: base + cômodos
let rooms = {};              // nome -> { group, floor, walls[], highlight, label, lights:{}, fx:{} }
let floorSlabs = [];         // lajes por andar: [{ floor, mesh }]
let pickMeshes = [];
let selectedRoom = null;
let floorFilter = 'all';     // 'all' | número do andar
let lastInteraction = 0;
let desiredTarget = null;
let downPos = null;
const clock = { t: 0, last: performance.now() };

export function initScene3D(containerEl, labelsEl, onRoomSelect) {
  container = containerEl;
  labelRoot = labelsEl;
  onRoomSelectCb = onRoomSelect;
  const THREE = window.THREE;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1120);
  scene.fog = new THREE.Fog(0x0b1120, 26, 62);

  camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  camera.position.set(14.5, 13.5, 14.5);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputEncoding = THREE.sRGBEncoding;
  container.appendChild(renderer.domElement);

  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.8, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 8;
  controls.maxDistance = 34;
  controls.maxPolarAngle = 1.32;
  controls.enablePan = false;
  controls.autoRotateSpeed = 0.5;
  ['start', 'end'].forEach((ev) => controls.addEventListener(ev, () => { lastInteraction = performance.now(); }));

  raycaster = new THREE.Raycaster();
  pointer = new THREE.Vector2();

  buildLights(THREE);
  buildGround(THREE);
  buildPlan(THREE);

  // interação de clique (sem confundir arrasto de câmera com clique)
  renderer.domElement.addEventListener('pointerdown', (e) => { downPos = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!downPos) return;
    const moved = Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]);
    downPos = null;
    if (moved < 6) handlePick(e);
  });

  window.addEventListener('resize', resize);
  resize();

  // sincroniza quando dispositivos mudam (UI, realtime ou avaliador IFTTT)
  on('device-changed', (device) => { if (device) applyDeviceState(device); });
  on('devices-changed', (devices) => {
    devices.forEach((d) => applyDeviceState(d));
    updateLabelBadges(devices);
  });

  // planta editada → reconstrói os cômodos sem recarregar a página
  on('rooms-changed', () => rebuildPlan());

  buildFloorFilter();
  animate();
  return api;
}

// ------------------------------------------------------------
// Construção da cena
// ------------------------------------------------------------

function buildLights(THREE) {
  const hemi = new THREE.HemisphereLight(0x93c5fd, 0x0b1120, 0.55);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff2df, 0.95);
  sun.position.set(12, 20, 9);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -14; sun.shadow.camera.right = 14;
  sun.shadow.camera.top = 14; sun.shadow.camera.bottom = -14;
  sun.shadow.camera.far = 60;
  sun.shadow.bias = -0.0004;
  scene.add(sun);

  const rim = new THREE.DirectionalLight(0x6366f1, 0.25);
  rim.position.set(-10, 8, -12);
  scene.add(rim);
}

function buildGround(THREE) {
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(90, 90),
    new THREE.MeshStandardMaterial({ color: 0x0e1526, roughness: 1, metalness: 0 })
  );
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = -0.06;
  plane.receiveShadow = true;
  scene.add(plane);

  const grid = new THREE.GridHelper(60, 60, 0x24314f, 0x16203a);
  grid.position.y = -0.04;
  grid.material.transparent = true;
  grid.material.opacity = 0.55;
  scene.add(grid);
}

// ------------------------------------------------------------
// Planta: constrói (e reconstrói) base + cômodos de state.rooms
// ------------------------------------------------------------

function roomDefFromRow(row) {
  const kind = row.kind || inferRoomKind(row.name);
  return {
    name: row.name,
    kind,
    floorNo: Math.max(0, Math.trunc(Number(row.floor) || 0)),
    pos: [Number(row.pos_x) * METER || 0, 0, Number(row.pos_z) * METER || 0],
    sizeX: Math.max(1, Number(row.size_x) || 3) * METER,
    sizeZ: Math.max(1, Number(row.size_z) || 3) * METER,
    color: row.color || '#818cf8',
    outdoor: kind === 'area_externa' || row.name === 'Área Externa',
  };
}

function buildPlan(THREE) {
  planGroup = new THREE.Group();
  scene.add(planGroup);
  floorSlabs = [];

  // laje por andar, dimensionada pelos limites da planta DAQUELE andar
  const floors = [...new Set(state.rooms.map((r) => Math.max(0, Math.trunc(Number(r.floor) || 0))))].sort((a, b) => a - b);
  floors.forEach((f) => {
    const rows = state.rooms.filter((r) => Math.max(0, Math.trunc(Number(r.floor) || 0)) === f);
    if (!rows.length) return;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    rows.forEach((r) => {
      const x = Number(r.pos_x) * METER || 0, z = Number(r.pos_z) * METER || 0;
      const hw = (Math.max(1, Number(r.size_x) || 3) * METER) / 2;
      const hd = (Math.max(1, Number(r.size_z) || 3) * METER) / 2;
      minX = Math.min(minX, x - hw); maxX = Math.max(maxX, x + hw);
      minZ = Math.min(minZ, z - hd); maxZ = Math.max(maxZ, z + hd);
    });
    const base = new THREE.Mesh(
      new THREE.BoxGeometry((maxX - minX) + 0.7, 0.28, (maxZ - minZ) + 0.7),
      new THREE.MeshStandardMaterial({ color: 0x131c33, roughness: 0.9 })
    );
    // térreo: base no solo; andares: laje no topo do andar anterior
    base.position.set((minX + maxX) / 2, f === 0 ? 0.02 : f * FLOOR_H + 0.04, (minZ + maxZ) / 2);
    base.receiveShadow = true; base.castShadow = true;
    planGroup.add(base);
    floorSlabs.push({ floor: f, mesh: base });
  });

  state.rooms.forEach((row) => buildRoom(THREE, roomDefFromRow(row)));
  applyFloorFilter();
}

// Reconstrói a planta inteira (dispose correto de geometrias/materiais)
function rebuildPlan() {
  const THREE = window.THREE;
  if (!THREE || !scene) return;

  if (planGroup) {
    planGroup.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach((m) => m.dispose());
      }
    });
    scene.remove(planGroup);
    planGroup = null;
  }
  Object.values(rooms).forEach((r) => r.label?.remove());
  rooms = {};
  pickMeshes = [];

  buildPlan(THREE);
  buildFloorFilter();

  // reaplica o estado dos dispositivos nos meshes recém-criados
  state.devices.forEach((d) => applyDeviceState(d));
  updateLabelBadges(state.devices);

  // seleção pode ter ficado órfã (cômodo renomeado/removido)
  if (selectedRoom && !rooms[selectedRoom]) selectRoom(null);
  else if (selectedRoom) selectRoom(selectedRoom); // reancora o highlight/label
}

function mat(THREE, color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.05, ...opts });
}

function box(THREE, w, h, d, material, x = 0, y = 0, z = 0, castShadow = true) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  m.castShadow = castShadow; m.receiveShadow = true;
  return m;
}

function buildRoom(THREE, def) {
  const g = new THREE.Group();
  g.position.set(def.pos[0], 0.16 + def.floorNo * FLOOR_H, def.pos[2]);
  planGroup.add(g);

  const room = { group: g, def, walls: [], lights: {}, fx: {}, floorMat: null, wallMats: [] };
  const SX = def.sizeX, SZ = def.sizeZ;

  // piso: cor do cômodo misturada ao escuro do tema
  const baseHex = def.outdoor ? 0x14301f : 0x111a30;
  const floorColor = new THREE.Color(def.color).lerp(new THREE.Color(baseHex), 0.78);
  const floorMat = mat(THREE, floorColor, { roughness: def.outdoor ? 1 : 0.7 });
  const floor = box(THREE, SX, 0.12, SZ, floorMat, 0, 0, 0);
  floor.userData.roomName = def.name;
  g.add(floor);
  room.floor = floor; room.floorMat = floorMat;
  pickMeshes.push(floor);

  if (!def.outdoor) {
    // paredes (duas externas + meias-paredes internas para visibilidade)
    const wallMat = mat(THREE, 0x25304f, { roughness: 0.95 });
    const mkWall = (w, h, d, x, y, z) => {
      const wm = wallMat.clone();
      const m = box(THREE, w, h, d, wm, x, y, z);
      m.userData.roomName = def.name;
      g.add(m); room.walls.push(m); room.wallMats.push(wm); pickMeshes.push(m);
      return m;
    };
    const HX = SX / 2, HZ = SZ / 2;
    // decide as paredes externas conforme o quadrante
    const backZ = def.pos[2] > 0 ? HZ : -HZ;   // parede no lado "de fora" em z
    const backX = def.pos[0] > 0 ? HX : -HX;   // parede no lado "de fora" em x
    mkWall(SX + WALL_T, WALL_H, WALL_T, 0, WALL_H / 2, backZ);
    mkWall(WALL_T, WALL_H, SZ + WALL_T, backX, WALL_H / 2, 0);
    // meia parede interna (para sugerir divisão sem fechar a vista)
    mkWall(SX * 0.55, WALL_H * 0.55, WALL_T, -backX * 0.22, WALL_H * 0.275, -backZ);
  } else {
    // Área externa: cerca baixa em dois lados
    const fenceMat = mat(THREE, 0x2d3a55);
    const HX = SX / 2, HZ = SZ / 2;
    const f1 = box(THREE, SX, 0.7, 0.08, fenceMat, 0, 0.35, -HZ);
    const f2 = box(THREE, 0.08, 0.7, SZ, fenceMat, HX, 0.35, 0);
    f1.userData.roomName = def.name; f2.userData.roomName = def.name;
    g.add(f1, f2); room.walls.push(f1, f2); pickMeshes.push(f1, f2);
  }

  // moldura de seleção (highlight)
  const hl = new THREE.Mesh(
    new THREE.BoxGeometry(SX + 0.25, WALL_H + 0.4, SZ + 0.25),
    new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.1, depthWrite: false })
  );
  hl.position.y = (WALL_H + 0.4) / 2 - 0.1;
  hl.visible = false;
  g.add(hl);
  room.highlight = hl;

  // mobiliário segue o `kind` do cômodo (presets da v1.6.0), com
  // fallback genérico para tipos desconhecidos
  const furnish = FURNISH_BY_KIND[def.kind] || furnishGeneric;
  furnish(THREE, g, room);

  // brilho de teto neutro em cômodos internos sem "coolGlow" temático:
  // permite a reação visual de dispositivos vinculados (ex.: AC/TV SmartThings)
  if (!def.outdoor && !room.fx.coolGlow) {
    const neutralMat = mat(THREE, 0x1a2440, { emissive: 0x2563eb, emissiveIntensity: 0 });
    g.add(box(THREE, SX - 0.3, 0.04, SZ - 0.3, neutralMat, 0, WALL_H - 0.09, 0, false));
    room.fx.coolGlow = neutralMat;
  }

  // rótulo flutuante (div sobreposta) — bolinha na cor do cômodo
  const label = document.createElement('div');
  label.className = 'room-label';
  const dot = document.createElement('span');
  dot.className = 'room-label-dot';
  dot.style.background = def.color;
  const txt = document.createElement('span');
  txt.textContent = def.name;
  label.append(dot, txt);
  labelRoot.appendChild(label);
  room.label = label;
  room.ghost = 1;

  // marca andar em todos os meshes (filtro de andares + raycast)
  g.traverse((o) => { if (o.isMesh) o.userData.roomFloor = def.floorNo; });

  rooms[def.name] = room;
}

// ---- mobiliário por tipo de cômodo (kind) — v1.6.0
const FURNISH_BY_KIND = {
  sala_estar: furnishLiving,
  sala_jantar: furnishDining,
  quarto: furnishBedroom,
  suite: furnishSuite,
  banheiro: furnishBathroom,
  cozinha: furnishKitchen,
  lavanderia: furnishLaundry,
  escritorio: furnishOffice,
  varanda: furnishBalcony,
  garagem: furnishGarage,
  corredor: furnishCorridor,
  area_externa: furnishOutdoor,
  closet: furnishCloset,
  despensa: furnishPantry,
};

// ---- filtro de andares da cena (Todos / Térreo / 1º / 2º) ----------

function buildFloorFilter() {
  const el = document.getElementById('floor-filter');
  if (!el) return;
  const floors = [...new Set(state.rooms.map((r) => Math.max(0, Math.trunc(Number(r.floor) || 0))))].sort((a, b) => a - b);
  // com um único andar (térreo) o filtro não é necessário
  if (floors.length <= 1) {
    el.classList.add('hidden');
    el.innerHTML = '';
    if (floorFilter !== 'all') { floorFilter = 'all'; applyFloorFilter(); }
    return;
  }
  if (floorFilter !== 'all' && !floors.includes(floorFilter)) floorFilter = 'all';
  el.classList.remove('hidden');
  el.innerHTML = '';
  const mk = (val, label) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    const active = (val === 'all' && floorFilter === 'all') || val === floorFilter;
    if (active) b.classList.add('ff-active');
    b.addEventListener('click', () => {
      floorFilter = val;
      applyFloorFilter();
      buildFloorFilter();
    });
    el.appendChild(b);
  };
  mk('all', 'Todos');
  floors.forEach((f) => mk(f, floorLabel(f)));
}

function applyFloorFilter() {
  Object.values(rooms).forEach((room) => {
    const f = room.def.floorNo;
    if (floorFilter === 'all') {
      room.group.visible = true;
      setRoomGhost(room, f > 0); // andares superiores semitransparentes
    } else {
      room.group.visible = f === floorFilter;
      setRoomGhost(room, false);
    }
  });
  floorSlabs.forEach(({ floor, mesh }) => {
    mesh.visible = floorFilter === 'all' || floor === floorFilter;
    ghostMesh(mesh, floorFilter === 'all' && floor > 0);
  });
}

function ghostMesh(mesh, ghost) {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  mats.forEach((m) => {
    if (m.userData.baseOpacity === undefined) {
      m.userData.baseOpacity = m.opacity;
      m.userData.baseTransparent = m.transparent;
    }
    m.opacity = m.userData.baseOpacity * (ghost ? 0.55 : 1);
    m.transparent = ghost || m.userData.baseTransparent;
  });
}

function setRoomGhost(room, ghost) {
  room.ghost = ghost ? 0.55 : 1;
  room.group.traverse((o) => { if (o.isMesh) ghostMesh(o, ghost); });
}

// ---- Sala de Estar: sofá, mesa, luminária (dispositivo "light")
function furnishLiving(THREE, g, room) {
  const sofaMat = mat(THREE, 0x334155);
  g.add(box(THREE, 2.2, 0.55, 0.9, sofaMat, -0.6, 0.34, -1.3));
  g.add(box(THREE, 2.2, 0.5, 0.28, sofaMat, -0.6, 0.8, -1.66));
  g.add(box(THREE, 0.3, 0.75, 0.9, sofaMat, -1.85, 0.45, -1.3));
  g.add(box(THREE, 0.3, 0.75, 0.9, sofaMat, 0.65, 0.45, -1.3));
  g.add(box(THREE, 1.1, 0.32, 0.6, mat(THREE, 0x475569), -0.5, 0.22, -0.1)); // mesa de centro
  // painel de TV
  g.add(box(THREE, 1.8, 1.0, 0.08, mat(THREE, 0x0f172a, { roughness: 0.3, metalness: 0.4 }), -0.6, 1.5, 2.32));

  // luminária de piso + abajur emissivo
  const lampX = 1.6, lampZ = 1.5;
  g.add(box(THREE, 0.08, 1.5, 0.08, mat(THREE, 0x475569), lampX, 0.75, lampZ));
  const shadeMat = mat(THREE, 0xfff1d6, { emissive: 0xffd9a0, emissiveIntensity: 0 });
  const shade = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.5, 24, 1, true), shadeMat);
  shade.position.set(lampX, 1.62, lampZ);
  g.add(shade);
  room.fx.lampShade = shadeMat;

  const pt = new THREE.PointLight(0xffd9a0, 0, 9, 2);
  pt.position.set(lampX, 1.9, lampZ);
  pt.castShadow = true;
  g.add(pt);
  room.lights.lamp = pt;

  // brilho quente no teto/ambiente
  const glowMat = mat(THREE, 0x1a2440, { emissive: 0xffc887, emissiveIntensity: 0 });
  const glow = box(THREE, room.def.sizeX - 0.3, 0.04, room.def.sizeZ - 0.3, glowMat, 0, WALL_H - 0.05, 0, false);
  g.add(glow);
  room.fx.ceilingGlow = glowMat;
}

// ---- Quarto: cama, criado, ar-condicionado (dispositivo "ac")
function furnishBedroom(THREE, g, room) {
  const bedMat = mat(THREE, 0x3b4a6b);
  g.add(box(THREE, 1.7, 0.4, 2.3, bedMat, -1.2, 0.26, 0.7));
  g.add(box(THREE, 1.7, 0.5, 0.25, mat(THREE, 0x2b3854), -1.2, 0.5, 1.85)); // cabeceira
  g.add(box(THREE, 0.65, 0.16, 0.4, mat(THREE, 0xe2e8f0), -1.55, 0.54, 1.45)); // travesseiros
  g.add(box(THREE, 0.65, 0.16, 0.4, mat(THREE, 0xe2e8f0), -0.85, 0.54, 1.45));
  g.add(box(THREE, 1.6, 0.1, 1.5, mat(THREE, 0x6366f1, { roughness: 1 }), -1.2, 0.5, 0.25)); // cobertor
  g.add(box(THREE, 0.5, 0.5, 0.5, mat(THREE, 0x334155), 0.2, 0.31, 1.6)); // criado

  // unidade de ar-condicionado na parede
  const acMat = mat(THREE, 0xe8edf5, { roughness: 0.4, emissive: 0x38bdf8, emissiveIntensity: 0 });
  const ac = box(THREE, 1.5, 0.5, 0.3, acMat, 0.9, 1.95, 2.28);
  g.add(ac);
  const ventMat = mat(THREE, 0x94a3b8, { emissive: 0x38bdf8, emissiveIntensity: 0 });
  g.add(box(THREE, 1.3, 0.08, 0.05, ventMat, 0.9, 1.78, 2.42));
  room.fx.acBody = acMat;
  room.fx.acVent = ventMat;

  // "fluxo de ar" — planos finos animados quando o AC está ligado
  const flowMat = new THREE.MeshBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0, depthWrite: false });
  room.fx.airFlows = [];
  for (let i = 0; i < 3; i++) {
    const f = new THREE.Mesh(new THREE.PlaneGeometry(1.1 - i * 0.2, 0.16), flowMat.clone());
    f.position.set(0.9, 1.55 - i * 0.28, 2.1 - i * 0.15);
    f.rotation.x = -0.5;
    g.add(f);
    room.fx.airFlows.push(f);
  }

  // tonalidade fria do ambiente quando ligado
  const coolMat = mat(THREE, 0x1a2440, { emissive: 0x2563eb, emissiveIntensity: 0 });
  const cool = box(THREE, room.def.sizeX - 0.3, 0.04, room.def.sizeZ - 0.3, coolMat, 0, WALL_H - 0.05, 0, false);
  g.add(cool);
  room.fx.coolGlow = coolMat;
}

// ---- Cozinha: bancada, geladeira, medidor de energia (dispositivo "meter")
function furnishKitchen(THREE, g, room) {
  const counterMat = mat(THREE, 0x3c4763);
  g.add(box(THREE, 2.6, 0.85, 0.7, counterMat, -0.6, 0.48, -1.9));
  g.add(box(THREE, 0.7, 0.85, 1.6, counterMat, 1.55, 0.48, -1.1));
  g.add(box(THREE, 0.8, 2.0, 0.75, mat(THREE, 0xcbd5e1, { roughness: 0.35, metalness: 0.35 }), 2.0, 1.06, 1.4)); // geladeira
  g.add(box(THREE, 0.6, 0.06, 0.5, mat(THREE, 0x0f172a), -1.4, 0.94, -1.9)); // cooktop

  // painel do medidor de energia
  const meterMat = mat(THREE, 0x0f172a, { emissive: 0x22d3ee, emissiveIntensity: 0.25, roughness: 0.4 });
  g.add(box(THREE, 0.9, 0.6, 0.1, meterMat, -1.8, 1.6, 2.3));
  room.fx.meterPanel = meterMat;
  const barMat = new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.85 });
  const bar = box(THREE, 0.12, 0.34, 0.04, barMat, -2.05, 1.55, 2.38, false);
  g.add(bar);
  room.fx.meterBar = bar;
}

// ---- Área externa: painel solar, tubulação + válvula (dispositivo "valve")
function furnishOutdoor(THREE, g, room) {
  // painel solar inclinado
  const panelGroup = new THREE.Group();
  const panelMat = mat(THREE, 0x1d4ed8, { roughness: 0.25, metalness: 0.55, emissive: 0x1e40af, emissiveIntensity: 0.12 });
  const panel = box(THREE, 2.2, 0.08, 1.5, panelMat);
  panelGroup.add(panel);
  const frame = box(THREE, 2.34, 0.06, 1.64, mat(THREE, 0x475569));
  frame.position.y = -0.04;
  panelGroup.add(frame);
  panelGroup.position.set(-1.2, 1.15, -1.2);
  panelGroup.rotation.x = -0.42;
  panelGroup.rotation.y = 0.35;
  g.add(panelGroup);
  g.add(box(THREE, 0.12, 1.0, 0.12, mat(THREE, 0x475569), -1.2, 0.5, -1.2));

  // árvore
  g.add(box(THREE, 0.22, 1.1, 0.22, mat(THREE, 0x6b4f2e), 1.8, 0.55, 1.8));
  const leaves = new THREE.Mesh(new THREE.IcosahedronGeometry(0.75, 0), mat(THREE, 0x15803d, { roughness: 1 }));
  leaves.position.set(1.8, 1.55, 1.8);
  leaves.castShadow = true;
  g.add(leaves);

  // tubulação de água + registro (válvula)
  const pipeMat = mat(THREE, 0x64748b, { roughness: 0.4, metalness: 0.6 });
  const pipe1 = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 2.6, 16), pipeMat);
  pipe1.rotation.z = Math.PI / 2;
  pipe1.position.set(0.4, 0.35, 0.9);
  pipe1.castShadow = true;
  g.add(pipe1);
  const pipe2 = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.7, 16), pipeMat);
  pipe2.position.set(1.6, 0.35, 0.9);
  pipe2.castShadow = true;
  g.add(pipe2);

  const wheelMat = mat(THREE, 0xdc2626, { roughness: 0.5, emissive: 0x22c55e, emissiveIntensity: 0.5 });
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.055, 12, 24), wheelMat);
  wheel.position.set(0.4, 0.62, 0.9);
  wheel.rotation.x = Math.PI / 2;
  g.add(wheel);
  room.fx.valveWheel = wheel;
  room.fx.valveMat = wheelMat;

  // córrego de água (visível quando a válvula está aberta)
  const waterMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.55 });
  const water = box(THREE, 2.3, 0.05, 0.16, waterMat, 0.4, 0.22, 0.9, false);
  g.add(water);
  room.fx.water = water;
}

// ---- Cômodo genérico (nome fora dos quatro padrões): tapete na cor do cômodo + mesa
function furnishGeneric(THREE, g, room) {
  const d = room.def;
  g.add(box(THREE, Math.min(d.sizeX - 0.6, 2.6), 0.04, Math.min(d.sizeZ - 0.6, 2.0),
    mat(THREE, d.color, { roughness: 1 }), 0, 0.04, 0, false));
  g.add(box(THREE, 0.9, 0.42, 0.6, mat(THREE, 0x475569), 0.3, 0.27, 0.2));
}

// ---- Suíte: quarto completo + guarda-roupa com espelho
function furnishSuite(THREE, g, room) {
  furnishBedroom(THREE, g, room);
  g.add(box(THREE, 0.65, 2.0, 2.1, mat(THREE, 0x4a3f63), 2.05, 1.06, -1.15)); // guarda-roupa
  g.add(box(THREE, 0.05, 1.5, 0.7, mat(THREE, 0x93c5fd, { roughness: 0.15, metalness: 0.7 }), 1.7, 1.15, -1.15)); // espelho nas portas
}

// ---- Sala de Jantar: mesa com 4 cadeiras + pendente (dispositivo "light")
function furnishDining(THREE, g, room) {
  const tableMat = mat(THREE, 0x5b4636);
  g.add(box(THREE, 1.9, 0.09, 1.1, tableMat, 0, 0.78, 0)); // tampo
  [[-0.8, -0.4], [0.8, -0.4], [-0.8, 0.4], [0.8, 0.4]].forEach(([lx, lz]) =>
    g.add(box(THREE, 0.1, 0.74, 0.1, tableMat, lx, 0.39, lz)));
  const chairMat = mat(THREE, 0x475569);
  [[-0.55, -0.95], [0.55, -0.95], [-0.55, 0.95], [0.55, 0.95]].forEach(([cx, cz]) => {
    g.add(box(THREE, 0.42, 0.08, 0.42, chairMat, cx, 0.45, cz)); // assento
    g.add(box(THREE, 0.42, 0.55, 0.07, chairMat, cx, 0.75, cz + (cz > 0 ? 0.18 : -0.18))); // encosto
  });

  // pendente emissivo sobre a mesa (reage a dispositivos "light")
  g.add(box(THREE, 0.04, 0.7, 0.04, mat(THREE, 0x475569), 0, WALL_H - 0.4, 0, false)); // fio
  const shadeMat = mat(THREE, 0xfff1d6, { emissive: 0xffd9a0, emissiveIntensity: 0 });
  const shade = new THREE.Mesh(new THREE.ConeGeometry(0.36, 0.4, 24, 1, true), shadeMat);
  shade.position.set(0, WALL_H - 0.72, 0);
  g.add(shade);
  room.fx.lampShade = shadeMat;

  const pt = new THREE.PointLight(0xffd9a0, 0, 8, 2);
  pt.position.set(0, WALL_H - 0.85, 0);
  g.add(pt);
  room.lights.lamp = pt;

  const glowMat = mat(THREE, 0x1a2440, { emissive: 0xffc887, emissiveIntensity: 0 });
  g.add(box(THREE, room.def.sizeX - 0.3, 0.04, room.def.sizeZ - 0.3, glowMat, 0, WALL_H - 0.05, 0, false));
  room.fx.ceilingGlow = glowMat;
}

// ---- Banheiro: vaso, pia com cuba e box de vidro
function furnishBathroom(THREE, g, room) {
  g.add(box(THREE, 0.5, 0.42, 0.65, mat(THREE, 0xe2e8f0, { roughness: 0.3 }), -0.55, 0.27, 0.55)); // vaso
  g.add(box(THREE, 0.7, 0.78, 0.5, mat(THREE, 0x3c4763), 0.55, 0.45, -0.6)); // gabinete da pia
  g.add(box(THREE, 0.58, 0.08, 0.4, mat(THREE, 0xcbd5e1, { roughness: 0.25 }), 0.55, 0.88, -0.6)); // cuba
  const glassMat = new THREE.MeshBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.14, depthWrite: false });
  g.add(box(THREE, 0.04, 1.85, 0.95, glassMat, -0.95, 0.95, -0.6, false)); // box de vidro
  g.add(box(THREE, 0.3, 0.06, 0.3, mat(THREE, 0x94a3b8, { metalness: 0.6, roughness: 0.3 }), -1.35, 1.95, -0.6, false)); // chuveiro
}

// ---- Lavanderia: máquina de lavar, tanque e cesto
function furnishLaundry(THREE, g, room) {
  g.add(box(THREE, 0.75, 0.85, 0.7, mat(THREE, 0xcbd5e1, { roughness: 0.35, metalness: 0.3 }), -0.6, 0.48, -0.75)); // lavadora
  const door = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.23, 0.05, 20), mat(THREE, 0x0f172a, { roughness: 0.2 }));
  door.rotation.x = Math.PI / 2;
  door.position.set(-0.6, 0.5, -0.39);
  g.add(door);
  g.add(box(THREE, 0.7, 0.6, 0.55, mat(THREE, 0x3c4763), 0.55, 0.36, -0.8)); // tanque
  g.add(box(THREE, 0.5, 0.34, 0.4, mat(THREE, 0x64748b), 0.25, 0.23, 0.6)); // cesto de roupas
}

// ---- Escritório: escrivaninha, monitor emissivo, cadeira e estante
function furnishOffice(THREE, g, room) {
  const deskMat = mat(THREE, 0x4b3f30);
  g.add(box(THREE, 1.6, 0.07, 0.7, deskMat, -0.4, 0.76, -1.5));
  g.add(box(THREE, 0.08, 0.74, 0.6, deskMat, -1.1, 0.38, -1.5));
  g.add(box(THREE, 0.08, 0.74, 0.6, deskMat, 0.3, 0.38, -1.5));
  const scrMat = mat(THREE, 0x0f172a, { emissive: 0x38bdf8, emissiveIntensity: 0.35, roughness: 0.3 });
  g.add(box(THREE, 0.72, 0.42, 0.04, scrMat, -0.4, 1.12, -1.66));
  g.add(box(THREE, 0.06, 0.22, 0.06, mat(THREE, 0x334155), -0.4, 0.88, -1.66, false)); // pé do monitor
  g.add(box(THREE, 0.5, 0.5, 0.5, mat(THREE, 0x334155), 0.1, 0.31, -0.6)); // cadeira
  g.add(box(THREE, 0.9, 1.6, 0.32, mat(THREE, 0x475569), 1.5, 0.86, 1.5)); // estante
  g.add(box(THREE, 0.7, 0.06, 0.24, mat(THREE, 0xa78bfa, { roughness: 1 }), 1.5, 1.2, 1.5, false)); // livros
}

// ---- Varanda: mesinha redonda, 2 cadeiras e vasos de planta
function furnishBalcony(THREE, g, room) {
  const tableTop = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.05, 20), mat(THREE, 0x5b4636));
  tableTop.position.set(0, 0.62, 0);
  tableTop.castShadow = true;
  g.add(tableTop);
  g.add(box(THREE, 0.08, 0.6, 0.08, mat(THREE, 0x475569), 0, 0.31, 0));
  const chairMat = mat(THREE, 0x475569);
  [[-0.85, 0], [0.85, 0]].forEach(([cx, cz]) => {
    g.add(box(THREE, 0.4, 0.08, 0.4, chairMat, cx, 0.4, cz));
    g.add(box(THREE, 0.07, 0.4, 0.4, chairMat, cx + (cx > 0 ? 0.17 : -0.17), 0.62, cz));
  });
  [[-1.3, -0.7], [1.3, 0.7]].forEach(([px, pz]) => {
    g.add(box(THREE, 0.34, 0.3, 0.34, mat(THREE, 0x7c5a3a), px, 0.21, pz)); // vaso
    const bush = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 0), mat(THREE, 0x15803d, { roughness: 1 }));
    bush.position.set(px, 0.56, pz);
    bush.castShadow = true;
    g.add(bush);
  });
}

// ---- Garagem: silhueta de carro (corpo, cabine, rodas) + prateleira
function furnishGarage(THREE, g, room) {
  const carMat = mat(THREE, 0x7f2d3a, { roughness: 0.35, metalness: 0.4 });
  g.add(box(THREE, 1.85, 0.5, 3.4, carMat, 0, 0.5, 0)); // corpo
  g.add(box(THREE, 1.65, 0.45, 1.8, mat(THREE, 0x1e293b, { roughness: 0.15, metalness: 0.6 }), 0, 0.95, 0.15)); // cabine/vidros
  const wheelMat = mat(THREE, 0x0b1120, { roughness: 0.9 });
  [[-0.85, -1.1], [0.85, -1.1], [-0.85, 1.1], [0.85, 1.1]].forEach(([wx, wz]) => {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.2, 18), wheelMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(wx, 0.28, wz);
    wheel.castShadow = true;
    g.add(wheel);
  });
  g.add(box(THREE, 1.4, 1.5, 0.35, mat(THREE, 0x475569), -2.2, 0.81, -1.2)); // prateleira de ferramentas
}

// ---- Corredor: tapete runner + aparador
function furnishCorridor(THREE, g, room) {
  const d = room.def;
  const runner = d.sizeX >= d.sizeZ
    ? box(THREE, Math.min(d.sizeX - 0.5, 3.4), 0.03, Math.min(d.sizeZ - 0.5, 0.9), mat(THREE, d.color, { roughness: 1 }), 0, 0.03, 0, false)
    : box(THREE, Math.min(d.sizeX - 0.5, 0.9), 0.03, Math.min(d.sizeZ - 0.5, 3.4), mat(THREE, d.color, { roughness: 1 }), 0, 0.03, 0, false);
  g.add(runner);
  g.add(box(THREE, 1.0, 0.78, 0.3, mat(THREE, 0x475569), -0.9, 0.45, -(d.sizeZ / 2) + 0.35)); // aparador
  g.add(box(THREE, 0.26, 0.34, 0.26, mat(THREE, 0x15803d, { roughness: 1 }), -0.9, 0.98, -(d.sizeZ / 2) + 0.35)); // vaso sobre o aparador
}

// ---- Closet: armário aberto com arara, gaveteiro e espelho
function furnishCloset(THREE, g, room) {
  g.add(box(THREE, 1.7, 1.95, 0.5, mat(THREE, 0x4a3f63), 0, 1.03, -0.55)); // armário
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.5, 12), mat(THREE, 0x94a3b8, { metalness: 0.7, roughness: 0.3 }));
  rod.rotation.z = Math.PI / 2;
  rod.position.set(0, 1.6, -0.28);
  g.add(rod);
  const clothColors = [0x818cf8, 0xf472b6, 0x38bdf8, 0xfbbf24];
  clothColors.forEach((c, i) =>
    g.add(box(THREE, 0.22, 0.55, 0.08, mat(THREE, c, { roughness: 1 }), -0.55 + i * 0.36, 1.3, -0.28, false)));
  g.add(box(THREE, 0.7, 0.8, 0.45, mat(THREE, 0x475569), 0.4, 0.46, 0.55)); // gaveteiro
  g.add(box(THREE, 0.5, 1.4, 0.05, mat(THREE, 0x93c5fd, { roughness: 0.15, metalness: 0.7 }), -0.75, 0.95, 0.6)); // espelho
}

// ---- Despensa: prateleiras com potes e caixas
function furnishPantry(THREE, g, room) {
  const shelfMat = mat(THREE, 0x5b4636);
  for (let i = 0; i < 3; i++) {
    g.add(box(THREE, 1.2, 0.05, 0.38, shelfMat, 0, 0.45 + i * 0.5, -0.45));
  }
  const jarColors = [0xfbbf24, 0x4ade80, 0xf472b6, 0x94a3b8];
  jarColors.forEach((c, i) => {
    const jar = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.22, 12), mat(THREE, c, { roughness: 0.5 }));
    jar.position.set(-0.45 + i * 0.3, 0.59 + (i % 2) * 0.5, -0.45);
    jar.castShadow = true;
    g.add(jar);
  });
  g.add(box(THREE, 0.5, 0.4, 0.4, mat(THREE, 0x7c5a3a), 0.15, 0.26, 0.45)); // caixa de mantimentos
}

// ------------------------------------------------------------
// Estado dos dispositivos → visual
// ------------------------------------------------------------

export function applyDeviceState(device) {
  const room = rooms[device.room];
  if (!room) return;
  const s = device.status || {};

  if (device.type === 'light' && room.fx.lampShade) {
    const onOff = !!s.on;
    const b = Math.max(0, Math.min(100, Number(s.brightness ?? 70))) / 100;
    const color = s.color || '#ffd9a0';
    room.fx.lampShade.emissive.set(color);
    room.fx.lampShade.emissiveIntensity = onOff ? 0.4 + b * 1.3 : 0;
    room.lights.lamp.color.set(color);
    room.lights.lamp.intensity = onOff ? 0.5 + b * 1.2 : 0;
    room.fx.ceilingGlow.emissive.set(color);
    room.fx.ceilingGlow.emissiveIntensity = onOff ? 0.10 + b * 0.25 : 0;
  }

  if (device.type === 'ac') {
    const onOff = !!s.on;
    if (room.fx.acBody) {
      room.fx.acBody.emissiveIntensity = onOff ? 0.55 : 0;
      room.fx.acVent.emissiveIntensity = onOff ? 1.2 : 0;
      room.fx.airFlows.forEach((f) => { f.visible = onOff; });
    }
    // tom frio do ambiente — todo cômodo interno tem coolGlow desde a v1.4.0
    if (room.fx.coolGlow) room.fx.coolGlow.emissiveIntensity = onOff ? 0.22 : 0;
  }

  // TV (SmartThings): brilho sutil de tela no cômodo
  if (device.type === 'tv') {
    const glow = room.fx.ceilingGlow || room.fx.coolGlow;
    if (glow) {
      glow.emissive.set(0x93c5fd);
      glow.emissiveIntensity = s.on ? 0.12 : 0;
    }
  }

  if (device.type === 'valve' && room.fx.valveMat) {
    const open = s.open !== false;
    room.fx.valveMat.emissive.set(open ? 0x22c55e : 0xef4444);
    room.fx.valveMat.emissiveIntensity = open ? 0.6 : 0.9;
    room.fx.water.visible = open;
  }

  if (device.type === 'meter' && room.fx.meterPanel) {
    const w = Number(s.watts || 0);
    room.fx.meterPanel.emissiveIntensity = 0.2 + Math.min(1, w / 4500) * 1.1;
    room.fx.meterPanel.emissive.set(w > 4500 ? 0xef4444 : w > 3000 ? 0xf59e0b : 0x22d3ee);
    const h = 0.08 + Math.min(1, w / 4500) * 0.3;
    room.fx.meterBar.scale.y = h / 0.34;
    room.fx.meterBar.material.color.set(w > 4500 ? 0xef4444 : w > 3000 ? 0xf59e0b : 0x22d3ee);
  }
}

// ------------------------------------------------------------
// Seleção de cômodos + rótulos
// ------------------------------------------------------------

function handlePick(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  // com filtro de andar ativo, só o andar isolado é clicável
  const pickables = floorFilter === 'all'
    ? pickMeshes
    : pickMeshes.filter((m) => (m.userData.roomFloor ?? 0) === floorFilter);
  const hits = raycaster.intersectObjects(pickables, false);
  if (hits.length) {
    const name = hits[0].object.userData.roomName;
    selectRoom(selectedRoom === name ? null : name);
  } else {
    selectRoom(null);
  }
}

export function selectRoom(name) {
  selectedRoom = name;
  state.selectedRoom = name;
  Object.entries(rooms).forEach(([n, r]) => {
    r.highlight.visible = n === name;
    r.label.classList.toggle('room-label-active', n === name);
  });
  if (name && rooms[name]) {
    const p = rooms[name].group.position;
    desiredTarget = new window.THREE.Vector3(p.x, p.y + 0.7, p.z);
  }
  if (onRoomSelectCb) onRoomSelectCb(name);
  emit('room-selected', name);
}

function updateLabelBadges(devices) {
  const counts = {};
  devices.forEach((d) => {
    const active = (d.type === 'light' || d.type === 'ac') ? !!d.status?.on : null;
    if (active) counts[d.room] = (counts[d.room] || 0) + 1;
  });
  Object.entries(rooms).forEach(([n, r]) => {
    r.label.querySelector('.room-label-dot').style.opacity = counts[n] ? '1' : '0.25';
  });
}

function updateLabels() {
  const w = renderer.domElement.clientWidth;
  const h = renderer.domElement.clientHeight;
  const v = new window.THREE.Vector3();
  Object.values(rooms).forEach((r) => {
    if (!r.group.visible) { r.label.style.opacity = '0'; return; } // andar oculto pelo filtro
    v.setFromMatrixPosition(r.group.matrixWorld);
    v.y += WALL_H + 0.7;
    v.project(camera);
    const x = (v.x * 0.5 + 0.5) * w;
    const y = (-v.y * 0.5 + 0.5) * h;
    const behind = v.z > 1;
    r.label.style.opacity = behind ? '0' : '1';
    r.label.style.transform = `translate(-50%, -100%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  });
}

// ------------------------------------------------------------
// Loop de renderização
// ------------------------------------------------------------

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = Math.min(0.05, (now - clock.last) / 1000);
  clock.last = now;
  clock.t += dt;

  // deriva suave da câmera quando o usuário está inativo
  controls.autoRotate = now - lastInteraction > 7000;

  // aproxima o alvo da câmera do cômodo selecionado
  if (desiredTarget) {
    controls.target.lerp(desiredTarget, 0.06);
    if (controls.target.distanceTo(desiredTarget) < 0.05) desiredTarget = null;
  }

  // animações sutis contínuas (multiplicadas pelo fator "ghost" quando o
  // andar está semitransparente no modo Todos)
  Object.values(rooms).forEach((r) => {
    const k = r.ghost ?? 1;
    if (r.fx.water?.visible) {
      r.fx.water.material.opacity = (0.4 + Math.sin(clock.t * 5) * 0.15) * k;
      r.fx.valveWheel.rotation.z += dt * 0.8;
    }
    r.fx.airFlows?.forEach((f, i) => {
      if (f.visible) {
        f.material.opacity = (0.12 + 0.1 * Math.sin(clock.t * 3 + i * 1.4)) * k;
        f.position.y += Math.sin(clock.t * 2 + i) * 0.0006;
      }
    });
    if (r.highlight.visible) r.highlight.material.opacity = (0.08 + 0.05 * Math.sin(clock.t * 3)) * k;
  });

  controls.update();
  renderer.render(scene, camera);
  updateLabels();
}

function resize() {
  const w = container.clientWidth || window.innerWidth;
  const h = container.clientHeight || window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

const api = { applyDeviceState, selectRoom };
