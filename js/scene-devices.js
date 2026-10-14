// ============================================================
// NexusHome OS — Modelos 3D dos dispositivos (v2.8 · biblioteca v2.9)
// ------------------------------------------------------------
// Cada dispositivo posicionado vira um objeto 3D. O modelo vem da
// biblioteca (js/device-catalog.js) e é montado em METROS com a origem
// no PONTO DE FIXAÇÃO:
//   parede    origem na face da parede, base do aparelho; +z = para dentro do cômodo
//   teto      origem no teto; o aparelho pende para baixo (y negativo)
//   piso/móvel origem no apoio (piso ou tampo do móvel), centro da base
// scene3d.js posiciona na altura pos_y, gira por pos_rot e escala para a cena.
// update(device, t) reflete o estado (ligado, aberta, brilho...).
// ============================================================

import { catalogFor } from './device-catalog.js';
import { buildExtraModel, buildExtraLight } from './scene-devices-extra.js';

const lin = (THREE, hex) => new THREE.Color(hex).convertSRGBToLinear();

/** Qual modelo usar (modelo da biblioteca). Mantido para compatibilidade com v2.8. */
export function deviceModelKind(d) {
  const m = catalogFor(d).model;
  const legacy = { split: 'ac', ac_portatil: 'ac', smart_tv: 'tv', tv_wall: 'tv', plafon: 'light', pendant: 'light', lamp: 'light', led_strip: 'light', temp_sensor: 'sensor', presence: 'sensor', door_sensor: 'sensor' };
  return legacy[m] || m;
}

export function buildDeviceModel(THREE, d) {
  const entry = catalogFor(d);
  const g = new THREE.Group();
  const mats = [];
  const M = (hex, opts = {}) => {
    const m = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.08, ...opts, color: lin(THREE, hex) });
    if (opts.emissive !== undefined) m.emissive = lin(THREE, opts.emissive);
    mats.push(m);
    return m;
  };
  /** caixa: (w, h, d) com a base em y e o FUNDO em z (cresce para +z) quando back=true */
  const B = (w, h, dp, mat, x = 0, y = 0, z = 0, back = false) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, dp), mat);
    m.position.set(x, y + h / 2, back ? z + dp / 2 : z); m.castShadow = true; m.receiveShadow = true;
    g.add(m); return m;
  };
  const C = (r, h, mat, x = 0, y = 0, z = 0, seg = 18) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), mat);
    m.position.set(x, y + h / 2, z); m.castShadow = true;
    g.add(m); return m;
  };
  const ledMat = (hex, k = 0.8) => M(0x0b1120, { emissive: hex, emissiveIntensity: k });
  const isOn = (dev) => dev.is_online !== false && (dev.status?.on === true || dev.status?.open === true);
  let orb = 0.5;               // altura (m, relativa à origem) do indicador de estado
  let update = () => {};

  switch (entry.model) {
    case 'split': {                                         // split de parede
      B(0.9, 0.3, 0.22, M(0xf4f6f8, { roughness: 0.35 }), 0, 0, 0, true);
      const flap = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.02, 0.08), M(0xdfe3e8));
      flap.position.set(0, 0.02, 0.21); g.add(flap);
      const led = ledMat(0x38bdf8, 0);
      B(0.05, 0.015, 0.01, led, 0.32, 0.2, 0.225);
      const display = ledMat(0x38bdf8, 0);
      B(0.1, 0.035, 0.01, display, 0, 0.15, 0.225);
      const flowMat = new THREE.MeshBasicMaterial({ color: lin(THREE, 0x7dd3fc), transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
      const flow = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.9), flowMat);
      flow.rotation.x = -Math.PI / 3; flow.position.set(0, -0.3, 0.55); g.add(flow);
      orb = 0.5;
      update = (dev, t = 0) => {
        const on = !!dev.status?.on && dev.is_online !== false;
        flap.rotation.x = on ? -0.6 : 0;
        led.emissiveIntensity = on ? 1.4 : 0.15;
        display.emissiveIntensity = on ? 1 : 0;
        flowMat.opacity = on ? 0.12 + 0.06 * Math.sin(t * 3) : 0;
      };
      break;
    }
    case 'ac_portatil': {
      B(0.45, 0.75, 0.38, M(0xf4f6f8, { roughness: 0.35 }), 0, 0, 0);
      const grille = ledMat(0x38bdf8, 0);
      B(0.36, 0.08, 0.01, grille, 0, 0.62, 0.19);
      C(0.06, 0.5, M(0xcbd5e1), 0, 0.3, -0.25, 12).rotation.x = 0.6;
      orb = 0.95;
      update = (dev) => { grille.emissiveIntensity = dev.status?.on && dev.is_online !== false ? 1 : 0.1; };
      break;
    }
    case 'ceiling_fan': {
      C(0.015, 0.3, M(0x9aa7b8, { metalness: 0.6 }), 0, -0.3, 0, 8);
      C(0.09, 0.12, M(0xe5e7eb), 0, -0.42, 0);
      const rotor = new THREE.Group(); rotor.position.y = -0.38; g.add(rotor);
      const bladeMat = M(0xc49a6c);
      for (let i = 0; i < 4; i++) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.012, 0.12), bladeMat);
        b.position.set(Math.cos((i * Math.PI) / 2) * 0.33, 0, Math.sin((i * Math.PI) / 2) * 0.33);
        b.rotation.y = -(i * Math.PI) / 2; b.castShadow = true; rotor.add(b);
      }
      orb = -0.6;
      update = (dev, t = 0) => { rotor.rotation.y = dev.status?.on && dev.is_online !== false ? t * 6 : 0; };
      break;
    }
    case 'plafon': case 'pendant': case 'lamp': case 'led_strip':
    case 'spot': case 'sconce': case 'floor_lamp': case 'outdoor_light': case 'garden_light': {
      const bulb = M(0xfff7e0, { emissive: 0xffd9a0, emissiveIntensity: 0 });
      let lightY = -0.3, lightZ = entry.model === 'led_strip' ? 0.2 : 0;
      const extra = buildExtraLight({ THREE, g, M, B, C }, entry.model, bulb);   // luzes da v2.13
      if (extra) {
        lightY = extra.lightY; orb = extra.orb; lightZ = extra.offsetZ;
      } else if (entry.model === 'plafon') {
        const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.24, 0.06, 32), bulb);
        disc.position.y = -0.03; g.add(disc);
        lightY = -0.25; orb = -0.25;
      } else if (entry.model === 'pendant') {
        C(0.08, 0.03, M(0xe5e7eb), 0, -0.03, 0);
        C(0.006, 0.45, M(0x1f2937), 0, -0.48, 0, 6);
        const shade = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.18, 24, 1, true), M(0x1f2937, { roughness: 0.4, metalness: 0.3, side: THREE.DoubleSide }));
        shade.position.y = -0.55; shade.castShadow = true; g.add(shade);
        const b = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 12), bulb);
        b.position.y = -0.6; g.add(b);
        lightY = -0.65; orb = -0.85;
      } else if (entry.model === 'lamp') {
        C(0.08, 0.02, M(0x1f2937), 0, 0, 0);
        C(0.01, 0.3, M(0x9aa7b8, { metalness: 0.6 }), 0, 0.02, 0, 8);
        const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.15, 0.2, 24, 1, true), bulb);
        shade.position.y = 0.38; g.add(shade);
        lightY = 0.36; orb = 0.65;
      } else {                                              // fita LED na sanca
        B(1.6, 0.02, 0.03, bulb, 0, 0, 0, true);
        lightY = 0.0; orb = 0.25;
      }
      const pt = new THREE.PointLight(0xffd9a0, 0, 7, 2);
      pt.position.set(0, lightY, lightZ); g.add(pt);
      update = (dev) => {
        const s = dev.status || {};
        const on = !!s.on && dev.is_online !== false;
        const k = on ? 0.35 + (Number(s.brightness ?? 70) / 100) * 1.3 : 0;
        bulb.emissive.set(s.color || '#ffd9a0').convertSRGBToLinear();
        bulb.emissiveIntensity = k * 1.4;
        pt.color.set(s.color || '#ffd9a0');
        pt.intensity = k * 1.6;
      };
      break;
    }
    case 'switch': case 'plug': case 'dimmer': {
      B(0.09, 0.12, 0.012, M(0xf8fafc, { roughness: 0.4 }), 0, 0, 0, true);
      const led = ledMat(0x22c55e, 0.2);
      B(0.012, 0.012, 0.004, led, 0, entry.model === 'plug' ? 0.1 : 0.09, 0.014);
      if (entry.model === 'plug') { C(0.025, 0.006, M(0xe2e8f0), 0, 0.05, 0.014, 16).rotation.x = Math.PI / 2; }
      orb = 0.3;
      update = (dev) => { led.emissiveIntensity = isOn(dev) ? 1.2 : 0.15; };
      break;
    }
    case 'smart_tv': case 'tv_wall': {
      const wall = entry.model === 'tv_wall';
      if (!wall) { B(0.3, 0.02, 0.18, M(0x1f2937), 0, 0, 0); B(0.05, 0.08, 0.04, M(0x1f2937), 0, 0.02, 0); }
      const y0 = wall ? 0 : 0.1;
      const zf = wall ? 0.03 : 0;
      B(1.25, 0.74, 0.05, M(0x0b1120, { roughness: 0.3, metalness: 0.3 }), 0, y0, zf, wall);
      const screen = M(0x020617, { roughness: 0.15, emissive: 0x3b82f6, emissiveIntensity: 0 });
      B(1.19, 0.68, 0.01, screen, 0, y0 + 0.03, wall ? 0.085 : 0.03, false);
      const stand = ledMat(0xef4444, 0.6);
      B(0.02, 0.01, 0.01, stand, 0.55, y0 + 0.005, wall ? 0.085 : 0.03);
      orb = y0 + 0.95;
      update = (dev, t = 0) => {
        const on = !!dev.status?.on && dev.is_online !== false;
        screen.emissiveIntensity = on ? 0.55 + 0.12 * Math.sin(t * 2.3) : 0;
        stand.emissiveIntensity = on ? 0 : 0.6;
      };
      break;
    }
    case 'speaker': case 'hub': {
      const speaker = entry.model === 'speaker';
      if (speaker) C(0.07, 0.17, M(0x1f2937, { roughness: 0.8 }), 0, 0, 0, 24);
      else B(0.14, 0.04, 0.14, M(0xf8fafc, { roughness: 0.4 }), 0, 0, 0);
      const ring = ledMat(speaker ? 0x38bdf8 : 0x22c55e, 0.6);
      if (speaker) { const r = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.008, 6, 24), ring); r.rotation.x = Math.PI / 2; r.position.y = 0.17; g.add(r); }
      else B(0.02, 0.01, 0.01, ring, 0.04, 0.04, 0.07);
      orb = 0.4;
      update = (dev, t = 0) => { ring.emissiveIntensity = dev.is_online === false ? 0.05 : (isOn(dev) ? 0.9 + 0.3 * Math.sin(t * 4) : 0.4); };
      break;
    }
    case 'valve': {                                         // registro no cano rente à parede
      const pipe = M(0x9aa7b8, { metalness: 0.7, roughness: 0.3 });
      const h = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.6, 14), pipe);
      h.rotation.z = Math.PI / 2; h.position.set(0, 0, 0.05); g.add(h);
      B(0.14, 0.14, 0.14, M(0xb45309, { metalness: 0.6, roughness: 0.35 }), 0, -0.07, 0.05);
      const wheelMat = M(0x22c55e, { roughness: 0.5 });
      const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.015, 8, 20), wheelMat);
      wheel.position.set(0, 0, 0.19); g.add(wheel);
      orb = 0.35;
      update = (dev) => {
        const open = dev.status?.open !== false;
        wheelMat.color.copy(lin(THREE, open ? 0x22c55e : 0xef4444));
        wheel.rotation.z = open ? 0 : Math.PI / 2;
      };
      break;
    }
    case 'meter': case 'solar': case 'temp_sensor': {
      const small = entry.model === 'temp_sensor';
      const w = small ? 0.1 : 0.32, h = small ? 0.1 : 0.42;
      B(w, h, small ? 0.03 : 0.12, M(entry.model === 'solar' ? 0xe5e7eb : (small ? 0xf8fafc : 0xd1d5db), { roughness: 0.5 }), 0, 0, 0, true);
      const lcd = ledMat(entry.model === 'solar' ? 0xfacc15 : (small ? 0x2dd4bf : 0x22c55e), 0.9);
      B(w * 0.62, small ? 0.03 : 0.08, 0.01, lcd, 0, h * 0.62, small ? 0.033 : 0.123);
      orb = h + 0.25;
      update = (dev) => { lcd.emissiveIntensity = dev.is_online === false ? 0.05 : 0.9; };
      break;
    }
    case 'leak': {
      C(0.05, 0.03, M(0xf8fafc, { roughness: 0.4 }), 0, 0, 0, 20);
      const led = ledMat(0x22c55e, 0.8);
      C(0.008, 0.005, led, 0, 0.03, 0, 8);
      orb = 0.25;
      update = (dev) => {
        const alarm = !!(dev.status?.leak || dev.status?.alarm);
        led.emissive.copy(lin(THREE, alarm ? 0xef4444 : 0x22c55e));
        led.emissiveIntensity = dev.is_online === false ? 0.05 : (alarm ? 2 : 0.8);
      };
      break;
    }
    case 'level': {
      C(0.03, 1.2, M(0x94a3b8, { metalness: 0.4 }), 0, 0, 0, 10);
      B(0.12, 0.12, 0.12, M(0xf8fafc), 0, 1.2, 0);
      const led = ledMat(0x38bdf8, 0.8);
      B(0.03, 0.03, 0.01, led, 0, 1.28, 0.061);
      orb = 1.45;
      update = (dev) => { led.emissiveIntensity = dev.is_online === false ? 0.05 : 0.8; };
      break;
    }
    case 'lock': {
      B(0.07, 0.28, 0.05, M(0x1f2937, { metalness: 0.5, roughness: 0.3 }), 0, -0.14, 0, true);
      const pad = ledMat(0x38bdf8, 0.7);
      B(0.05, 0.08, 0.005, pad, 0, -0.02, 0.052);
      B(0.12, 0.02, 0.03, M(0x9aa7b8, { metalness: 0.7 }), -0.04, -0.12, 0.06);
      orb = 0.3;
      update = (dev) => {
        const locked = dev.status?.locked !== false && dev.status?.open !== true;
        pad.emissive.copy(lin(THREE, locked ? 0x22c55e : 0xf59e0b));
        pad.emissiveIntensity = dev.is_online === false ? 0.05 : 0.9;
      };
      break;
    }
    case 'camera': {
      B(0.06, 0.06, 0.12, M(0xe5e7eb), 0, -0.03, 0, true);
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.16, 16), M(0xf8fafc, { roughness: 0.35 }));
      body.rotation.x = Math.PI / 2 - 0.35; body.position.set(0, -0.05, 0.18); body.castShadow = true; g.add(body);
      const lens = ledMat(0x0ea5e9, 0.4);
      const l = new THREE.Mesh(new THREE.CircleGeometry(0.03, 16), lens);
      l.position.set(0, -0.08, 0.265); l.rotation.x = -0.35; g.add(l);
      orb = 0.25;
      update = (dev) => { lens.emissiveIntensity = dev.is_online === false ? 0.02 : 0.6; };
      break;
    }
    case 'door_sensor': case 'presence': {
      if (entry.model === 'presence') {
        const dome = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), M(0xf8fafc, { roughness: 0.3 }));
        dome.rotation.x = Math.PI / 2; dome.position.set(0, 0, 0); g.add(dome);
      } else {
        B(0.03, 0.08, 0.02, M(0xf8fafc), -0.03, 0, 0, true);
        B(0.03, 0.05, 0.02, M(0xf8fafc), 0.03, 0.015, 0, true);
      }
      const led = ledMat(0x2dd4bf, 0.8);
      B(0.01, 0.01, 0.005, led, 0, 0.04, 0.05);
      orb = 0.25;
      update = (dev) => { led.emissiveIntensity = dev.is_online === false ? 0.05 : (isOn(dev) ? 1.6 : 0.6); };
      break;
    }
    case 'curtain': {
      const w = Number(d.width) || 1.4;
      B(w, 0.04, 0.06, M(0xd1d5db, { metalness: 0.4 }), 0, 0, 0.06, true);           // trilho
      const fabric = M(0xe8e2d6, { roughness: 1, side: THREE.DoubleSide });
      const left = new THREE.Mesh(new THREE.BoxGeometry(1, 1.9, 0.02), fabric);
      const right = left.clone();
      [left, right].forEach((p) => { p.position.set(0, -0.95, 0.09); p.castShadow = true; g.add(p); });
      orb = 0.25;
      update = (dev) => {
        const open = dev.status?.open !== false && dev.status?.on !== false;   // aberta por padrão
        const pw = open ? w * 0.18 : w * 0.52;
        [left, right].forEach((p, i) => { p.scale.x = pw; p.position.x = (i ? 1 : -1) * (w / 2 - pw / 2); });
      };
      break;
    }
    default: {
      // biblioteca ampliada (v2.13): computadores, áudio, vídeo, eletrodomésticos, segurança...
      const extra = buildExtraModel({ THREE, g, M, B, C, ledMat, isOn, lin }, entry, d);
      if (extra) { orb = extra.orb; update = extra.update; break; }
      B(0.1, 0.1, 0.035, M(0xf8fafc, { roughness: 0.4 }), 0, 0, 0, true);
      const led = ledMat(0x2dd4bf, 0.8);
      B(0.01, 0.01, 0.005, led, 0.03, 0.07, 0.037);
      orb = 0.3;
      update = (dev) => { led.emissiveIntensity = dev.is_online === false ? 0.05 : 0.8; };
    }
  }
  return { group: g, orb, entry, kind: entry.model, update, dispose: () => mats.forEach((m) => m.dispose()) };
}
