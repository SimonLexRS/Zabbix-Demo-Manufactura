// Realistic vehicle traffic: acceleration and braking, car following (IDM-like),
// intersection reservations, overtaking of parked vehicles, pedestrians as
// obstacles, near misses and collisions when a driver does not brake
// (brake failure or distraction).
//
// Units: distance in world units (1 u ≈ 1.5 m); time in simulated minutes, which
// at 1x is one real second, so speeds read as "units per second" on screen.
import { ROADS } from './layout.js';

export const KMH = 2.6; // display factor: u/s → km/h (internal limit ~25 km/h)
const ACC = 2.5; // u/s² acceleration
const BRAKE = 5; // service braking
const EMERGENCY = 9; // emergency braking
const ENGINE_BRAKE = 0.8; // what a truck without brakes can still do
const S0 = 3; // minimum standstill gap
const HEADWAY = 0.8; // time gap
const TRUCK_LEN = 11;
const LANE_BAND = 2.4; // lateral half-width of "same lane"

// Intersections = overlap of a horizontal and a vertical road rectangle.
export function buildIntersections() {
  const roads = ROADS.filter((r) => !r.yard && !r.highway);
  const horiz = (r) => r.rect[2] - r.rect[0] > r.rect[3] - r.rect[1];
  const boxes = [];
  for (const a of roads)
    for (const b of roads) {
      if (a === b || !horiz(a) || horiz(b)) continue;
      const x0 = Math.max(a.rect[0], b.rect[0]);
      const z0 = Math.max(a.rect[1], b.rect[1]);
      const x1 = Math.min(a.rect[2], b.rect[2]);
      const z1 = Math.min(a.rect[3], b.rect[3]);
      if (x1 > x0 && z1 > z0) boxes.push({ id: boxes.length, name: `${a.id}×${b.id}`, x0: x0 - 1, z0: z0 - 1, x1: x1 + 1, z1: z1 + 1 });
    }
  return boxes;
}

const YARD = ROADS.find((r) => r.yard).rect;

export class Traffic {
  constructor(sim) {
    this.sim = sim;
    this.boxes = buildIntersections();
    this.owner = new Map(); // boxId → vehicle id
    this.nearMissPairs = new Map(); // `${vid}:${pid}` → t
  }

  boxAt(x, z) {
    for (const b of this.boxes) if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) return b.id;
    return -1;
  }

  zoneSpeed(v) {
    const cfg = this.sim.realism;
    if (v.x > 62) return 14; // RN4 / access
    if (v.x >= YARD[0] && v.x <= YARD[2] && v.z >= YARD[1] && v.z <= YARD[3]) return 5.5; // yard
    return 11 * cfg.speedFactor;
  }

  // Remaining length of the current path and distance/angle to the next corner.
  pathInfo(v) {
    let remain = 0;
    let px = v.x;
    let pz = v.z;
    let corner = null;
    for (let i = v.pi; i < v.path.length; i++) {
      const p = v.path[i];
      const seg = Math.hypot(p.x - px, p.z - pz);
      if (!corner && i + 1 < v.path.length) {
        const n = v.path[i + 1];
        const a1 = Math.atan2(p.z - pz, p.x - px);
        const a2 = Math.atan2(n.z - p.z, n.x - p.x);
        let d = Math.abs(a2 - a1);
        if (d > Math.PI) d = 2 * Math.PI - d;
        if (d > 0.35) corner = { d: remain + seg, angle: d };
      }
      remain += seg;
      px = p.x;
      pz = p.z;
    }
    return { remain, corner };
  }

  direction(v) {
    const p = v.path[Math.min(v.pi, v.path.length - 1)];
    const dx = p.x - v.x;
    const dz = p.z - v.z;
    const l = Math.hypot(dx, dz);
    return l < 1e-3 ? { fx: Math.cos(v.h), fz: Math.sin(v.h) } : { fx: dx / l, fz: dz / l };
  }

  // Nearest obstacle ahead in this vehicle's lane: vehicles and people.
  leader(v, fx, fz) {
    let best = null;
    const look = 45;
    for (const o of this.sim.vehicles) {
      if (o === v || o.gone) continue;
      if (o.plan[o.step] === 'SLOT' && o.phase !== 'travel' && !o.crashed) continue; // parked in a yard bay
      const dx = o.x - v.x;
      const dz = o.z - v.z;
      const fwd = dx * fx + dz * fz;
      if (fwd <= 0.5 || fwd > look) continue;
      // Oncoming traffic (opposite heading) only blocks us when it is truly in our line;
      // otherwise it is passing in the other lane (or easing into it).
      const oncoming = Math.cos(o.h) * fx + Math.sin(o.h) * fz < -0.3 && o.phase === 'travel';
      if (Math.abs(-dx * fz + dz * fx) > (oncoming ? 0.6 : LANE_BAND)) continue;
      const gap = fwd - TRUCK_LEN;
      if (!best || gap < best.gap) best = { gap, speed: o.speed ?? 0, obj: o, isPerson: false, stationary: (o.speed ?? 0) < 0.2 && o.phase !== 'travel' };
    }
    for (const p of this.sim.people) {
      const dx = p.x - v.x;
      const dz = p.z - v.z;
      const fwd = dx * fx + dz * fz;
      if (fwd <= 0 || fwd > look) continue;
      if (Math.abs(-dx * fz + dz * fx) > 2) continue;
      const gap = fwd - TRUCK_LEN / 2 - 0.6;
      if (!best || gap < best.gap) best = { gap, speed: 0, obj: p, isPerson: true, stationary: !p.moving };
    }
    return best;
  }

  // Boxes the path enters within `look` units: [{id, entry}] in order.
  boxesAhead(v, look) {
    const out = [];
    let px = v.x;
    let pz = v.z;
    let dist = 0;
    const cur = this.boxAt(v.x, v.z);
    let last = cur;
    for (let i = v.pi; i < v.path.length && dist < look; i++) {
      const p = v.path[i];
      const seg = Math.hypot(p.x - px, p.z - pz);
      for (let s = 1.5; s <= seg && dist + s < look; s += 1.5) {
        const t = s / seg;
        const id = this.boxAt(px + (p.x - px) * t, pz + (p.z - pz) * t);
        if (id !== -1 && id !== last && id !== cur && !out.some((o) => o.id === id)) out.push({ id, entry: dist + s });
        last = id;
      }
      dist += seg;
      px = p.x;
      pz = p.z;
    }
    return { cur, ahead: out };
  }

  release(v, keep = new Set()) {
    for (const [id, owner] of this.owner) if (owner === v.id && !keep.has(id)) this.owner.delete(id);
  }

  releaseAll(v) {
    this.release(v);
  }

  // True when v belongs to a cycle of stopped vehicles waiting for each other (via leaderId).
  inCycle(v) {
    const byId = new Map(this.sim.vehicles.map((o) => [o.id, o]));
    const chain = [v];
    let x = byId.get(v.leaderId);
    for (let i = 0; i < 8 && x; i++) {
      if (x === v) {
        this.cycle = chain;
        return true;
      }
      if ((x.speed ?? 0) > 0.5 || chain.includes(x)) return false;
      chain.push(x);
      x = byId.get(x.leaderId);
    }
    return false;
  }

  // Who goes first in the last detected cycle: trucks leaving the plant, then the oldest.
  cycleWinner() {
    const leaving = (o) => (['GATE_OUT', 'EXIT_N', 'EXIT_S', 'BAL_OUT'].includes(o.plan[o.step]) ? 2 : 1);
    return [...this.cycle].sort((a, b) => leaving(b) - leaving(a) || parseInt(a.id.slice(1), 10) - parseInt(b.id.slice(1), 10))[0];
  }

  // Moves a travelling vehicle one step. Returns true when it reached the end of its path.
  drive(v, dt) {
    const sim = this.sim;
    if (v.crashed) {
      v.speed = 0;
      v.braking = false;
      return false;
    }
    v.speed ??= 0;
    const { fx, fz } = this.direction(v);
    const { remain, corner } = this.pathInfo(v);
    // Collisions off: drivers always brake (brake failures become a slow stop instead).
    const ignoring = sim.realism.collisions && (v.brakeFail || sim.t < (v.distractedUntil ?? 0));
    let target = this.zoneSpeed(v) * (v.damaged ? 0.45 : 1);
    target = Math.min(target, Math.sqrt(2 * BRAKE * Math.max(0, remain - 0.3)) + 0.6);
    if (corner) {
      const vc = corner.angle > 1 ? 4.5 : 7;
      target = Math.min(target, Math.sqrt(vc * vc + 2 * BRAKE * corner.d));
    }
    let reason = null;

    // Car following / pedestrians.
    const L = this.leader(v, fx, fz);
    v.leaderId = L && !L.isPerson ? L.obj.id : null;
    // Waiting cycle (A waits for B … waits for A, typical in the yard): the truck that is
    // leaving the plant goes first, then the oldest; the others yield and let it pass.
    if (L && !L.isPerson && v.speed < 0.5 && L.gap < 8 && this.inCycle(v) && this.cycleWinner() === v) {
      v.passing = true;
    } else if (L) {
      const vf = Math.sqrt(Math.max(0, L.speed * L.speed + 2 * BRAKE * (L.gap - S0 - HEADWAY * v.speed * 0.3)));
      // Overtaking a stopped vehicle, or a priority vehicle (tow) passing using the other lane.
      const overtaking = !L.isPerson && !L.obj.crashed && ((sim.t < (v.overtakeUntil ?? 0) && L.stationary) || v.priority);
      v.passing = overtaking && (L.gap < 14 || sim.t < (v.overtakeUntil ?? 0));
      if (!ignoring && !overtaking && vf < target) {
        target = vf;
        reason = L.isPerson ? 'peaton' : 'vehiculo';
      }
    }

    // Intersections: reserve the next crossing(s) before entering; otherwise stop at the line.
    const look = Math.max(16, (v.speed * v.speed) / (2 * BRAKE) + 10);
    const { cur, ahead } = this.boxesAhead(v, look);
    const keep = new Set(cur === -1 ? [] : [cur]);
    if (ahead.length) {
      // Reserve chained crossings (exit of one ≈ entry of the next) atomically.
      const chain = [ahead[0]];
      for (let i = 1; i < ahead.length && ahead[i].entry - ahead[i - 1].entry < 16; i++) chain.push(ahead[i]);
      const free = chain.every((b) => !this.owner.has(b.id) || this.owner.get(b.id) === v.id || !sim.vehicles.some((o) => o.id === this.owner.get(b.id) && !o.gone));
      const flagman = sim.t < (v.flagmanUntil ?? 0);
      if (free || flagman || ignoring) {
        for (const b of chain) {
          this.owner.set(b.id, v.id);
          keep.add(b.id);
        }
      } else {
        const vb = Math.sqrt(2 * BRAKE * Math.max(0, chain[0].entry - 2));
        if (vb < target) {
          target = vb;
          reason = 'cruce';
        }
      }
    }
    if (cur !== -1) this.owner.set(cur, v.id);
    this.release(v, keep);

    // Longitudinal dynamics.
    const prev = v.speed;
    if (target >= v.speed) v.speed = Math.min(target, v.speed + ACC * dt);
    else {
      const need = (v.speed - target) / dt;
      const dec = v.brakeFail && sim.realism.collisions ? ENGINE_BRAKE : Math.min(need, EMERGENCY);
      if (!v.brakeFail && need > BRAKE * 1.15 && v.speed > 3) {
        if (!v.hardBrakeLatch) {
          v.hardBrakeLatch = true;
          sim.counters.hardBrakes++;
        }
      } else if (need < BRAKE * 0.5) v.hardBrakeLatch = false;
      v.speed = Math.max(0, v.speed - dec * dt);
    }
    v.braking = v.speed < prev - 0.05 || (reason && v.speed < 0.5);
    v.waitReason = v.speed < 0.3 ? reason : null;

    // Move.
    let arrived = false;
    if (remain <= 0.6 && v.speed < 4) {
      arrived = moveTo(v, remain + 1);
      v.speed = 0;
    } else arrived = moveTo(v, v.speed * dt);

    // Contacts.
    if (!L) v.passing = sim.t < (v.overtakeUntil ?? 0) && v.speed > 0.5;
    if (L) {
      const newGap = L.gap - v.speed * dt + L.speed * dt;
      if (!L.isPerson && !v.passing && !v.priority && newGap <= 0 && sim.realism.collisions && ignoring) {
        sim.collide(v, L.obj);
        return false;
      }
      if (L.isPerson && newGap < 2.5 && (ignoring || v.speed > 3)) this.nearMiss(v, L.obj, ignoring);
    }

    // Distraction (reaction delay) appears now and then while driving.
    if (sim.realism.collisions && v.speed > 3 && Math.random() < (sim.realism.distractionPerHour / 60) * dt) v.distractedUntil = sim.t + 0.4 + Math.random() * 0.6;

    // Waiting management: overtake stopped obstacles, flagman for blocked crossings.
    if (v.speed < 0.3) v.blockedFor = (v.blockedFor ?? 0) + dt;
    else v.blockedFor = 0;
    if (L && L.stationary && !L.isPerson && !L.obj.crashed && v.blockedFor > 2 && this.oncomingClear(v, fx, fz)) {
      v.overtakeUntil = sim.t + 3;
      v.blockedFor = 0;
      sim.counters.overtakes++;
    }
    if (reason === 'cruce' && v.blockedFor > 6) {
      v.flagmanUntil = sim.t + 1.5;
      v.blockedFor = 0;
      sim.counters.flagman++;
      sim.log(1, `Señalero: el supervisor da paso al camión ${v.plate} en un cruce trabado`, 'PLAYA', 'transito');
      sim.staff?.flagman(v);
    }
    if (reason === 'peaton' && v.blockedFor > 2 && L?.obj && !L.obj.moving) {
      // A person standing in the lane steps aside to let the truck through.
      L.obj.x += -fz * 3.5;
      L.obj.z += fx * 3.5;
      v.blockedFor = 0;
    }
    return arrived;
  }

  oncomingClear(v, fx, fz) {
    for (const o of this.sim.vehicles) {
      if (o === v || o.gone) continue;
      const dx = o.x - v.x;
      const dz = o.z - v.z;
      const fwd = dx * fx + dz * fz;
      const lat = -dx * fz + dz * fx; // positive = to our left in the opposite lane
      if (fwd > -6 && fwd < 40 && lat < -1 && lat > -6 && (o.speed ?? 0) > 0.5) return false;
    }
    return true;
  }

  nearMiss(v, person, ignoring) {
    const sim = this.sim;
    const key = `${v.id}:${person.id}`;
    if (sim.t - (this.nearMissPairs.get(key) ?? -99) < 5) return;
    this.nearMissPairs.set(key, sim.t);
    sim.counters.nearMisses++;
    // The person jumps aside (no one is ever run over).
    const { fx, fz } = this.direction(v);
    person.x += -fz * 3.2;
    person.z += fx * 3.2;
    person.path = null;
    person.wait = 1;
    const why = ignoring ? (v.brakeFail ? 'camión sin frenos' : 'conductor distraído') : 'frenado al límite';
    sim.log(ignoring ? 3 : 2, `Casi accidente: ${person.name} y camión ${v.plate} (${why})`, 'PLAYA', 'seguridad');
    sim.staff?.nearMiss(v, person);
  }
}

// Advances along the path by `dist`, returns true at the end.
export function moveTo(a, dist) {
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
