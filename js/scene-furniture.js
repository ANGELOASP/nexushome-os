// ============================================================
// NexusHome OS — Modelos 3D dos móveis do catálogo (js/furniture.js)
// ------------------------------------------------------------
// Cada modelo é montado em METROS com a origem no centro da pegada,
// no chão; +z = frente do móvel (lado marcado no editor de planta).
// scene3d.js escala o grupo para unidades de cena e aplica a rotação.
// Retorna { group, fx } — fx expõe materiais/luzes que reagem a
// dispositivos (ex.: luminária → lâmpada do cômodo).
// ============================================================

const C = {
  wood: 0x9a7350, woodLight: 0xc49a6c, woodDark: 0x5d4632,
  fabric: 0x5b6b8c, fabricLight: 0x7c8bab, linen: 0xe8e2d6, white: 0xeef1f5,
  metal: 0xcbd5e1, steel: 0x9aa7b8, dark: 0x1f2937, black: 0x0b1120, green: 0x3f8f4f,
  glass: 0x9ad8ff, red: 0x9f2a35,
};

export function buildFurnitureModel(THREE, kind) {
  const g = new THREE.Group();
  const fx = {};
  const mats = new Map();
  const mat = (color, opts = {}) => {
    const key = `${color}|${JSON.stringify(opts)}`;
    if (!mats.has(key)) {
      // a saída é sRGB (r128 trata o hex como linear): converte para a cor do catálogo não "lavar"
      const m = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.04, ...opts, color: new THREE.Color(color).convertSRGBToLinear() });
      if (opts.emissive !== undefined) m.emissive = new THREE.Color(opts.emissive).convertSRGBToLinear();
      mats.set(key, m);
    }
    return mats.get(key);
  };
  // caixa com a BASE em y (mais natural para móveis)
  const B = (w, h, d, color, x = 0, y = 0, z = 0, opts) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), typeof color === 'object' ? color : mat(color, opts));
    m.position.set(x, y + h / 2, z);
    m.castShadow = true; m.receiveShadow = true;
    g.add(m);
    return m;
  };
  const Cyl = (r, h, color, x, y, z, opts, seg = 20) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), typeof color === 'object' ? color : mat(color, opts));
    m.position.set(x, y + h / 2, z);
    m.castShadow = true; m.receiveShadow = true;
    g.add(m);
    return m;
  };
  const legs = (w, d, h, color, inset = 0.05, t = 0.05) => {
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sz]) =>
      B(t, h, t, color, sx * (w / 2 - inset), 0, sz * (d / 2 - inset)));
  };
  const chair = (x, z, faceZ) => {
    B(0.44, 0.05, 0.44, C.woodLight, x, 0.44, z);
    legs(0.44, 0.44, 0.44, C.woodDark, 0.04, 0.035);
    g.children.slice(-4).forEach((m) => { m.position.x += x; m.position.z += z; });
    B(0.44, 0.45, 0.05, C.woodLight, x, 0.49, z - faceZ * 0.2);
  };

  switch (kind) {
    case 'sofa': case 'poltrona': {
      const w = kind === 'sofa' ? 2.0 : 0.85;
      B(w - 0.3, 0.4, 0.75, C.fabric, 0, 0.02, 0.05);                      // assento
      B(w - 0.32, 0.12, 0.62, C.fabricLight, 0, 0.42, 0.1);                 // almofada
      B(w, 0.82, 0.2, C.fabric, 0, 0.02, -0.35);                            // encosto
      B(0.16, 0.62, 0.9, C.fabric, -(w / 2 - 0.08), 0.02, 0);               // braços
      B(0.16, 0.62, 0.9, C.fabric, (w / 2 - 0.08), 0.02, 0);
      break;
    }
    case 'mesa_centro':
      B(1.0, 0.05, 0.6, C.woodLight, 0, 0.35, 0);
      legs(1.0, 0.6, 0.35, C.woodDark);
      break;
    case 'rack_tv': {
      B(1.8, 0.45, 0.45, C.woodDark, 0, 0.05, 0);
      B(0.05, 0.05, 0.05, C.black, -0.8, 0, 0); B(0.05, 0.05, 0.05, C.black, 0.8, 0, 0);
      B(0.08, 0.12, 0.08, C.black, 0, 0.5, -0.05);                          // pé da TV
      const screen = mat(C.black, { roughness: 0.3, metalness: 0.2, emissive: 0x1d4ed8, emissiveIntensity: 0.12 });
      B(1.3, 0.76, 0.05, screen, 0, 0.62, -0.05);
      fx.tvScreen = screen;
      break;
    }
    case 'estante': {
      B(0.9, 1.8, 0.04, C.woodDark, 0, 0, -0.155);
      B(0.04, 1.8, 0.35, C.woodDark, -0.43, 0, 0); B(0.04, 1.8, 0.35, C.woodDark, 0.43, 0, 0);
      [0, 0.45, 0.9, 1.35, 1.76].forEach((y) => B(0.86, 0.04, 0.33, C.wood, 0, y, 0));
      [0x818cf8, 0xf472b6, 0x38bdf8, 0xfbbf24, 0x4ade80].forEach((c, i) =>
        B(0.1, 0.3, 0.22, c, -0.32 + i * 0.13, 0.94, 0, { roughness: 1 }));
      break;
    }
    case 'luminaria': {
      Cyl(0.16, 0.03, C.dark, 0, 0, 0);
      Cyl(0.015, 1.4, C.steel, 0, 0.03, 0, { metalness: 0.6, roughness: 0.3 });
      const shadeMat = mat(0xfff1d6, { emissive: 0xffd9a0, emissiveIntensity: 0 });
      const shade = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.3, 24, 1, true), shadeMat);
      shade.position.set(0, 1.5, 0);
      g.add(shade);
      const pt = new THREE.PointLight(0xffd9a0, 0, 6, 2);
      pt.position.set(0, 1.45, 0);
      pt.castShadow = true;
      g.add(pt);
      fx.lampShade = shadeMat; fx.lamp = pt;
      break;
    }
    case 'planta': {
      Cyl(0.16, 0.3, 0x7c5a3a, 0, 0, 0, { roughness: 0.9 });
      const leaves = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 1), mat(C.green, { roughness: 1, flatShading: true }));
      leaves.position.set(0, 0.7, 0); leaves.castShadow = true;
      g.add(leaves);
      break;
    }
    case 'cama_casal': case 'cama_solteiro': {
      const w = kind === 'cama_casal' ? 1.6 : 0.9, d = kind === 'cama_casal' ? 2.0 : 1.9;
      B(w, 0.28, d, C.woodDark, 0, 0.04, 0);                                // estrado
      B(w - 0.06, 0.22, d - 0.08, C.white, 0, 0.32, 0.02);                  // colchão
      B(w - 0.02, 0.08, d * 0.6, 0x7a8fb3, 0, 0.5, d * 0.18, { roughness: 1 }); // edredom
      B(w, 0.95, 0.08, C.wood, 0, 0, -d / 2 + 0.04);                        // cabeceira
      const pw = kind === 'cama_casal' ? 0.62 : 0.6;
      (kind === 'cama_casal' ? [-0.36, 0.36] : [0]).forEach((x) =>
        B(pw, 0.14, 0.38, C.linen, x, 0.54, -d / 2 + 0.32, { roughness: 1 }));
      break;
    }
    case 'criado':
      B(0.45, 0.5, 0.4, C.wood, 0, 0.05, 0);
      B(0.4, 0.02, 0.01, C.woodDark, 0, 0.32, 0.2);
      legs(0.45, 0.4, 0.05, C.woodDark, 0.03);
      break;
    case 'guarda_roupa': {
      B(1.8, 2.1, 0.6, C.woodLight, 0, 0, 0);
      [-0.6, 0, 0.6].forEach((x) => B(0.012, 1.98, 0.01, C.woodDark, x - 0.3, 0.06, 0.3));
      B(0.012, 1.98, 0.01, C.woodDark, 0.9 - 0.012, 0.06, 0.3);
      [-0.66, -0.06, 0.54].forEach((x) => B(0.02, 0.35, 0.03, C.steel, x, 0.9, 0.31, { metalness: 0.7, roughness: 0.3 }));
      break;
    }
    case 'comoda':
      B(1.0, 0.8, 0.5, C.wood, 0, 0.05, 0);
      [0.2, 0.45, 0.7].forEach((y) => B(0.9, 0.01, 0.01, C.woodDark, 0, y, 0.25));
      legs(1.0, 0.5, 0.05, C.woodDark, 0.04);
      break;
    case 'escrivaninha': {
      B(1.2, 0.04, 0.6, C.woodLight, 0, 0.71, 0);
      B(0.04, 0.71, 0.56, C.woodDark, -0.56, 0, 0); B(0.04, 0.71, 0.56, C.woodDark, 0.56, 0, 0);
      const scr = mat(C.black, { emissive: 0x38bdf8, emissiveIntensity: 0.3, roughness: 0.3 });
      B(0.6, 0.36, 0.03, scr, 0, 0.88, -0.2);
      B(0.05, 0.13, 0.05, C.dark, 0, 0.75, -0.2);
      break;
    }
    case 'mesa_jantar': {
      B(1.6, 0.05, 0.9, C.woodLight, 0, 0.72, 0);
      legs(1.6, 0.9, 0.72, C.woodDark, 0.08, 0.06);
      [[-0.4, 0.62, -1], [0.4, 0.62, -1], [-0.4, -0.62, 1], [0.4, -0.62, 1]].forEach(([x, z, f]) => chair(x, z, f));
      break;
    }
    case 'cadeira': chair(0, 0, 1); break;
    case 'geladeira': {
      B(0.7, 1.8, 0.68, C.metal, 0, 0, 0, { metalness: 0.45, roughness: 0.35 });
      B(0.68, 0.01, 0.01, C.steel, 0, 1.15, 0.345);
      B(0.03, 0.4, 0.03, C.dark, -0.28, 1.25, 0.35); B(0.03, 0.4, 0.03, C.dark, -0.28, 0.6, 0.35);
      break;
    }
    case 'fogao': {
      B(0.6, 0.86, 0.6, C.white, 0, 0, 0, { roughness: 0.4 });
      B(0.58, 0.02, 0.58, C.black, 0, 0.86, 0, { roughness: 0.3 });
      [[-0.14, -0.14], [0.14, -0.14], [-0.14, 0.14], [0.14, 0.14]].forEach(([x, z]) => Cyl(0.07, 0.015, C.dark, x, 0.88, z));
      B(0.5, 0.36, 0.01, C.black, 0, 0.3, 0.3, { roughness: 0.2 });
      break;
    }
    case 'bancada': {
      B(1.6, 0.86, 0.58, C.white, 0, 0, 0, { roughness: 0.6 });
      B(1.62, 0.04, 0.62, 0x3f3f46, 0, 0.86, 0, { roughness: 0.35 });
      B(0.5, 0.02, 0.36, C.steel, 0.35, 0.89, 0, { metalness: 0.7, roughness: 0.25 });
      Cyl(0.015, 0.28, C.steel, 0.35, 0.9, -0.2, { metalness: 0.7, roughness: 0.25 });
      [-0.6, -0.2, 0.2, 0.6].forEach((x) => B(0.012, 0.7, 0.01, 0xcbd5e1, x, 0.08, 0.29));
      break;
    }
    case 'armario':
      B(0.8, 2.0, 0.5, C.white, 0, 0, 0, { roughness: 0.55 });
      B(0.012, 1.9, 0.01, 0xcbd5e1, 0, 0.05, 0.25);
      break;
    case 'vaso': {
      B(0.36, 0.4, 0.5, C.white, 0, 0, 0.06, { roughness: 0.3 });
      B(0.38, 0.06, 0.48, C.white, 0, 0.4, 0.07, { roughness: 0.25 });
      B(0.4, 0.38, 0.17, C.white, 0, 0.36, -0.24, { roughness: 0.3 });
      break;
    }
    case 'pia_banheiro': {
      B(0.6, 0.78, 0.45, C.wood, 0, 0, 0);
      B(0.6, 0.06, 0.46, C.white, 0, 0.78, 0, { roughness: 0.3 });
      Cyl(0.015, 0.2, C.steel, 0, 0.84, -0.16, { metalness: 0.7, roughness: 0.25 });
      B(0.55, 0.7, 0.02, 0xbfe3ff, 0, 1.15, -0.22, { roughness: 0.08, metalness: 0.8 });   // espelho
      break;
    }
    case 'chuveiro': {
      B(0.9, 0.05, 0.9, C.white, 0, 0, 0, { roughness: 0.4 });
      const glass = new THREE.MeshStandardMaterial({ color: C.glass, transparent: true, opacity: 0.18, roughness: 0.05, depthWrite: false });
      B(0.9, 1.95, 0.02, glass, 0, 0.05, 0.44).castShadow = false;
      B(0.02, 1.95, 0.9, glass, 0.44, 0.05, 0).castShadow = false;
      Cyl(0.1, 0.02, C.steel, -0.25, 1.95, -0.25, { metalness: 0.7, roughness: 0.25 });
      break;
    }
    case 'maquina_lavar': {
      B(0.6, 0.86, 0.62, C.white, 0, 0, 0, { roughness: 0.35 });
      const door = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.03, 24), mat(C.dark, { roughness: 0.15, metalness: 0.4 }));
      door.rotation.x = Math.PI / 2; door.position.set(0, 0.42, 0.32);
      g.add(door);
      B(0.5, 0.06, 0.02, C.steel, 0, 0.74, 0.31);
      break;
    }
    case 'tanque':
      B(0.6, 0.8, 0.55, 0xd1d5db, 0, 0, 0, { roughness: 0.5 });
      B(0.5, 0.02, 0.4, 0x94a3b8, 0, 0.8, 0.02);
      break;
    case 'carro': {
      const body = mat(C.red, { roughness: 0.3, metalness: 0.45 });
      B(1.8, 0.55, 4.2, body, 0, 0.25, 0);
      B(1.6, 0.5, 2.1, C.dark, 0, 0.8, -0.2, { roughness: 0.1, metalness: 0.6 });
      [[-0.82, 1.35], [0.82, 1.35], [-0.82, -1.35], [0.82, -1.35]].forEach(([x, z]) => {
        const w = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.22, 20), mat(C.black, { roughness: 0.9 }));
        w.rotation.z = Math.PI / 2; w.position.set(x, 0.32, z); w.castShadow = true;
        g.add(w);
      });
      break;
    }
    case 'mesa_externa': {
      Cyl(0.42, 0.04, C.woodLight, 0, 0.72, 0);
      Cyl(0.04, 0.72, C.dark, 0, 0, 0);
      chair(0, 0.65, -1); chair(0, -0.65, 1);
      break;
    }
    default:
      B(0.5, 0.5, 0.5, C.steel, 0, 0, 0);
  }
  return { group: g, fx };
}
