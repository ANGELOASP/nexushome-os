// ============================================================
// NexusHome OS — Motor 3D (Three.js r128 via CDN)
// Casa isométrica com 4 cômodos clicáveis que reagem ao estado
// dos dispositivos (luz, ar-condicionado, válvula, medidor).
// ============================================================

import { state, on, emit } from './state.js';

const ROOM_DEFS = [
  { name: 'Sala de Estar',    pos: [-3.05, 0,  3.05], outdoor: false },
  { name: 'Cozinha',          pos: [ 3.05, 0,  3.05], outdoor: false },
  { name: 'Quarto Principal', pos: [-3.05, 0, -3.05], outdoor: false },
  { name: 'Área Externa',     pos: [ 3.05, 0, -3.05], outdoor: true  },
];
const ROOM_SIZE = 5.7;
const WALL_H = 2.5;
const WALL_T = 0.16;

let scene, camera, renderer, controls, raycaster, pointer;
let container, labelRoot;
let onRoomSelectCb = null;
const rooms = {};           // nome -> { group, floor, walls[], highlight, label, lights:{}, fx:{} }
const pickMeshes = [];
let selectedRoom = null;
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
  ROOM_DEFS.forEach((def) => buildRoom(THREE, def));

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

  // base elevada da casa
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(ROOM_SIZE * 2 + 0.7, 0.28, ROOM_SIZE * 2 + 0.7),
    new THREE.MeshStandardMaterial({ color: 0x131c33, roughness: 0.9 })
  );
  base.position.y = 0.02;
  base.receiveShadow = true; base.castShadow = true;
  scene.add(base);
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
  g.position.set(def.pos[0], 0.16, def.pos[2]);
  scene.add(g);

  const room = { group: g, def, walls: [], lights: {}, fx: {}, floorMat: null, wallMats: [] };

  // piso
  const floorColor = def.outdoor ? 0x1b3a2a : 0x1a2440;
  const floorMat = mat(THREE, floorColor, { roughness: def.outdoor ? 1 : 0.7 });
  const floor = box(THREE, ROOM_SIZE, 0.12, ROOM_SIZE, floorMat, 0, 0, 0);
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
    const S = ROOM_SIZE / 2;
    // decide as paredes externas conforme o quadrante
    const backZ = def.pos[2] > 0 ? S : -S;   // parede no lado "de fora" em z
    const backX = def.pos[0] > 0 ? S : -S;   // parede no lado "de fora" em x
    mkWall(ROOM_SIZE + WALL_T, WALL_H, WALL_T, 0, WALL_H / 2, backZ);
    mkWall(WALL_T, WALL_H, ROOM_SIZE + WALL_T, backX, WALL_H / 2, 0);
    // meias paredes internas (para sugerir divisão sem fechar a vista)
    mkWall(ROOM_SIZE * 0.55, WALL_H * 0.55, WALL_T, -backX * 0.22, WALL_H * 0.275, -backZ, false);
  } else {
    // Área externa: cerca baixa em dois lados
    const fenceMat = mat(THREE, 0x2d3a55);
    const S = ROOM_SIZE / 2;
    const f1 = box(THREE, ROOM_SIZE, 0.7, 0.08, fenceMat, 0, 0.35, -S);
    const f2 = box(THREE, 0.08, 0.7, ROOM_SIZE, fenceMat, S, 0.35, 0);
    f1.userData.roomName = def.name; f2.userData.roomName = def.name;
    g.add(f1, f2); room.walls.push(f1, f2); pickMeshes.push(f1, f2);
  }

  // moldura de seleção (highlight)
  const hl = new THREE.Mesh(
    new THREE.BoxGeometry(ROOM_SIZE + 0.25, WALL_H + 0.4, ROOM_SIZE + 0.25),
    new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.1, depthWrite: false })
  );
  hl.position.y = (WALL_H + 0.4) / 2 - 0.1;
  hl.visible = false;
  g.add(hl);
  room.highlight = hl;

  // mobiliário específico do cômodo
  if (def.name === 'Sala de Estar') furnishLiving(THREE, g, room);
  if (def.name === 'Quarto Principal') furnishBedroom(THREE, g, room);
  if (def.name === 'Cozinha') furnishKitchen(THREE, g, room);
  if (def.name === 'Área Externa') furnishOutdoor(THREE, g, room);

  // rótulo flutuante (div sobreposta)
  const label = document.createElement('div');
  label.className = 'room-label';
  label.innerHTML = `<span class="room-label-dot"></span><span>${def.name}</span>`;
  labelRoot.appendChild(label);
  room.label = label;

  rooms[def.name] = room;
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
  const glow = box(THREE, ROOM_SIZE - 0.3, 0.04, ROOM_SIZE - 0.3, glowMat, 0, WALL_H - 0.05, 0, false);
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
  const cool = box(THREE, ROOM_SIZE - 0.3, 0.04, ROOM_SIZE - 0.3, coolMat, 0, WALL_H - 0.05, 0, false);
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

  if (device.type === 'ac' && room.fx.acBody) {
    const onOff = !!s.on;
    room.fx.acBody.emissiveIntensity = onOff ? 0.55 : 0;
    room.fx.acVent.emissiveIntensity = onOff ? 1.2 : 0;
    room.fx.coolGlow.emissiveIntensity = onOff ? 0.22 : 0;
    room.fx.airFlows.forEach((f) => { f.visible = onOff; });
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
  const hits = raycaster.intersectObjects(pickMeshes, false);
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
    desiredTarget = new window.THREE.Vector3(p.x, 0.8, p.z);
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

  // animações sutis contínuas
  const ext = rooms['Área Externa'];
  if (ext?.fx.water?.visible) {
    ext.fx.water.material.opacity = 0.4 + Math.sin(clock.t * 5) * 0.15;
    ext.fx.valveWheel.rotation.z += dt * 0.8;
  }
  const quarto = rooms['Quarto Principal'];
  quarto?.fx.airFlows?.forEach((f, i) => {
    if (f.visible) {
      f.material.opacity = 0.12 + 0.1 * Math.sin(clock.t * 3 + i * 1.4);
      f.position.y += Math.sin(clock.t * 2 + i) * 0.0006;
    }
  });
  Object.values(rooms).forEach((r) => {
    if (r.highlight.visible) r.highlight.material.opacity = 0.08 + 0.05 * Math.sin(clock.t * 3);
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
