// Low-poly procedural builders for every piece of the plant.
// Each builder returns a THREE.Group centred on the origin (ground at y = 0).
import * as THREE from 'three';

let M = null;
export function setMaterials(m) {
  M = m;
}

export function mesh(geo, mat, x = 0, y = 0, z = 0, { cast = true, receive = true } = {}) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = cast;
  m.receiveShadow = receive;
  return m;
}
export const box = (g, w, h, d, mat, x = 0, y = 0, z = 0, opts) => {
  const m = mesh(new THREE.BoxGeometry(w, h, d), mat, x, y, z, opts);
  g.add(m);
  return m;
};
export const cyl = (g, rt, rb, h, mat, x = 0, y = 0, z = 0, seg = 24, opts) => {
  const m = mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat, x, y, z, opts);
  g.add(m);
  return m;
};

// Gable roof prism: ridge along the longer side.
function gableRoof(w, d, rise, mat, overhang = 0.6) {
  const along = d >= w;
  const span = (along ? w : d) + overhang * 2;
  const len = (along ? d : w) + overhang * 2;
  const shape = new THREE.Shape();
  shape.moveTo(-span / 2, 0);
  shape.lineTo(span / 2, 0);
  shape.lineTo(0, rise);
  shape.lineTo(-span / 2, 0);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: len, bevelEnabled: false });
  geo.translate(0, 0, -len / 2);
  // Map corrugation across the roof.
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / 6, uv.getY(i) / 6);
  const m = mesh(geo, mat);
  if (!along) m.rotation.y = Math.PI / 2;
  return m;
}

// Hip roof (four slopes, ridge along the longer side).
function hipRoof(w, d, rise, mat, overhang = 0.8) {
  const W = w / 2 + overhang;
  const D = d / 2 + overhang;
  const ridge = Math.max(0, Math.max(W, D) - Math.min(W, D));
  const r = d >= w ? [0, ridge] : [ridge, 0];
  const A = [-W, 0, -D], B = [W, 0, -D], C = [W, 0, D], E = [-W, 0, D];
  const R1 = [-r[0], rise, -r[1]], R2 = [r[0], rise, r[1]];
  const tris = d >= w
    ? [A, R1, B, B, R1, R2, B, R2, C, C, R2, E, E, R2, R1, E, R1, A]
    : [A, R1, E, A, R2, R1, A, B, R2, B, C, R2, C, R1, R2, C, E, R1];
  const pos = new Float32Array(tris.flat());
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const uv = new Float32Array((pos.length / 3) * 2);
  for (let i = 0; i < pos.length / 3; i++) {
    uv[i * 2] = pos[i * 3] / 6;
    uv[i * 2 + 1] = pos[i * 3 + 2] / 6;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return mesh(geo, mat);
}

function roofMat(kind) {
  return { red: M.roofRed, orange: M.roofOrange, white: M.roofWhite, gray: M.roofGray }[kind] || M.roofGray;
}

// Vertical level gauge (dark track + coloured fill). Returns {group, set(pct, color)}.
export function gauge(height, width = 0.9) {
  const g = new THREE.Group();
  const bg = mesh(new THREE.BoxGeometry(width, height, 0.25), M.gaugeBg, 0, height / 2, 0, { cast: false });
  const fillMat = new THREE.MeshBasicMaterial({ color: 0x2fbf71 });
  const fill = mesh(new THREE.BoxGeometry(width * 0.7, 1, 0.3), fillMat, 0, 0, 0.02, { cast: false });
  g.add(bg, fill);
  return {
    group: g,
    set(pct, color) {
      const h = Math.max(0.05, (height - 0.3) * Math.min(1, Math.max(0, pct / 100)));
      fill.scale.y = h;
      fill.position.y = 0.15 + h / 2;
      fillMat.color.setHex(color);
    },
  };
}

export function building({ w, d, h, roof = 'gray', windows = true }) {
  const g = new THREE.Group();
  box(g, w, h, d, M.wall, 0, h / 2, 0);
  const r = gableRoof(w, d, Math.min(w, d) * 0.18, roofMat(roof));
  r.position.y = h;
  g.add(r);
  if (windows) {
    const n = Math.max(1, Math.floor(Math.max(w, d) / 4));
    const along = d >= w;
    for (let i = 0; i < n; i++) {
      const t = -0.5 + (i + 0.5) / n;
      if (along) {
        box(g, 0.1, 1.1, 1.6, M.glass, w / 2 + 0.05, h * 0.6, t * d, { cast: false });
        box(g, 0.1, 1.1, 1.6, M.glass, -w / 2 - 0.05, h * 0.6, t * d, { cast: false });
      } else {
        box(g, 1.6, 1.1, 0.1, M.glass, t * w, h * 0.6, d / 2 + 0.05, { cast: false });
        box(g, 1.6, 1.1, 0.1, M.glass, t * w, h * 0.6, -d / 2 - 0.05, { cast: false });
      }
    }
  }
  return g;
}

export function warehouse({ w, d, h, roof = 'gray', hip = true, doors = 2 }) {
  const g = new THREE.Group();
  box(g, w, h, d, M.wall, 0, h / 2, 0);
  const rise = Math.min(w, d) * 0.22;
  const r = hip ? hipRoof(w, d, rise, roof === 'mixed' ? M.roofGray : roofMat(roof)) : gableRoof(w, d, rise, roofMat(roof));
  r.position.y = h;
  g.add(r);
  if (roof === 'mixed') {
    // Patched roof sections in red, like the aerial photo.
    const p = hipRoof(w * 0.35, d * 0.9, rise * 0.98, M.roofRed, 0.2);
    p.position.set(w * 0.18, h + 0.05, 0);
    g.add(p);
  }
  // Big sliding doors on the long sides.
  const along = d >= w;
  for (let i = 0; i < doors; i++) {
    const t = doors === 1 ? 0 : -0.3 + (0.6 * i) / (doors - 1);
    if (along) box(g, 0.15, h * 0.6, 5, M.dark, w / 2 + 0.05, h * 0.3, t * d, { cast: false });
    else box(g, 5, h * 0.6, 0.15, M.dark, t * w, h * 0.3, d / 2 + 0.05, { cast: false });
  }
  return g;
}

export function silo({ r, h, small = false }) {
  const g = new THREE.Group();
  cyl(g, r, r, h, M.silo, 0, h / 2, 0, 40);
  const roofH = r * 0.45;
  cyl(g, 0.9, r * 1.05, roofH, M.siloRoof, 0, h + roofH / 2, 0, 40);
  cyl(g, 0.9, 0.9, 1.2, M.steelLight, 0, h + roofH + 0.6, 0, 12);
  // Concrete base ring and stiffener rings.
  cyl(g, r * 1.08, r * 1.12, 0.8, M.concrete, 0, 0.4, 0, 40);
  for (let y = h * 0.25; y < h; y += h * 0.25) cyl(g, r * 1.01, r * 1.01, 0.25, M.steelLight, 0, y, 0, 40, { cast: false });
  // Ladder.
  box(g, 0.7, h + roofH, 0.15, M.steel, 0, (h + roofH) / 2, r + 0.15, { cast: false });
  if (!small) {
    // Aeration fans at the base.
    box(g, 1.6, 1.6, 1.6, M.steel, r + 0.9, 0.8, 0);
    cyl(g, 0.7, 0.7, 0.2, M.dark, r + 1.75, 0.8, 0, 16).rotation.z = Math.PI / 2;
  }
  return g;
}

export function tank({ r, h, color = 'white' }) {
  const g = new THREE.Group();
  const mat = color === 'white' ? M.tankWhite : M.stainless;
  cyl(g, r, r, h, mat, 0, h / 2, 0, 32);
  const dome = mesh(new THREE.SphereGeometry(r, 32, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat);
  dome.scale.y = 0.18;
  dome.position.y = h;
  g.add(dome);
  // Handrail ring and stair.
  const rail = mesh(new THREE.TorusGeometry(r * 0.98, 0.06, 4, 32), M.steel, 0, h + 0.9, 0, { cast: false });
  rail.rotation.x = Math.PI / 2;
  g.add(rail);
  box(g, 0.6, h, 0.15, M.steel, 0, h / 2, r + 0.12, { cast: false });
  cyl(g, r + 0.6, r + 0.6, 0.4, M.concrete, 0, 0.2, 0, 32);
  return g;
}

export function extractionPlant({ w, d, h }) {
  const g = new THREE.Group();
  // Concrete slab + containment curb.
  box(g, w + 4, 0.3, d + 4, M.concrete, 0, 0.15, 0);
  // Steel structure: columns, beams and gratings on 4 levels.
  const cols = 4;
  const levels = 4;
  for (let i = 0; i < cols; i++)
    for (let j = 0; j < cols - 1; j++) {
      const x = -w / 2 + (i * w) / (cols - 1);
      const z = -d / 2 + (j * d) / (cols - 2);
      box(g, 0.5, h, 0.5, M.steel, x, h / 2, z);
    }
  for (let l = 1; l <= levels; l++) {
    const y = (l * h) / (levels + 0.4);
    box(g, w, 0.15, d, M.grating, 0, y, 0, { cast: false });
    box(g, w, 0.4, 0.3, M.yellow, 0, y + 0.6, d / 2, { cast: false });
    box(g, w, 0.4, 0.3, M.yellow, 0, y + 0.6, -d / 2, { cast: false });
  }
  // Extractor (horizontal loop extractor).
  const ext = cyl(g, 2.6, 2.6, w * 0.75, M.stainless, -1, h * 0.42, -2, 24);
  ext.rotation.z = Math.PI / 2;
  // Desolventizer-toaster (vertical) + dryer-cooler.
  cyl(g, 2.4, 2.4, h * 0.65, M.stainless, w * 0.28, h * 0.33, d * 0.22, 24);
  cyl(g, 2.0, 2.0, h * 0.35, M.stainless, -w * 0.3, h * 0.18, d * 0.25, 24);
  // Miscella distillation columns and condensers on top.
  cyl(g, 1.0, 1.0, h * 0.55, M.stainless, w * 0.32, h * 0.95, -d * 0.25, 16);
  cyl(g, 0.8, 0.8, h * 0.4, M.stainless, w * 0.18, h * 0.88, -d * 0.3, 16);
  for (let i = 0; i < 3; i++) {
    const c = cyl(g, 0.7, 0.7, 6, M.steelLight, -w * 0.25 + i * 2.2, h * 0.92, d * 0.05, 16);
    c.rotation.x = Math.PI / 2;
  }
  // Stair tower.
  box(g, 3, h * 1.05, 3, M.yellow, w / 2 + 2, h * 0.52, -d / 2 + 2, { cast: true });
  // Hazard sign.
  const sign = mesh(new THREE.BoxGeometry(2.2, 2.2, 0.1), M.yellow, -w / 2 - 2.2, 2.2, d / 2 + 2.05, { cast: false });
  sign.rotation.z = Math.PI / 4;
  g.add(sign);
  return g;
}

export function prepBuilding({ w, d, h }) {
  const g = building({ w, d, h, roof: 'red', windows: true });
  // Cyclones and aspiration ducts on the roof.
  for (let i = 0; i < 3; i++) {
    const x = -w * 0.3 + i * w * 0.3;
    cyl(g, 1.2, 1.2, 3, M.steelLight, x, h + d * 0.18 + 1.5, -d * 0.25, 16);
    cyl(g, 0.15, 1.2, 2.2, M.steelLight, x, h + d * 0.18 - 1.1, -d * 0.25, 16);
  }
  box(g, w * 0.8, 0.8, 0.8, M.steelLight, 0, h + d * 0.18 + 3.2, -d * 0.25);
  return g;
}

export function powerHouse({ w, d, h }) {
  const g = building({ w, d, h, roof: 'gray' });
  return g;
}

export function boiler() {
  const g = new THREE.Group();
  const shell = cyl(g, 2.3, 2.3, 9, M.stainless, 0, 2.8, 0, 24);
  shell.rotation.x = Math.PI / 2;
  box(g, 3.6, 1.2, 8, M.steel, 0, 0.6, 0);
  cyl(g, 0.5, 0.5, 2.6, M.steelLight, 0, 5.6, 2.5, 12);
  // Open shed roof.
  for (const [x, z] of [[-2.8, -5], [2.8, -5], [-2.8, 5], [2.8, 5]]) box(g, 0.3, 8, 0.3, M.steel, x, 4, z);
  box(g, 6.4, 0.3, 11, M.roofGray, 0, 8.1, 0);
  return g;
}

export function chimney({ r, h }) {
  const g = new THREE.Group();
  cyl(g, r * 0.75, r, h, M.redWhite, 0, h / 2, 0, 20);
  cyl(g, r * 1.3, r * 1.3, 1.2, M.concrete, 0, 0.6, 0, 20);
  return g;
}

export function coolingTower({ w, d, h }) {
  const g = new THREE.Group();
  box(g, w, h, d, M.wall, 0, h / 2, 0);
  const fans = [];
  for (let i = 0; i < 2; i++) {
    const x = -w / 4 + (i * w) / 2;
    cyl(g, 2.4, 2.4, 1.6, M.steel, x, h + 0.8, 0, 20);
    const fan = new THREE.Group();
    fan.position.set(x, h + 1.7, 0);
    for (let b = 0; b < 4; b++) {
      const blade = mesh(new THREE.BoxGeometry(4.2, 0.08, 0.6), M.dark, 0, 0, 0, { cast: false });
      blade.rotation.y = (b * Math.PI) / 4;
      fan.add(blade);
    }
    g.add(fan);
    fans.push(fan);
  }
  g.userData.fans = fans;
  return g;
}

export function bufferSilo({ r, h }) {
  const g = silo({ r, h });
  return g;
}

export function dryer({ w, d, h }) {
  const g = new THREE.Group();
  const louvre = M.silo;
  box(g, w, h, d, louvre, 0, h / 2, 0);
  box(g, w + 1, 2, d + 1, M.steel, 0, h + 1, 0);
  box(g, 2.5, 3, 2.5, M.red, w / 2 + 1.6, 1.5, 0);
  cyl(g, 0.5, 0.5, h * 0.5, M.steelLight, -w / 2 - 0.8, h * 0.75, 0, 12);
  return g;
}

export function noria({ h }) {
  const g = new THREE.Group();
  box(g, 1.6, h, 1.6, M.yellow, -0.9, h / 2, 0);
  box(g, 1.6, h, 1.6, M.yellow, 0.9, h / 2, 0);
  box(g, 4, 3, 3.2, M.steelLight, 0, h + 1.5, 0);
  box(g, 3, 1.2, 3, M.steel, 0, 0.6, 0);
  return g;
}

// Elevated conveyor gallery between two points (world coords, y heights).
export function gallery(a, b, width = 2.2, heightBox = 1.8) {
  const g = new THREE.Group();
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dy, dz);
  const body = mesh(new THREE.BoxGeometry(len, heightBox, width), M.steelLight);
  body.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  const dir = new THREE.Vector3(dx, dy, dz).normalize();
  body.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
  g.add(body);
  // Support trestles.
  const n = Math.max(1, Math.floor(len / 14));
  for (let i = 1; i <= n; i++) {
    const t = i / (n + 1);
    const x = a.x + dx * t;
    const y = a.y + dy * t;
    const z = a.z + dz * t;
    box(g, 0.5, y, 0.5, M.steel, x, y / 2, z);
  }
  return g;
}

export function hopper() {
  const g = new THREE.Group();
  box(g, 5, 0.12, 12, M.dark, 0, 0.07, 0, { cast: false });
  for (let i = -5; i <= 5; i += 1) box(g, 4.6, 0.05, 0.12, M.steelLight, 0, 0.15, i, { cast: false });
  for (const [x, z] of [[-3.5, -7], [3.5, -7], [-3.5, 7], [3.5, 7]]) box(g, 0.35, 8, 0.35, M.steel, x, 4, z);
  box(g, 8, 0.3, 15, M.roofGray, 0, 8.1, 0);
  return g;
}

export function scale() {
  const g = new THREE.Group();
  box(g, 4, 0.35, 18, M.concrete, 0, 0.17, 0, { cast: false });
  box(g, 3.6, 0.1, 17.6, M.steelLight, 0, 0.38, 0, { cast: false });
  // Indicator booth.
  box(g, 3, 3, 3, M.wallWhite, 4.5, 1.5, 0);
  box(g, 3.4, 0.25, 3.4, M.roofWhite, 4.5, 3.1, 0);
  box(g, 0.1, 1.1, 1.8, M.glass, 2.95, 1.9, 0, { cast: false });
  // Barrier.
  box(g, 0.3, 1.2, 0.3, M.yellow, 2.4, 0.6, -9.5);
  const arm = box(g, 0.15, 0.15, 4, M.redWhite, 2.4, 1.2, -11.5, { cast: false });
  g.userData.arm = arm;
  return g;
}

export function sampler() {
  const g = new THREE.Group();
  box(g, 4, 0.2, 14, M.concrete, 0, 0.1, 0, { cast: false });
  box(g, 0.6, 9, 0.6, M.steel, 4, 4.5, 0);
  const boom = new THREE.Group();
  boom.position.set(4, 8.5, 0);
  box(boom, 4.5, 0.6, 0.6, M.yellow, -2.2, 0, 0);
  const probe = box(boom, 0.25, 4, 0.25, M.stainless, -4.2, -2, 0, { cast: false });
  g.add(boom);
  g.userData.boom = boom;
  g.userData.probe = probe;
  box(g, 2.5, 2.6, 2.5, M.wallWhite, 6.2, 1.3, 2.5);
  return g;
}

export function loadingRack(kind = 'oil') {
  const g = new THREE.Group();
  box(g, 4, 0.2, 16, M.concrete, 0, 0.1, 0, { cast: false });
  for (const z of [-5, 5]) box(g, 0.5, 7, 0.5, M.steel, 3.5, 3.5, z);
  box(g, 0.6, 0.6, 12, M.steel, 3.5, 7, 0);
  box(g, 2, 0.15, 12, M.grating, 2.4, 5.6, 0, { cast: false });
  const arm = new THREE.Group();
  arm.position.set(3.2, 6.6, 0);
  box(arm, 2.8, 0.25, 0.25, kind === 'oil' ? M.pipeOil : M.steelLight, -1.4, 0, 0, { cast: false });
  box(arm, 0.25, 1.4, 0.25, kind === 'oil' ? M.pipeOil : M.steelLight, -2.8, -0.7, 0, { cast: false });
  g.add(arm);
  g.userData.arm = arm;
  if (kind === 'meal') {
    cyl(g, 1.8, 0.4, 3, M.steelLight, 0, 8.5, 0, 16);
    box(g, 0.5, 0.5, 14, M.steelLight, 0, 10.2, -7);
  }
  return g;
}

export function hexaneTank({ w, d }) {
  const g = new THREE.Group();
  // Containment dike.
  box(g, w, 0.2, d, M.concrete, 0, 0.1, 0, { cast: false });
  box(g, w, 1, 0.3, M.concrete, 0, 0.5, d / 2);
  box(g, w, 1, 0.3, M.concrete, 0, 0.5, -d / 2);
  box(g, 0.3, 1, d, M.concrete, w / 2, 0.5, 0);
  box(g, 0.3, 1, d, M.concrete, -w / 2, 0.5, 0);
  const t = cyl(g, 1.7, 1.7, w * 0.7, M.redWhite, 0, 2.4, -1, 20);
  t.rotation.z = Math.PI / 2;
  const t2 = cyl(g, 1.3, 1.3, w * 0.55, M.red, 0, 1.9, 2, 20);
  t2.rotation.z = Math.PI / 2;
  for (const x of [-w * 0.25, w * 0.25]) box(g, 0.6, 1.2, 4, M.concrete, x, 0.6, -1, { cast: false });
  return g;
}

export function gatehouse({ w, d, h }) {
  const g = new THREE.Group();
  box(g, w, h, d, M.wallWhite, 0, h / 2, 0);
  box(g, w + 1, 0.3, d + 1, M.roofWhite, 0, h + 0.15, 0);
  box(g, 0.1, 1.2, d * 0.6, M.glass, -w / 2 - 0.05, h * 0.6, 0, { cast: false });
  return g;
}

// ───────────── vehicles & people ─────────────
const CAB_COLORS = [0xf5f5f5, 0xc0392b, 0x2563a8, 0xe0a019, 0x2f7d4a, 0x8a8f96, 0x5b3a8c];

function wheels(g, xs, track = 1.25, r = 0.55) {
  for (const x of xs)
    for (const z of [-track, track]) {
      const wh = mesh(new THREE.CylinderGeometry(r, r, 0.45, 12), M.tire, x, r, z, { receive: false });
      wh.rotation.x = Math.PI / 2;
      g.add(wh);
    }
}

// Truck facing +X. Length ≈ 11 units.
export function truck(kind, seed = 0) {
  const g = new THREE.Group();
  const cabMat = new THREE.MeshStandardMaterial({ color: CAB_COLORS[seed % CAB_COLORS.length], roughness: 0.45, metalness: 0.3 });
  // Cab.
  box(g, 2.3, 2.6, 2.5, cabMat, 4.3, 2.0, 0);
  box(g, 0.1, 1.0, 2.2, M.glass, 5.46, 2.6, 0, { cast: false });
  box(g, 1.2, 0.6, 2.5, cabMat, 5.0, 0.9, 0, { cast: false });
  box(g, 10.5, 0.35, 1.6, M.dark, 0, 0.85, 0, { cast: false });
  let load = null;
  if (kind === 'soy') {
    // Open grain trailer.
    box(g, 7.6, 0.2, 2.5, M.steel, -1.2, 1.2, 0);
    box(g, 7.6, 1.8, 0.12, M.steelLight, -1.2, 2.2, 1.2);
    box(g, 7.6, 1.8, 0.12, M.steelLight, -1.2, 2.2, -1.2);
    box(g, 0.12, 1.8, 2.5, M.steelLight, 2.6, 2.2, 0);
    box(g, 0.12, 1.8, 2.5, M.steelLight, -5, 2.2, 0);
    load = mesh(new THREE.BoxGeometry(7.4, 1, 2.3), M.soy, -1.2, 2.2, 0, { cast: false });
    g.add(load);
  } else if (kind === 'oil') {
    const t = cyl(g, 1.25, 1.25, 7.6, M.stainless, -1.2, 2.45, 0, 20);
    t.rotation.z = Math.PI / 2;
    box(g, 6, 0.15, 0.6, M.grating, -1.2, 3.75, 0, { cast: false });
  } else if (kind === 'tow') {
    // Tow / service truck: yellow body with boom and a beacon bar on the cab.
    const yellow = new THREE.MeshStandardMaterial({ color: 0xf2b416, roughness: 0.5 });
    box(g, 6.5, 1.2, 2.5, yellow, -1.2, 1.5, 0);
    const boom = box(g, 5.5, 0.35, 0.35, M.steel, -2.2, 3.2, 0);
    boom.rotation.z = 0.35;
    box(g, 0.25, 1.4, 0.25, M.steel, -4.6, 2.2, 0, { cast: false });
  } else {
    box(g, 7.6, 2.4, 2.5, M.tarp, -1.2, 2.5, 0);
    box(g, 7.7, 0.3, 2.6, M.steel, -1.2, 1.25, 0, { cast: false });
  }
  wheels(g, [4.6, 3.1, -3.4, -4.6]);
  // Brake lights (rear) and hazard/beacon lamps: their materials are animated by plant.js.
  const brake = new THREE.MeshStandardMaterial({ color: 0x5a1010, emissive: 0xff2a1a, emissiveIntensity: 0 });
  const amber = new THREE.MeshStandardMaterial({ color: 0x6b4a10, emissive: 0xffa31a, emissiveIntensity: 0 });
  for (const z of [-1.05, 1.05]) {
    box(g, 0.08, 0.3, 0.45, brake, -5.12, 1.25, z, { cast: false });
    box(g, 0.1, 0.25, 0.25, amber, -5.12, 1.65, z, { cast: false });
    box(g, 0.1, 0.25, 0.25, amber, 5.62, 1.0, z, { cast: false });
  }
  if (kind === 'tow') box(g, 0.5, 0.3, 2.2, amber, 4.3, 3.45, 0, { cast: false });
  g.userData.load = load;
  g.userData.brakeMat = brake;
  g.userData.amberMat = amber;
  return g;
}

// Small electric service cart under a technician who is driving to a job.
export function cart() {
  const g = new THREE.Group();
  const green = new THREE.MeshStandardMaterial({ color: 0x18a35e, roughness: 0.5 });
  box(g, 2.6, 0.5, 1.5, green, 0, 0.55, 0);
  box(g, 0.1, 1.2, 1.4, M.steel, -0.9, 1.3, 0, { cast: false });
  box(g, 1.6, 0.08, 1.5, M.roofWhite, -0.2, 1.9, 0, { cast: false });
  for (const [x, z] of [[0.9, 0.7], [0.9, -0.7], [-0.9, 0.7], [-0.9, -0.7]]) {
    const w = mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.2, 10), M.tire, x, 0.3, z, { receive: false });
    w.rotation.x = Math.PI / 2;
    g.add(w);
  }
  return g;
}

export function person(helmet = 0xffd400, vest = 0xff7a00) {
  const g = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: 0x24456b, roughness: 0.8 });
  const vestM = new THREE.MeshStandardMaterial({ color: vest, roughness: 0.7, emissive: vest, emissiveIntensity: 0.15 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xc89a74, roughness: 0.8 });
  const helm = new THREE.MeshStandardMaterial({ color: helmet, roughness: 0.4 });
  const legs = new THREE.Group();
  box(legs, 0.25, 0.75, 0.22, body, 0, 0.375, -0.14);
  box(legs, 0.25, 0.75, 0.22, body, 0, 0.375, 0.14);
  g.add(legs);
  box(g, 0.34, 0.65, 0.58, vestM, 0, 1.08, 0);
  g.add(mesh(new THREE.SphereGeometry(0.19, 12, 8), skin, 0, 1.58, 0));
  const hat = mesh(new THREE.SphereGeometry(0.22, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), helm, 0, 1.64, 0);
  g.add(hat);
  g.scale.setScalar(1.25);
  g.userData.legs = legs;
  g.userData.hat = hat;
  g.userData.vest = vestM;
  return g;
}

// Warning triangle placed behind a crashed truck.
export function warningTriangle() {
  const m = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.1, 3), new THREE.MeshStandardMaterial({ color: 0xe5301a, emissive: 0xe5301a, emissiveIntensity: 0.4 }));
  m.position.y = 0.55;
  return m;
}

export function car(color) {
  const g = new THREE.Group();
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.5 });
  box(g, 3.6, 0.9, 1.7, m, 0, 0.75, 0);
  box(g, 1.9, 0.7, 1.5, M.glass, -0.2, 1.5, 0);
  wheels(g, [1.2, -1.2], 0.8, 0.35);
  return g;
}

export function tree(scale = 1, alt = false) {
  const g = new THREE.Group();
  box(g, 0.4, 2.2, 0.4, M.trunk, 0, 1.1, 0);
  const crown = mesh(new THREE.IcosahedronGeometry(2.2, 0), alt ? M.leaves2 : M.leaves, 0, 3.6, 0);
  crown.scale.set(1, 0.85, 1);
  g.add(crown);
  g.scale.setScalar(scale);
  return g;
}
