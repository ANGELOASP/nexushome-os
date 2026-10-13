// ============================================================
// NexusHome OS — Modelos 3D dos dispositivos (v2.8)
// ------------------------------------------------------------
// Cada dispositivo posicionado na planta vira um objeto 3D no ponto
// marcado: ar-condicionado split na parede, luminária pendente, TV,
// válvula no cano, medidor, sensor... Montado em METROS com a origem
// no chão; +z = frente (scene3d.js gira o modelo para o centro do
// cômodo e escala para unidades de cena).
// update(device) reflete o estado (ligado, temperatura, aberta...).
// ============================================================

const lin = (THREE, hex) => new THREE.Color(hex).convertSRGBToLinear();

/** Qual modelo usar: tipo do dispositivo + modelo do fabricante (Tuya/Samsung). */
export function deviceModelKind(d) {
  const m = String(d?.model || '').toLowerCase();
  if (d?.type === 'ac') return 'ac';
  if (d?.type === 'tv') return 'tv';
  if (d?.type === 'light') return 'light';
  if (d?.type === 'valve' || m.includes('valve')) return 'valve';
  if (d?.type === 'meter') return 'meter';
  if (d?.type === 'solar') return 'solar';
  if (m.includes('leak') || m.includes('water_leak')) return 'leak';
  if (m.includes('level') || m.includes('tank')) return 'level';
  return 'sensor';
}

export function buildDeviceModel(THREE, d) {
  const g = new THREE.Group();
  const mats = [];
  const M = (hex, opts = {}) => {
    const m = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.08, ...opts, color: lin(THREE, hex) });
    if (opts.emissive !== undefined) m.emissive = lin(THREE, opts.emissive);
    mats.push(m);
    return m;
  };
  const B = (w, h, dp, mat, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, dp), mat);
    m.position.set(x, y + h / 2, z); m.castShadow = true; m.receiveShadow = true;
    g.add(m); return m;
  };
  const C = (r, h, mat, x = 0, y = 0, z = 0, seg = 18) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), mat);
    m.position.set(x, y + h / 2, z); m.castShadow = true;
    g.add(m); return m;
  };
  const kind = deviceModelKind(d);
  let top = 1;                 // altura (m) do topo do modelo — o indicador de estado fica acima
  let update = () => {};

  switch (kind) {
    case 'ac': {                                           // split de parede a 2,1 m
      const body = M(0xf4f6f8, { roughness: 0.35 });
      B(0.9, 0.3, 0.22, body, 0, 2.05, 0);
      const flap = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.02, 0.08), M(0xdfe3e8));
      flap.position.set(0, 2.06, 0.11); g.add(flap);
      const led = M(0x0b1120, { emissive: 0x38bdf8, emissiveIntensity: 0 });
      B(0.05, 0.015, 0.01, led, 0.32, 2.25, 0.111);
      const display = M(0x0b1120, { emissive: 0x38bdf8, emissiveIntensity: 0 });
      B(0.1, 0.035, 0.01, display, 0, 2.2, 0.111);
      const flowMat = new THREE.MeshBasicMaterial({ color: lin(THREE, 0x7dd3fc), transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
      const flow = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.9), flowMat);
      flow.rotation.x = -Math.PI / 3; flow.position.set(0, 1.75, 0.45); g.add(flow);
      top = 2.35;
      update = (dev, t = 0) => {
        const on = !!dev.status?.on && dev.is_online !== false;
        flap.rotation.x = on ? -0.6 : 0;
        led.emissiveIntensity = on ? 1.4 : 0.15;
        display.emissiveIntensity = on ? 1 : 0;
        flowMat.opacity = on ? 0.12 + 0.06 * Math.sin(t * 3) : 0;
      };
      break;
    }
    case 'light': {                                         // luminária pendente sob o teto
      C(0.08, 0.03, M(0xe5e7eb), 0, 2.47, 0);
      C(0.006, 0.45, M(0x1f2937), 0, 2.02, 0, 6);
      const shadeMat = M(0x1f2937, { roughness: 0.4, metalness: 0.3 });
      const shade = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.18, 24, 1, true), shadeMat);
      shade.position.set(0, 1.95, 0); shade.material.side = THREE.DoubleSide; shade.castShadow = true; g.add(shade);
      const bulb = M(0xfff7e0, { emissive: 0xffd9a0, emissiveIntensity: 0 });
      const b = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 12), bulb);
      b.position.set(0, 1.9, 0); g.add(b);
      const pt = new THREE.PointLight(0xffd9a0, 0, 7, 2);
      pt.position.set(0, 1.85, 0); g.add(pt);
      top = 2.5;
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
    case 'tv': {                                            // TV de parede a 1,25 m
      B(1.25, 0.74, 0.05, M(0x0b1120, { roughness: 0.3, metalness: 0.3 }), 0, 0.88, 0);
      const screen = M(0x020617, { roughness: 0.15, emissive: 0x3b82f6, emissiveIntensity: 0 });
      B(1.19, 0.68, 0.01, screen, 0, 0.91, 0.03);
      const led = M(0x0b1120, { emissive: 0xef4444, emissiveIntensity: 0.6 });
      B(0.02, 0.01, 0.01, led, 0.55, 0.885, 0.03);
      top = 1.65;
      update = (dev, t = 0) => {
        const on = !!dev.status?.on && dev.is_online !== false;
        screen.emissiveIntensity = on ? 0.55 + 0.12 * Math.sin(t * 2.3) : 0;
        led.emissiveIntensity = on ? 0 : 0.6;
      };
      break;
    }
    case 'valve': {                                         // registro no cano, perto do piso
      const pipe = M(0x9aa7b8, { metalness: 0.7, roughness: 0.3 });
      C(0.035, 0.9, pipe, 0, 0, 0);
      const h = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.5, 14), pipe);
      h.rotation.z = Math.PI / 2; h.position.set(0, 0.5, 0); g.add(h);
      B(0.14, 0.14, 0.14, M(0xb45309, { metalness: 0.6, roughness: 0.35 }), 0, 0.43, 0);
      const wheelMat = M(0x22c55e, { roughness: 0.5 });
      const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.015, 8, 20), wheelMat);
      wheel.position.set(0, 0.5, 0.12); g.add(wheel);
      C(0.012, 0.06, wheelMat, 0, 0.47, 0.09, 8);
      top = 0.95;
      update = (dev) => {
        const open = dev.status?.open !== false;
        wheelMat.color.copy(lin(THREE, open ? 0x22c55e : 0xef4444));
        wheel.rotation.z = open ? 0 : Math.PI / 2;
      };
      break;
    }
    case 'meter': case 'solar': {                           // caixa de medição na parede
      const solar = kind === 'solar';
      B(0.32, 0.42, 0.12, M(solar ? 0xe5e7eb : 0xd1d5db, { roughness: 0.5 }), 0, 1.25, 0);
      const lcd = M(0x052e16, { emissive: solar ? 0xfacc15 : 0x22c55e, emissiveIntensity: 0.9 });
      B(0.2, 0.08, 0.01, lcd, 0, 1.52, 0.061);
      B(0.06, 0.06, 0.01, M(0x1f2937), -0.08, 1.33, 0.061);
      top = 1.75;
      update = (dev) => { lcd.emissiveIntensity = dev.is_online === false ? 0.05 : 0.9; };
      break;
    }
    case 'leak': {                                          // sensor de vazamento no piso
      C(0.05, 0.03, M(0xf8fafc, { roughness: 0.4 }), 0, 0, 0, 20);
      const led = M(0x0b1120, { emissive: 0x22c55e, emissiveIntensity: 0.8 });
      C(0.008, 0.005, led, 0, 0.03, 0, 8);
      top = 0.25;
      update = (dev) => {
        const alarm = !!(dev.status?.leak || dev.status?.alarm);
        led.emissive.copy(lin(THREE, alarm ? 0xef4444 : 0x22c55e));
        led.emissiveIntensity = dev.is_online === false ? 0.05 : (alarm ? 2 : 0.8);
      };
      break;
    }
    case 'level': {                                         // sensor de nível (boia/ultrassom) com tubo
      C(0.03, 1.2, M(0x94a3b8, { metalness: 0.4 }), 0, 0, 0, 10);
      B(0.12, 0.12, 0.12, M(0xf8fafc), 0, 1.2, 0);
      const led = M(0x0b1120, { emissive: 0x38bdf8, emissiveIntensity: 0.8 });
      B(0.03, 0.03, 0.01, led, 0, 1.28, 0.061);
      top = 1.45;
      update = (dev) => { led.emissiveIntensity = dev.is_online === false ? 0.05 : 0.8; };
      break;
    }
    default: {                                              // sensor genérico na parede (temp./umidade/presença)
      B(0.1, 0.1, 0.035, M(0xf8fafc, { roughness: 0.4 }), 0, 1.5, 0);
      const led = M(0x0b1120, { emissive: 0x2dd4bf, emissiveIntensity: 0.8 });
      C(0.008, 0.01, led, 0.03, 1.57, 0.02, 8).rotation.x = Math.PI / 2;
      top = 1.75;
      update = (dev) => { led.emissiveIntensity = dev.is_online === false ? 0.05 : 0.8; };
    }
  }
  return { group: g, top, kind, update, dispose: () => mats.forEach((m) => m.dispose()) };
}
