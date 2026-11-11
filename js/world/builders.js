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

// ───────────── monitoring room ─────────────
// Offices with the monitoring room: glass walls, a video wall on the north wall (facing +z),
// an operator console and chairs. `screens`: 3 materials for the video wall (dashboard).
// userData.roofMats / roofMeshes let the view fade the roof so the room can be seen from outside.
export function controlRoom({ w, d, h }, screens) {
  const g = new THREE.Group();
  const floor = new THREE.MeshStandardMaterial({ color: 0x8d949b, roughness: 0.85 });
  const wallM = new THREE.MeshStandardMaterial({ color: 0xe9e8e2, roughness: 0.8 });
  const frame = new THREE.MeshStandardMaterial({ color: 0x3a3f45, roughness: 0.5, metalness: 0.4 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x9cc3d6, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.28, depthWrite: false });
  const deskM = new THREE.MeshStandardMaterial({ color: 0xd9d4c7, roughness: 0.6 });
  const chairM = new THREE.MeshStandardMaterial({ color: 0x22262b, roughness: 0.7 });
  const roofM = new THREE.MeshStandardMaterial({ color: 0xb4513a, roughness: 0.7, transparent: true, opacity: 1 });
  const hw = w / 2;
  const hd = d / 2;
  box(g, w + 0.6, 0.25, d + 0.6, floor, 0, 0.12, 0);
  // North wall (solid, carries the video wall) and the low parapets with glass above.
  box(g, w, h, 0.35, wallM, 0, h / 2, -hd);
  for (const side of [-1, 1]) {
    box(g, 0.35, 1.0, d, wallM, side * hw, 0.5, 0);
    const gl = box(g, 0.08, h - 1.2, d - 0.4, glass, side * hw, 1.0 + (h - 1.2) / 2, 0, { cast: false });
    gl.renderOrder = 2;
    for (let k = -2; k <= 2; k++) box(g, 0.14, h - 1, 0.14, frame, side * hw, 0.5 + (h - 1) / 2, (k * d) / 5, { cast: false });
  }
  // South side: glass front with the door in the middle.
  for (const side of [-1, 1]) {
    const segW = hw - 1.4;
    box(g, segW, 1.0, 0.35, wallM, side * (1.4 + segW / 2), 0.5, hd);
    const gl = box(g, segW, h - 1.2, 0.08, glass, side * (1.4 + segW / 2), 1.0 + (h - 1.2) / 2, hd, { cast: false });
    gl.renderOrder = 2;
    box(g, 0.14, h, 0.14, frame, side * 1.4, h / 2, hd, { cast: false });
  }
  box(g, 2.8, 0.5, 0.35, frame, 0, h - 0.25, hd, { cast: false });
  // Roof (fades out when the camera comes close).
  const roof = box(g, w + 0.8, 0.3, d + 0.8, roofM, 0, h + 0.15, 0);
  // Video wall: three screens with bezels.
  const sw = 3.4;
  const sh = sw * (9 / 16);
  const sy = 2.9;
  box(g, sw * 3 + 1.2, sh + 0.8, 0.25, frame, 0, sy, -hd + 0.3, { cast: false });
  const screenMeshes = [];
  screens.forEach((m, i) => {
    const s = mesh(new THREE.PlaneGeometry(sw, sh), m, (i - 1) * (sw + 0.15), sy, -hd + 0.45, { cast: false, receive: false });
    g.add(s);
    screenMeshes.push(s);
  });
  // Operator console (two desks facing the wall) with monitors and chairs.
  for (const x of [-2.6, 2.6]) {
    box(g, 4.2, 0.12, 1.3, deskM, x, 1.05, -hd + 6.2);
    box(g, 0.12, 1.0, 1.2, frame, x - 2, 0.55, -hd + 6.2, { cast: false });
    box(g, 0.12, 1.0, 1.2, frame, x + 2, 0.55, -hd + 6.2, { cast: false });
    for (const dx of [-1, 1]) {
      box(g, 1.1, 0.68, 0.06, frame, x + dx * 0.75, 1.55, -hd + 5.85, { cast: false });
      const mon = mesh(new THREE.PlaneGeometry(1.0, 0.58), screens[dx < 0 ? 1 : 0], x + dx * 0.75, 1.55, -hd + 5.89, { cast: false, receive: false });
      g.add(mon); // faces +z, towards the chairs
    }
    // Chairs (behind the desks, facing the wall).
    for (const dx of [-1, 1]) {
      const c = new THREE.Group();
      box(c, 0.7, 0.12, 0.7, chairM, 0, 0.75, 0);
      box(c, 0.7, 0.8, 0.1, chairM, 0, 1.2, 0.33);
      cyl(c, 0.06, 0.06, 0.65, frame, 0, 0.38, 0, 8);
      c.position.set(x + dx * 0.9, 0, -hd + 7.4);
      g.add(c);
    }
  }
  // A plant and a sign over the door.
  cyl(g, 0.35, 0.28, 0.6, chairM, hw - 1, 0.3, -hd + 1.2, 10);
  g.add(mesh(new THREE.IcosahedronGeometry(0.55, 0), M.leaves, hw - 1, 1.0, -hd + 1.2));
  g.userData.roof = roof;
  g.userData.roofMat = roofM;
  g.userData.screens = screenMeshes;
  return g;
}

// ───────────── vehicles & people ─────────────
const CAB_COLORS = [0xf5f5f5, 0xc0392b, 0x2563a8, 0xe0a019, 0x2f7d4a, 0x8a8f96, 0x5b3a8c, 0x1f2a36];
// Shared geometries / materials (many vehicles on screen).
const G = {};
const geo = (key, make) => (G[key] ??= make());
let VM = null;
// Night: vehicle headlights glow brighter (shared material of every truck and car).
export function setNightLights(night) {
  vmats().head.emissiveIntensity = night ? 3.2 : 0.6;
}

function vmats() {
  if (VM) return VM;
  const std = (o) => new THREE.MeshStandardMaterial(o);
  VM = {
    tire: std({ color: 0x18191b, roughness: 0.9 }),
    rim: std({ color: 0xc9cdd1, roughness: 0.3, metalness: 0.8 }),
    chrome: std({ color: 0xdfe3e6, roughness: 0.2, metalness: 0.95 }),
    chassis: std({ color: 0x24272b, roughness: 0.7, metalness: 0.3 }),
    glass: std({ color: 0x1e2a33, roughness: 0.08, metalness: 0.6 }),
    head: std({ color: 0xfff6d8, emissive: 0xfff1c4, emissiveIntensity: 0.6, roughness: 0.2 }),
    fuel: std({ color: 0xbfc5ca, roughness: 0.25, metalness: 0.9 }),
    mud: std({ color: 0x111214, roughness: 1 }),
    tarpGreen: std({ color: 0x2f5f3d, roughness: 0.9 }),
    tarpBlue: std({ color: 0x24507a, roughness: 0.9 }),
    trailerWall: std({ color: 0xc3c8cc, roughness: 0.5, metalness: 0.5 }),
  };
  return VM;
}

// Wheel facing ±z, inside a pivot that spins around z (plant.js turns `userData.wheels`).
function wheel(r, wdt, dual = false) {
  const m = vmats();
  const pivot = new THREE.Group();
  const t = mesh(geo(`tire${r}${wdt}`, () => new THREE.CylinderGeometry(r, r, wdt, 16)), m.tire, 0, 0, 0, { receive: false });
  t.rotation.x = Math.PI / 2;
  pivot.add(t);
  const rim = mesh(geo(`rim${r}`, () => new THREE.CylinderGeometry(r * 0.55, r * 0.55, wdt + 0.02, 10)), m.rim, 0, 0, 0, { cast: false });
  rim.rotation.x = Math.PI / 2;
  pivot.add(rim);
  // Spokes / bolts so the rotation is visible.
  const bar = mesh(geo(`spoke${r}`, () => new THREE.BoxGeometry(r * 1.0, 0.08, wdt + 0.04)), m.chassis, 0, 0, 0, { cast: false });
  pivot.add(bar);
  if (dual) {
    const t2 = t.clone();
    t2.position.z = 0;
    pivot.add(t2);
  }
  return pivot;
}

function axle(g, wheels, x, track, r, wdt, dual) {
  for (const z of [-track, track]) {
    const w = wheel(r, dual ? wdt * 1.8 : wdt);
    w.position.set(x, r, z);
    g.add(w);
    wheels.push(w);
  }
}

// Articulated truck facing +X, ≈ 11 units long: tractor (cab, chassis, fifth wheel) and a
// semitrailer hung from the king pin (userData.trailer, origin at the pin) so plant.js can make
// it follow the tractor through the curves.
export function truck(kind, seed = 0) {
  const m = vmats();
  const g = new THREE.Group();
  const wheels = [];
  const cabColor = kind === 'tow' ? 0xf2b416 : CAB_COLORS[seed % CAB_COLORS.length];
  const cabMat = new THREE.MeshStandardMaterial({ color: cabColor, roughness: 0.35, metalness: 0.35 });
  // ── tractor (x 1.0 … 5.7)
  box(g, 4.6, 0.32, 1.1, m.chassis, 3.3, 0.78, 0, { cast: false }); // frame rails
  // Cab: lower body, upper body with sloped windshield, roof fairing.
  box(g, 2.0, 1.25, 2.35, cabMat, 4.65, 1.55, 0);
  box(g, 1.6, 1.05, 2.3, cabMat, 4.45, 2.68, 0);
  const shield = box(g, 0.08, 0.95, 2.05, m.glass, 5.38, 2.66, 0, { cast: false });
  shield.rotation.z = -0.16;
  for (const z of [-1.16, 1.16]) box(g, 0.9, 0.6, 0.04, m.glass, 4.75, 2.75, z, { cast: false }); // side windows
  box(g, 1.4, 0.45, 2.2, cabMat, 4.25, 3.4, 0); // roof fairing
  box(g, 0.1, 0.7, 1.6, m.chrome, 5.68, 1.35, 0, { cast: false }); // grille
  box(g, 0.25, 0.32, 2.4, m.chassis, 5.72, 0.82, 0, { cast: false }); // bumper
  for (const z of [-0.85, 0.85]) box(g, 0.06, 0.22, 0.42, m.head, 5.75, 1.05, z, { cast: false }); // headlights
  for (const z of [-1.32, 1.32]) {
    box(g, 0.06, 0.55, 0.05, m.chassis, 5.25, 2.6, z, { cast: false }); // mirror arm
    box(g, 0.12, 0.42, 0.22, m.chassis, 5.25, 2.6, z * 1.06, { cast: false }); // mirror
  }
  const tankL = mesh(geo('fuel', () => new THREE.CylinderGeometry(0.33, 0.33, 1.2, 14)), m.fuel, 3.2, 0.8, 0, { cast: false });
  tankL.rotation.z = Math.PI / 2;
  for (const z of [-1.05, 1.05]) {
    const t = tankL.clone();
    t.position.z = z;
    g.add(t);
  }
  const pipe = cyl(g, 0.07, 0.07, 1.9, m.chrome, 3.55, 2.6, 1.0, 8, { cast: false }); // exhaust stack
  pipe.userData.exhaust = true;
  box(g, 1.1, 0.12, 1.4, m.chassis, 1.9, 1.02, 0, { cast: false }); // fifth wheel
  axle(g, wheels, 4.95, 1.02, 0.52, 0.42, false);
  axle(g, wheels, 2.05, 1.02, 0.52, 0.42, true);
  for (const z of [-1.05, 1.05]) box(g, 0.8, 0.06, 0.55, m.chassis, 2.05, 1.12, z, { cast: false }); // mud guards

  // ── semitrailer (origin at the king pin, x 0 … -7.6 in its own frame)
  const tr = new THREE.Group();
  tr.position.set(1.9, 0, 0);
  g.add(tr);
  const L = 7.6;
  box(tr, L, 0.3, 1.2, m.chassis, -L / 2 + 0.3, 1.0, 0, { cast: false }); // main beam
  let load = null;
  if (kind === 'soy') {
    // Grain hopper trailer: steel sides, hoppers underneath, tarp rolled at the side.
    box(tr, L, 0.12, 2.45, m.trailerWall, -L / 2, 1.3, 0);
    for (const z of [-1.2, 1.2]) box(tr, L, 1.55, 0.08, m.trailerWall, -L / 2, 2.05, z);
    for (const x of [-0.04, -L + 0.04]) box(tr, 0.08, 1.55, 2.45, m.trailerWall, x, 2.05, 0);
    for (let k = 1; k < 6; k++) box(tr, 0.06, 1.6, 2.5, m.chassis, -k * (L / 6), 2.05, 0, { cast: false }); // ribs
    for (const x of [-2.2, -5.0]) {
      const hop = mesh(geo('hopper', () => new THREE.CylinderGeometry(0.9, 0.25, 0.7, 4)), m.trailerWall, x, 0.95, 0, { cast: false });
      hop.rotation.y = Math.PI / 4;
      tr.add(hop);
    }
    load = mesh(geo('grain', () => new THREE.BoxGeometry(L - 0.2, 1, 2.3)), M.soy, -L / 2, 2.0, 0, { cast: false });
    tr.add(load);
    const roll = mesh(geo('tarpRoll', () => new THREE.CylinderGeometry(0.12, 0.12, L - 0.2, 8)), m.tarpGreen, -L / 2, 2.9, 1.25, { cast: false });
    roll.rotation.z = Math.PI / 2;
    tr.add(roll);
  } else if (kind === 'oil') {
    // Stainless tanker: barrel, end caps, catwalk and manholes.
    const t = mesh(geo('tank', () => new THREE.CylinderGeometry(1.15, 1.15, L - 0.6, 24)), M.stainless, -L / 2, 2.35, 0);
    t.rotation.z = Math.PI / 2;
    tr.add(t);
    for (const x of [-0.3, -L + 0.3]) {
      const cap = mesh(geo('tankCap', () => new THREE.SphereGeometry(1.15, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2)), M.stainless, x, 2.35, 0, { cast: false });
      cap.rotation.z = x > -1 ? -Math.PI / 2 : Math.PI / 2;
      cap.scale.y = 0.25;
      tr.add(cap);
    }
    box(tr, L - 1.5, 0.08, 0.55, M.grating, -L / 2, 3.55, 0, { cast: false });
    for (const x of [-1.8, -3.8, -5.8]) cyl(tr, 0.28, 0.28, 0.18, m.chassis, x, 3.55, 0, 12, { cast: false });
    for (const z of [-0.3, 0.3]) box(tr, L - 1.5, 0.35, 0.04, m.chrome, -L / 2, 3.85, z, { cast: false }); // handrails
  } else if (kind === 'tow') {
    // Wrecker body with boom, winch and a light bar.
    const yellow = new THREE.MeshStandardMaterial({ color: 0xf2b416, roughness: 0.5 });
    box(tr, 5.2, 1.2, 2.4, yellow, -2.8, 1.75, 0);
    const boom = box(tr, 4.8, 0.32, 0.32, M.steel, -3.4, 3.3, 0);
    boom.rotation.z = 0.32;
    box(tr, 0.24, 1.5, 0.24, M.steel, -5.6, 2.3, 0, { cast: false });
    cyl(tr, 0.3, 0.3, 0.9, m.chassis, -1.2, 2.6, 0, 12, { cast: false });
  } else {
    // Meal: curtain-side box trailer.
    box(tr, L, 2.4, 2.45, m.tarpBlue, -L / 2, 2.45, 0);
    box(tr, L + 0.05, 0.12, 2.5, m.trailerWall, -L / 2, 3.68, 0, { cast: false });
    for (let k = 0; k <= 6; k++) box(tr, 0.05, 2.4, 2.5, m.trailerWall, -k * (L / 6) - 0.02, 2.45, 0, { cast: false });
  }
  // Trailer bogie (tandem axle) near the rear, landing gear in front.
  axle(tr, wheels, -L + 1.55, 1.0, 0.5, 0.42, true);
  axle(tr, wheels, -L + 2.75, 1.0, 0.5, 0.42, true);
  for (const z of [-0.7, 0.7]) box(tr, 0.12, 0.8, 0.12, m.chassis, -1.7, 0.55, z, { cast: false });
  // Brake / hazard lights (animated by plant.js).
  const brake = new THREE.MeshStandardMaterial({ color: 0x5a1010, emissive: 0xff2a1a, emissiveIntensity: 0 });
  const amber = new THREE.MeshStandardMaterial({ color: 0x6b4a10, emissive: 0xffa31a, emissiveIntensity: 0 });
  for (const z of [-1.05, 1.05]) {
    box(tr, 0.08, 0.26, 0.42, brake, -L - 0.02, 1.18, z, { cast: false });
    box(tr, 0.08, 0.2, 0.22, amber, -L - 0.02, 1.5, z, { cast: false });
    box(g, 0.08, 0.18, 0.22, amber, 5.76, 1.32, z * 0.95, { cast: false });
  }
  box(tr, 0.15, 0.5, 2.3, m.mud, -L + 0.4, 0.55, 0, { cast: false }); // rear bumper / mud flaps
  if (kind === 'tow') box(g, 0.5, 0.25, 2.0, amber, 4.3, 3.7, 0, { cast: false });
  g.userData.load = load;
  g.userData.brakeMat = brake;
  g.userData.amberMat = amber;
  g.userData.trailer = tr;
  g.userData.trailerLen = 5.6; // king pin → trailer axles
  g.userData.wheels = wheels;
  g.userData.wheelR = 0.52;
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

const SKIN = [0xf1c9a5, 0xd9a47a, 0xb97f55, 0x8d5a3b, 0xe8b894, 0x6e4529];
const SHIRT = { operator: 0x36506e, tech: 0x2e5a3c, supervisor: 0x2b4f8a, chief: 0xe9edf2, manager: 0xdfe8f4 };

// Articulated worker facing +X, ≈ 1.35 units (≈ 2 m) tall. userData.legs.children = [left, right]
// and userData.arms = [left, right] are pivots swung by plant.js while walking.
export function person(helmet = 0xffd400, vest = 0xff7a00, { kind = 'operator', seed = 0 } = {}) {
  const g = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: SKIN[seed % SKIN.length], roughness: 0.75 });
  const shirt = new THREE.MeshStandardMaterial({ color: SHIRT[kind] ?? SHIRT.operator, roughness: 0.85 });
  const pants = new THREE.MeshStandardMaterial({ color: kind === 'manager' || kind === 'chief' ? 0x2b2f36 : 0x253247, roughness: 0.9 });
  const boots = new THREE.MeshStandardMaterial({ color: 0x3a2a1c, roughness: 0.8 });
  const vestM = new THREE.MeshStandardMaterial({ color: vest, roughness: 0.7, emissive: vest, emissiveIntensity: 0.18 });
  const stripe = new THREE.MeshStandardMaterial({ color: 0xe8edf0, emissive: 0xbfc8cf, emissiveIntensity: 0.35, roughness: 0.3 });
  const helm = new THREE.MeshStandardMaterial({ color: helmet, roughness: 0.35 });
  const hair = new THREE.MeshStandardMaterial({ color: 0x2a1d14, roughness: 0.9 });
  const hasVest = kind !== 'manager';
  // Legs (pivots at the hips).
  const legs = new THREE.Group();
  for (const z of [-0.1, 0.1]) {
    const leg = new THREE.Group();
    leg.position.set(0, 0.92, z);
    box(leg, 0.17, 0.48, 0.17, pants, 0, -0.24, 0);
    box(leg, 0.15, 0.42, 0.15, pants, 0, -0.68, 0);
    box(leg, 0.28, 0.11, 0.17, boots, 0.05, -0.87, 0);
    legs.add(leg);
  }
  g.add(legs);
  box(g, 0.24, 0.2, 0.36, pants, 0, 0.95, 0); // pelvis
  box(g, 0.25, 0.56, 0.42, shirt, 0, 1.3, 0); // torso
  if (hasVest) {
    box(g, 0.28, 0.46, 0.45, vestM, 0, 1.3, 0);
    for (const y of [1.17, 1.33]) box(g, 0.29, 0.05, 0.46, stripe, 0, y, 0, { cast: false });
  } else {
    box(g, 0.02, 0.36, 0.05, new THREE.MeshStandardMaterial({ color: 0x7b1f2a }), 0.13, 1.33, 0, { cast: false }); // tie
  }
  // Arms (pivots at the shoulders).
  const arms = [];
  for (const z of [-0.27, 0.27]) {
    const arm = new THREE.Group();
    arm.position.set(0, 1.54, z);
    box(arm, 0.12, 0.32, 0.12, shirt, 0, -0.16, 0);
    box(arm, 0.1, 0.3, 0.1, kind === 'manager' ? shirt : skin, 0, -0.46, 0);
    arm.add(mesh(geo('hand', () => new THREE.SphereGeometry(0.06, 8, 6)), skin, 0, -0.64, 0, { cast: false }));
    g.add(arm);
    arms.push(arm);
  }
  cyl(g, 0.06, 0.07, 0.1, skin, 0, 1.63, 0, 8, { cast: false }); // neck
  const head = mesh(geo('head', () => new THREE.SphereGeometry(0.125, 14, 10)), skin, 0.01, 1.78, 0);
  head.scale.set(0.95, 1.1, 0.9);
  g.add(head);
  box(g, 0.02, 0.04, 0.12, new THREE.MeshStandardMaterial({ color: 0x1a1a1a }), 0.12, 1.8, 0, { cast: false }); // eyes band (reads as a face)
  const hat = mesh(geo('helmet', () => new THREE.SphereGeometry(0.15, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2)), helm, 0, 1.83, 0);
  g.add(hat);
  const brim = mesh(geo('brim', () => new THREE.CylinderGeometry(0.19, 0.19, 0.02, 14)), helm, 0.03, 1.84, 0, { cast: false });
  g.add(brim);
  g.add(mesh(geo('hairBack', () => new THREE.SphereGeometry(0.12, 10, 8)), hair, -0.03, 1.74, 0, { cast: false }));
  g.scale.setScalar(0.74);
  g.userData.legs = legs;
  g.userData.arms = arms;
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

// Passenger vehicle facing +X (sedan, suv, pickup, van), ≈ 3.2 units long.
export function car(variant = 'sedan', color = 0xffffff) {
  const m = vmats();
  const g = new THREE.Group();
  const wheels = [];
  const body = new THREE.MeshStandardMaterial({ color, roughness: 0.3, metalness: 0.55 });
  const dims = { sedan: [3.1, 0.55, 0.5], suv: [3.2, 0.7, 0.62], pickup: [3.5, 0.65, 0.55], van: [3.4, 0.75, 0.85] }[variant] ?? [3.1, 0.55, 0.5];
  const [len, lower, cabin] = dims;
  const wdt = 1.38;
  const base = 0.3;
  box(g, len, lower, wdt, body, 0, base + lower / 2, 0); // lower body
  if (variant === 'pickup') {
    box(g, 1.3, cabin, wdt - 0.08, body, 0.45, base + lower + cabin / 2, 0);
    box(g, 1.2, 0.04, wdt - 0.15, m.glass, 0.45, base + lower + cabin / 2, 0, { cast: false });
    for (const z of [-wdt / 2 + 0.04, wdt / 2 - 0.04]) box(g, 1.35, 0.28, 0.06, body, -0.95, base + lower + 0.14, z); // bed sides
    box(g, 0.06, 0.28, wdt, body, -len / 2 + 0.03, base + lower + 0.14, 0);
  } else {
    const cabLen = variant === 'van' ? len - 0.6 : variant === 'suv' ? len * 0.62 : len * 0.5;
    const cx = variant === 'van' ? -0.2 : variant === 'suv' ? -0.15 : -0.1;
    box(g, cabLen, cabin, wdt - 0.08, body, cx, base + lower + cabin / 2, 0);
    // Glass band around the cabin.
    box(g, cabLen + 0.02, cabin * 0.55, wdt - 0.06, m.glass, cx, base + lower + cabin * 0.5, 0, { cast: false });
    box(g, cabLen - 0.1, 0.05, wdt - 0.1, body, cx, base + lower + cabin + 0.01, 0, { cast: false }); // roof
  }
  for (const z of [-0.45, 0.45]) box(g, 0.05, 0.12, 0.3, m.head, len / 2 + 0.01, base + lower * 0.6, z, { cast: false });
  box(g, 0.08, 0.12, wdt, m.chassis, len / 2 + 0.02, base + 0.08, 0, { cast: false }); // bumpers
  box(g, 0.08, 0.12, wdt, m.chassis, -len / 2 - 0.02, base + 0.08, 0, { cast: false });
  const brake = new THREE.MeshStandardMaterial({ color: 0x5a1010, emissive: 0xff2a1a, emissiveIntensity: 0 });
  const amber = new THREE.MeshStandardMaterial({ color: 0x6b4a10, emissive: 0xffa31a, emissiveIntensity: 0 });
  for (const z of [-0.5, 0.5]) box(g, 0.05, 0.14, 0.26, brake, -len / 2 - 0.01, base + lower * 0.65, z, { cast: false });
  for (const x of [len / 2 - 0.65, -len / 2 + 0.65]) axle(g, wheels, x, wdt / 2, 0.32, 0.24, false);
  g.userData.brakeMat = brake;
  g.userData.amberMat = amber;
  g.userData.wheels = wheels;
  g.userData.wheelR = 0.32;
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
