// ============================================================
// NexusHome OS — Modelos 3D da biblioteca ampliada (v2.13)
// ------------------------------------------------------------
// Computadores, tablets, rede, áudio, vídeo, eletrodomésticos, segurança,
// acesso e as luzes novas. Mesmas convenções de scene-devices.js (metros,
// origem no ponto de fixação; parede → cresce para +z; teto → pende para -y).
// Recebe o "kit" do construtor (materiais e primitivas) e devolve
// { orb, update } — ou null se o modelo não é daqui.
// ============================================================

export function buildExtraModel(kit, entry, d) {
  const { THREE, g, M, B, C, ledMat, isOn, lin } = kit;
  const online = (dev) => dev.is_online !== false;
  const on = (dev) => online(dev) && isOn(dev);
  const plastic = (hex = 0x1f2937, o = {}) => M(hex, { roughness: 0.45, ...o });
  const white = () => M(0xf3f4f6, { roughness: 0.4 });
  const metal = (hex = 0x9aa7b8) => M(hex, { metalness: 0.6, roughness: 0.35 });
  const disc = (r, h, mat, y = 0, z = 0, seg = 24) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), mat);
    m.rotation.x = Math.PI / 2; m.position.set(0, y, z + h / 2); m.castShadow = true; g.add(m); return m;
  };
  /** tela com moldura; z0 = fundo da moldura (cresce para +z) */
  const screen = (w, h, depth, y, z0 = 0, frame = 0x0b1120) => {
    B(w, h, depth, M(frame, { roughness: 0.3, metalness: 0.3 }), 0, y, z0, true);
    const mat = M(0x020617, { roughness: 0.15, emissive: 0x60a5fa, emissiveIntensity: 0 });
    B(w * 0.92, h * 0.88, 0.004, mat, 0, y + h * 0.06, z0 + depth, true);
    return mat;
  };
  const glow = (mat, k) => { mat.emissiveIntensity = k; };
  const pulse = (t, f = 3) => 0.75 + 0.25 * Math.sin(t * f);
  /** luz de indicação (LED) que acende ligado e fica fraca desligado */
  const statusLed = (hex, x, y, z) => { const m = ledMat(hex, 0.2); B(0.012, 0.012, 0.004, m, x, y, z); return m; };
  const ledUpdate = (m, offK = 0.15) => (dev) => glow(m, !online(dev) ? 0.03 : (on(dev) ? 1.2 : offK));

  const model = entry.model;
  const pos_y = Number(d.pos_y ?? entry.y);
  switch (model) {
    // ---------------- computadores e rede ----------------
    case 'desktop_pc': {
      B(0.2, 0.45, 0.45, plastic(0x111827), 0, 0, 0);
      const led = ledMat(0x38bdf8, 0.2);
      B(0.008, 0.3, 0.004, led, -0.07, 0.08, 0.227);
      return { orb: 0.7, update: ledUpdate(led, 0.05) };
    }
    case 'all_in_one': case 'monitor': {
      const big = model === 'all_in_one';
      B(0.22, 0.015, 0.16, metal(0xcbd5e1), 0, 0, -0.02);
      B(0.04, big ? 0.16 : 0.12, 0.03, metal(0xcbd5e1), 0, 0.015, -0.06);
      const scr = screen(big ? 0.62 : 0.6, big ? 0.42 : 0.36, big ? 0.05 : 0.03, big ? 0.14 : 0.11, -0.05, big ? 0xe5e7eb : 0x0b1120);
      return { orb: 0.8, update: (dev, t = 0) => glow(scr, on(dev) ? 0.5 + 0.05 * Math.sin(t * 1.5) : 0) };
    }
    case 'notebook': {
      B(0.34, 0.018, 0.24, metal(0xcbd5e1), 0, 0, 0);
      const lid = new THREE.Group(); lid.position.set(0, 0.018, -0.12); g.add(lid);
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.23, 0.008), metal(0xcbd5e1));
      back.position.set(0, 0.115, 0); lid.add(back);
      const scr = M(0x020617, { emissive: 0x60a5fa, emissiveIntensity: 0 });
      const face = new THREE.Mesh(new THREE.PlaneGeometry(0.31, 0.2), scr);
      face.position.set(0, 0.115, 0.005); lid.add(face);
      lid.rotation.x = -0.25;
      return { orb: 0.45, update: (dev) => glow(scr, on(dev) ? 0.55 : 0) };
    }
    case 'tablet': case 'phone': {
      const tab = model === 'tablet';
      B(tab ? 0.14 : 0.08, 0.03, 0.08, plastic(0x374151), 0, 0, 0);          // suporte/base de carga
      const s = new THREE.Group(); s.position.set(0, 0.02, -0.01); s.rotation.x = -0.25; g.add(s);
      const body = new THREE.Mesh(new THREE.BoxGeometry(tab ? 0.25 : 0.075, tab ? 0.17 : 0.155, 0.008), plastic(0x111827));
      body.position.y = (tab ? 0.17 : 0.155) / 2; s.add(body);
      const scr = M(0x020617, { emissive: 0x93c5fd, emissiveIntensity: 0 });
      const face = new THREE.Mesh(new THREE.PlaneGeometry(tab ? 0.23 : 0.068, tab ? 0.15 : 0.14), scr);
      face.position.set(0, (tab ? 0.17 : 0.155) / 2, 0.0045); s.add(face);
      return { orb: 0.4, update: (dev) => glow(scr, !online(dev) ? 0 : (on(dev) ? 0.6 : 0.12)) };
    }
    case 'tablet_wall': case 'touch_panel': {
      const scr = screen(model === 'touch_panel' ? 0.13 : 0.26, model === 'touch_panel' ? 0.085 : 0.18, 0.015, 0, 0, 0x111827);
      return { orb: 0.35, update: (dev) => glow(scr, online(dev) ? 0.45 : 0.02) };
    }
    case 'printer': {
      B(0.42, 0.22, 0.36, white(), 0, 0, 0);
      B(0.3, 0.012, 0.18, plastic(0x9ca3af), 0, 0.22, 0.04);
      const led = statusLed(0x22c55e, 0.16, 0.18, 0.181);
      return { orb: 0.5, update: ledUpdate(led) };
    }
    case 'nas': {
      B(0.17, 0.22, 0.22, plastic(0x111827), 0, 0, 0);
      const leds = [0, 1, 2, 3].map((i) => statusLed(0x22c55e, -0.05 + i * 0.033, 0.17, 0.111));
      return { orb: 0.45, update: (dev, t = 0) => leds.forEach((m, i) => glow(m, online(dev) ? (Math.sin(t * 7 + i * 1.7) > 0.3 ? 1.4 : 0.3) : 0.03)) };
    }
    case 'router': {
      B(0.24, 0.04, 0.16, plastic(0x1f2937), 0, 0, 0);
      [-0.09, -0.03, 0.03, 0.09].forEach((x) => B(0.012, 0.16, 0.012, plastic(0x111827), x, 0.04, -0.07));
      const led = statusLed(0x38bdf8, 0, 0.025, 0.081);
      return { orb: 0.35, update: (dev, t = 0) => glow(led, online(dev) ? pulse(t, 5) : 0.03) };
    }
    case 'mesh_ap': {
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.04, 32), white());
      body.position.y = -0.02; g.add(body);
      const ring = ledMat(0x38bdf8, 0.6);
      const r = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.006, 6, 32), ring);
      r.rotation.x = Math.PI / 2; r.position.y = -0.042; g.add(r);
      return { orb: -0.25, update: (dev) => glow(ring, online(dev) ? 0.9 : 0.03) };
    }
    case 'network_rack': {
      B(0.56, 0.5, 0.4, plastic(0x111827), 0, 0, 0, true);
      const glass = M(0x334155, { transparent: true, opacity: 0.5, roughness: 0.1 });
      B(0.5, 0.44, 0.005, glass, 0, 0.03, 0.4, true);
      const leds = [0, 1, 2].map((i) => { const m = ledMat(0x22c55e, 0.6); B(0.36, 0.01, 0.004, m, 0, 0.12 + i * 0.1, 0.395); return m; });
      return { orb: 0.75, update: (dev, t = 0) => leds.forEach((m, i) => glow(m, online(dev) ? 0.4 + 0.5 * (Math.sin(t * 6 + i) > 0 ? 1 : 0) : 0.02)) };
    }
    case 'ir_blaster': {
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.03, 24), plastic(0x111827));
      body.position.y = 0.015; g.add(body);
      const led = ledMat(0xef4444, 0.3);
      B(0.012, 0.006, 0.004, led, 0, 0.012, 0.048);
      return { orb: 0.3, update: (dev, t = 0) => glow(led, online(dev) ? (Math.sin(t * 9) > 0.85 ? 1.5 : 0.2) : 0.02) };
    }
    // ---------------- áudio ----------------
    case 'soundbar': {
      B(0.9, 0.07, 0.1, M(0x1f2937, { roughness: 0.85 }), 0, 0, 0);
      const led = statusLed(0xffffff, 0.38, 0.05, 0.051);
      return { orb: 0.3, update: (dev, t = 0) => glow(led, !online(dev) ? 0.02 : (on(dev) && !dev.status?.muted ? 0.6 + 0.4 * Math.sin(t * 6) : 0.1)) };
    }
    case 'av_receiver': case 'streamer': {
      const rec = model === 'av_receiver';
      B(rec ? 0.43 : 0.2, rec ? 0.16 : 0.06, rec ? 0.38 : 0.2, rec ? plastic(0x111827) : plastic(0x374151), 0, 0, 0);
      const lcd = ledMat(0x38bdf8, 0.1);
      B(rec ? 0.16 : 0.06, rec ? 0.03 : 0.012, 0.004, lcd, 0, rec ? 0.09 : 0.035, (rec ? 0.38 : 0.2) / 2 + 0.002);
      if (rec) disc(0.03, 0.02, metal(0x6b7280), 0.08, 0.19, 24).position.x = 0.15;
      return { orb: rec ? 0.45 : 0.3, update: (dev) => glow(lcd, !online(dev) ? 0.02 : (on(dev) ? 1 : 0.08)) };
    }
    case 'bookshelf_speaker': case 'floor_speaker': case 'wall_speaker': case 'outdoor_speaker': {
      const dims = { bookshelf_speaker: [0.18, 0.3, 0.22], floor_speaker: [0.24, 1.0, 0.3], wall_speaker: [0.2, 0.3, 0.14], outdoor_speaker: [0.2, 0.3, 0.16] }[model];
      const [w, h, dp] = dims;
      const wall = model === 'wall_speaker' || model === 'outdoor_speaker';
      B(w, h, dp, model === 'outdoor_speaker' ? white() : M(0x3f2d20, { roughness: 0.6 }), 0, 0, 0, wall);
      const zf = wall ? dp : dp / 2;
      const cone = M(0x111827, { roughness: 0.9, emissive: 0x38bdf8, emissiveIntensity: 0 });
      disc(w * 0.32, 0.01, cone, h * 0.35, zf, 24);
      disc(w * 0.12, 0.01, M(0x111827), h * 0.78, zf, 16);
      return { orb: h + 0.2, update: (dev, t = 0) => glow(cone, on(dev) && !dev.status?.muted ? 0.08 + 0.08 * Math.sin(t * 8) : 0) };
    }
    case 'subwoofer': {
      B(0.35, 0.38, 0.35, M(0x111827, { roughness: 0.85 }), 0, 0, 0);
      const cone = M(0x0b0f19, { roughness: 0.9, emissive: 0x38bdf8, emissiveIntensity: 0 });
      disc(0.12, 0.01, cone, 0.19, 0.175, 28);
      return { orb: 0.6, update: (dev, t = 0) => glow(cone, on(dev) && !dev.status?.muted ? 0.1 + 0.1 * Math.abs(Math.sin(t * 5)) : 0) };
    }
    case 'ceiling_speaker': {
      const grill = M(0xf3f4f6, { roughness: 0.7, emissive: 0x38bdf8, emissiveIntensity: 0 });
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.012, 32), grill);
      m.position.y = -0.006; g.add(m);
      return { orb: -0.25, update: (dev, t = 0) => glow(grill, on(dev) && !dev.status?.muted ? 0.15 + 0.1 * Math.sin(t * 7) : 0) };
    }
    case 'turntable': {
      B(0.45, 0.1, 0.36, M(0x3f2d20, { roughness: 0.5 }), 0, 0, 0);
      const platter = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.015, 40), M(0x111827, { roughness: 0.3 }));
      platter.position.set(-0.05, 0.108, 0); g.add(platter);
      B(0.012, 0.012, 0.22, metal(), 0.15, 0.12, -0.03);
      return { orb: 0.4, update: (dev, t = 0) => { platter.rotation.y = on(dev) ? t * 3.5 : 0; } };
    }
    case 'smart_display': {
      B(0.18, 0.06, 0.1, M(0xd1d5db, { roughness: 0.8 }), 0, 0, 0);
      const s = new THREE.Group(); s.position.set(0, 0.05, 0.02); s.rotation.x = -0.35; g.add(s);
      const scr = M(0x020617, { emissive: 0xfcd34d, emissiveIntensity: 0 });
      const face = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.13, 0.012), scr);
      face.position.y = 0.065; s.add(face);
      return { orb: 0.4, update: (dev) => glow(scr, online(dev) ? (on(dev) ? 0.6 : 0.2) : 0.02) };
    }
    // ---------------- vídeo ----------------
    case 'projector': case 'projector_table': {
      const ceil = model === 'projector';
      const y0 = ceil ? -0.32 : 0;
      if (ceil) B(0.04, 0.2, 0.04, metal(), 0, -0.2, 0);
      B(0.32, 0.12, 0.26, white(), 0, y0, 0);
      const lens = M(0x0b1120, { emissive: 0xffffff, emissiveIntensity: 0 });
      disc(0.035, 0.02, lens, y0 + 0.06, 0.13, 20);
      const beamMat = new THREE.MeshBasicMaterial({ color: lin(THREE, 0xe0f2fe), transparent: true, opacity: 0, depthWrite: false });
      const beam = new THREE.Mesh(new THREE.ConeGeometry(0.5, 2.2, 24, 1, true), beamMat);
      beam.rotation.x = -Math.PI / 2; beam.position.set(0, y0 + 0.06, 0.15 + 1.1); g.add(beam);
      return { orb: ceil ? -0.6 : 0.35, update: (dev, t = 0) => { const k = on(dev); glow(lens, k ? 1.4 : 0); beamMat.opacity = k ? 0.05 + 0.01 * Math.sin(t * 2) : 0; } };
    }
    case 'projection_screen': {
      const w = 2.0;
      B(w + 0.1, 0.1, 0.1, white(), 0, 0, 0, true);                      // caixa da tela, no alto da parede
      const canvas = M(0xf8fafc, { roughness: 0.9, emissive: 0x93c5fd, emissiveIntensity: 0, side: THREE.DoubleSide });
      const sheet = new THREE.Mesh(new THREE.BoxGeometry(w, 1.3, 0.005), canvas);
      sheet.position.set(0, -0.65, 0.05); g.add(sheet);
      return { orb: 0.25, update: (dev) => {
        const down = on(dev);
        sheet.scale.y = down ? 1 : 0.02;
        sheet.position.y = down ? -0.65 : -0.01;
        glow(canvas, down ? 0.12 : 0);
      } };
    }
    case 'media_player': case 'console': case 'hdmi_matrix': {
      const dims = { media_player: [0.1, 0.035, 0.1], console: [0.39, 0.1, 0.26], hdmi_matrix: [0.44, 0.045, 0.2] }[model];
      const [w, h, dp] = dims;
      B(w, h, dp, model === 'console' ? white() : plastic(0x111827), 0, 0, 0);
      const led = statusLed(model === 'console' ? 0x3b82f6 : 0xffffff, w / 2 - 0.02, h * 0.45, dp / 2 + 0.002);
      return { orb: h + 0.25, update: (dev) => glow(led, !online(dev) ? 0.02 : (on(dev) ? 1.3 : 0.12)) };
    }
    // ---------------- eletrodomésticos ----------------
    case 'fridge': case 'washer': case 'dryer': case 'dishwasher': case 'oven': {
      const panel = pos_y > 0.05;                                         // sobre o móvel: só o painel inteligente
      const disp = ledMat(0x38bdf8, 0.1);
      if (panel) {
        B(0.16, 0.07, 0.012, plastic(0x111827), 0, 0, 0, true);
        B(0.12, 0.035, 0.004, disp, 0, 0.018, 0.012, true);
        return { orb: 0.3, update: (dev, t = 0) => glow(disp, !online(dev) ? 0.02 : (on(dev) ? 0.9 + 0.2 * Math.sin(t * 3) : 0.25)) };
      }
      const dims = { fridge: [0.7, 1.8, 0.7], washer: [0.6, 0.9, 0.65], dryer: [0.6, 0.85, 0.65], dishwasher: [0.6, 0.85, 0.6], oven: [0.6, 0.9, 0.6] }[model];
      const [w, h, dp] = dims;
      B(w, h, dp, M(model === 'oven' ? 0x1f2937 : 0xe5e7eb, { roughness: 0.35, metalness: 0.2 }), 0, 0, 0);
      B(0.16, 0.04, 0.004, disp, 0, h - 0.12, dp / 2 + 0.002);
      let drum = null;
      if (model === 'washer' || model === 'dryer') {
        drum = disc(0.2, 0.01, M(0x334155, { transparent: true, opacity: 0.85, roughness: 0.1 }), h * 0.45, dp / 2, 32);
      }
      if (model === 'fridge') B(0.02, 0.5, 0.03, metal(), w / 2 - 0.08, 1.0, dp / 2);
      return { orb: h + 0.2, update: (dev, t = 0) => {
        glow(disp, !online(dev) ? 0.02 : (on(dev) ? 1 : 0.25));
        if (drum) drum.rotation.y = on(dev) ? t * 8 : 0;
      } };
    }
    case 'microwave': {
      B(0.5, 0.3, 0.4, plastic(0x1f2937, { metalness: 0.3 }), 0, 0, 0);
      const win = M(0x111827, { emissive: 0xfbbf24, emissiveIntensity: 0 });
      B(0.3, 0.2, 0.004, win, -0.06, 0.05, 0.2);
      return { orb: 0.5, update: (dev) => glow(win, on(dev) ? 0.8 : 0) };
    }
    case 'coffee': case 'air_fryer': {
      const coffee = model === 'coffee';
      B(coffee ? 0.2 : 0.3, coffee ? 0.32 : 0.32, coffee ? 0.28 : 0.3, plastic(coffee ? 0x111827 : 0x1f2937), 0, 0, 0);
      const led = statusLed(coffee ? 0xf59e0b : 0xef4444, 0, 0.26, (coffee ? 0.28 : 0.3) / 2 + 0.002);
      return { orb: 0.55, update: ledUpdate(led) };
    }
    case 'range_hood': {
      B(0.9, 0.12, 0.5, metal(0xd1d5db), 0, 0, 0, true);
      B(0.28, 0.6, 0.25, metal(0xd1d5db), 0, 0.12, 0, true);
      const lamp = M(0xfff7e0, { emissive: 0xffe4b5, emissiveIntensity: 0 });
      B(0.2, 0.004, 0.08, lamp, 0, -0.002, 0.3);
      return { orb: 0.95, update: (dev) => glow(lamp, on(dev) ? 1.4 : 0) };
    }
    case 'robot_vacuum': {
      const bot = new THREE.Group(); g.add(bot);
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.09, 32), plastic(0x111827));
      body.position.y = 0.045; body.castShadow = true; bot.add(body);
      const top = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.02, 16), plastic(0x374151));
      top.position.set(0, 0.1, -0.05); bot.add(top);
      const led = ledMat(0x22c55e, 0.4);
      const l = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.006, 0.006), led); l.position.set(0, 0.092, 0.1); bot.add(l);
      B(0.32, 0.08, 0.12, white(), 0, 0, -0.32);                        // base de carga
      return { orb: 0.35, update: (dev, t = 0) => {
        const cleaning = online(dev) && dev.status?.state === 'cleaning';
        bot.position.set(cleaning ? Math.sin(t * 0.6) * 0.6 : 0, 0, cleaning ? Math.cos(t * 0.6) * 0.6 : 0);
        bot.rotation.y = cleaning ? t * 0.6 + Math.PI / 2 : 0;
        led.emissive.copy(lin(THREE, cleaning ? 0x38bdf8 : 0x22c55e));
        glow(led, online(dev) ? 1 : 0.03);
      } };
    }
    // ---------------- clima ----------------
    case 'floor_fan': {
      C(0.15, 0.03, metal(0x6b7280), 0, 0, 0, 24);
      C(0.015, 0.95, metal(), 0, 0.03, 0, 8);
      const head = new THREE.Group(); head.position.set(0, 1.05, 0); g.add(head);
      const cage = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.008, 6, 32), metal());
      head.add(cage);
      const rotor = new THREE.Group(); rotor.position.z = 0.02; head.add(rotor);
      const bm = plastic(0x93c5fd, { transparent: true, opacity: 0.85 });
      for (let i = 0; i < 3; i++) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.06, 0.005), bm);
        b.position.set(Math.cos(i * 2.094) * 0.09, Math.sin(i * 2.094) * 0.09, 0); b.rotation.z = i * 2.094; rotor.add(b);
      }
      return { orb: 1.45, update: (dev, t = 0) => { const k = on(dev); rotor.rotation.z = k ? t * 14 : 0; head.rotation.y = k ? Math.sin(t * 0.5) * 0.6 : 0; } };
    }
    case 'exhaust_fan': {
      B(0.3, 0.3, 0.05, white(), 0, 0, 0, true);
      const rotor = new THREE.Group(); rotor.position.set(0, 0.15, 0.055); g.add(rotor);
      const bm = plastic(0x9ca3af);
      for (let i = 0; i < 4; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.04, 0.004), bm); b.position.set(Math.cos(i * 1.571) * 0.055, Math.sin(i * 1.571) * 0.055, 0); b.rotation.z = i * 1.571; rotor.add(b); }
      return { orb: 0.5, update: (dev, t = 0) => { rotor.rotation.z = on(dev) ? t * 16 : 0; } };
    }
    case 'thermostat': {
      disc(0.05, 0.025, M(0xe5e7eb, { metalness: 0.4 }), 0.05, 0, 32);
      const face = M(0x0b1120, { emissive: 0xf97316, emissiveIntensity: 0.4 });
      disc(0.038, 0.004, face, 0.05, 0.025, 32);
      return { orb: 0.3, update: (dev) => {
        face.emissive.copy(lin(THREE, on(dev) ? 0xf97316 : 0x38bdf8));
        glow(face, online(dev) ? 0.7 : 0.03);
      } };
    }
    case 'air_purifier': case 'heater': {
      const pur = model === 'air_purifier';
      if (pur) C(0.13, 0.55, white(), 0, 0, 0, 32);
      else B(0.45, 0.6, 0.16, white(), 0, 0, 0);
      const led = ledMat(pur ? 0x22c55e : 0xf97316, 0.1);
      if (pur) { const r = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.008, 6, 28), led); r.rotation.x = Math.PI / 2; r.position.y = 0.556; g.add(r); }
      else B(0.35, 0.03, 0.004, led, 0, 0.5, 0.082);
      return { orb: 0.85, update: (dev, t = 0) => glow(led, !online(dev) ? 0.02 : (on(dev) ? (pur ? 1 : 0.9 + 0.3 * Math.sin(t * 2)) : 0.1)) };
    }
    case 'humidifier': {
      C(0.09, 0.22, white(), 0, 0, 0, 28);
      const mistMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
      const mist = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.35, 16, 1, true), mistMat);
      mist.rotation.x = Math.PI; mist.position.y = 0.4; g.add(mist);
      return { orb: 0.6, update: (dev, t = 0) => { mistMat.opacity = on(dev) ? 0.18 + 0.06 * Math.sin(t * 3) : 0; } };
    }
    // ---------------- água / energia ----------------
    case 'irrigation': {
      B(0.16, 0.2, 0.08, M(0x166534, { roughness: 0.5 }), 0, 0, 0, true);
      const led = statusLed(0x38bdf8, 0, 0.15, 0.081);
      return { orb: 0.45, update: (dev) => glow(led, !online(dev) ? 0.02 : (dev.status?.open ? 1.3 : 0.15)) };
    }
    case 'water_heater': {
      B(0.36, 0.6, 0.2, white(), 0, 0, 0, true);
      const flame = M(0x111827, { emissive: 0x38bdf8, emissiveIntensity: 0 });
      B(0.08, 0.04, 0.004, flame, 0, 0.42, 0.201);
      return { orb: 0.85, update: (dev) => glow(flame, on(dev) ? 1.2 : (online(dev) ? 0.1 : 0.02)) };
    }
    case 'pump': case 'ups': case 'battery': {
      const dims = { pump: [0.35, 0.3, 0.22], ups: [0.15, 0.3, 0.4], battery: [0.5, 0.9, 0.2] }[model];
      const [w, h, dp] = dims;
      B(w, h, dp, model === 'pump' ? M(0x1d4ed8, { metalness: 0.4 }) : (model === 'battery' ? white() : plastic(0x111827)), 0, 0, 0);
      if (model === 'pump') { const p = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.4, 12), metal()); p.rotation.z = Math.PI / 2; p.position.set(0, 0.2, 0); g.add(p); }
      const led = statusLed(model === 'battery' ? 0x22c55e : 0x38bdf8, 0, h * 0.8, dp / 2 + 0.002);
      return { orb: h + 0.2, update: (dev) => glow(led, !online(dev) ? 0.02 : (model === 'battery' || on(dev) ? 1.1 : 0.12)) };
    }
    case 'ev_charger': {
      B(0.24, 0.36, 0.12, M(0x111827, { roughness: 0.4 }), 0, 0, 0, true);
      const ring = ledMat(0x22c55e, 0.3);
      disc(0.05, 0.004, ring, 0.22, 0.12, 28);
      return { orb: 0.6, update: (dev, t = 0) => glow(ring, !online(dev) ? 0.02 : (on(dev) ? pulse(t, 2) : 0.25)) };
    }
    // ---------------- segurança ----------------
    case 'ptz_camera': {
      B(0.06, 0.04, 0.06, white(), 0, -0.04, 0);
      const dome = new THREE.Mesh(new THREE.SphereGeometry(0.075, 20, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), M(0x111827, { transparent: true, opacity: 0.85, roughness: 0.1 }));
      dome.position.y = -0.04; g.add(dome);
      const led = ledMat(0xef4444, 0.3);
      B(0.008, 0.008, 0.004, led, 0, -0.06, 0.07);
      return { orb: -0.3, update: (dev, t = 0) => { dome.rotation.y = online(dev) ? Math.sin(t * 0.4) * 1.2 : 0; glow(led, online(dev) ? 0.8 : 0.02); } };
    }
    case 'doorbell': case 'intercom': {
      const bell = model === 'doorbell';
      B(bell ? 0.05 : 0.13, bell ? 0.13 : 0.2, 0.025, plastic(0x111827), 0, 0, 0, true);
      const lens = ledMat(0x38bdf8, 0.3);
      disc(bell ? 0.012 : 0.015, 0.004, lens, bell ? 0.1 : 0.16, 0.025, 16);
      const btn = ledMat(0x38bdf8, 0.5);
      if (bell) disc(0.014, 0.004, btn, 0.03, 0.025, 20);
      else B(0.1, 0.07, 0.004, btn, 0, 0.06, 0.025, true);
      return { orb: 0.35, update: (dev, t = 0) => { const ring = !!dev.status?.ringing; glow(btn, !online(dev) ? 0.02 : (ring ? pulse(t, 10) * 1.6 : 0.5)); glow(lens, online(dev) ? 0.4 : 0.02); } };
    }
    case 'alarm_panel': case 'siren': {
      const siren = model === 'siren';
      B(siren ? 0.2 : 0.14, siren ? 0.2 : 0.18, siren ? 0.07 : 0.025, siren ? white() : plastic(0xe5e7eb), 0, 0, 0, true);
      const light = ledMat(siren ? 0xef4444 : 0x22c55e, 0.2);
      if (siren) disc(0.06, 0.03, light, 0.1, 0.07, 24);
      else B(0.1, 0.05, 0.004, light, 0, 0.11, 0.025, true);
      return { orb: 0.45, update: (dev, t = 0) => {
        const s = dev.status || {};
        const color = s.triggered ? 0xef4444 : s.armed === 'away' ? 0xef4444 : s.armed === 'home' ? 0xf59e0b : 0x22c55e;
        light.emissive.copy(lin(THREE, siren ? 0xef4444 : color));
        const k = s.triggered ? (Math.sin(t * 12) > 0 ? 2 : 0.1) : (siren ? 0.05 : 0.8);
        glow(light, online(dev) ? k : 0.02);
      } };
    }
    case 'smoke': case 'gas': case 'panic': {
      const led = ledMat(0x22c55e, 0.4);
      if (model === 'smoke') {
        const body = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.065, 0.04, 28), white());
        body.position.y = -0.02; g.add(body);
        const l = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.004, 0.01), led); l.position.set(0.03, -0.042, 0); g.add(l);
      } else if (model === 'gas') {
        B(0.08, 0.11, 0.035, white(), 0, 0, 0, true);
        B(0.01, 0.01, 0.004, led, 0.02, 0.085, 0.036);
      } else {
        B(0.08, 0.08, 0.02, white(), 0, 0, 0, true);
        disc(0.025, 0.012, M(0xdc2626, { roughness: 0.4 }), 0.04, 0.02, 20);
        B(0.008, 0.008, 0.004, led, 0.028, 0.068, 0.021);
      }
      return { orb: model === 'smoke' ? -0.25 : 0.3, update: (dev, t = 0) => {
        const s = dev.status || {};
        const alarm = !!(s.alarm || s.smoke || s.gas || s.pressed || s.triggered);
        led.emissive.copy(lin(THREE, alarm ? 0xef4444 : 0x22c55e));
        glow(led, !online(dev) ? 0.02 : (alarm ? (Math.sin(t * 12) > 0 ? 2 : 0.2) : 0.5));
      } };
    }
    // ---------------- conforto e acesso ----------------
    case 'blind': {
      const w = Number(d.width) || 1.4;
      B(w, 0.06, 0.07, white(), 0, 0, 0.04, true);
      const slats = M(0xe5e7eb, { roughness: 0.7, side: THREE.DoubleSide });
      const blind = new THREE.Mesh(new THREE.BoxGeometry(w * 0.98, 1, 0.01), slats);
      blind.position.set(0, -0.5, 0.08); g.add(blind);
      return { orb: 0.25, update: (dev) => {
        const open = dev.status?.open !== false;                         // aberta = recolhida
        const h = open ? 0.12 : 1.15;
        blind.scale.y = h; blind.position.y = -h / 2;
      } };
    }
    case 'awning': {
      B(2.2, 0.12, 0.14, M(0x9ca3af, { metalness: 0.4 }), 0, 0, 0, true);
      const cloth = M(0x0f766e, { roughness: 0.9, side: THREE.DoubleSide });
      const arm = new THREE.Group(); arm.position.set(0, 0.04, 0.12); g.add(arm);
      const sheet = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.01, 1.6), cloth);
      sheet.position.z = 0.8; arm.add(sheet);
      return { orb: 0.35, update: (dev) => {
        const out = dev.status?.open === true || dev.status?.on === true;
        arm.scale.z = out ? 1 : 0.02; arm.rotation.x = out ? 0.25 : 0;
      } };
    }
    case 'gate': {
      B(0.3, 0.3, 0.2, M(0x374151, { metalness: 0.3 }), 0, 0, 0);          // motor
      const leaf = new THREE.Group(); leaf.position.set(0.2, 0, 0); g.add(leaf);
      const bars = M(0x111827, { metalness: 0.5, roughness: 0.4 });
      const frame = new THREE.Mesh(new THREE.BoxGeometry(3.0, 1.8, 0.04), M(0x1f2937, { transparent: true, opacity: 0.35, metalness: 0.5 }));
      frame.position.set(1.5, 0.95, 0); leaf.add(frame);
      for (let i = 0; i <= 10; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.03, 1.8, 0.03), bars); b.position.set(i * 0.3, 0.95, 0); leaf.add(b); }
      const led = ledMat(0xf59e0b, 0.2);
      B(0.04, 0.04, 0.04, led, 0, 0.3, 0);
      return { orb: 0.65, update: (dev, t = 0) => {
        const open = dev.status?.open === true;
        leaf.position.x = 0.2 + (open ? -2.6 : 0);                        // portão deslizante
        glow(led, !online(dev) ? 0.02 : (dev.status?.moving ? (Math.sin(t * 8) > 0 ? 1.6 : 0.1) : (open ? 0.9 : 0.15)));
      } };
    }
    case 'garage_door': {
      const panel = M(0xe5e7eb, { roughness: 0.6, metalness: 0.2 });
      const door = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2.1, 0.05), panel);
      door.position.set(0, 1.05, 0.03); door.castShadow = true; g.add(door);
      B(0.3, 0.12, 0.3, plastic(0x374151), 0, 2.2, 0.3, false);            // motor no teto da garagem
      return { orb: 2.5, update: (dev) => {
        const open = dev.status?.open === true;
        door.scale.y = open ? 0.08 : 1; door.position.y = open ? 2.02 : 1.05;
      } };
    }
    default: return null;
  }
}

/** Luzes novas (v2.13): forma da luminária. Devolve { bulbMesh, lightY, orb, offsetZ } ou null. */
export function buildExtraLight(kit, model, bulb) {
  const { THREE, g, M, B, C } = kit;
  switch (model) {
    case 'spot': {
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.012, 24), M(0xe5e7eb, { metalness: 0.4 }));
      ring.position.y = -0.006; g.add(ring);
      const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.006, 20), bulb);
      lens.position.y = -0.013; g.add(lens);
      return { lightY: -0.15, orb: -0.2, offsetZ: 0 };
    }
    case 'sconce': {
      B(0.1, 0.18, 0.03, M(0x1f2937, { metalness: 0.4 }), 0, 0, 0, true);
      const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.16, 20, 1, true), bulb);
      shade.position.set(0, 0.09, 0.1); g.add(shade);
      return { lightY: 0.1, orb: 0.4, offsetZ: 0.15 };
    }
    case 'floor_lamp': {
      C(0.13, 0.02, M(0x1f2937), 0, 0, 0);
      C(0.012, 1.4, M(0x9aa7b8, { metalness: 0.6 }), 0, 0.02, 0, 8);
      const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, 0.26, 24, 1, true), bulb);
      shade.position.y = 1.5; g.add(shade);
      return { lightY: 1.45, orb: 1.85, offsetZ: 0 };
    }
    case 'outdoor_light': {
      B(0.08, 0.08, 0.06, M(0x111827), 0, 0, 0, true);
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.16, 0.06), M(0x111827));
      head.position.set(0, -0.02, 0.12); head.rotation.x = 0.5; g.add(head);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(0.19, 0.13), bulb);
      face.position.set(0, -0.035, 0.155); face.rotation.x = 0.5; g.add(face);
      return { lightY: -0.1, orb: 0.35, offsetZ: 0.3 };
    }
    case 'garden_light': {
      C(0.04, 0.45, M(0x111827, { metalness: 0.3 }), 0, 0, 0, 12);
      const top = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.045, 0.1, 16), bulb);
      top.position.y = 0.5; g.add(top);
      return { lightY: 0.5, orb: 0.8, offsetZ: 0 };
    }
    default: return null;
  }
}
