// Builds the plant from the shared layout and keeps the dynamic parts in sync
// with the simulation snapshots (levels, flows, trucks, people, alarms).
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/CSS2DRenderer.js';
import { STORAGES, OIL_TANKS, DAY_TANKS, BOILERS, BUILDINGS, STATIONS, GATE_LANES, RN4 } from '../sim/layout.js';
import * as B from './builders.js';
import { flowTex, levelColor } from './materials.js';
import { DashboardWall } from './dashboard.js';

const STATION_BUILDERS = {
  SAMP: () => B.sampler(),
  BAL_IN: () => B.scale(),
  BAL_OUT: () => B.scale(),
  BAL_D: () => B.scale(),
  BAL_DS: () => B.scale(),
  H1: () => B.hopper(),
  H2: () => B.hopper(),
  OL: () => B.loadingRack('oil'),
  ML: () => B.loadingRack('meal'),
};
// Rotation (radians) so each station lines up with its road.
const STATION_ROT = { SAMP: Math.PI / 2, BAL_IN: Math.PI / 2, BAL_OUT: Math.PI / 2, BAL_D: 0, BAL_DS: Math.PI / 2, H1: Math.PI / 2, H2: Math.PI / 2, OL: -Math.PI / 2, ML: -Math.PI / 2 };

// Where to show an alarm beacon for a problem source.
function sourcePos(src) {
  const all = [...STORAGES, ...OIL_TANKS, ...BUILDINGS, ...Object.values(STATIONS), ...BOILERS];
  const map = { TA: OIL_TANKS[1], PLAYA: { x: 36, z: 71, h: 6 }, SF: BUILDINGS.find((b) => b.id === 'SF') };
  const e = map[src] || all.find((x) => x.id === src);
  if (!e) return null;
  return new THREE.Vector3(e.x, (e.h ?? 8) + 9, e.z);
}

class FlowLine {
  // Beads travelling along a polyline when the flow is active.
  constructor(scene, pts, color, { count = 24, size = 0.7, speed = 12 } = {}) {
    this.curve = new THREE.CurvePath();
    for (let i = 0; i < pts.length - 1; i++) this.curve.add(new THREE.LineCurve3(pts[i], pts[i + 1]));
    this.length = this.curve.getLength();
    this.speed = speed;
    this.t = 0;
    const geo = new THREE.BoxGeometry(size, size, size);
    const mat = new THREE.MeshBasicMaterial({ color });
    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.frustumCulled = false;
    this.count = count;
    this.active = false;
    this.alpha = 0;
    scene.add(this.mesh);
    this.tmp = new THREE.Matrix4();
    this.update(0);
  }
  update(dt) {
    this.alpha += ((this.active ? 1 : 0) - this.alpha) * Math.min(1, dt * 3);
    this.mesh.visible = this.alpha > 0.02;
    if (!this.mesh.visible) return;
    this.t = (this.t + (dt * this.speed) / this.length) % 1;
    const s = this.alpha;
    for (let i = 0; i < this.count; i++) {
      const u = (this.t + i / this.count) % 1;
      const p = this.curve.getPointAt(u);
      this.tmp.makeScale(s, s, s).setPosition(p);
      this.mesh.setMatrixAt(i, this.tmp);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

function tube(scene, pts, mat, r = 0.35) {
  const path = new THREE.CurvePath();
  for (let i = 0; i < pts.length - 1; i++) path.add(new THREE.LineCurve3(pts[i], pts[i + 1]));
  const geo = new THREE.TubeGeometry(path, pts.length * 8, r, 8, false);
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  scene.add(m);
  // Trestles under the pipe.
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const len = a.distanceTo(b);
    for (let s = 8; s < len; s += 12) {
      const p = a.clone().lerp(b, s / len);
      if (p.y > 1.5) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.35, p.y, 0.35), mat.userData.post || mat);
        post.position.set(p.x, p.y / 2, p.z);
        scene.add(post);
      }
    }
  }
  return m;
}

const V = (x, y, z) => new THREE.Vector3(x, y, z);

export class PlantView {
  constructor(scene, M, { labelsVisible = true } = {}) {
    this.scene = scene;
    this.M = M;
    this.pickables = [];
    this.labels = [];
    this.vehicles = new Map();
    this.people = new Map();
    this.gauges = new Map();
    this.beacons = new Map();
    this.storeLabels = new Map();
    this.lamps = new Map();
    this.flows = {};
    this.smoke = [];
    this.time = 0;
    this.labelsVisible = labelsVisible;
    B.setMaterials(M);
    this.wall = new DashboardWall(); // video wall of the monitoring room
    this.monitorMode = false;
    this.camera = null;
    this.buildStatic();
    this.buildFlows();
    this.buildSelection();
  }

  pick(obj, kind, id) {
    obj.traverse((o) => (o.userData.pickRoot = obj));
    obj.userData.pick = { kind, id };
    this.pickables.push(obj);
  }

  label(text, pos, cls = '') {
    const el = document.createElement('div');
    el.className = `lbl ${cls}`;
    el.innerHTML = text;
    const o = new CSS2DObject(el);
    o.position.copy(pos);
    o.center.set(0.5, 1);
    o.userData.prio = cls.includes('store') ? 2 : 1; // silos/tanks win over zone names
    this.scene.add(o);
    this.labels.push(o);
    return el;
  }

  // Fades out labels that overlap on screen (higher priority and nearer first). Positions come
  // from projecting each label with the camera and sizes are cached per text, so this never
  // forces a layout every frame; labels fade instead of popping.
  declutter(camera, width, height) {
    const now = performance.now();
    if (!this.labelsVisible || now - (this.lastDeclutter || 0) < 200) return;
    this.lastDeclutter = now;
    const v = this._v || (this._v = new THREE.Vector3());
    const items = [];
    for (const o of this.labels) {
      const el = o.element;
      if (el.style.display === 'none') continue;
      o.getWorldPosition(v).project(camera);
      if (v.z < -1 || v.z > 1) continue;
      const html = el.innerHTML;
      if (o.userData.sizeFor !== html) {
        o.userData.sizeFor = html;
        o.userData.w = el.offsetWidth || 60;
        o.userData.h = el.offsetHeight || 18;
      }
      const x = (v.x * 0.5 + 0.5) * width;
      const y = (-v.y * 0.5 + 0.5) * height - 4;
      const w = o.userData.w;
      const h = o.userData.h;
      items.push({ el, prio: o.userData.prio, r: { left: x - w * o.center.x, right: x + w * (1 - o.center.x), top: y - h * o.center.y, bottom: y + h * (1 - o.center.y) } });
    }
    items.sort((a, b) => b.prio - a.prio || b.r.bottom - a.r.bottom);
    const placed = [];
    for (const it of items) {
      const { r } = it;
      const hit = placed.some((p) => r.left < p.right + 3 && r.right > p.left - 3 && r.top < p.bottom + 2 && r.bottom > p.top - 2);
      if (hit !== it.el.classList.contains('lbl-off')) it.el.classList.toggle('lbl-off', hit);
      if (!hit) placed.push(r);
    }
  }

  add(group, x, z, rotY = 0) {
    group.position.set(x, 0, z);
    group.rotation.y = rotY;
    this.scene.add(group);
    return group;
  }

  buildStatic() {
    // Buildings & equipment.
    for (const b of BUILDINGS) {
      let g;
      switch (b.type) {
        case 'warehouse':
          g = B.warehouse({ w: b.w, d: b.d, h: b.h, roof: b.roof });
          break;
        case 'prep':
          g = B.prepBuilding(b);
          break;
        case 'extraction':
          g = B.extractionPlant(b);
          break;
        case 'hexane':
          g = B.hexaneTank(b);
          break;
        case 'power':
          g = B.powerHouse(b);
          break;
        case 'chimney':
          g = B.chimney(b);
          break;
        case 'cooling':
          g = B.coolingTower(b);
          this.fans = g.userData.fans;
          break;
        case 'bufferSilo':
          g = B.bufferSilo(b);
          break;
        case 'dryer':
          g = B.dryer(b);
          break;
        case 'noria':
          g = B.noria(b);
          break;
        case 'gatehouse':
          g = B.gatehouse(b);
          break;
        case 'controlRoom':
          g = B.controlRoom(b, this.wall.materials);
          this.room = { g, b };
          break;
        default:
          g = B.building(b);
      }
      this.add(g, b.x, b.z);
      this.pick(g, 'building', b.id);
      if (b.type === 'controlRoom') {
        // Clicking the video wall opens the real Zabbix dashboard.
        for (const sc of g.userData.screens) {
          sc.userData.pickRoot = sc;
          sc.userData.pick = { kind: 'dashboard', id: 'zabbix' };
          this.pickables.push(sc);
        }
      }
      if (b.id === 'SP') {
        const gg = B.gauge(b.h * 0.8);
        gg.group.position.set(b.x, 0.5, b.z + b.r + 0.4);
        this.scene.add(gg.group);
        this.gauges.set('SP', gg);
      }
    }

    // Grain storage (silos & bulk warehouses) with level gauges.
    for (const s of STORAGES) {
      const g = s.kind === 'silo' ? B.silo({ r: s.r, h: s.h, small: s.r < 7 }) : B.warehouse({ w: s.w, d: s.d, h: s.h, roof: 'gray', doors: 3 });
      this.add(g, s.x, s.z);
      this.pick(g, 'storage', s.id);
      const gh = s.kind === 'silo' ? s.h * 0.85 : s.h * 0.8;
      const gg = B.gauge(gh, s.kind === 'silo' ? 1 : 1.6);
      if (s.kind === 'silo') gg.group.position.set(s.x - s.r * 0.55, 0.5, s.z + s.r * 0.86);
      else gg.group.position.set(s.x - s.w / 2 + 3, 0.5, s.z + s.d / 2 + 0.3);
      this.scene.add(gg.group);
      this.gauges.set(s.id, gg);
      const top = s.kind === 'silo' ? s.h + s.r * 0.5 + 3 : s.h + Math.min(s.w, s.d) * 0.22 + 2;
      this.storeLabels.set(s.id, this.label(`<b>${s.id}</b> <span>—</span>`, V(s.x, top, s.z), 'lbl-store'));
    }

    for (const t of OIL_TANKS) {
      const g = B.tank({ r: t.r, h: t.h });
      this.add(g, t.x, t.z);
      this.pick(g, 'tank', t.id);
      const gg = B.gauge(t.h * 0.85);
      gg.group.position.set(t.x - t.r - 0.2, 0.4, t.z);
      gg.group.rotation.y = -Math.PI / 2;
      this.scene.add(gg.group);
      this.gauges.set(t.id, gg);
      this.storeLabels.set(t.id, this.label(`<b>${t.id}</b> <span>—</span>`, V(t.x, t.h + 3, t.z), 'lbl-store'));
    }
    for (const t of DAY_TANKS) {
      const g = B.tank({ r: t.r, h: t.h, color: 'steel' });
      this.add(g, t.x, t.z);
      this.pick(g, 'dayTank', t.id);
    }
    for (const b of BOILERS) {
      const g = B.boiler();
      this.add(g, b.x, b.z);
      this.pick(g, 'boiler', b.id);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.6, 12, 8), new THREE.MeshBasicMaterial({ color: 0x2fbf71 }));
      lamp.position.set(b.x, 9, b.z);
      this.scene.add(lamp);
      this.lamps.set(b.id, lamp);
    }

    // Truck stations.
    this.stationObjs = {};
    for (const s of Object.values(STATIONS)) {
      if (s.id === 'GATE') continue;
      const g = STATION_BUILDERS[s.id]();
      this.add(g, s.x, s.z, STATION_ROT[s.id] ?? 0);
      this.pick(g, 'station', s.id);
      this.stationObjs[s.id] = g;
    }
    // Gate: one barrier per lane of the access road (entry and exit). Each boom pivots on its
    // post and is raised only when the simulation lets a truck through.
    this.gateBooms = {};
    for (const k of ['in', 'out']) {
      const L = GATE_LANES[k];
      const gate = new THREE.Group();
      const dir = Math.sign(L.z - L.post) || 1; // the boom reaches across its lane
      const len = Math.abs(L.z - L.post) + 2;
      B.box(gate, 0.45, 1.3, 0.45, this.M.yellow, 0, 0.65, 0);
      B.box(gate, 0.7, 0.5, 0.9, this.M.yellow, 0, 1.15, -dir * 0.3); // counterweight housing
      const boom = new THREE.Group();
      boom.position.set(0, 1.15, 0);
      B.box(boom, 0.16, 0.16, len, this.M.redWhite, 0, 0, (dir * len) / 2, { cast: false });
      B.box(boom, 0.12, 0.7, 0.12, this.M.yellow, 0, -0.35, dir * (len - 0.2), { cast: false }); // tip support
      gate.add(boom);
      boom.userData.up = -dir * (Math.PI / 2) * 0.96;
      boom.userData.k = k;
      this.add(gate, L.boomX, L.post);
      this.pick(gate, 'station', 'GATE');
      this.gateBooms[k] = boom;
    }
    this.gateOpen = { in: false, out: false };

    // Zone labels.
    const zones = [
      ['Oficinas', 26, 12, -112], ['Almacén general', -14, 14, -112], ['Taller', -46, 10, -112], ['Tanques diarios', 43, 12, -115],
      ['Preparación', 18, 24, -72], ['Extracción (hexano)', 18, 30, -38], ['Sala de fuerza', 44, 44, -55],
      ['Galpón harina', -14, 18, -30], ['Galpón cascarilla', -14, 14, -66], ['Silo pulmón', -46, 30, -60],
      ['Playa de camiones', 36, 6, 70], ['Portería', 71, 7, 66], ['Laboratorio', 46, 8, 41], ['Ruta Nacional 4 (doble vía)', RN4.medianX, 2, -60],
      ['Retorno norte', RN4.medianX, 3, RN4.retN - 4], ['Retorno sur', RN4.medianX, 3, RN4.retS + 4], ['Calador', 4, 9, 44], ['Balanza de ingreso', -16, 6, 44],
      ['Balanza de tara (despacho)', 60, 6, 30], ['Balanza bruto (despacho)', -34, 6, -2],
    ];
    for (const [t, x, y, z] of zones) this.label(t, V(x, y, z), 'lbl-zone');
  }

  buildFlows() {
    const M = this.M;
    M.pipeOil.userData.post = M.steel;
    M.pipeHex.userData.post = M.steel;
    M.pipeSteam.userData.post = M.steel;
    // Galleries (conveyors) — static structures.
    const gal = (a, b) => this.scene.add(B.gallery(a, b));
    gal(V(-40, 36, 102), V(-40, 36, 109));
    gal(V(-40, 36, 109), V(36, 34, 109));
    gal(V(-50, 31, 56), V(-46, 25, 40));
    gal(V(-46, 25, 40), V(-46, 25, 14));
    gal(V(-46, 22, -60), V(5, 14, -72));
    gal(V(18, 12, -63), V(18, 14, -48));
    gal(V(7, 9, -36), V(2, 9, -30));
    // Ground conveyor from storage to buffer silo.
    gal(V(-53, 3, 100), V(-53, 3, -55));

    // Pipes.
    tube(this.scene, [V(29, 6, -36), V(34, 6, -36), V(34, 6, 7), V(46.5, 6, 7), V(46.5, 6, 8.5)], M.pipeOil, 0.4);
    tube(this.scene, [V(22, 2.5, -14), V(22, 2.5, -20), V(22, 8, -26)], M.pipeHex, 0.3);
    tube(this.scene, [V(40, 7, -41), V(30, 7, -41)], M.pipeSteam, 0.35);
    tube(this.scene, [V(46.5, 3, 35.5), V(51.2, 3, 35.5), V(51.2, 3, 6.5), V(47, 3, 6.5)], M.pipeOil, 0.3);

    const soy = 0xe9c46a;
    this.flows.H1 = [
      new FlowLine(this.scene, [V(-40, 0.6, 93), V(-40, 0.6, 102), V(-40, 36, 102)], soy, { count: 26, speed: 14 }),
      new FlowLine(this.scene, [V(-40, 37.2, 102), V(-40, 37.2, 109), V(36, 35.2, 109)], soy, { count: 40, speed: 16 }),
    ];
    this.flows.H2 = [
      new FlowLine(this.scene, [V(-44, 0.6, 49), V(-50, 0.6, 56), V(-50, 31, 56)], soy, { count: 22, speed: 14 }),
      new FlowLine(this.scene, [V(-50, 32.2, 56), V(-46, 26.2, 40), V(-46, 26.2, 14)], soy, { count: 26, speed: 14 }),
    ];
    this.flows.crush = [
      new FlowLine(this.scene, [V(-53, 4.2, 100), V(-53, 4.2, -55)], soy, { count: 60, speed: 12 }),
      new FlowLine(this.scene, [V(-46, 23.2, -60), V(5, 15.2, -72)], soy, { count: 22, speed: 12 }),
      new FlowLine(this.scene, [V(18, 13.2, -63), V(18, 15.2, -48)], 0xd9b26f, { count: 10, speed: 10 }),
      new FlowLine(this.scene, [V(7, 10.2, -36), V(2, 10.2, -30)], 0xc9a16a, { count: 6, speed: 8 }),
    ];
    this.flows.oil = [new FlowLine(this.scene, [V(29, 6.6, -36), V(34, 6.6, -36), V(34, 6.6, 7), V(46.5, 6.6, 7)], 0xffb000, { count: 40, size: 0.45, speed: 10 })];
    this.flows.hex = [new FlowLine(this.scene, [V(22, 3, -14), V(22, 3, -20), V(22, 8.5, -26)], 0xff5a4f, { count: 8, size: 0.35, speed: 5 })];
    this.flows.steam = [new FlowLine(this.scene, [V(40, 7.5, -41), V(30, 7.5, -41)], 0xffffff, { count: 8, size: 0.4, speed: 8 })];
    this.flows.OL = [new FlowLine(this.scene, [V(51.2, 3.6, 35.5), V(51.2, 3.6, 6.5), V(47, 3.6, 6.5)], 0xffb000, { count: 14, size: 0.35, speed: 9 })];
    this.flows.ML = [new FlowLine(this.scene, [V(-14, 10.6, -16), V(-14, 10.6, 3)], 0xc9a16a, { count: 10, size: 0.45, speed: 8 })];
    this.scene.add(B.gallery(V(-14, 10, -17), V(-14, 10, 3)));

    // Chimney smoke puffs.
    const chim = BUILDINGS.find((b) => b.id === 'CHIM');
    for (let i = 0; i < 18; i++) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), this.M.smoke.clone());
      s.userData.phase = i / 18;
      s.userData.base = V(chim.x, chim.h, chim.z);
      this.scene.add(s);
      this.smoke.push(s);
    }
  }

  buildSelection() {
    const ring = new THREE.Mesh(new THREE.RingGeometry(1, 1.25, 48), this.M.select);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.3;
    ring.visible = false;
    ring.renderOrder = 10;
    this.scene.add(ring);
    this.selRing = ring;
    this.selected = null;
  }

  select(pick) {
    this.selected = pick;
    this.selInfo = null;
    this.selRing.visible = !!pick;
  }

  findObject(pick) {
    if (!pick) return null;
    if (pick.kind === 'truck') return this.vehicles.get(pick.id);
    if (pick.kind === 'person') return this.people.get(pick.id);
    return this.pickables.find((p) => p.userData.pick.kind === pick.kind && p.userData.pick.id === pick.id);
  }

  setLabelsVisible(v) {
    this.labelsVisible = v;
    for (const l of this.labels) l.visible = v;
  }

  // ───────────── per-snapshot (state) updates ─────────────
  applyState(s) {
    this.wall.update(s);
    for (const st of s.storages) {
      const g = this.gauges.get(st.id);
      if (g) g.set(st.pct, st.temp > 32 ? 0xe5484d : levelColor(st.pct));
      setHtml(this.storeLabels.get(st.id), `<b>${st.id}</b> <span>${st.pct.toFixed(0)}%</span>`);
    }
    for (const t of s.tanks) {
      this.gauges.get(t.id)?.set(t.pct, levelColor(t.pct));
      setHtml(this.storeLabels.get(t.id), `<b>${t.id}</b> <span>${t.pct.toFixed(0)}%</span>`);
    }
    this.gauges.get('SP')?.set((s.buffer.stock / s.buffer.cap) * 100, 0x2fbf71);
    for (const b of s.boilers) {
      this.lamps.get(b.id)?.material.color.setHex(b.on ? 0x2fbf71 : 0xe5484d);
    }
    const crushing = s.proc.feed > 0.05;
    for (const f of this.flows.H1) f.active = !!s.flows.H1;
    for (const f of this.flows.H2) f.active = !!s.flows.H2;
    for (const f of this.flows.crush) f.active = crushing;
    for (const f of this.flows.oil) f.active = crushing;
    for (const f of this.flows.hex) f.active = crushing;
    for (const f of this.flows.steam) f.active = s.boilers.some((b) => b.on);
    for (const f of this.flows.OL) f.active = !!s.flows.OL;
    for (const f of this.flows.ML) f.active = !!s.flows.ML;
    this.boilersOn = s.boilers.filter((b) => b.on).length;
    this.crushing = crushing;
    this.stationState = s.stations;

    // Alarm beacons for active problems.
    const want = new Map();
    for (const p of s.problems) {
      // Traffic incidents follow the crash site (or the truck without brakes).
      let pos = sourcePos(p.src);
      if (p.src === 'VIA') {
        const c = s.traffic?.collision;
        const j = s.traffic?.jam;
        const v = !c && (s.vehicles.find((x) => x.stalled) || s.vehicles.find((x) => x.brakeFail));
        pos = c ? new THREE.Vector3(c.x, 14, c.z) : v ? new THREE.Vector3(v.x, 14, v.z) : j ? new THREE.Vector3(j.x, 14, j.z) : null;
      }
      if (!pos) continue;
      const key = p.src;
      if (!want.has(key) || want.get(key).sev < p.sev) want.set(key, { pos, sev: p.sev });
    }
    for (const [k, b] of this.beacons) {
      if (!want.has(k)) {
        this.scene.remove(b);
        this.beacons.delete(k);
      }
    }
    for (const [k, w] of want) {
      let b = this.beacons.get(k);
      if (!b) {
        b = new THREE.Group();
        const cone = new THREE.Mesh(new THREE.ConeGeometry(1.4, 3, 4), new THREE.MeshBasicMaterial({ color: 0xe5484d }));
        cone.rotation.x = Math.PI;
        b.add(cone);
        const halo = new THREE.Mesh(new THREE.SphereGeometry(2.6, 16, 12), new THREE.MeshBasicMaterial({ color: 0xe5484d, transparent: true, opacity: 0.25, depthWrite: false }));
        b.add(halo);
        b.userData.halo = halo;
        this.scene.add(b);
        this.beacons.set(k, b);
      }
      const color = [0x7aa2ff, 0xf2c94c, 0xf2994a, 0xe5484d, 0xb3261e][w.sev];
      b.children[0].material.color.setHex(color);
      b.userData.halo.material.color.setHex(color);
      b.position.copy(w.pos);
    }
  }

  // ───────────── per-frame updates (interpolated) ─────────────
  // `smp` holds four frames around the playback time (p0, a, b, p3) and alpha between a and b:
  // positions follow a smooth curve through the frames (corners become bends instead of
  // zigzags) and the heading follows the curve, turning at a limited rate.
  syncAgents(smp, dt, speed) {
    const { p0, a, b, p3, alpha } = smp;
    const k = Math.max(1, Math.min(speed || 1, 8));
    const ease = (rate) => 1 - Math.exp(-dt * rate);
    const byId = (snap, key) => (snap[`_${key}`] ??= new Map(snap[key].map((o) => [o.id, o])));

    // Vehicles.
    const seen = new Set();
    const A = byId(a, 'vehicles');
    const P0 = byId(p0, 'vehicles');
    const P3 = byId(p3, 'vehicles');
    for (const v of b.vehicles) {
      seen.add(v.id);
      let g = this.vehicles.get(v.id);
      if (!g) {
        g = v.kind === 'car' ? B.car(v.variant, v.color) : B.truck(v.kind, parseInt(v.id.slice(1), 10));
        g.userData.pick = { kind: 'truck', id: v.id };
        g.traverse((o) => (o.userData.pickRoot = g));
        g.userData.lat = 0;
        this.scene.add(g);
        this.vehicles.set(v.id, g);
      }
      const ud = g.userData;
      const va = A.get(v.id) || v;
      const px = ud.pos?.x;
      const pz = ud.pos?.z;
      const pos = curvePoint(P0.get(v.id) || va, va, v, P3.get(v.id) || v, alpha, ud.pos || (ud.pos = { x: 0, z: 0 }));
      const moved = px === undefined ? 0 : Math.hypot(pos.x - px, pos.z - pz);
      const dir = curveDir(P0.get(v.id) || va, va, v, P3.get(v.id) || v, alpha);
      const want = dir === null ? lerpAngle(va.h, v.h, Math.min(1, alpha)) : dir;
      // A truck can only turn as fast as it rolls (no pivoting on the spot): the yaw rate is
      // limited by its speed over a minimum turning radius, with a small floor for manoeuvres.
      const rollU = Math.max(moved / Math.max(dt, 1e-3), (v.speedKmh ?? 0) / 2.6);
      const maxRate = v.kind === 'car' ? 2.4 * k : Math.max(0.5 * k, rollU / 3);
      ud.yaw = ud.yaw === undefined ? want : turnToward(ud.yaw, want, ease(7), maxRate * dt);
      // Overtaking / priority passing: drive in the opposite lane (shifted to the left).
      ud.lat += ((v.passing ? 3.4 : 0) - ud.lat) * ease(3 * k);
      g.position.set(pos.x + Math.sin(ud.yaw) * ud.lat, 0, pos.z - Math.cos(ud.yaw) * ud.lat);
      g.rotation.y = -ud.yaw - (v.crashed ? v.tilt : 0);
      // Wheels turn with the distance travelled; the semitrailer follows the king pin
      // (kinematic hitch: it cuts inside the curve, as a real one does).
      if (moved > 0 && moved < 5) for (const w of ud.wheels || []) w.rotation.z -= moved / ud.wheelR;
      if (ud.trailer) {
        let turn = ud.yaw - (ud.prevYaw ?? ud.yaw);
        while (turn > Math.PI) turn -= Math.PI * 2;
        while (turn < -Math.PI) turn += Math.PI * 2;
        ud.prevYaw = ud.yaw;
        if (ud.trailerYaw === undefined || moved >= 5) ud.trailerYaw = ud.yaw;
        else if (!v.crashed) {
          // Turning almost on the spot (the route reverses at a station): the rig turns as a whole.
          if (moved < Math.abs(turn) * 1.5) ud.trailerYaw += turn;
          let d = ud.yaw - ud.trailerYaw;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          ud.trailerYaw += Math.sin(d) * Math.min(1, moved / ud.trailerLen);
          d = ud.yaw - ud.trailerYaw;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          if (Math.abs(d) > 1.2) ud.trailerYaw = ud.yaw - Math.sign(d) * 1.2; // never jackknife
        }
        ud.trailer.rotation.y = ud.trailerYaw - ud.yaw;
      }
      const load = ud.load;
      if (load) {
        const l = Math.max(0.02, v.loaded);
        load.scale.y = l * 1.6;
        load.position.y = 1.3 + (l * 1.6) / 2;
      }
      ud.brakeMat.emissiveIntensity = v.braking || v.crashed || (!v.moving && v.speedKmh === 0 && v.waitReason) ? 2.2 : this.night ? 0.9 : 0.12;
      // Warning triangle behind a crashed truck.
      if (v.crashed && !ud.triangle) {
        const tri = B.warningTriangle();
        tri.position.set(-9, 0, 0);
        g.add(tri);
        ud.triangle = tri;
      } else if (!v.crashed && ud.triangle) {
        g.remove(ud.triangle);
        ud.triangle = null;
      }
      ud.state = v;
    }
    for (const [id, g] of this.vehicles) {
      if (!seen.has(id)) {
        this.scene.remove(g);
        this.vehicles.delete(id);
        if (this.selected?.kind === 'truck' && this.selected.id === id) this.select(null);
      }
    }
    // People.
    const PA = byId(a, 'people');
    const PP0 = byId(p0, 'people');
    const PP3 = byId(p3, 'people');
    for (const p of b.people) {
      let g = this.people.get(p.id);
      if (!g) {
        g = B.person(p.helmet, p.vest, { kind: p.kind, seed: parseInt(p.id.slice(1), 10) * 7 });
        g.userData.pick = { kind: 'person', id: p.id };
        g.traverse((o) => (o.userData.pickRoot = g));
        if (p.kind === 'tech' || p.kind === 'manager') {
          const c = B.cart();
          c.visible = false;
          c.scale.setScalar(1.3); // the person group is scaled 0.74
          g.add(c);
          g.userData.cart = c;
        }
        this.scene.add(g);
        this.people.set(p.id, g);
      }
      const ud = g.userData;
      const q = PA.get(p.id) || p;
      const pos = curvePoint(PP0.get(p.id) || q, q, p, PP3.get(p.id) || p, alpha, ud.pos || (ud.pos = { x: 0, z: 0 }));
      const dir = curveDir(PP0.get(p.id) || q, q, p, PP3.get(p.id) || p, alpha);
      const want = dir === null ? lerpAngle(q.h, p.h, Math.min(1, alpha)) : dir;
      ud.yaw = ud.yaw === undefined ? want : turnToward(ud.yaw, want, ease(12), 7 * k * dt);
      g.position.set(pos.x, 0, pos.z);
      g.rotation.y = -ud.yaw;
      ud.moving = p.moving;
      // Technicians ride a cart while driving to/from a job (sitting a bit higher).
      if (ud.cart) {
        const riding = p.riding ?? p.moving;
        ud.cart.visible = riding;
        ud.legs.visible = !riding;
        g.children.forEach((c) => c !== ud.cart && c !== ud.legs && (c.position.y = (c.userData.baseY ??= c.position.y) + (riding ? 0.35 : 0)));
      }
      this.bubble(g, p.say);
    }
  }

  // Speech bubble above a person (CSS2D, independent of the labels toggle).
  bubble(g, text) {
    if (!text) {
      if (g.userData.bubble) g.userData.bubble.visible = false;
      return;
    }
    if (!g.userData.bubble) {
      const el = document.createElement('div');
      el.className = 'bubble';
      const o = new CSS2DObject(el);
      o.position.set(0, 2.6, 0);
      o.center.set(0.5, 1);
      g.add(o);
      g.userData.bubble = o;
    }
    const o = g.userData.bubble;
    o.visible = true;
    if (o.element.textContent !== text) o.element.textContent = text;
  }

  frame(dt, speed, playT = null, night = false) {
    this.time += dt;
    // Gate barriers follow the simulation clock: the boom takes 0.3 simulated minutes to go up
    // or down — exactly what the truck waits at the line — so it is up when the truck moves,
    // at any simulation speed.
    if (this.gateBooms) {
      for (const boom of Object.values(this.gateBooms)) {
        const g = this.gateOpen?.[boom.userData.k];
        let f;
        if (g && typeof g === 'object' && playT !== null) {
          const p = Math.max(0, Math.min(1, (playT - (g.since ?? 0)) / 0.3));
          f = g.open ? p : 1 - p;
        } else f = g ? 1 : 0;
        const target = boom.userData.up * f;
        // Light smoothing between frames only.
        boom.rotation.x += (target - boom.rotation.x) * Math.min(1, dt * 12);
      }
    }
    // Night: headlights and brake lights glow; street lights on.
    if (night !== this.night) {
      this.night = night;
      B.setNightLights(night);
    }
    // Monitoring room: the roof fades out when looking into the room.
    if (this.room && this.camera) {
      const { g, b } = this.room;
      const c = this.camera.position;
      const near = Math.hypot(c.x - b.x, c.z - b.z) < 30 && c.y < 40;
      const want = this.monitorMode || near ? 0.0 : 1;
      const m = g.userData.roofMat;
      m.opacity += (want - m.opacity) * Math.min(1, dt * 4);
      g.userData.roof.visible = m.opacity > 0.03;
      m.depthWrite = m.opacity > 0.95;
      g.userData.roof.castShadow = m.opacity > 0.95;
    }
    const k = Math.max(1, Math.min(speed || 1, 6));
    for (const list of Object.values(this.flows)) for (const f of list) f.update(dt * k);
    if (this.fans) for (const f of this.fans) f.rotation.y += dt * (this.crushing ? 6 : 1.5);
    // Smoke depends on boilers in service.
    const on = this.boilersOn ?? 2;
    for (const s of this.smoke) {
      const ph = (s.userData.phase + this.time * 0.08) % 1;
      s.userData.phase2 = ph;
      const base = s.userData.base;
      s.position.set(base.x + ph * 14, base.y + ph * 22, base.z - ph * 6);
      s.scale.setScalar(1.2 + ph * 5);
      s.material.opacity = on === 0 ? 0 : (1 - ph) * 0.32 * (on / 2);
      s.visible = on > 0;
    }
    // Hazard lights blink on crashed trucks, trucks without brakes and the tow truck.
    const blink = Math.sin(this.time * 9) > 0 ? 2.6 : 0;
    for (const g of this.vehicles.values()) {
      const v = g.userData.state;
      if (v) g.userData.amberMat.emissiveIntensity = v.crashed || v.brakeFail || v.stalled || v.kind === 'tow' ? blink : 0;
    }
    // People walking animation.
    for (const g of this.people.values()) {
      const { legs, arms } = g.userData;
      const walking = g.userData.moving && legs.visible;
      const ph = this.time * 8 + (g.id % 7);
      const swing = walking ? Math.sin(ph) * 0.55 : 0;
      legs.children[0].rotation.z += (swing - legs.children[0].rotation.z) * Math.min(1, dt * 12);
      legs.children[1].rotation.z += (-swing - legs.children[1].rotation.z) * Math.min(1, dt * 12);
      if (arms) {
        // Arms swing opposite to the legs; at rest a slight breathing sway.
        const rest = walking ? 0 : Math.sin(this.time * 1.6 + g.id) * 0.03;
        arms[0].rotation.z += (-swing * 0.8 + rest - arms[0].rotation.z) * Math.min(1, dt * 12);
        arms[1].rotation.z += (swing * 0.8 + rest - arms[1].rotation.z) * Math.min(1, dt * 12);
      }
    }
    // Station animations.
    const st = this.stationState || {};
    const samp = this.stationObjs.SAMP?.userData;
    if (samp) {
      const busy = st.SAMP?.busy > 0;
      samp.probe.position.y = -2 - (busy ? (Math.sin(this.time * 1.5) * 0.5 + 0.5) * 3 : 0);
      samp.boom.rotation.y = busy ? Math.sin(this.time * 0.4) * 0.3 : 0;
    }
    for (const id of ['OL', 'ML']) {
      const arm = this.stationObjs[id]?.userData.arm;
      if (arm) arm.rotation.z += ((this.flows[id][0].active ? -0.5 : 0) - arm.rotation.z) * Math.min(1, dt * 2);
    }
    for (const id of ['BAL_IN', 'BAL_OUT', 'BAL_D']) {
      const arm = this.stationObjs[id]?.userData.arm;
      if (arm) arm.rotation.x += ((st[id]?.busy ? 0 : 0) - arm.rotation.x) * dt;
    }
    // Beacons pulse.
    for (const b of this.beacons.values()) {
      const s = 1 + Math.sin(this.time * 5) * 0.25;
      b.userData.halo.scale.setScalar(s);
      b.children[0].position.y = Math.sin(this.time * 3) * 0.6;
      b.rotation.y += dt * 2;
    }
    // Selection ring follows the selected object (its size is measured once).
    if (this.selected) {
      const obj = this.findObject(this.selected);
      if (!obj) {
        this.selRing.visible = false;
      } else {
        if (this.selInfo?.obj !== obj) {
          const box = new THREE.Box3().setFromObject(obj);
          const size = box.getSize(new THREE.Vector3());
          const c = box.getCenter(new THREE.Vector3());
          const moving = this.selected.kind === 'truck' || this.selected.kind === 'person';
          this.selInfo = { obj, r: Math.max(size.x, size.z) * (moving ? 0.5 : 0.62) + 1.5, dx: moving ? 0 : c.x - obj.position.x, dz: moving ? 0 : c.z - obj.position.z };
        }
        const si = this.selInfo;
        this.selRing.position.set(obj.position.x + si.dx, 0.3, obj.position.z + si.dz);
        this.selRing.scale.setScalar(si.r * (1 + Math.sin(this.time * 4) * 0.04));
        this.selRing.visible = true;
      }
    }
  }
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}
function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function setHtml(el, html) {
  if (el && el.innerHTML !== html) el.innerHTML = html;
}

// Turns `cur` toward `want` (radians) with smoothing `f` and at most `max` per call.
function turnToward(cur, want, f, max) {
  let d = want - cur;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return cur + Math.max(-max, Math.min(max, d * f));
}

// Cubic Hermite through frames p1 → p2 with Catmull-Rom tangents, limited so a vehicle that
// stops or starts never overshoots. Past p2 (t > 1) it extrapolates in a straight line.
function curvePoint(p0, p1, p2, p3, t, out) {
  const dx = p2.x - p1.x;
  const dz = p2.z - p1.z;
  const d = Math.hypot(dx, dz);
  if (t >= 1 || d < 0.02) {
    out.x = p1.x + dx * t;
    out.z = p1.z + dz * t;
    return out;
  }
  const m1 = tangent(p0, p2, d);
  const m2 = tangent(p1, p3, d);
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  out.x = h00 * p1.x + h10 * m1.x + h01 * p2.x + h11 * m2.x;
  out.z = h00 * p1.z + h10 * m1.z + h01 * p2.z + h11 * m2.z;
  return out;
}

function tangent(a, b, d) {
  let x = (b.x - a.x) / 2;
  let z = (b.z - a.z) / 2;
  const l = Math.hypot(x, z);
  if (l > d * 1.2) {
    x *= (d * 1.2) / l;
    z *= (d * 1.2) / l;
  }
  return { x, z };
}

// Direction of travel along the curve (null when standing still).
const _c1 = { x: 0, z: 0 };
const _c2 = { x: 0, z: 0 };
function curveDir(p0, p1, p2, p3, t) {
  if (Math.hypot(p2.x - p1.x, p2.z - p1.z) < 0.02) return null;
  const ta = Math.max(0, Math.min(1, t) - 0.04);
  const tb = Math.min(1, Math.min(1, t) + 0.04);
  curvePoint(p0, p1, p2, p3, ta, _c1);
  curvePoint(p0, p1, p2, p3, tb, _c2);
  const dx = _c2.x - _c1.x;
  const dz = _c2.z - _c1.z;
  if (Math.hypot(dx, dz) < 1e-4) return null;
  return Math.atan2(dz, dx);
}
