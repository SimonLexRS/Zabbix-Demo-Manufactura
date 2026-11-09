// Entry point: renderer, camera, picking, follow-cam, tour and the frame loop.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/CSS2DRenderer.js';
import { createMaterials } from './world/materials.js';
import { createEnvironment } from './world/environment.js';
import { PlantView } from './world/plant.js';
import { SnapshotBuffer, connect } from './net.js';
import { UI } from './ui/ui.js';
import { STORAGES, OIL_TANKS, BUILDINGS, STATIONS, BOILERS } from './sim/layout.js';

const container = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.className = 'labels';
container.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, 1, 1, 3000);
const HOME = { pos: new THREE.Vector3(190, 175, 230), target: new THREE.Vector3(-5, 0, 5) };
camera.position.copy(HOME.pos);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(HOME.target);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.47;
controls.minDistance = 12;
controls.maxDistance = 750;
controls.screenSpacePanning = false;

const M = createMaterials();
const env = createEnvironment(scene, M);
const plant = new PlantView(scene, M);

const snaps = new SnapshotBuffer();
let follow = null; // { kind, id }
let fly = null;

const ui = new UI({
  onSpeed: (v) => source?.control({ speed: v }),
  onTour: (t) => {
    follow = null;
    flyTo(new THREE.Vector3(...t.target), t.dist);
  },
  onFault: async (cmd) => {
    const r = await source?.control(cmd);
    if (cmd.clearFaults) ui.toast('Fallas normalizadas');
    else ui.toast(r?.ok ? 'Falla inyectada — mira los problemas y Zabbix' : 'Esa falla ya está activa');
  },
  onLabels: (on) => plant.setLabelsVisible(on),
  onHome: () => {
    follow = null;
    flyTo(HOME.target.clone(), null, HOME.pos.clone());
  },
  onSelect: (pick) => select(pick),
  onSource: (src) => {
    const pick = pickForSource(src);
    if (pick) {
      select(pick);
      focusPick(pick);
    }
  },
  onAction: async (a) => {
    if (a.follow) {
      follow = { kind: a.person ? 'person' : 'truck', id: a.follow };
      ui.toast('Siguiendo — arrastra para salir del seguimiento');
    }
    if (a.cmd) {
      await source?.control(a.cmd);
      ui.toast(a.cmd.clearFaults ? 'Fallas normalizadas' : 'Falla inyectada');
    }
  },
});

let source = null;
connect({
  onSnapshot: (s) => {
    snaps.push(s);
    plant.applyState(s);
    ui.update(s);
  },
  onMode: (m) => ui.setMode(m),
}).then((s) => (source = s));

// ───────────── picking ─────────────
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let down = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY };
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!down) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  down = null;
  if (moved > 6) {
    follow = null;
    return;
  }
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const targets = [...plant.pickables, ...plant.vehicles.values(), ...plant.people.values()];
  const hit = ray.intersectObjects(targets, true).find((h) => h.object.userData.pickRoot);
  select(hit ? hit.object.userData.pickRoot.userData.pick : null);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (down) return;
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const targets = [...plant.pickables, ...plant.vehicles.values(), ...plant.people.values()];
  const hit = ray.intersectObjects(targets, true).find((h) => h.object.userData.pickRoot);
  renderer.domElement.style.cursor = hit ? 'pointer' : 'grab';
});

function select(pick) {
  plant.select(pick);
  ui.showDetails(pick);
  if (!pick) follow = null;
}

function pickForSource(src) {
  if (STORAGES.some((s) => s.id === src)) return { kind: 'storage', id: src };
  if (OIL_TANKS.some((s) => s.id === src)) return { kind: 'tank', id: src };
  if (src === 'TA') return { kind: 'tank', id: 'TA2' };
  if (BOILERS.some((s) => s.id === src)) return { kind: 'boiler', id: src };
  if (STATIONS[src]) return { kind: 'station', id: src };
  if (src === 'PLAYA') return { kind: 'station', id: 'GATE' };
  if (BUILDINGS.some((s) => s.id === src)) return { kind: 'building', id: src };
  return null;
}

function focusPick(pick) {
  const obj = plant.findObject(pick);
  if (!obj) return;
  const box = new THREE.Box3().setFromObject(obj);
  const c = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).length();
  follow = null;
  flyTo(new THREE.Vector3(c.x, 0, c.z), Math.max(35, size * 2.2));
}

function flyTo(target, dist, pos) {
  const dir = camera.position.clone().sub(controls.target).normalize();
  const to = pos || target.clone().add(dir.multiplyScalar(dist));
  if (!pos) to.y = Math.max(to.y, dist * 0.55);
  fly = { t: 0, fromPos: camera.position.clone(), fromTarget: controls.target.clone(), toPos: to, toTarget: target };
}

// ───────────── loop ─────────────
function resize() {
  const w = container.clientWidth;
  const h = container.clientHeight;
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(0.1, clock.getDelta());
  const sample = snaps.sample();
  if (sample) {
    plant.syncAgents(sample.a, sample.b, sample.alpha);
    const t = sample.b.t;
    env.update(dt, (t % 1440) / 60);
  } else {
    env.update(dt, 10);
  }
  plant.frame(dt, snaps.latest?.speed ?? 1);

  if (fly) {
    fly.t = Math.min(1, fly.t + dt / 1.2);
    const e = fly.t < 0.5 ? 4 * fly.t ** 3 : 1 - (-2 * fly.t + 2) ** 3 / 2;
    camera.position.lerpVectors(fly.fromPos, fly.toPos, e);
    controls.target.lerpVectors(fly.fromTarget, fly.toTarget, e);
    if (fly.t >= 1) fly = null;
  } else if (follow) {
    const obj = follow.kind === 'truck' ? plant.vehicles.get(follow.id) : plant.people.get(follow.id);
    if (obj) {
      const delta = obj.position.clone().sub(controls.target);
      delta.y = 0;
      controls.target.add(delta.multiplyScalar(0.15));
      camera.position.add(delta);
    } else {
      follow = null;
    }
  }
  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
