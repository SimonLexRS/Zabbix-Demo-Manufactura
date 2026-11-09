// Shared procedural textures and materials (no external assets).
import * as THREE from 'three';

function canvasTex(w, h, draw, repeat = [1, 1]) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(...repeat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// Corrugated sheet: alternating light/dark stripes.
export function corrugated(base = '#c9ced3', dark = '#9ea6ad', stripes = 32, vertical = true) {
  return canvasTex(256, 256, (g, w, h) => {
    const grad = vertical ? g.createLinearGradient(0, 0, w / stripes, 0) : g.createLinearGradient(0, 0, 0, h / stripes);
    grad.addColorStop(0, base);
    grad.addColorStop(0.5, dark);
    grad.addColorStop(1, base);
    g.fillStyle = grad;
    for (let i = 0; i < stripes; i++) {
      g.save();
      if (vertical) g.translate((i * w) / stripes, 0);
      else g.translate(0, (i * h) / stripes);
      g.fillRect(0, 0, vertical ? w / stripes : w, vertical ? h : h / stripes);
      g.restore();
    }
  });
}

export function noiseTex(base, spots, amount = 900, size = 3, repeat = [1, 1]) {
  return canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < amount; i++) {
      g.fillStyle = spots[i % spots.length];
      g.globalAlpha = 0.25 + Math.random() * 0.35;
      g.fillRect(Math.random() * w, Math.random() * h, Math.random() * size + 1, Math.random() * size + 1);
    }
    g.globalAlpha = 1;
  }, repeat);
}

// Moving dashes along pipes/conveyors (offset animated each frame).
export function flowTex(color, bg = 'rgba(0,0,0,0)') {
  const t = canvasTex(128, 16, (g, w, h) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.fillStyle = color;
    g.fillRect(0, 0, w * 0.45, h);
  });
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function laneTex() {
  return canvasTex(64, 512, (g, w, h) => {
    g.fillStyle = '#3b3e42';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 2000; i++) {
      g.fillStyle = Math.random() > 0.5 ? '#45484d' : '#33363a';
      g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
    }
    g.fillStyle = '#e8e3d0';
    for (let y = 0; y < h; y += 64) g.fillRect(w / 2 - 1.5, y, 3, 34);
    g.fillStyle = '#f3f0e6';
    g.fillRect(2, 0, 2, h);
    g.fillRect(w - 4, 0, 2, h);
  });
}

const std = (o) => new THREE.MeshStandardMaterial(o);

export function createMaterials() {
  const roofGray = corrugated('#aab2b8', '#7f888f', 48);
  const roofRed = corrugated('#b4513a', '#8a3726', 48);
  const roofOrange = corrugated('#de6a2c', '#b14f1b', 48);
  const siloTex = corrugated('#d4d9dd', '#a7afb5', 40, false);
  const wallTex = corrugated('#dadcd8', '#b9bcb6', 64);
  return {
    grass: std({ map: noiseTex('#5c8a3c', ['#4d7a31', '#6c9a47', '#557f36'], 3000, 4, [40, 40]), roughness: 1 }),
    dirt: std({ map: noiseTex('#cdb894', ['#bba67f', '#d9c7a4', '#b59c74'], 2500, 3, [12, 24]), roughness: 1 }),
    concrete: std({ map: noiseTex('#b8b5ad', ['#a8a59d', '#c6c3bb'], 1500, 2, [8, 8]), roughness: 0.95 }),
    gravel: std({ map: noiseTex('#a39d90', ['#8f897c', '#b5afa2', '#7d776b'], 3000, 2, [4, 40]), roughness: 1 }),
    asphalt: std({ map: laneTex(), roughness: 0.9 }),
    riverbed: std({ map: noiseTex('#b9b7ad', ['#9c9a90', '#d2d0c6', '#8e8b80'], 4000, 3, [3, 30]), roughness: 1 }),
    water: new THREE.MeshStandardMaterial({ color: 0x4f8fa8, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.85 }),
    wall: std({ map: wallTex, color: 0xffffff, roughness: 0.8 }),
    wallWhite: std({ color: 0xf1f0ea, roughness: 0.8 }),
    roofGray: std({ map: roofGray, roughness: 0.55, metalness: 0.35, side: THREE.DoubleSide }),
    roofRed: std({ map: roofRed, roughness: 0.6, metalness: 0.2, side: THREE.DoubleSide }),
    roofOrange: std({ map: roofOrange, roughness: 0.6, metalness: 0.2, side: THREE.DoubleSide }),
    roofWhite: std({ color: 0xe9ebec, roughness: 0.6, side: THREE.DoubleSide }),
    silo: std({ map: siloTex, roughness: 0.35, metalness: 0.65 }),
    siloRoof: std({ color: 0xc3c9ce, roughness: 0.35, metalness: 0.7 }),
    tankWhite: std({ color: 0xf2f2ee, roughness: 0.45, metalness: 0.15 }),
    steel: std({ color: 0x5c6670, roughness: 0.5, metalness: 0.6 }),
    steelLight: std({ color: 0x9aa4ad, roughness: 0.4, metalness: 0.7 }),
    yellow: std({ color: 0xf2c230, roughness: 0.6 }),
    red: std({ color: 0xc23b2c, roughness: 0.5 }),
    redWhite: std({ map: corrugated('#c23b2c', '#f2f2ee', 10, false), roughness: 0.5 }),
    dark: std({ color: 0x2a2d31, roughness: 0.9 }),
    glass: std({ color: 0x8fb3c9, roughness: 0.1, metalness: 0.5 }),
    tire: std({ color: 0x1d1f22, roughness: 0.95 }),
    soy: std({ color: 0xd8b75a, roughness: 1 }),
    meal: std({ color: 0xc9a16a, roughness: 1 }),
    tarp: std({ color: 0x2f6b45, roughness: 0.9 }),
    stainless: std({ color: 0xd9dde0, roughness: 0.2, metalness: 0.9 }),
    grating: new THREE.MeshStandardMaterial({ color: 0x6d7780, roughness: 0.7, metalness: 0.5, transparent: true, opacity: 0.7 }),
    gaugeBg: new THREE.MeshBasicMaterial({ color: 0x1b2026 }),
    trunk: std({ color: 0x6b4b2e, roughness: 1 }),
    leaves: std({ color: 0x3f7a35, roughness: 1 }),
    leaves2: std({ color: 0x2f6a2d, roughness: 1 }),
    fence: std({ color: 0x8b9399, roughness: 0.6, metalness: 0.5 }),
    pipeOil: std({ color: 0xc98a1a, roughness: 0.4, metalness: 0.4 }),
    pipeHex: std({ color: 0xb33a3a, roughness: 0.4, metalness: 0.4 }),
    pipeSteam: std({ color: 0xd8dde0, roughness: 0.3, metalness: 0.6 }),
    smoke: new THREE.MeshBasicMaterial({ color: 0xdedede, transparent: true, opacity: 0.35, depthWrite: false }),
    select: new THREE.MeshBasicMaterial({ color: 0x29d3ff, transparent: true, opacity: 0.85, depthWrite: false }),
  };
}

export const LEVEL_COLORS = { ok: 0x2fbf71, warn: 0xf2a33a, high: 0xe5484d };
export function levelColor(pct) {
  if (pct > 95) return LEVEL_COLORS.high;
  if (pct > 85) return LEVEL_COLORS.warn;
  return LEVEL_COLORS.ok;
}
