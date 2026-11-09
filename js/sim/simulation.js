// Plant simulation engine (runs on the Node server, or in the browser as fallback).
//
// Architecture borrowed from AI Town:
//  - a fixed-step engine (`advance`) that mutates a serialisable world state,
//  - agents (trucks, operators) driven by small state machines / plans,
//  - A* over a walkability grid for movement,
//  - snapshots streamed to clients, which interpolate between them.
// Time: 1 movement-second == 1 simulated minute (so at 1x a sim day lasts 24 real minutes).

import { GRID_BOUNDS, ROADS, SITE, STATIONS, SPAWN, YARD_SLOTS, YARD_AISLE_Z, STORAGES, OIL_TANKS, DAY_TANKS, BOILERS, BUILDINGS } from './layout.js';
import { Grid, offsetRight, lanePath } from './grid.js';
import { MONITOR_ROOM } from './layout.js';
import { PROBLEMS, PROBLEM_BY_ID, PLC_EXT_FIELDS } from './problems.js';
import { IoTFleet } from './iot.js';
import { CepEngine } from './cep.js';
import { Traffic, moveTo, KMH } from './traffic.js';
import { Staff, STAFF, LOOK, WORKSHOP_SPOT } from './staff.js';

export const SEVERITY = ['Información', 'Advertencia', 'Promedio', 'Alta', 'Desastre'];
export const NOMINAL_CRUSH = 1.05; // t/min ≈ 1500 t/day
const PERSON_SPEED = 1.4;
export // Heading of the road a route ends on: the last segment that is not a short lane merge,
// snapped to the road axis.
function roadHeading(path, fallback) {
  for (let i = (path?.length ?? 0) - 1; i > 0; i--) {
    const dx = path[i].x - path[i - 1].x;
    const dz = path[i].z - path[i - 1].z;
    if (Math.hypot(dx, dz) >= 5) return Math.round(Math.atan2(dz, dx) / (Math.PI / 2)) * (Math.PI / 2);
  }
  return fallback;
}

const CAR_COLORS = [0xf2f2f0, 0x1c1c1e, 0x9aa1a8, 0xb3261e, 0x1f4e8c, 0x5c6b73, 0x2f5d3a, 0xc8b28a];

// Waiting points on the RN4 shoulders, beside the driving lanes (northbound ≈ x 76, southbound ≈ x 72).
const PREGATE_SOY = { x: 80, z: 86 };
const PREGATE_DISPATCH = { x: 68, z: 56 };

const DEFAULT_REALISM = { collisions: true, incidentsPerDay: 8, distractionPerHour: 0.15, speedFactor: 1, techsRepairManual: false, escalation1: 15, escalation2: 40 };
const ORIGINS = ['San Julián', 'Cuatro Cañadas', 'Pailón', 'Okinawa', 'Montero', 'Mineros', 'Guarayos', 'San Pedro', 'Fernández Alonso'];
const FIRST = ['Juan', 'Carlos', 'Luis', 'Marco', 'Jorge', 'Pedro', 'Raúl', 'Diego', 'Mario', 'Hugo', 'Óscar', 'Wilson', 'Edwin', 'Fredy'];
const LAST = ['Rojas', 'Vargas', 'Gutiérrez', 'Mamani', 'Suárez', 'Justiniano', 'Áñez', 'Ribera', 'Flores', 'Peña', 'Saucedo', 'Melgar'];

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const expo = (mean) => -Math.log(1 - Math.random()) * mean;
const plate = () => `${Math.floor(rand(1000, 5999))}${String.fromCharCode(65 + Math.floor(rand(0, 26)))}${String.fromCharCode(65 + Math.floor(rand(0, 26)))}${String.fromCharCode(65 + Math.floor(rand(0, 26)))}`;

function buildRoadGrid(withYard = true) {
  const g = new Grid(GRID_BOUNDS);
  for (const r of ROADS) if (withYard || !r.yard) g.paintRect(...r.rect, 1);
  return g;
}

function buildPedGrid(offRoad = false) {
  const g = new Grid(GRID_BOUNDS);
  g.paintRect(SITE.x0 + 2, SITE.z0 + 2, SITE.x1 - 2, SITE.z1 - 2, 1);
  if (offRoad) for (const r of ROADS) g.paintRect(...r.rect, 0); // spots to stand on without blocking traffic
  const block = (x, z, w, d) => g.paintRect(x - w / 2 - 1, z - d / 2 - 1, x + w / 2 + 1, z + d / 2 + 1, 0);
  for (const b of BUILDINGS) if (b.block) b.r ? block(b.x, b.z, b.r * 2, b.r * 2) : block(b.x, b.z, b.w, b.d);
  // Monitoring room: walls block, the interior is walkable, entrance through the south door.
  const R = MONITOR_ROOM;
  block(R.x, R.z, R.w, R.d);
  g.paintRect(R.x - R.w / 2 + 1, R.z - R.d / 2 + 1, R.x + R.w / 2 - 1, R.z + R.d / 2 - 1, 1);
  g.paintRect(R.door.x - 1.5, R.z + R.d / 2 - 2, R.door.x + 1.5, R.door.z + 1, 1);
  for (const s of STORAGES) s.r ? block(s.x, s.z, s.r * 2, s.r * 2) : block(s.x, s.z, s.w, s.d);
  for (const t of [...OIL_TANKS, ...DAY_TANKS]) block(t.x, t.z, t.r * 2, t.r * 2);
  if (!offRoad) {
    // Walking along a road costs more: people cross roads instead of strolling down them.
    g.cost = new Uint8Array(g.w * g.h);
    const road = new Grid(GRID_BOUNDS);
    for (const r of ROADS) if (!r.highway) road.paintRect(...r.rect, 1);
    for (let i = 0; i < g.cost.length; i++) if (road.cells[i]) g.cost[i] = 6;
  }
  return g;
}

// Where each operator walks (AI Town agents have plans; ours have routines).
const STAFF_TECH_INDEX = { n: 0 };

// Operators: a fixed post facing their equipment (post: [x, z, lookX, lookZ]) and a short
// round inside their own area. They spend most of the shift at the post.
const ROUTINES = [
  { name: 'Balancero', role: 'Recepción · Balanza de ingreso', helmet: 0xffffff, post: [24, 44, 24, 49], round: [[30, 44], [18, 44]] },
  { name: 'Calador', role: 'Recepción / Calidad · Calador', helmet: 0x2b7fff, post: [33, 44, 38, 49], round: [[38, 44], [28, 44]] },
  { name: 'Laboratorista', role: 'Control de calidad · Laboratorio', helmet: 0xffffff, post: [39, 45, 46, 41], round: [[36, 45]] },
  { name: 'Op. Volcadoras', role: 'Acopio · Volcadora 1 y noria', helmet: 0xffd400, post: [-35, 99, -40, 93], round: [[-48, 99], [-31, 97]] },
  { name: 'Op. Silos', role: 'Acopio · Silos', helmet: 0xffd400, post: [-14, 97.5, -14, 109], round: [[-24, 97.5], [6, 97.5]] },
  { name: 'Op. Preparación', role: 'Producción · Preparación', helmet: 0xffd400, post: [3, -77, 18, -72], round: [[3, -83], [10, -84]] },
  { name: 'Op. Extracción', role: 'Producción (zona hexano) · Extracción', helmet: 0xff7a00, post: [4.5, -38, 18, -38], round: [[4.5, -30], [4.5, -46]] },
  { name: 'Op. Sala de fuerza', role: 'Energía / Calderas', helmet: 0xff7a00, post: [35.5, -58, 44, -60], round: [[35.5, -50], [35.5, -66]] },
  { name: 'Supervisor de turno', role: 'Supervisión · Recepción, acopio y despacho', kind: 'supervisor', staffId: 'SUP', post: [51, 97, 36, 71], round: [[38, 97.5], [46, 97.5]] },
];

export class Simulation {
  constructor({ randomFaults = false, realism = {} } = {}) {
    this.realism = { ...DEFAULT_REALISM, ...realism };
    this.t = 6 * 60; // minutes since day 1 00:00
    this.speed = 1;
    this.tick = 0;
    this.nextId = 1;
    this.road = buildRoadGrid();
    this.roadNoYard = buildRoadGrid(false); // through traffic goes around the parked trucks
    this.ped = buildPedGrid();
    this.pedOff = buildPedGrid(true);
    this.stations = Object.fromEntries(Object.values(STATIONS).map((s) => [s.id, { ...s, users: new Set(), opsToday: 0 }]));
    this.yard = YARD_SLOTS.map((s, i) => ({ ...s, i, truck: null }));
    this.storages = STORAGES.map((s) => ({ ...s, stock: s.cap * rand(0.42, 0.72), temp: rand(22, 26.5), hum: rand(11.6, 12.8), inflow: 0, outflow: 0 }));
    this.tanks = OIL_TANKS.map((t) => ({ ...t, stock: t.cap * rand(0.3, 0.55), temp: rand(36, 40), inflow: 0 }));
    this.dayTanks = DAY_TANKS.map((t) => ({ id: t.id, pct: rand(30, 85), phase: rand(0, 6) }));
    this.meal = { stock: 2600, cap: 9000 };
    this.hulls = { stock: 380, cap: 2000 };
    this.buffer = { stock: 520, cap: 900 };
    this.hexane = { stock: 140, cap: 200 };
    this.boilers = BOILERS.map((b) => ({ ...b, on: true, load: 70, flue: 185 }));
    this.proc = {
      feed: NOMINAL_CRUSH, steam: 10.2, steamDemand: 34, prepTemp: 68, extractorTemp: 58, dtTemp: 105,
      miscella: 24, lel: 4, hexLoss: 1.0, residualOil: 0.8, residualHexane: 180, mealProtein: 46.6,
      mealHumidity: 12.1, oilRate: 0, mealRate: 0, power: 2.4, extractorRun: true,
    };
    this.active = new Map();
    this.iot = new IoTFleet();
    this.cep = new CepEngine();
    this.randomFaults = !!randomFaults;
    this.counters = this.freshCounters();
    this.roadQueue = 0;
    this.vehicles = [];
    this.people = [];
    this.events = [];
    this.problems = new Map();
    this.flows = {};
    this.outbox = []; // staff actions for Zabbix acknowledge (drained by the server)
    this.collision = null;
    this.brakeTruck = null;
    this.pendingCollision = false;
    this.traffic = new Traffic(this);
    this.nextSpawn = { soy: this.t + 1, oil: this.t + 20, meal: this.t + 6 };
    this.nextRandomFault = this.t + rand(45, 120);
    STAFF_TECH_INDEX.n = 0;
    ROUTINES.forEach((r, i) => this.spawnPerson(r, i));
    STAFF.forEach((s, i) => this.spawnPerson(s, ROUTINES.length + i));
    this.staff = new Staff(this);
    // Start with some trucks already in the yard so the scene is alive.
    for (let i = 0; i < 4; i++) this.spawnTruck('soy', this.yard[i]);
    this.log(0, 'Simulación iniciada — turno mañana 06:00', 'sistema');
  }

  freshCounters() {
    return {
      receivedT: 0, trucksIn: 0, rejected: 0, crushedT: 0, oilT: 0, mealT: 0, oilDispatchedT: 0, mealDispatchedT: 0, tankers: 0, mealTrucks: 0,
      hardBrakes: 0, nearMisses: 0, collisions: 0, overtakes: 0, flagman: 0, escalations: 0, evacuations: 0,
      woCompleted: 0, woRepairMin: 0, woResponseMin: 0, woResponded: 0,
    };
  }

  // ───────────────────────────── main loop ─────────────────────────────
  advance(minutes) {
    let left = Math.min(minutes, 60);
    while (left > 1e-9) {
      const dt = Math.min(0.25, left);
      this.step(dt);
      left -= dt;
    }
    if (minutes > 0) this.evalCep();
    this.tick++;
  }

  step(dt) {
    const prevDay = Math.floor(this.t / 1440);
    this.t += dt;
    if (Math.floor(this.t / 1440) !== prevDay) {
      const c = this.counters;
      this.log(0, `Cierre del día ${prevDay + 1}: recibidas ${c.receivedT.toFixed(0)} t, molidas ${c.crushedT.toFixed(0)} t, aceite ${c.oilT.toFixed(0)} t, harina ${c.mealT.toFixed(0)} t`, 'sistema');
      this.counters = this.freshCounters();
      for (const s of Object.values(this.stations)) s.opsToday = 0;
    }
    this.flows = { H1: false, H2: false, OL: false, ML: false };
    this.monitorPresence ??= false; // someone is looking at the monitoring room (set by the server / client)
    this.updateSpawns();
    this.updateHighway();
    this.updateFaults();
    this.iot.step(this, dt);
    this.updateProcess(dt);
    for (const v of this.vehicles) this.updateTruck(v, dt);
    for (const v of this.vehicles) if (v.gone) this.traffic.releaseAll(v);
    this.vehicles = this.vehicles.filter((v) => !v.gone);
    this.staff.update(dt);
    for (const p of this.people) this.updatePerson(p, dt);
    this.evalTriggers();
  }

  // ───────────────────────────── events ─────────────────────────────
  log(sev, msg, src = 'planta', kind = 'evento') {
    this.events.unshift({ id: this.nextId++, t: this.t, sev, msg, src, kind });
    if (this.events.length > 200) this.events.length = 200;
  }

  clock(t = this.t) {
    const day = Math.floor(t / 1440) + 1;
    const m = Math.floor(t % 1440);
    return { day, hh: Math.floor(m / 60), mm: m % 60, label: `Día ${day} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` };
  }

  // ───────────────────────────── problems (manual + random) ─────────────────────────────
  // this.active: id → { origin: 'manual' | 'random', since, until }
  hasFault(type, target) {
    for (const id of this.active.keys()) {
      const e = PROBLEM_BY_ID[id].effect;
      if (e.type === type && (target === undefined || e.target === target)) return true;
    }
    return false;
  }

  // Station physically stopped (frozen truck, nobody enters).
  stationDown(id) {
    return this.hasFault('station_down', id) || (id === 'H1' && this.hasFault('noria_jam', 'N1')) || (id === 'H2' && this.hasFault('noria_jam', 'N2'));
  }

  // on=true activates (manual: until switched off or repaired; random: until repaired).
  // on=false deactivates. Returns true if state changed.
  setProblem(id, on, origin = 'manual', by = null) {
    const p = PROBLEM_BY_ID[id];
    if (!p) return false;
    const cur = this.active.get(id);
    if (on) {
      if (cur && cur.origin === origin) return false;
      if (cur && origin === 'manual') {
        // A random fault taken over by hand is now a manual one.
        this.active.set(id, { origin: 'manual', since: cur.since, until: null });
        this.log(p.sev, `Falla tomada como manual: ${p.name}`, p.src, 'falla');
        return true;
      }
      if (cur) return false;
      // Random faults are fixed by the technicians; the fallback only avoids eternal faults.
      const until = origin === 'random' ? this.t + 360 : null;
      this.active.set(id, { origin, since: this.t, until });
      this.log(p.sev, `${origin === 'manual' ? 'Falla activada manualmente' : 'Falla aleatoria'}: ${p.name}`, p.src, 'falla');
      this.onProblemOn(id, origin);
      return true;
    }
    if (!cur) return false;
    this.active.delete(id);
    this.log(0, `Normalizado: ${p.name} (${Math.round(this.t - cur.since)} min, ${by ?? (cur.origin === 'manual' ? 'manual' : 'aleatoria')})`, p.src, 'mantenimiento');
    this.onProblemOff(id);
    return true;
  }

  // ───────────── traffic incidents ─────────────
  onProblemOn(id) {
    if (id === 'brake_fail') this.armBrakeFailure(false);
    if (id === 'vehicle_collision' && !this.collision) this.pendingCollision = true;
  }

  onProblemOff(id) {
    if (id === 'brake_fail') {
      const v = this.vehicles.find((x) => x.id === this.brakeTruck);
      if (v) v.brakeFail = false;
      this.brakeTruck = null;
    }
    if (id === 'vehicle_collision') {
      this.pendingCollision = false;
      if (this.collision) {
        // Road cleared: the damaged trucks leave the plant slowly.
        for (const v of this.vehicles) {
          if (!v.crashed) continue;
          v.crashed = false;
          v.damaged = true;
          v.brakeFail = false;
          if (v.kind === 'tow') continue;
          v.plan = ['GATE_OUT', v.kind === 'soy' ? 'EXIT_N' : 'EXIT_S'];
          v.step = 0;
          v.phase = 'request';
        }
        this.log(0, 'Vía despejada: los camiones dañados se retiran de planta', 'VIA', 'transito');
        this.collision = null;
      }
    }
  }

  // Picks a moving truck to lose its brakes (preferably one with a vehicle ahead).
  armBrakeFailure(forCollision) {
    const moving = this.vehicles.filter((v) => v.phase === 'travel' && !v.crashed && !v.brakeFail && v.kind !== 'tow' && (v.speed ?? 0) > 1.5 && v.x < 64);
    if (!moving.length) return false;
    const scored = moving.map((v) => {
      const { fx, fz } = this.traffic.direction(v);
      const L = this.traffic.leader(v, fx, fz);
      return { v, gap: L && !L.isPerson ? L.gap : 999 };
    });
    scored.sort((a, b) => a.gap - b.gap);
    const best = scored[0];
    if (forCollision && best.gap > 40) return false;
    best.v.brakeFail = true;
    this.brakeTruck = best.v.id;
    this.log(3, `Falla de frenos: camión ${best.v.plate} (${best.v.driver}) sin frenos de servicio`, 'VIA', 'transito');
    return true;
  }

  collide(a, b) {
    for (const v of [a, b]) {
      v.crashed = true;
      v.speed = 0;
      v.crashTilt = (Math.random() - 0.5) * 0.5;
      v.label = 'Colisionado — esperando a mantenimiento';
    }
    a.brakeFail = false;
    this.pendingCollision = false;
    this.counters.collisions++;
    this.collision = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, vehicles: [a.id, b.id], since: this.t };
    this.log(4, `COLISIÓN: el camión ${a.plate} impactó al ${b.plate}${a.id === this.brakeTruck ? ' (sin frenos)' : ''}. Vía bloqueada`, 'VIA', 'transito');
    const cur = this.active.get('vehicle_collision');
    if (!cur) this.setProblem('vehicle_collision', true, 'random');
  }

  trafficMetrics() {
    const c = this.counters;
    const moving = this.vehicles.filter((v) => v.phase === 'travel' && v.x < 64 && v.kind !== 'car');
    const stopped = moving.filter((v) => v.crashed || ((v.speed ?? 0) < 0.3 && (v.blockedFor ?? 0) > 1)).length;
    const avg = moving.length ? moving.reduce((a, v) => a + (v.speed ?? 0), 0) / moving.length : 0;
    return {
      traffic_collisions_today: c.collisions,
      traffic_hard_brakes_today: c.hardBrakes,
      traffic_near_misses_today: c.nearMisses,
      traffic_vehicles_stopped: stopped,
      traffic_avg_speed_kmh: Number((avg * KMH).toFixed(1)),
      traffic_flagman_today: c.flagman,
      traffic_overtakes_today: c.overtakes,
    };
  }

  configureRealism(patch = {}) {
    this.realism = { ...this.realism, ...patch };
  }

  // Tow / service truck from the workshop to the collision site.
  spawnTow(at) {
    const id = `T${this.nextId++}`;
    const v = {
      id, kind: 'tow', plate: 'GRÚA-01', driver: 'Mantenimiento (grúa)', x: -60, z: -120, h: Math.PI / 2, speed: 0,
      path: null, pi: 0, phase: 'request', step: 0, wait: 0, station: null, slot: null, blockedFor: 0, loaded: 0,
      label: 'Grúa en camino', since: this.t, tare: 18, net: 0, origin: 'Taller', priority: true,
      plan: ['TOW_GO', 'TOW_WAIT', 'TOW_BACK', 'TOW_END'], towTarget: { x: at.x, z: at.z },
    };
    this.vehicles.push(v);
    return id;
  }

  sendTowBack(id) {
    const v = this.vehicles.find((x) => x.id === id);
    if (!v) return;
    v.towDone = true;
  }

  clearFaults() {
    for (const id of [...this.active.keys()]) this.setProblem(id, false);
  }

  setRandomFaults(on) {
    this.randomFaults = !!on;
    this.nextRandomFault = this.t + rand(120, 360);
    this.log(0, `Fallas aleatorias ${this.randomFaults ? 'activadas' : 'desactivadas'}`, 'sistema');
  }

  updateFaults() {
    for (const [id, a] of [...this.active]) if (a.origin === 'random' && this.t >= a.until) this.setProblem(id, false, 'random', 'sin atención: cerrada por tiempo máximo');
    if (this.pendingCollision && !this.collision) this.armBrakeFailure(true);
    if (this.active.has('brake_fail') && !this.brakeTruck) this.armBrakeFailure(false);
    if (this.randomFaults && this.t >= this.nextRandomFault) {
      const free = PROBLEMS.filter((p) => !this.active.has(p.id));
      if (free.length) this.setProblem(pick(free).id, true, 'random');
      this.nextRandomFault = this.t + rand(120, 360);
    }
    // Road incidents (brake failure or a distracted driver) on their own schedule, so traffic
    // realism shows up every few simulated hours instead of once a day.
    const perDay = this.realism.incidentsPerDay ?? 8;
    if (this.randomFaults && this.realism.collisions && perDay > 0) {
      this.nextIncident ??= this.t + rand(20, 60);
      if (this.t >= this.nextIncident) this.nextIncident = this.t + (this.roadIncident() ? Math.max(30, expo(1440 / perDay)) : 3);
    } else this.nextIncident = null;
    for (const b of this.boilers) b.on = !this.hasFault('boiler_trip', b.id);
  }

  // Starts a road incident; false when the roads are not in a state to have one now.
  roadIncident() {
    if (this.collision || this.active.has('brake_fail') || this.active.has('vehicle_collision')) return false;
    if (Math.random() < 0.5) {
      const moving = this.vehicles.some((v) => v.phase === 'travel' && v.kind !== 'tow' && (v.speed ?? 0) > 1.5 && v.x < 64);
      if (!moving) return false;
      return this.setProblem('brake_fail', true, 'random') !== false;
    }
    // Distracted driver: a truck that has another vehicle ahead stops watching the road.
    const cands = this.vehicles
      .filter((v) => v.phase === 'travel' && !v.crashed && v.kind !== 'tow' && (v.speed ?? 0) > 3)
      .map((v) => ({ v, L: this.traffic.leader(v) }))
      .filter((c) => c.L && !c.L.isPerson && c.L.gap < 35);
    if (!cands.length) return false;
    const { v } = cands[Math.floor(Math.random() * cands.length)];
    v.distractedUntil = this.t + 1.2;
    this.log(2, `Conductor distraído: el camión ${v.plate} (${v.driver}) no mira la vía`, 'VIA', 'transito');
    return true;
  }

  // ───────────────────────────── process ─────────────────────────────
  updateProcess(dt) {
    const p = this.proc;
    const boilersOn = this.boilers.filter((b) => b.on);
    const steamCap = boilersOn.reduce((a, b) => a + b.cap, 0); // t/h
    p.steamDemand = 6 + p.feed * 60 * 0.45; // t/h
    const targetP = steamCap >= p.steamDemand ? 10.2 : Math.max(2, 10.2 * (steamCap / p.steamDemand) - 2);
    p.steam += (targetP + rand(-0.15, 0.15) - p.steam) * Math.min(1, dt * 0.12);
    for (const b of this.boilers) {
      const share = b.on ? p.steamDemand / Math.max(1, steamCap) : 0;
      b.load += (clamp(share * 100, 0, 100) + rand(-1, 1) - b.load) * Math.min(1, dt * 0.2);
      b.flue += ((b.on ? 150 + b.load * 0.6 : 60) - b.flue) * Math.min(1, dt * 0.05);
    }

    // Hexane safety interlock.
    const lelFault = this.hasFault('hexane_lel');
    const lelTarget = lelFault ? 34 : 4 + Math.sin(this.t / 37) * 1.5;
    p.lel += (lelTarget + rand(-0.4, 0.4) - p.lel) * Math.min(1, dt * (lelFault ? 0.15 : 0.08));
    p.lel = Math.max(0.5, p.lel);
    if (p.lel > 25) p.extractorRun = false;
    if (!lelFault && p.lel < 10) p.extractorRun = true;

    const oilSpace = this.tanks.some((t) => t.stock < t.cap * 0.995);
    const mealSpace = this.meal.stock < this.meal.cap;
    const steamFactor = clamp((p.steam - 5) / 4, 0.2, 1);
    const avail = this.buffer.stock > 3 && oilSpace && mealSpace && this.hexane.stock > 8 && p.extractorRun && !this.hasFault('prep_power') ? 1 : 0;
    const target = NOMINAL_CRUSH * steamFactor * avail;
    p.feed += (target - p.feed) * Math.min(1, dt * 0.08);
    if (this.hasFault('prep_power')) p.feed = 0; // MCC tripped: motors stop at once
    if (p.feed < 0.005) p.feed = 0;

    // Feed buffer silo from storage (fullest storage first).
    const want = p.feed + (this.buffer.cap * 0.6 - this.buffer.stock) * 0.03;
    let draw = clamp(want, 0, 1.6) * dt;
    for (const s of this.storages) s.outflow = 0;
    const sources = [...this.storages].sort((a, b) => b.stock / b.cap - a.stock / a.cap);
    for (const s of sources) {
      if (draw <= 0) break;
      const take = Math.min(draw, Math.max(0, s.stock - 5));
      s.stock -= take;
      s.outflow += take / dt;
      this.buffer.stock += take;
      draw -= take;
      break; // one source at a time (one conveyor line)
    }

    const crushed = Math.min(this.buffer.stock, p.feed * dt);
    this.buffer.stock -= crushed;
    this.counters.crushedT += crushed;

    // Mass balance: oil ~19 %, meal ~73 %, hulls ~6.5 %, moisture/losses ~1.5 %.
    const oil = crushed * 0.19;
    const meal = crushed * 0.73;
    const hulls = crushed * 0.065;
    p.oilRate = (oil / dt) * 60;
    p.mealRate = (meal / dt) * 60;
    for (const t of this.tanks) t.inflow = 0;
    const tank = [...this.tanks].filter((t) => t.stock < t.cap).sort((a, b) => a.stock / a.cap - b.stock / b.cap)[0];
    if (tank) {
      tank.stock = Math.min(tank.cap, tank.stock + oil);
      tank.inflow = p.oilRate;
    }
    this.counters.oilT += oil;
    this.meal.stock = Math.min(this.meal.cap, this.meal.stock + meal);
    this.counters.mealT += meal;
    this.hulls.stock = Math.min(this.hulls.cap, this.hulls.stock + hulls);
    // Boiler 1 burns hulls.
    if (this.boilers[0].on) this.hulls.stock = Math.max(0, this.hulls.stock - 0.055 * dt * (this.boilers[0].load / 70));

    // Hexane losses (L/t) go up when the desolventizer lacks steam.
    p.dtTemp += ((p.feed > 0.05 ? 92 + 13 * steamFactor : 70) + rand(-0.4, 0.4) - p.dtTemp) * Math.min(1, dt * 0.06);
    p.hexLoss += ((0.85 + (1 - steamFactor) * 1.6 + (lelFault ? 0.8 : 0)) + rand(-0.03, 0.03) - p.hexLoss) * Math.min(1, dt * 0.05);
    p.residualHexane += ((150 + (1 - steamFactor) * 600) + rand(-8, 8) - p.residualHexane) * Math.min(1, dt * 0.05);
    this.hexane.stock = Math.max(0, this.hexane.stock - (crushed * p.hexLoss) / 1000);
    if (this.hexane.stock < 60 && !this.hexRefillAt) this.hexRefillAt = this.t + 90;
    if (this.hexRefillAt && this.t >= this.hexRefillAt) {
      this.hexRefillAt = null;
      this.hexane.stock = Math.min(this.hexane.cap, this.hexane.stock + 45);
      this.log(0, 'Recepción de cisterna de hexano: +45 m³', 'HEX');
    }

    p.extractorTemp += ((p.feed > 0.05 ? 58 : 45) + rand(-0.3, 0.3) - p.extractorTemp) * Math.min(1, dt * 0.05);
    p.prepTemp += ((p.feed > 0.05 ? 62 + 6 * steamFactor : 40) + rand(-0.3, 0.3) - p.prepTemp) * Math.min(1, dt * 0.05);
    p.miscella += (24 + rand(-0.5, 0.5) - p.miscella) * Math.min(1, dt * 0.05);
    p.residualOil += (0.75 + (1 - steamFactor) * 0.4 + rand(-0.02, 0.02) - p.residualOil) * Math.min(1, dt * 0.05);
    p.mealProtein += (46.6 + rand(-0.15, 0.15) - p.mealProtein) * Math.min(1, dt * 0.05);
    p.mealHumidity += (12 + rand(-0.1, 0.1) - p.mealHumidity) * Math.min(1, dt * 0.05);
    p.power = 0.6 + p.feed * 1.7 + rand(-0.03, 0.03); // MW

    // Grain condition in storage.
    for (const s of this.storages) {
      const hot = this.hasFault('silo_hotspot', s.id);
      s.temp += ((hot ? 38 : 24.5) + rand(-0.1, 0.1) - s.temp) * Math.min(1, dt * (hot ? 0.025 : 0.01));
      s.hum += (12.3 + rand(-0.05, 0.05) - s.hum) * Math.min(1, dt * 0.002);
    }
    for (const t of this.tanks) t.temp += (38 + rand(-0.1, 0.1) - t.temp) * Math.min(1, dt * 0.02);
    for (const d of this.dayTanks) d.pct = 55 + 30 * Math.sin(this.t / 180 + d.phase);
  }

  // ───────────────────────────── trucks ─────────────────────────────
  updateSpawns() {
    const hour = (this.t % 1440) / 60;
    const day = hour >= 6 && hour < 22;
    if (this.t >= this.nextSpawn.soy) {
      this.nextSpawn.soy = this.t + expo(day ? 24 : 48);
      const freeSlot = this.yard.find((s) => !s.truck);
      const gateBusy = this.rn4Queue() >= 3 || this.stationDown('GATE') || !this.spawnClear('soy');
      if (freeSlot && !gateBusy && this.truckCount() < 18) {
        this.spawnTruck('soy');
        this.roadQueue = Math.max(0, this.roadQueue - 1);
      } else {
        this.roadQueue = Math.min(25, this.roadQueue + 1);
        if (this.roadQueue === 1 || this.roadQueue % 5 === 0) this.log(1, `Playa de camiones llena: ${this.roadQueue} camión(es) esperando sobre RN4`, 'PLAYA');
      }
    }
    // Trucks waiting on the highway enter as soon as there is room.
    if (this.roadQueue > 0 && this.yard.some((s) => !s.truck) && this.rn4Queue() < 2 && !this.stationDown('GATE') && this.truckCount() < 18 && this.spawnClear('soy')) {
      this.spawnTruck('soy');
      this.roadQueue--;
    }
    const oilStock = this.tanks.reduce((a, t) => a + t.stock, 0);
    if (this.t >= this.nextSpawn.oil && !this.spawnClear('oil')) this.nextSpawn.oil = this.t + 1;
    if (this.t >= this.nextSpawn.meal && !this.spawnClear('meal')) this.nextSpawn.meal = this.t + 1;
    if (this.t >= this.nextSpawn.oil) {
      this.nextSpawn.oil = this.t + expo(110);
      if (oilStock > 1200 && this.vehicles.filter((v) => v.kind === 'oil').length < 2) this.spawnTruck('oil');
    }
    if (this.t >= this.nextSpawn.meal) {
      this.nextSpawn.meal = this.t + expo(36);
      if (this.meal.stock > 1000 && this.vehicles.filter((v) => v.kind === 'meal').length < 3) this.spawnTruck('meal');
    }
  }

  truckCount() {
    return this.vehicles.filter((v) => v.kind !== 'car').length;
  }

  // Through traffic on RN4: cars (and the odd truck passing by) driven by the same traffic model
  // as the plant trucks, so they brake behind them and give way at the plant access.
  updateHighway() {
    const hour = (this.t % 1440) / 60;
    const mean = hour >= 6 && hour < 21 ? 3.5 : 9; // simulated minutes between cars, per direction
    this.nextCar ??= { s: this.t + rand(0, 2), n: this.t + rand(0, 2) };
    for (const dir of ['s', 'n']) {
      if (this.t < this.nextCar[dir]) continue;
      const fromSouth = dir === 's';
      const x = fromSouth ? 75.7 : 72.3;
      const z0 = fromSouth ? 183 : -183;
      const clear = !this.vehicles.some((o) => Math.abs(o.x - x) < 3 && Math.abs(o.z - z0) < 22);
      if (!clear || this.vehicles.filter((v) => v.kind === 'car').length >= 12) {
        this.nextCar[dir] = this.t + 0.5;
        continue;
      }
      this.nextCar[dir] = this.t + expo(mean);
      const variant = pick(['sedan', 'sedan', 'pickup', 'suv', 'pickup', 'van']);
      this.vehicles.push({
        id: `C${this.nextId++}`, kind: 'car', variant, color: pick(CAR_COLORS), plate: plate(), driver: 'Particular',
        x, z: z0, h: fromSouth ? -Math.PI / 2 : Math.PI / 2, path: [{ x, z: z0 }, { x, z: -z0 }], pi: 1, phase: 'travel',
        plan: ['RN4'], step: 0, speed: 12, maxSpeed: rand(14, 18), loaded: 0, label: fromSouth ? 'Circulando por RN4 hacia el norte' : 'Circulando por RN4 hacia el sur',
        since: this.t, origin: 'RN4', net: 0, tare: 0, station: null, slot: null, blockedFor: 0,
      });
    }
  }

  updateCar(v, dt) {
    if (this.traffic.drive(v, dt)) v.gone = true;
    v.label = v.waitReason === 'cruce' ? 'Cediendo el paso en el acceso a planta' : v.speed < 3 && v.waitReason ? 'Frenado detrás de un camión' : v.h < 0 ? 'Circulando por RN4 hacia el norte' : 'Circulando por RN4 hacia el sur';
  }

  // A new truck only appears on RN4 when there is room at the edge of the map.
  spawnClear(kind) {
    const sp = kind === 'soy' ? SPAWN.south : SPAWN.north;
    return !this.vehicles.some((o) => !o.gone && Math.hypot(o.x - sp.x, o.z - sp.z) < 18);
  }

  // Soy trucks already on RN4 waiting for the gate.
  rn4Queue() {
    return this.vehicles.filter((v) => v.kind === 'soy' && ['PREGATE', 'GATE'].includes(v.plan[v.step]) && v.phase !== 'dwell').length;
  }

  spawnTruck(kind, yardSlot) {
    const id = `T${this.nextId++}`;
    const fromSouth = kind === 'soy';
    const sp = fromSouth ? SPAWN.south : SPAWN.north;
    const v = {
      id, kind, plate: plate(), driver: `${pick(FIRST)} ${pick(LAST)}`,
      x: sp.x + (fromSouth ? 3 : -3), z: sp.z, h: fromSouth ? -Math.PI / 2 : Math.PI / 2,
      path: null, pi: 0, phase: 'request', step: 0, wait: 0, station: null, slot: null,
      blockedFor: 0, speed: 0, loaded: kind === 'soy' ? 1 : 0, label: 'Ingresando por RN4', since: this.t,
      tare: kind === 'oil' ? rand(14.5, 16) : rand(14, 16.5),
      net: kind === 'soy' ? rand(27.5, 32.5) : rand(28, 31),
      origin: kind === 'soy' ? pick(ORIGINS) : pick(['Puerto Quijarro (exportación)', 'Arica (exportación)', 'Cochabamba', 'La Paz', 'Puerto Suárez']),
    };
    if (kind === 'soy') {
      v.plan = ['PREGATE', 'GATE', 'SLOT', 'SAMP', 'BAL_IN', 'HOPPER', 'BAL_OUT', 'GATE_OUT', 'EXIT_N'];
    } else {
      v.plan = ['PREGATE', 'GATE', 'BAL_D', kind === 'oil' ? 'OL' : 'ML', 'BAL_DS', 'GATE_OUT', 'EXIT_S'];
    }
    if (yardSlot) {
      // Pre-placed truck waiting in the yard.
      yardSlot.truck = id;
      v.slot = yardSlot.i;
      v.x = yardSlot.x;
      v.z = yardSlot.z;
      v.h = -Math.PI / 2;
      v.step = 2;
      v.phase = 'dwell';
      v.wait = rand(0, 4);
      v.label = 'En playa, esperando calador';
      this.counters.trucksIn++;
    } else if (kind === 'soy') {
      this.counters.trucksIn++;
    }
    this.vehicles.push(v);
    return v;
  }

  stationFree(id) {
    const s = this.stations[id];
    if (!s) return true;
    // A jammed noria blocks its hopper. With a network/system outage the next truck still
    // drives onto the station (nobody stops it) and gets stuck there, as in a real plant.
    if (this.stationDown(id) && !this.hasFault('station_down', id)) return false;
    return s.users.size < s.cap;
  }

  chooseHopper(v) {
    const group = (h) => this.storages.filter((s) => s.hopper === h && s.stock < s.cap * 0.98);
    const opts = ['H1', 'H2']
      .map((h) => ({ h, st: group(h).sort((a, b) => a.stock / a.cap - b.stock / b.cap)[0] }))
      .filter((o) => o.st && this.stationFree(o.h));
    if (!opts.length) return null;
    opts.sort((a, b) => a.st.stock / a.st.cap - b.st.stock / b.st.cap);
    v.target = opts[0].st.id;
    return opts[0].h;
  }

  // First come, first served per station: a truck may only take a station when it is
  // the longest-waiting truck that asked for it (no starvation).
  firstInLine(key, v) {
    const q = (this.queues ||= {});
    const line = (q[key] ||= []).filter((id) => this.vehicles.some((o) => o.id === id && !o.gone && o.phase === 'request'));
    if (!line.includes(v.id)) line.push(v.id);
    q[key] = line;
    return line[0] === v.id;
  }

  leaveLine(key, v) {
    if (this.queues?.[key]) this.queues[key] = this.queues[key].filter((id) => id !== v.id);
  }

  // Try to reserve the next step of the plan; returns the destination or null if it must wait.
  reserveNext(v) {
    const step = v.plan[v.step];
    let dest = null;
    let stationId = null;
    if (step === 'SLOT') {
      const slot = this.yard.find((s) => !s.truck);
      if (!slot) return null;
      slot.truck = v.id;
      v.slot = slot.i;
      dest = slot;
    } else if (step === 'HOPPER') {
      if (!this.firstInLine('HOPPER', v)) return null;
      stationId = this.chooseHopper(v);
      if (!stationId) return null;
      this.leaveLine('HOPPER', v);
      dest = this.stations[stationId];
    } else if (step === 'EXIT_N' || step === 'EXIT_S') {
      dest = step === 'EXIT_N' ? SPAWN.north : SPAWN.south;
    } else if (step === 'PREGATE') {
      // Wait on the RN4 shoulder, in the driving direction, before the access road (not reserved:
      // trucks queue behind each other on the highway).
      dest = v.kind === 'soy' ? PREGATE_SOY : PREGATE_DISPATCH;
    } else if (step === 'GATE_OUT') {
      // Exit check in the outbound lane of the access road (incoming trucks use the inbound lane),
      // never reserved, so trucks leaving can never deadlock.
      dest = { x: this.stations.GATE.x, z: this.stations.GATE.z + 1.7 };
    } else {
      if (!this.firstInLine(step, v) || !this.stationFree(step)) return null;
      this.leaveLine(step, v);
      stationId = step;
      dest = this.stations[step];
    }
    // Release what we were holding.
    if (v.station) this.stations[v.station].users.delete(v.id);
    v.station = null;
    if (v.slot !== null && step !== 'SLOT') {
      this.yard[v.slot].truck = null;
      v.slot = null;
    }
    if (stationId) {
      this.stations[stationId].users.add(v.id);
      v.station = stationId;
    }
    return dest;
  }

  label(v) {
    const step = v.plan[v.step];
    const st = this.stations[v.station];
    const tgt = this.storages.find((s) => s.id === v.target);
    if (v.phase === 'travel') {
      return {
        PREGATE: 'Llegando por RN4', GATE: 'Ingresando a planta', GATE_OUT: 'Saliendo hacia portería',
        SLOT: 'Dirigiéndose a playa de espera',
        SAMP: 'Hacia el calador', BAL_IN: 'Hacia balanza de ingreso', BAL_D: 'Hacia balanza de despacho',
        HOPPER: `Hacia ${st?.name ?? 'volcadora'}`, BAL_OUT: 'Hacia balanza de salida', BAL_DS: 'Hacia balanza de despacho (bruto)',
        OL: 'Hacia carga de aceite', ML: 'Hacia carga de harina',
        EXIT_N: 'Retirándose por RN4 (norte)', EXIT_S: 'Retirándose por RN4 (sur)',
      }[step];
    }
    if (v.phase === 'dwell') {
      return {
        PREGATE: 'En banquina de RN4, esperando turno de portería', GATE: 'Control documental en portería', GATE_OUT: 'Control de salida en portería', SLOT: 'En playa, esperando calador',
        SAMP: 'Calado: muestreo de humedad e impurezas', BAL_IN: 'Pesaje bruto', BAL_D: 'Pesaje de tara (vacío)',
        HOPPER: `Descargando soya → ${tgt?.name ?? ''}`, BAL_OUT: 'Pesaje de tara', BAL_DS: 'Pesaje bruto (cargado)',
        OL: 'Cargando aceite crudo', ML: 'Cargando harina de soya',
      }[step];
    }
    return {
      SAMP: 'Esperando calador', BAL_IN: 'Esperando balanza de ingreso', BAL_D: 'Esperando balanza de despacho', HOPPER: 'Esperando volcadora libre',
      BAL_OUT: 'Esperando balanza de salida', BAL_DS: 'Esperando balanza de despacho', SLOT: 'Esperando lugar en playa', OL: 'Esperando brazo de carga', ML: 'Esperando carga de harina', GATE: 'En banquina de RN4, esperando turno de portería',
    }[step] ?? 'En espera';
  }

  dwellTime(v, step) {
    return {
      PREGATE: 0, GATE: rand(1, 2), GATE_OUT: rand(0.5, 1), SLOT: rand(3, 10), SAMP: rand(4, 6), BAL_IN: rand(2, 3), BAL_D: rand(2, 3), HOPPER: rand(12, 16),
      BAL_OUT: rand(2, 3), BAL_DS: rand(2, 3), OL: rand(22, 28), ML: rand(16, 22),
    }[step] ?? 0;
  }

  // Tow truck: drives (with priority) to the collision, waits until the road is cleared, returns.
  updateTow(v, dt) {
    const step = v.plan[v.step];
    const route = (dest) => {
      const raw = this.road.findPath({ x: v.x, z: v.z }, dest);
      v.path = raw ? lanePath(raw, v) : [dest];
      v.pi = v.path.length > 1 ? 1 : 0;
      v.phase = 'travel';
    };
    if (v.phase === 'request') {
      if (step === 'TOW_GO') route(v.towTarget);
      else if (step === 'TOW_BACK') route({ x: -60, z: -128 });
      else v.phase = 'dwell';
    } else if (v.phase === 'travel') {
      const arrived = this.traffic.drive(v, dt);
      const near = step === 'TOW_GO' && Math.hypot(v.x - v.towTarget.x, v.z - v.towTarget.z) < 24 && (v.speed ?? 0) < 0.5;
      if (arrived || near) {
        v.speed = 0;
        v.step++;
        v.phase = step === 'TOW_BACK' ? 'gone' : 'dwell';
        if (step === 'TOW_BACK') v.gone = true;
      }
    } else if (v.phase === 'dwell') {
      v.speed = 0;
      if (v.towDone || !this.collision) {
        v.step = v.plan.indexOf('TOW_BACK');
        v.phase = 'request';
      }
    }
    v.label = { TOW_GO: 'Grúa en camino a la colisión', TOW_WAIT: 'Grúa despejando la vía', TOW_BACK: 'Grúa regresando al taller' }[v.plan[v.step]] ?? 'Grúa';
  }

  updateTruck(v, dt) {
    if (v.kind === 'car') return this.updateCar(v, dt);
    if (v.kind === 'tow') return this.updateTow(v, dt);
    const step = v.plan[v.step];
    if (v.phase === 'request') {
      const dest = this.reserveNext(v);
      if (dest) {
        // Roads only (through traffic never crosses the yard). Bays are entered and left in a
        // straight line from/to the C3 road, through the gaps of the staggered rows.
        const from = { x: v.x, z: v.z };
        const route = (a, b) => this.roadNoYard.findPath(a, b) || this.road.findPath(a, b);
        if (step === 'GATE' && v.plan[v.step - 1] === 'PREGATE') {
          // From the shoulder: keep to the shoulder up to the junction and cross the lanes only
          // inside the reserved RN4×access box (never cut into traffic in a lane).
          // Into the inbound lane of the access road (z ≈ 69.3); trucks leaving use z ≈ 72.7.
          const g = this.stations.GATE;
          const inZ = g.z - 1.7;
          v.path = v.x > 74
            ? [from, { x: v.x, z: 73 }, { x: 66, z: inZ }, { x: g.x, z: inZ }]
            : [from, { x: v.x, z: 64 }, { x: 64.5, z: inZ }, { x: g.x, z: inZ }];
        } else if (step === 'PREGATE') {
          // Straight along RN4 onto the shoulder: the line of waiting trucks forms behind.
          const dir = Math.sign(dest.z - v.z) || 1;
          v.path = [from, { x: dest.x, z: v.z + dir * 14 }, { x: dest.x, z: dest.z }];
        } else if (step === 'SLOT') {
          const raw = route(from, { x: dest.x, z: YARD_AISLE_Z });
          v.path = [...(raw ? lanePath(raw, v) : [from]), { x: dest.x, z: YARD_AISLE_Z + 6 }, { x: dest.x, z: dest.z }];
        } else if (v.plan[v.step - 1] === 'SLOT') {
          const exit = { x: v.x, z: YARD_AISLE_Z };
          const raw = route(exit, dest);
          v.path = [from, exit, ...(raw ? lanePath(raw, exit).slice(1) : [{ x: dest.x, z: dest.z }])];
        } else {
          const raw = route(from, dest);
          v.path = raw ? lanePath(raw, v) : [{ x: dest.x, z: dest.z }];
        }
        v.pi = v.path.length > 1 ? 1 : 0;
        v.phase = 'travel';
      }
    } else if (v.phase === 'travel') {
      // Acceleration, braking, crossings and collisions live in traffic.js.
      if (this.traffic.drive(v, dt)) {
        if (step === 'EXIT_N' || step === 'EXIT_S') {
          v.gone = true;
          if (v.station) this.stations[v.station].users.delete(v.id);
          return;
        }
        v.phase = 'dwell';
        v.speed = 0;
        v.wait = this.dwellTime(v, step);
        if (step === 'SLOT') v.h = -Math.PI / 2;
        // Park aligned with the road (the last bit of the route is often a short lane merge).
        else v.h = roadHeading(v.path, v.h);
        if (step === 'HOPPER' || step === 'BAL_IN' || step === 'BAL_OUT' || step === 'BAL_D' || step === 'BAL_DS' || step === 'SAMP' || step === 'OL' || step === 'ML') {
          this.stations[v.station].opsToday++;
        }
      }
      if (v.crashed) return;
    } else if (v.phase === 'dwell') {
      if (v.station && this.stationDown(v.station)) {
        // Station stopped (network down, jam, blocked arm): the truck stays frozen on it.
        v.frozen = true;
        const name = this.stations[v.station].name;
        v.label = v.station.startsWith('BAL') ? `Detenido sobre la balanza: sin red (${name})` : `Detenido: ${name} fuera de servicio`;
        return;
      }
      v.frozen = false;
      v.wait -= dt;
      if (step === 'HOPPER') {
        const tgt = this.storages.find((s) => s.id === v.target);
        const total = 14;
        const amount = Math.min(v.net * v.loaded, (v.net / total) * dt);
        if (tgt && amount > 0) {
          tgt.stock = Math.min(tgt.cap, tgt.stock + amount);
          tgt.inflow = (amount / dt) * 60;
          v.loaded = Math.max(0, v.loaded - amount / v.net);
          this.counters.receivedT += amount;
          this.flows[v.station] = true;
        }
      }
      if (step === 'OL' || step === 'ML') {
        const total = step === 'OL' ? 25 : 19;
        const amount = (v.net / total) * dt;
        if (step === 'OL') {
          const tank = [...this.tanks].sort((a, b) => b.stock - a.stock)[0];
          tank.stock = Math.max(0, tank.stock - amount);
          this.counters.oilDispatchedT += amount;
        } else {
          this.meal.stock = Math.max(0, this.meal.stock - amount);
          this.counters.mealDispatchedT += amount;
        }
        v.loaded = Math.min(1, v.loaded + amount / v.net);
        this.flows[step] = true;
      }
      if (v.wait <= 0) this.finishStep(v, step);
    }
    v.label = this.label(v);
  }

  finishStep(v, step) {
    if (step === 'SAMP') {
      v.sample = { hum: rand(10.8, 15.2), imp: rand(0.4, 2.2), dmg: rand(0.5, 4) };
      if (Math.random() < 0.05) v.sample.hum = rand(15.6, 17.5);
      if (v.sample.hum > 15.5 || v.sample.imp > 2.1) {
        v.rejected = true;
        this.counters.rejected++;
        this.log(1, `Camión ${v.plate} rechazado en calado (humedad ${v.sample.hum.toFixed(1)}%, impurezas ${v.sample.imp.toFixed(1)}%)`, 'SAMP');
        v.plan = ['GATE_OUT', 'EXIT_N'];
        v.step = 0;
        v.phase = 'request';
        return;
      }
    }
    if (step === 'BAL_IN' || step === 'BAL_D') v.weighIn = v.kind === 'soy' ? v.tare + v.net : v.tare;
    if (step === 'HOPPER') {
      const tgt = this.storages.find((s) => s.id === v.target);
      if (v.loaded > 0 && tgt) {
        const rest = v.net * v.loaded;
        tgt.stock = Math.min(tgt.cap, tgt.stock + rest);
        this.counters.receivedT += rest;
      }
      v.loaded = 0;
      this.log(0, `Descarga completa ${v.plate} (${v.origin}): ${v.net.toFixed(1)} t → ${tgt?.name}`, v.station);
    }
    if (step === 'BAL_OUT' || step === 'BAL_DS') {
      v.weighOut = v.kind === 'soy' ? v.tare : v.tare + v.net;
      if (v.kind === 'oil') {
        this.counters.tankers++;
        this.log(0, `Despacho aceite crudo: cisterna ${v.plate}, ${v.net.toFixed(1)} t → ${v.origin}`, 'OL');
      } else if (v.kind === 'meal') {
        this.counters.mealTrucks++;
        this.log(0, `Despacho harina: ${v.plate}, ${v.net.toFixed(1)} t → ${v.origin}`, 'ML');
      }
    }
    v.step++;
    v.phase = 'request';
  }

  // ───────────────────────────── people ─────────────────────────────
  spawnPerson(r, i) {
    const kind = r.kind ?? 'operator';
    const look = LOOK[kind];
    let [x, z] = r.post ?? r.stops?.[0] ?? WORKSHOP_SPOT;
    if (kind === 'tech') {
      // Lined up at the workshop, off the road.
      const k = STAFF_TECH_INDEX.n++;
      const c = this.pedOff.nearestWalkable(x - 6 + (k % 4) * 3, z - 3 - Math.floor(k / 4) * 3, 10);
      if (c) ({ x, z } = this.pedOff.center(c.i, c.j));
    }
    this.people.push({
      id: `P${i + 1}`, staffId: r.id ?? r.staffId ?? null, name: r.name, role: r.role, kind, skills: r.skills ?? [], areas: r.areas ?? [],
      zone: /Extracción/.test(r.name) ? 'extraccion' : null, helmet: r.helmet ?? look.helmet, vest: r.vest ?? look.vest,
      stops: r.stops ?? null, si: 0, x, z, h: r.post ? Math.atan2(r.post[3] - r.post[1], r.post[2] - r.post[0]) : 0, path: null, pi: 0, wait: rand(0, 5), moving: false,
      post: r.post ? { x: r.post[0], z: r.post[1], h: r.post.length > 2 ? Math.atan2(r.post[3] - r.post[1], r.post[2] - r.post[0]) : r.postH ?? 0 } : null,
      round: r.round ?? null, leg: null,
      // Technicians move in a service cart; managers walk briskly.
      speed: kind === 'tech' ? 7 : kind === 'manager' || kind === 'chief' ? 3 : PERSON_SPEED,
      label: 'En su puesto', task: null, say: null,
    });
  }

  updatePerson(p, dt) {
    // Stepping aside from a truck: a quick sidestep over a few tenths of a second.
    if (p.dodge) {
      const d = Math.min(p.dodge.left, 8 * dt);
      p.x += p.dodge.dx * d;
      p.z += p.dodge.dz * d;
      p.dodge.left -= d;
      p.moving = true;
      if (p.dodge.left <= 1e-3) p.dodge = null;
      return;
    }
    // Staff with a task (work order, inspection, evacuation): walk there and stay.
    if (p.task) {
      if (p.path) {
        p.moving = true;
        if (moveAlong(p, p.speed * dt)) {
          p.path = null;
          p.moving = false;
          if (p.task.type === 'return') p.task = null;
        }
      } else p.moving = false;
      p.label = this.personLabel(p);
      return;
    }
    if (p.post) return this.atPost(p, dt);
    if (!p.stops) {
      // Idle technicians wait in the workshop.
      p.moving = false;
      p.label = 'En el taller, disponible';
      return;
    }
    if (p.wait > 0) {
      p.wait -= dt;
      p.moving = false;
      return;
    }
    if (!p.path) {
      p.si = (p.si + 1) % p.stops.length;
      const [x, z] = p.stops[p.si];
      p.path = this.ped.findPath({ x: p.x, z: p.z }, { x, z }) || [{ x, z }];
      p.pi = 1;
      p.label = `Caminando (ronda ${p.si + 1}/${p.stops.length})`;
    }
    p.moving = true;
    if (moveAlong(p, p.speed * dt)) {
      p.path = null;
      p.wait = rand(4, 14);
      p.moving = false;
      p.label = p.kind === 'operator' ? 'Inspección en sitio' : 'Recorrida de planta';
    }
  }

  // Shift routine: stay at the post facing the equipment; now and then a short round in the
  // area (off the roads when possible), then back to the post.
  atPost(p, dt) {
    const post = p.post;
    const here = Math.hypot(p.x - post.x, p.z - post.z) < 1.2;
    if (!p.path && p.wait > 0) {
      p.wait -= dt;
      p.moving = false;
      if (here) {
        p.h = post.h;
        p.label = p.kind === 'manager' ? 'En la sala de monitoreo, mirando el dashboard de Zabbix' : 'En su puesto';
      }
      return;
    }
    if (!p.path) {
      let dest;
      if (!here) {
        dest = post;
        p.leg = 'post';
      } else if (p.round?.length && Math.random() < 0.6) {
        const [x, z] = pick(p.round);
        dest = { x, z };
        p.leg = 'round';
      } else {
        p.wait = rand(20, 45);
        return;
      }
      const from = { x: p.x, z: p.z };
      p.path = this.pedOff.findPath(from, dest) || this.ped.findPath(from, dest) || [dest];
      p.path.push({ x: dest.x, z: dest.z });
      p.pi = 1;
      p.label = p.leg === 'round' ? 'Recorrida corta en su área' : 'Volviendo a su puesto';
    }
    p.moving = true;
    if (moveAlong(p, p.speed * dt)) {
      p.path = null;
      p.moving = false;
      if (p.leg === 'round') {
        p.wait = rand(3, 7);
        p.label = 'Inspección en sitio';
      } else {
        p.h = post.h;
        p.wait = rand(25, 60);
      }
    }
  }

  personLabel(p) {
    const t = p.task;
    if (!t) return p.kind === 'tech' ? 'En el taller, disponible' : 'En su puesto';
    if (t.type === 'monitor') return p.path ? 'Va a la sala de monitoreo' : 'En la sala de monitoreo, mirando el dashboard de Zabbix';
    const o = t?.order && this.staff.orders.find((x) => x.id === t.order);
    if (t.type === 'evac') return 'Evacuando al punto de encuentro';
    if (t.type === 'return') return 'Regresando al taller';
    if (t.type === 'inspect') return p.path ? `Va a revisar: ${o?.name ?? ''}` : `Revisando en sitio: ${o?.name ?? ''}`;
    if (t.type === 'work') {
      if (!o) return 'Trabajando';
      if (p.path) return `${o.id}: en camino a ${o.short}`;
      return o.status === 'en_reparacion' ? `${o.id}: reparando ${o.short}` : o.status === 'en_espera' ? `${o.id}: reparado, espera normalización` : `${o.id}: en sitio, esperando equipo`;
    }
    return 'En tarea';
  }

  // ───────────────────────────── triggers (Zabbix-like) ─────────────────────────────
  evalTriggers() {
    const p = this.proc;
    const active = new Map();
    const add = (key, sev, name, src) => active.set(key, { key, sev, name, src });
    if (p.steam < 8) add('steam_low', 3, `Presión de vapor baja (${p.steam.toFixed(1)} bar)`, 'SF');
    for (const b of this.boilers) if (!b.on) add(`boiler_${b.id}`, 2, `${b.name.split(' (')[0]} fuera de servicio`, b.id);
    if (p.lel > 25) add('lel_high', 4, `LEL hexano ${p.lel.toFixed(0)}% en extracción — extractor detenido`, 'EXT');
    else if (p.lel > 12) add('lel_warn', 1, `LEL hexano elevado (${p.lel.toFixed(0)}%)`, 'EXT');
    if (p.feed < NOMINAL_CRUSH * 0.7) add('crush_low', 2, `Molienda reducida a ${((p.feed / NOMINAL_CRUSH) * 100).toFixed(0)}% de capacidad`, 'PREP');
    if (p.residualHexane > 300) add('meal_hex', 2, `Hexano residual en harina ${p.residualHexane.toFixed(0)} ppm`, 'EXT');
    for (const s of this.storages) {
      if (s.stock / s.cap > 0.95) add(`full_${s.id}`, 1, `${s.name} casi lleno (${((s.stock / s.cap) * 100).toFixed(0)}%)`, s.id);
      if (s.temp > 32) add(`hot_${s.id}`, 3, `Punto caliente en ${s.name} (${s.temp.toFixed(1)} °C)`, s.id);
    }
    const oilPct = this.tanks.reduce((a, t) => a + t.stock, 0) / this.tanks.reduce((a, t) => a + t.cap, 0);
    if (oilPct > 0.9) add('oil_full', 1, `Tanques de aceite al ${(oilPct * 100).toFixed(0)}%`, 'TA');
    if (this.hexane.stock / this.hexane.cap < 0.25) add('hex_low', 1, `Stock de hexano bajo (${this.hexane.stock.toFixed(0)} m³)`, 'HEX');
    if (this.roadQueue > 4) add('road_queue', 1, `${this.roadQueue} camiones esperando sobre RN4`, 'PLAYA');
    for (const [id, a] of this.active) {
      const pr = PROBLEM_BY_ID[id];
      add(`p_${id}`, pr.sev, `${pr.name} (${a.origin === 'random' ? 'aleatoria' : 'manual'})`, pr.src);
    }
    const frozen = this.vehicles.filter((v) => v.frozen).length;
    if (frozen) add('trucks_frozen', 2, `${frozen} camión(es) detenido(s) por equipo fuera de servicio`, 'PLAYA');

    for (const [k, pr] of active) {
      if (!this.problems.has(k)) {
        this.problems.set(k, { ...pr, since: this.t });
        this.log(pr.sev, `PROBLEMA: ${pr.name}`, pr.src, 'problema');
      } else {
        this.problems.get(k).name = pr.name;
      }
    }
    for (const [k, pr] of this.problems) {
      if (!active.has(k)) {
        this.problems.delete(k);
        const dur = this.t - pr.since;
        this.log(0, `RESUELTO: ${pr.name.split(' (')[0]} (duración ${Math.round(dur)} min)`, pr.src, 'resuelto');
      }
    }
  }

  // ───────────────────────────── outputs ─────────────────────────────
  kpis() {
    const soyStock = this.storages.reduce((a, s) => a + s.stock, 0);
    const soyCap = this.storages.reduce((a, s) => a + s.cap, 0);
    const oilStock = this.tanks.reduce((a, t) => a + t.stock, 0);
    const oilCap = this.tanks.reduce((a, t) => a + t.cap, 0);
    return {
      soyStock, soyCap, soyPct: (soyStock / soyCap) * 100,
      oilStock, oilCap, oilPct: (oilStock / oilCap) * 100,
      mealStock: this.meal.stock, mealCap: this.meal.cap, mealPct: (this.meal.stock / this.meal.cap) * 100,
      hexane: this.hexane.stock, hexanePct: (this.hexane.stock / this.hexane.cap) * 100,
      crushRateTpd: this.proc.feed * 1440, crushPct: (this.proc.feed / NOMINAL_CRUSH) * 100,
      steam: this.proc.steam,
      trucksInPlant: this.vehicles.filter((v) => v.z < 160 && v.z > -160 && v.x < 64).length,
      trucksWaitingYard: this.yard.filter((s) => s.truck).length,
      roadQueue: this.roadQueue,
      problems: this.problems.size,
      ...this.counters,
    };
  }

  snapshot() {
    const r1 = (v) => Math.round(v * 10) / 10;
    const r2 = (v) => Math.round(v * 100) / 100;
    return {
      tick: this.tick,
      t: this.t,
      clock: this.clock(),
      speed: this.speed,
      vehicles: this.vehicles.map((v) => ({
        id: v.id, kind: v.kind, x: r2(v.x), z: r2(v.z), h: r2(v.h), loaded: r2(v.loaded), label: v.label, plate: v.plate,
        driver: v.driver, origin: v.origin, net: r1(v.net), tare: r1(v.tare), target: v.target ?? null, sample: v.sample ?? null,
        rejected: !!v.rejected, moving: (v.speed ?? 0) > 0.3, sinceMin: Math.round(this.t - v.since),
        speedKmh: Math.round((v.speed ?? 0) * KMH), braking: !!v.braking, crashed: !!v.crashed, damaged: !!v.damaged, brakeFail: !!v.brakeFail,
        passing: !!v.passing, waitReason: v.waitReason ?? null, tilt: v.crashTilt ?? 0, ...(v.kind === 'car' ? { variant: v.variant, color: v.color } : {}),
      })),
      people: this.people.map((p) => ({
        id: p.id, name: p.name, role: p.role, kind: p.kind, helmet: p.helmet, vest: p.vest, x: r2(p.x), z: r2(p.z), h: r2(p.h), moving: p.moving, label: p.label,
        riding: p.kind === 'tech' ? !!p.moving : !!(p.riding && p.moving),
        say: p.say?.text ?? null, order: p.task?.order ?? null,
      })),
      orders: this.staff.snapshot(),
      traffic: { ...this.trafficMetrics(), collision: this.collision ? { x: r1(this.collision.x), z: r1(this.collision.z) } : null, evacuation: this.staff.evacuating },
      realism: this.realism,
      storages: this.storages.map((s) => ({ id: s.id, stock: Math.round(s.stock), cap: s.cap, pct: r1((s.stock / s.cap) * 100), temp: r1(s.temp), hum: r1(s.hum), outflow: r2(s.outflow) })),
      tanks: this.tanks.map((t) => ({ id: t.id, stock: Math.round(t.stock), cap: t.cap, pct: r1((t.stock / t.cap) * 100), temp: r1(t.temp), filling: t.inflow > 0 })),
      dayTanks: this.dayTanks.map((d) => ({ id: d.id, pct: r1(d.pct) })),
      boilers: this.boilers.map((b) => ({ id: b.id, on: b.on, load: r1(b.load), flue: Math.round(b.flue) })),
      buffer: { stock: Math.round(this.buffer.stock), cap: this.buffer.cap },
      meal: { stock: Math.round(this.meal.stock), cap: this.meal.cap },
      hulls: { stock: Math.round(this.hulls.stock), cap: this.hulls.cap },
      hexane: { stock: r1(this.hexane.stock), cap: this.hexane.cap },
      proc: Object.fromEntries(Object.entries(this.proc).map(([k, v]) => [k, typeof v === 'number' ? r2(v) : v])),
      flows: this.flows,
      stations: Object.fromEntries(Object.values(this.stations).map((s) => [s.id, { busy: s.users.size, cap: s.cap, ops: s.opsToday, down: this.stationDown(s.id), stopped: this.vehicles.filter((v) => v.frozen && v.station === s.id).length }])),
      faults: [...this.active.keys()].map((id) => ({ type: PROBLEM_BY_ID[id].effect.type, target: PROBLEM_BY_ID[id].effect.target })),
      problemCatalog: this.problemStates(),
      randomFaults: this.randomFaults,
      iot: { enabled: this.iot.enabled, devices: this.iot.summary(this) },
      cep: this.cep.summary((t) => this.clock(t).label),
      kpi: Object.fromEntries(Object.entries(this.kpis()).map(([k, v]) => [k, r1(v)])),
      problems: [...this.problems.values()].map((p) => ({ ...p, since: this.clock(p.since).label, durMin: Math.round(this.t - p.since) })),
      events: this.events.slice(0, 40).map((e) => ({ ...e, time: this.clock(e.t).label })),
    };
  }

  // Flat, Zabbix-friendly metrics (HTTP agent master item + dependent items / LLD).
  metrics() {
    const k = this.kpis();
    const p = this.proc;
    const r = (v, d = 2) => Number(v.toFixed(d));
    const obj = (arr, fn) => Object.fromEntries(arr.map((x) => [x.id, fn(x)]));
    return {
      timestamp: Math.floor(Date.now() / 1000),
      sim_time: this.clock().label,
      sim_minutes: r(this.t, 1),
      speed: this.speed,
      plant: {
        soy_stock_t: r(k.soyStock, 1), soy_capacity_t: k.soyCap, soy_stock_pct: r(k.soyPct),
        soy_received_today_t: r(k.receivedT, 1), trucks_received_today: k.trucksIn, trucks_rejected_today: k.rejected,
        crush_rate_tpd: r(k.crushRateTpd, 1), crush_pct: r(k.crushPct, 1), crushed_today_t: r(k.crushedT, 1),
        oil_stock_t: r(k.oilStock, 1), oil_stock_pct: r(k.oilPct), oil_produced_today_t: r(k.oilT, 1), oil_dispatched_today_t: r(k.oilDispatchedT, 1),
        meal_stock_t: r(k.mealStock, 1), meal_stock_pct: r(k.mealPct), meal_produced_today_t: r(k.mealT, 1), meal_dispatched_today_t: r(k.mealDispatchedT, 1),
        hulls_stock_t: r(this.hulls.stock, 1), buffer_silo_t: r(this.buffer.stock, 1),
        hexane_stock_m3: r(k.hexane, 1), hexane_stock_pct: r(k.hexanePct), hexane_loss_l_per_t: r(p.hexLoss),
        steam_pressure_bar: r(p.steam), steam_demand_tph: r(p.steamDemand, 1), power_mw: r(p.power),
        prep_conditioner_temp_c: r(p.prepTemp, 1), extractor_temp_c: r(p.extractorTemp, 1), dt_temp_c: r(p.dtTemp, 1),
        miscella_pct: r(p.miscella, 1), lel_pct: r(p.lel, 1), extractor_running: p.extractorRun ? 1 : 0,
        meal_residual_hexane_ppm: r(p.residualHexane, 0), meal_residual_oil_pct: r(p.residualOil), meal_protein_pct: r(p.mealProtein), meal_humidity_pct: r(p.mealHumidity),
        trucks_in_plant: k.trucksInPlant, trucks_waiting_yard: k.trucksWaitingYard, trucks_waiting_road: k.roadQueue,
        tankers_dispatched_today: k.tankers, meal_trucks_dispatched_today: k.mealTrucks, problems_active: k.problems,
        ...this.trafficMetrics(),
        ...this.staff.metrics(),
      },
      silos: obj(this.storages, (s) => ({ name: s.name, type: s.kind, level_pct: r((s.stock / s.cap) * 100), stock_t: r(s.stock, 1), capacity_t: s.cap, temp_c: r(s.temp, 1), humidity_pct: r(s.hum) })),
      tanks: obj(this.tanks, (t) => ({ name: t.name, level_pct: r((t.stock / t.cap) * 100), stock_t: r(t.stock, 1), capacity_t: t.cap, temp_c: r(t.temp, 1) })),
      boilers: obj(this.boilers, (b) => ({ name: b.name, status: b.on ? 1 : 0, load_pct: r(b.load, 1), flue_temp_c: r(b.flue, 0) })),
      stations: obj(Object.values(this.stations), (s) => ({
        name: s.name, available: this.stationDown(s.id) ? 0 : 1, network: this.hasFault('station_down', s.id) ? 0 : 1,
        busy: s.users.size, operations_today: s.opsToday, trucks_stopped: this.vehicles.filter((v) => v.frozen && v.station === s.id).length,
      })),
      random_faults: this.randomFaults ? 1 : 0,
      problem_states: Object.fromEntries(this.problemStates().map((p) => [p.id, p.state])),
      discovery: {
        silos: this.storages.map((s) => ({ '{#ID}': s.id, '{#NAME}': s.name, '{#TYPE}': s.kind })),
        tanks: this.tanks.map((t) => ({ '{#ID}': t.id, '{#NAME}': t.name })),
        boilers: this.boilers.map((b) => ({ '{#ID}': b.id, '{#NAME}': b.name })),
        // {#AREA} feeds the `area` tag of the "camión detenido" trigger (Zabbix CEP groups by area).
        stations: Object.values(this.stations).map((s) => ({ '{#ID}': s.id, '{#NAME}': s.name, '{#AREA}': ['BAL_D', 'BAL_DS', 'OL', 'ML'].includes(s.id) ? 'despacho' : 'recepcion' })),
      },
      problems: [...this.problems.values()].map((pr) => ({ key: pr.key, severity: pr.sev, name: pr.name })),
    };
  }

  // 0 = normal, 1 = manual, 2 = random
  problemStates() {
    return PROBLEMS.map((p) => {
      const a = this.active.get(p.id);
      return {
        id: p.id, name: p.name, desc: p.desc, sev: p.sev, src: p.src,
        state: !a ? 0 : a.origin === 'manual' ? 1 : 2,
        sinceMin: a ? Math.round(this.t - a.since) : null,
        leftMin: a && a.until ? Math.max(0, Math.round(a.until - this.t)) : null,
      };
    });
  }

  // Every numeric plant key the app knows (what Zabbix would see with a healthy PLC).
  flatMetrics() {
    const m = this.metrics();
    const out = [
      { key: 'planta.sim_minutes', value: m.sim_minutes },
      { key: 'planta.speed', value: m.speed },
      { key: 'planta.random_faults', value: m.random_faults },
    ];
    for (const [f, v] of Object.entries(m.plant)) out.push({ key: `planta.${f}`, value: v, field: f });
    const group = (prefix, objs) => {
      for (const [id, fields] of Object.entries(objs))
        for (const [f, v] of Object.entries(fields)) if (typeof v === 'number') out.push({ key: `planta.${prefix}.${f}[${id}]`, value: v });
    };
    group('silo', m.silos);
    group('tank', m.tanks);
    group('boiler', m.boilers);
    group('station', m.stations);
    for (const [id, st] of Object.entries(m.problem_states)) out.push({ key: `planta.problem[${id}]`, value: st });
    return out;
  }

  // Flat list of {key, value} for Zabbix sender (trapper items) of the plant host.
  senderItems() {
    const plcDown = this.hasFault('plc_comm', 'EXT');
    const out = this.flatMetrics()
      .filter((i) => !(plcDown && i.field && PLC_EXT_FIELDS.includes(i.field)))
      .map(({ key, value }) => ({ key, value }));
    // The app's own CEP engine only feeds the app UI: event correlation in Zabbix is done by
    // the native CEP rules (server/zabbix-cep.js) on the real events.
    return out;
  }

  // LLD payloads of the plant host: key → JSON array.
  discoveryData() {
    const d = this.metrics().discovery;
    const out = Object.entries(d).map(([k, v]) => ({ key: `planta.${k}.discovery`, value: JSON.stringify(v) }));
    return out;
  }

  evalCep() {
    if (!this.cep) return;
    const metrics = {};
    for (const i of this.flatMetrics()) metrics[i.key] = i.value;
    this.cep.evaluate(this, { t: this.t, problems: new Set(this.active.keys()), metrics });
  }

  control(cmd = {}) {
    if (cmd.speed !== undefined) {
      const s = Number(cmd.speed);
      if ([0, 1, 5, 15, 30].includes(s)) this.speed = s;
    }
    if (cmd.problem) return this.setProblem(cmd.problem, cmd.active !== false);
    if (cmd.randomFaults !== undefined) this.setRandomFaults(cmd.randomFaults);
    if (cmd.clearFaults) this.clearFaults();
    return true;
  }
}

export function moveAlong(a, dist) {
  while (dist > 0 && a.path && a.pi < a.path.length) {
    const p = a.path[a.pi];
    const dx = p.x - a.x;
    const dz = p.z - a.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-4) {
      a.pi++;
      continue;
    }
    a.h = Math.atan2(dz, dx);
    if (d <= dist) {
      a.x = p.x;
      a.z = p.z;
      dist -= d;
      a.pi++;
    } else {
      a.x += (dx / d) * dist;
      a.z += (dz / d) * dist;
      dist = 0;
    }
  }
  return !a.path || a.pi >= a.path.length;
}
