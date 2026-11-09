// Entry point: renderer, camera, picking, follow-cam, tour and the frame loop.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/CSS2DRenderer.js';
import { createMaterials } from './world/materials.js';
import { createEnvironment } from './world/environment.js';
import { PlantView } from './world/plant.js';
import { SnapshotBuffer, connect } from './net.js';
import { mergeFrame } from './sim/frames.js';
import { UI } from './ui/ui.js';
import { ConfigPanel } from './ui/config-panel.js';
import { PixelRenderer, loadAppearance, saveAppearance } from './world/pixel.js';
import { STORAGES, OIL_TANKS, BUILDINGS, STATIONS, BOILERS, MONITOR_ROOM } from './sim/layout.js';
import { PROBLEM_BY_ID } from './sim/problems.js';

const container = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
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

let appearance = loadAppearance();
const pixel = new PixelRenderer(renderer, scene, camera, appearance);

const snaps = new SnapshotBuffer();
let follow = null; // { kind, id }
let fly = null;

const ui = new UI({
  onSpeed: (v) => source?.control({ speed: v }),
  onTour: (t) => {
    follow = null;
    if (t.monitor) return enterMonitor();
    setMonitor(false);
    flyTo(new THREE.Vector3(...t.target), t.dist);
  },
  onMonitor: () => (plant.monitorMode ? (setMonitor(false), flyTo(HOME.target.clone(), null, HOME.pos.clone())) : enterMonitor()),
  onProblem: (id, active) => setProblem(id, active),
  onRandomFaults: async (on) => {
    await source?.problems({ randomFaults: on });
    ui.toast(on ? 'Fallas aleatorias activadas' : 'Fallas aleatorias desactivadas (solo manuales)');
  },
  onClearProblems: async () => {
    await source?.problems({ clearAll: true });
    ui.toast('Todas las fallas normalizadas');
  },
  onConfig: () => (config.isOpen ? config.close() : (select(null), config.open())),
  onEscape: () => {
    if (config.isOpen) config.close();
    else select(null);
  },
  onLabels: (on) => plant.setLabelsVisible(on),
  onHome: () => {
    follow = null;
    setMonitor(false);
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
    if (a.problem) await setProblem(a.problem, a.active);
  },
});

async function setProblem(id, active) {
  const r = await source?.problems({ id, active });
  if (r?.cancelled) return;
  const p = r?.problems?.find((x) => x.id === id);
  if (p) ui.toast(active ? `Activado (manual): ${p.name} — se envía a Zabbix` : `Normalizado: ${p.name}`);
}

let source = null;
const config = new ConfigPanel({
  api: (m, u, b) => (source ? source.api(m, u, b) : Promise.resolve({ ok: false, error: 'Conectando…' })),
  toast: (m) => ui.toast(m),
  appearance: {
    get: () => appearance,
    set: (patch) => {
      appearance = { ...appearance, ...patch };
      saveAppearance(appearance);
      pixel.set(appearance);
    },
  },
});
// Fast frames (5 Hz) only carry what moves; the full state (1 Hz or on change) drives the
// panels, gauges and beacons.
let state = null;
connect({
  onSnapshot: (msg) => {
    const next = mergeFrame(state, msg);
    if (!next) return;
    state = next;
    snaps.push(msg);
    plant.stationState = state.stations;
    if (msg.k === 'f') {
      ui.updateFast(state);
      return;
    }
    plant.applyState(state);
    ui.update(state);
    config.updateLive(state);
  },
  onMode: (m) => ui.setMode(m),
  askToken: (msg) => ui.askToken(msg),
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
let lastHover = 0;
renderer.domElement.addEventListener('pointermove', (e) => {
  if (down) return;
  // Hover cursor only: 10 checks per second are plenty.
  const now = performance.now();
  if (now - lastHover < 100) return;
  lastHover = now;
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const targets = [...plant.pickables, ...plant.vehicles.values(), ...plant.people.values()];
  const hit = ray.intersectObjects(targets, true).find((h) => h.object.userData.pickRoot);
  renderer.domElement.style.cursor = hit ? 'pointer' : 'grab';
});

// ───────────── monitoring room ─────────────
// Entering the room (button, tour stop, or flying the camera into it) tells the server someone
// is watching: the plant manager comes to the room right away and stays at the dashboard.
function enterMonitor() {
  follow = null;
  select(null);
  setMonitor(true);
  const v = MONITOR_ROOM.view;
  flyTo(new THREE.Vector3(...v.target), null, new THREE.Vector3(...v.pos));
  ui.toast('Sala de monitoreo · clic en el muro para abrir el dashboard real en Zabbix');
}
function setMonitor(on) {
  plant.monitorMode = on;
  // Inside the room the camera may look horizontally and get close.
  controls.maxPolarAngle = on ? Math.PI * 0.5 : Math.PI * 0.47;
  controls.minDistance = on ? 3 : 12;
  ui.setMonitor(on);
  if (on) source?.presence?.();
}
const cameraInRoom = () => {
  const c = camera.position;
  return Math.abs(c.x - MONITOR_ROOM.x) < MONITOR_ROOM.w / 2 + 6 && Math.abs(c.z - MONITOR_ROOM.z) < MONITOR_ROOM.d / 2 + 8 && c.y < 14;
};
setInterval(() => {
  // Leaving by moving the camera away ends the visit.
  if (plant.monitorMode && !fly && Math.hypot(camera.position.x - MONITOR_ROOM.x, camera.position.z - MONITOR_ROOM.z) > 60) setMonitor(false);
  if (plant.monitorMode || cameraInRoom()) source?.presence?.();
}, 8000);
function openDashboard() {
  const url = state?.zabbix?.dashboardUrl;
  if (url) window.open(url, '_blank', 'noopener');
  else ui.toast('Configura la URL web de Zabbix (Configuración → Zabbix) para abrir el dashboard real');
}

function select(pick) {
  if (pick?.kind === 'dashboard') return openDashboard();
  if (pick && config?.isOpen) config.close();
  plant.select(pick);
  ui.showDetails(pick);
  if (!pick) follow = null;
}

function pickForSource(src) {
  if (PROBLEM_BY_ID[src]) src = PROBLEM_BY_ID[src].src; // work orders point to their problem
  if (src === 'VIA') {
    // Traffic incident: the crashed truck, or the one without brakes.
    const s = snaps.latest;
    const v = s?.vehicles.find((x) => x.crashed) || s?.vehicles.find((x) => x.brakeFail);
    return v ? { kind: 'truck', id: v.id } : null;
  }
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
let viewW = 1;
let viewH = 1;
function resize() {
  const w = container.clientWidth;
  const h = container.clientHeight;
  viewW = w;
  viewH = h;
  pixel.setSize(w, h);
  labelRenderer.setSize(w, h);
  camera.aspect = w / h;
  // Portrait screens need a wider vertical field of view to show the whole plant.
  camera.fov = camera.aspect < 1 ? 42 + (1 - camera.aspect) * 40 : 42;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

plant.camera = camera;
const clock = new THREE.Clock();
function step() {
  const raw = clock.getDelta();
  const dt = Math.min(0.1, raw);
  snaps.advance(Math.min(raw, 1));
  const sample = snaps.sample();
  const speed = snaps.latest?.speed ?? 1;
  if (sample) {
    plant.syncAgents(sample, dt, speed);
    env.update(dt, ((snaps.playT ?? sample.b.t) % 1440) / 60);
  } else {
    env.update(dt, 10);
  }
  plant.frame(dt, speed);

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
  pixel.render();
  labelRenderer.render(scene, camera);
  plant.declutter(camera, viewW, viewH);
}
function frame() {
  step();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Debug hook (only with ?debug in the URL): drive frames by hand, e.g. in a background tab.
if (new URLSearchParams(location.search).has('debug')) {
  window.__planta = { camera, controls, plant, state: () => state, step: (n = 1) => { for (let i = 0; i < n; i++) step(); }, enterMonitor, flyTo };
}
