// Ground, roads, river, trees, sky and day/night lighting.
import * as THREE from 'three';
import { ROADS, SITE } from '../sim/layout.js';
import { mesh, box, setMaterials } from './builders.js';

export function createEnvironment(scene, M) {
  setMaterials(M);
  // Ground.
  const ground = mesh(new THREE.PlaneGeometry(900, 900), M.grass, 0, 0, 0, { cast: false });
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const flat = (w, d, mat, x, z, y) => {
    const m = mesh(new THREE.PlaneGeometry(w, d), mat, x, y, z, { cast: false });
    m.rotation.x = -Math.PI / 2;
    scene.add(m);
    return m;
  };

  // Plant site (compacted soil) + concrete pads around process area.
  flat(SITE.x1 - SITE.x0, SITE.z1 - SITE.z0, M.dirt, (SITE.x0 + SITE.x1) / 2, (SITE.z0 + SITE.z1) / 2, 0.02);
  flat(60, 92, M.concrete, 20, -46, 0.03);
  flat(36, 40, M.concrete, -12, -112, 0.03);

  // Roads.
  for (const r of ROADS) {
    const [x0, z0, x1, z1] = r.rect;
    const w = x1 - x0;
    const d = z1 - z0;
    if (r.highway) {
      const m = flat(w, d, M.asphalt, (x0 + x1) / 2, (z0 + z1) / 2, 0.06);
      m.material = M.asphalt.clone();
      m.material.map = M.asphalt.map.clone();
      m.material.map.repeat.set(1, d / 40);
      m.material.map.needsUpdate = true;
      // Shoulders.
      flat(1.2, d, M.gravel, x0 - 0.6, (z0 + z1) / 2, 0.05);
      flat(1.2, d, M.gravel, x1 + 0.6, (z0 + z1) / 2, 0.05);
    } else {
      flat(w, d, r.yard ? M.concrete : M.gravel, (x0 + x1) / 2, (z0 + z1) / 2, r.yard ? 0.04 : 0.05);
    }
  }

  // Perimeter fence.
  const fenceH = 2.2;
  const fx = (SITE.x0 + SITE.x1) / 2;
  const fz = (SITE.z0 + SITE.z1) / 2;
  const fw = SITE.x1 - SITE.x0 + 4;
  const fd = SITE.z1 - SITE.z0 + 4;
  const fenceMat = M.fence.clone();
  fenceMat.transparent = true;
  fenceMat.opacity = 0.55;
  const fence = new THREE.Group();
  box(fence, fw, fenceH, 0.1, fenceMat, fx, fenceH / 2, SITE.z0 - 2, { cast: false });
  box(fence, fw, fenceH, 0.1, fenceMat, fx, fenceH / 2, SITE.z1 + 2, { cast: false });
  box(fence, 0.1, fenceH, fd, fenceMat, SITE.x0 - 2, fenceH / 2, fz, { cast: false });
  // East fence with the gate opening (z 64..78).
  box(fence, 0.1, fenceH, 64 - (SITE.z0 - 2), fenceMat, 62, fenceH / 2, (SITE.z0 - 2 + 64) / 2, { cast: false });
  box(fence, 0.1, fenceH, SITE.z1 + 2 - 78, fenceMat, 62, fenceH / 2, (78 + SITE.z1 + 2) / 2, { cast: false });
  scene.add(fence);

  // River (west) with gravel bed, meandering along Z.
  const riverX = (z) => -112 + Math.sin(z / 70) * 12 + Math.sin(z / 23) * 3;
  const strip = (half, mat, y) => {
    const pts = [];
    const uvs = [];
    const idx = [];
    const N = 120;
    for (let i = 0; i <= N; i++) {
      const z = -450 + (900 * i) / N;
      const x = riverX(z);
      const hw = half + Math.sin(z / 41) * half * 0.12;
      pts.push(x - hw, y, z, x + hw, y, z);
      uvs.push(0, i / 4, 1, i / 4);
      if (i < N) {
        const a = i * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mat);
    m.receiveShadow = true;
    scene.add(m);
    return m;
  };
  strip(30, M.riverbed, 0.03);
  const water = strip(12, M.water, 0.15);

  // Trees: instanced canopy + trunks along the river, perimeter and fields.
  const spots = [];
  const rnd = (a, b) => a + Math.random() * (b - a);
  for (let z = -440; z < 440; z += 7) {
    spots.push([riverX(z) + rnd(32, 46), z + rnd(-3, 3), rnd(0.8, 1.4)]);
    spots.push([riverX(z) - rnd(32, 50), z + rnd(-3, 3), rnd(0.8, 1.4)]);
    if (Math.random() < 0.5) spots.push([riverX(z) + rnd(48, 70), z + rnd(-3, 3), rnd(0.7, 1.2)]);
  }
  for (let z = SITE.z0; z < SITE.z1; z += 9) if (Math.random() < 0.6) spots.push([SITE.x0 - 6, z, rnd(0.8, 1.1)]);
  for (let x = SITE.x0; x < SITE.x1; x += 8) spots.push([x, SITE.z1 + 7, rnd(0.7, 1)]);
  for (let i = 0; i < 160; i++) {
    const x = rnd(92, 420);
    const z = rnd(-440, 440);
    if (Math.random() < 0.6) spots.push([x, z, rnd(0.8, 1.6)]);
  }
  // Garden trees near the offices.
  for (const [x, z] of [[14, -100], [36, -98], [8, -124], [48, -96], [-30, -94], [4, -96]]) spots.push([x, z, 1.1]);
  const trunkGeo = new THREE.BoxGeometry(0.45, 2.4, 0.45);
  trunkGeo.translate(0, 1.2, 0);
  const crownGeo = new THREE.IcosahedronGeometry(2.4, 0);
  crownGeo.translate(0, 4, 0);
  const trunks = new THREE.InstancedMesh(trunkGeo, M.trunk, spots.length);
  const crowns = new THREE.InstancedMesh(crownGeo, M.leaves, spots.length);
  crowns.castShadow = true;
  const mtx = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const col = new THREE.Color();
  spots.forEach(([x, z, s], i) => {
    q.setFromEuler(new THREE.Euler(0, Math.random() * Math.PI, 0));
    mtx.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(s, s * rnd(0.85, 1.2), s));
    trunks.setMatrixAt(i, mtx);
    crowns.setMatrixAt(i, mtx);
    crowns.setColorAt(i, col.setHSL(0.27 + Math.random() * 0.06, 0.45, 0.25 + Math.random() * 0.1));
  });
  scene.add(trunks, crowns);

  // Highway traffic is part of the simulation now (cars on RN4 brake behind the trucks).

  // Sky + lights.
  const hemi = new THREE.HemisphereLight(0xdcecff, 0x55663f, 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff3dd, 2.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(window.innerWidth < 860 ? 2048 : 4096, window.innerWidth < 860 ? 2048 : 4096);
  const sc = sun.shadow.camera;
  sc.left = -200;
  sc.right = 200;
  sc.top = 200;
  sc.bottom = -200;
  sc.near = 10;
  sc.far = 700;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  scene.add(sun, sun.target);

  const DAY = new THREE.Color(0xa9cbe6);
  const DUSK = new THREE.Color(0xe6a77a);
  const NIGHT = new THREE.Color(0x14213a);
  scene.background = DAY.clone();
  scene.fog = new THREE.Fog(DAY.clone(), 450, 1300);

  let waterT = 0;
  return {
    update(dt, hour) {
      // Sun path: rises at 6, sets at 19.
      const dayFrac = THREE.MathUtils.clamp((hour - 6) / 13, 0, 1);
      const elev = Math.sin(dayFrac * Math.PI);
      const az = -Math.PI / 2 + dayFrac * Math.PI;
      sun.position.set(Math.cos(az) * 260, 40 + elev * 300, -120 + Math.sin(az) * 60);
      sun.target.position.set(0, 0, 0);
      const night = hour < 5.5 || hour > 19.5;
      const twilight = !night && (hour < 7 || hour > 18);
      sun.intensity = night ? 0.25 : 0.6 + elev * 2.0;
      hemi.intensity = night ? 0.45 : 0.6 + elev * 0.4;
      const target = night ? NIGHT : twilight ? DUSK : DAY;
      scene.background.lerp(target, Math.min(1, dt * 0.8));
      scene.fog.color.copy(scene.background);
      sun.color.setHex(twilight ? 0xffc48a : night ? 0x8aa6ff : 0xfff3dd);
      waterT += dt;
      water.material.color.setHSL(0.54, 0.38, 0.45 + Math.sin(waterT * 0.7) * 0.02);
    },
  };
}
