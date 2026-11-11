// Plant staff that reacts to problems:
//  - technicians receive work orders (OT), walk to the asset, repair it;
//  - supervisors / chiefs go to check, complain while it is not fixed;
//  - the plant manager escalates when it drags on;
//  - the HSE chief orders an evacuation when hexane LEL is dangerous.
// Their actions are also queued in sim.outbox so the server can acknowledge the
// matching Zabbix problem (assignment, complaints, escalation, closure).
import { STATIONS, BOILERS, BUILDINGS, STORAGES, MONITOR_ROOM } from './layout.js';
import { PROBLEM_BY_ID } from './problems.js';

const r = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];

export const LOOK = {
  manager: { helmet: 0xffffff, vest: 0x1f3b63 },
  chief: { helmet: 0xffffff, vest: 0x2563a8 },
  supervisor: { helmet: 0x2b7fff, vest: 0xffd400 },
  tech: { helmet: 0x18b26b, vest: 0x18b26b },
  operator: { helmet: 0xffd400, vest: 0xff7a00 },
};

const WORKSHOP = [-38, -100];
const MEETING_POINT = [-34, -80];

export const STAFF = [
  // The plant manager's place is the monitoring room, in front of the Zabbix dashboard.
  { id: 'GER', name: 'Gerente de planta', role: 'Gerencia · Sala de monitoreo', kind: 'manager', post: [MONITOR_ROOM.seat.x, MONITOR_ROOM.seat.z, MONITOR_ROOM.seat.x, MONITOR_ROOM.z - 8], round: [[MONITOR_ROOM.x - 3.5, MONITOR_ROOM.z - 4], [MONITOR_ROOM.x + 3.5, MONITOR_ROOM.z - 4]] },
  { id: 'JPROD', name: 'Jefe de producción', role: 'Jefatura · Producción', kind: 'chief', areas: ['produccion', 'energia', 'extraccion'], post: [17, -111, 26, -111], round: [[12, -100]] },
  { id: 'JHSE', name: 'Jefe de seguridad (HSE)', role: 'Jefatura · Seguridad', kind: 'chief', areas: ['transito', 'seguridad'], post: [17, -117, 26, -117], round: [[12, -100]] },
  { id: 'JMANT', name: 'Jefe de mantenimiento', role: 'Jefatura · Mantenimiento', kind: 'chief', areas: ['mantenimiento'], post: [-38.5, -108, -46, -112], round: [[-36, -100]] },
  { id: 'TI', name: 'Técnico de redes / TI', role: 'Técnico', kind: 'tech', skills: ['red'] },
  { id: 'ELEC', name: 'Electricista', role: 'Técnico', kind: 'tech', skills: ['electrico'] },
  { id: 'MEC1', name: 'Mecánico 1', role: 'Técnico', kind: 'tech', skills: ['mecanico'] },
  { id: 'MEC2', name: 'Mecánico 2', role: 'Técnico', kind: 'tech', skills: ['mecanico'] },
  { id: 'INST', name: 'Instrumentista', role: 'Técnico', kind: 'tech', skills: ['instrumentos', 'red'] },
  { id: 'CALD', name: 'Calderista', role: 'Técnico', kind: 'tech', skills: ['calderas'] },
  { id: 'TSEG', name: 'Técnico de seguridad', role: 'Técnico', kind: 'tech', skills: ['seguridad'] },
];

const SKILL_NAME = { red: 'redes', electrico: 'electricidad', mecanico: 'mecánica', instrumentos: 'instrumentación', calderas: 'calderas', seguridad: 'seguridad' };

// What each problem needs: skills, area (who supervises), repair time range (sim minutes).
export const WORK = {
  bal_in_net: { skills: ['red'], area: 'recepcion', repair: [15, 30], short: 'la balanza de ingreso' },
  bal_out_net: { skills: ['red'], area: 'recepcion', repair: [15, 30], short: 'la balanza de salida' },
  gate_net: { skills: ['red'], area: 'recepcion', repair: [10, 25], short: 'el sistema de portería' },
  samp_fault: { skills: ['instrumentos'], area: 'recepcion', repair: [20, 40], short: 'el calador' },
  boiler_B1: { skills: ['calderas'], area: 'energia', repair: [40, 90], short: 'la caldera 1' },
  boiler_B2: { skills: ['calderas'], area: 'energia', repair: [40, 90], short: 'la caldera 2' },
  hexane_leak: { skills: ['seguridad', 'instrumentos'], area: 'seguridad', repair: [25, 45], short: 'la fuga de hexano' },
  noria_N1: { skills: ['mecanico'], area: 'recepcion', repair: [30, 60], short: 'la noria 1' },
  noria_N2: { skills: ['mecanico'], area: 'recepcion', repair: [30, 60], short: 'la noria 2' },
  silo_hot_S2: { skills: ['mecanico'], area: 'acopio', repair: [40, 80], short: 'el silo 2' },
  prep_power: { skills: ['electrico'], area: 'produccion', repair: [15, 40], short: 'el CCM de preparación' },
  ol_arm: { skills: ['mecanico'], area: 'despacho', repair: [20, 40], short: 'el brazo de carga' },
  plc_ext_comm: { skills: ['instrumentos'], area: 'extraccion', repair: [15, 35], short: 'el PLC de extracción' },
  brake_fail: { skills: ['mecanico'], area: 'transito', repair: [20, 40], short: 'los frenos del camión' },
  vehicle_collision: { skills: ['mecanico', 'seguridad'], area: 'transito', repair: [30, 60], short: 'la colisión', tow: true },
  traffic_jam: { skills: ['mecanico'], area: 'transito', repair: [10, 25], short: 'el camión varado' },
};

const STATUS = { abierta: 'Abierta', asignada: 'Asignada', en_camino: 'En camino', en_reparacion: 'En reparación', en_espera: 'Reparada, falta normalizar', resuelta: 'Resuelta', cancelada: 'Cancelada' };

const SAY = {
  inspect: ['Voy a revisar {x}.', 'Ya voy a ver qué pasa con {x}.', 'Revisando {x}, manténganme informado.'],
  complain: ['¿Cuánto falta con {x}? Necesito la planta operando.', '¡Seguimos parados por {x}! ¿Qué ETA tenemos?', 'Esto ya lleva {m} min, ¿qué pasa con {x}?'],
  escalate: ['Esto no puede seguir: {m} min con {x}. Quiero un informe ya.', 'Estamos perdiendo producción por {x}. ¡Prioridad máxima!', 'Llamen al proveedor si hace falta, {x} tiene que quedar hoy.'],
  tech: ['En camino a {x}.', 'Llegué, empiezo a trabajar en {x}.', 'Diagnosticando {x}…'],
  done: ['Listo, terminé con {x}.', 'Trabajo terminado en {x}. Pueden normalizar.'],
  thanks: ['Bien hecho, volvemos a operar.', 'Gracias equipo. Registren la causa en la OT.'],
  unassigned: ['¡No hay técnico libre para {x}! Llamen al de guardia.', 'Todos ocupados, {x} queda en cola.'],
  nearMiss: ['¡Casi accidente! Bajen la velocidad en las vías internas.', '¡Cuidado con los peatones! Esto va al reporte de seguridad.'],
  flagman: ['Yo doy el paso, avance despacio.', 'Despejen el cruce, uno por vez.'],
  evac: ['¡Evacuación! Todos al punto de encuentro.', 'Alarma de gas: salgan de extracción ahora.'],
  summon: ['Voy para la sala de monitoreo.', 'Ya voy, quiero ver el dashboard de Zabbix.', 'Voy a la sala, ¿qué muestra Zabbix?'],
  monitor: ['Revisando el dashboard de Zabbix.', 'Todo a la vista en Zabbix: problemas, CEP y KPIs.'],
};
const fill = (s, vars) => s.replace(/\{(\w)\}/g, (_, k) => vars[k] ?? '');

export class Staff {
  constructor(sim) {
    this.sim = sim;
    this.orders = [];
    this.seq = 1;
    this.evacuating = false;
    this.offRoad = sim.pedOff;
  }

  people(kind) {
    return this.sim.people.filter((p) => p.kind === kind);
  }
  byId(id) {
    return this.sim.people.find((p) => p.staffId === id);
  }

  say(p, kind, vars = {}, sev = 0, toZabbix = null) {
    if (!p) return;
    const text = fill(pick(SAY[kind]), vars);
    p.say = { text, until: this.sim.t + 7 };
    this.sim.log(sev, `${p.name}: «${text}»`, 'radio', 'radio');
    if (toZabbix) this.sim.outbox.push({ ...toZabbix, message: `${p.name}: ${text}` });
  }

  // A walkable spot near (x, z) off the roads, slightly spread per person.
  spot(x, z, k = 0) {
    const ang = k * 1.9;
    const c = this.offRoad.nearestWalkable(x + Math.cos(ang) * 5, z + Math.sin(ang) * 5, 20) || this.sim.ped.nearestWalkable(x, z, 20);
    return c ? this.offRoad.center(c.i, c.j) : { x, z };
  }

  walk(p, to, task) {
    p.task = task;
    p.path = this.sim.ped.findPath({ x: p.x, z: p.z }, to) || [to];
    p.pi = p.path.length > 1 ? 1 : 0;
    p.wait = 0;
  }

  location(id) {
    const sim = this.sim;
    if (id === 'vehicle_collision' && sim.collision) return { x: sim.collision.x, z: sim.collision.z };
    if (id === 'traffic_jam') {
      const v = sim.vehicles.find((x) => x.id === sim.stallTruck);
      if (v) return { x: v.x, z: v.z };
      return sim.jam ? { x: sim.jam.x, z: sim.jam.z } : { x: 56, z: 71 };
    }
    if (id === 'brake_fail' || id === 'vehicle_collision') {
      const v = sim.vehicles.find((x) => x.id === sim.brakeTruck);
      if (v) return { x: v.x, z: v.z };
      return { x: 40, z: 70 };
    }
    const src = PROBLEM_BY_ID[id]?.src;
    const e = STATIONS[src] || BOILERS.find((b) => b.id === src) || BUILDINGS.find((b) => b.id === src) || STORAGES.find((s) => s.id === src);
    return e ? { x: e.x, z: e.z } : { x: 0, z: 0 };
  }

  chiefFor(area) {
    if (['recepcion', 'acopio', 'despacho'].includes(area)) return this.sim.people.find((p) => p.kind === 'supervisor');
    return this.sim.people.find((p) => p.kind === 'chief' && p.areas?.includes(area));
  }

  // ───────────── main update ─────────────
  update(dt) {
    this.syncOrders();
    this.dispatch();
    this.progress();
    this.supervise();
    this.evacuation();
    this.manager();
    for (const p of this.sim.people) if (p.say && this.sim.t > p.say.until) p.say = null;
  }

  // Someone entered the monitoring room: the plant manager comes right away (whatever he was
  // doing) and stays in front of the dashboard while they are there.
  manager() {
    const g = this.byId('GER');
    if (!g) return;
    const R = MONITOR_ROOM;
    const inRoom = Math.abs(g.x - R.x) < R.w / 2 && Math.abs(g.z - R.z) < R.d / 2;
    if (this.sim.monitorPresence) {
      if (g.task?.type === 'monitor') {
        // Gets off the cart at the door and walks in.
        if (g.riding && Math.hypot(g.x - R.door.x, g.z - R.door.z) < 3) {
          g.riding = false;
          g.speed = 4;
        }
        if (!g.path) {
          g.h = R.seat.h;
          g.riding = false;
        }
        return;
      }
      const seat = { x: R.seat.x, z: R.seat.z };
      // Far away: he comes in a service cart; close by: a brisk walk.
      const far = Math.hypot(g.x - R.door.x, g.z - R.door.z) > 30;
      g.speed = far ? 9 : 5.5;
      g.riding = far;
      this.walk(g, seat, { type: 'monitor' });
      g.path.push(seat);
      if (!inRoom || Math.hypot(g.x - seat.x, g.z - seat.z) > 1.5) this.say(g, 'summon');
      else this.say(g, 'monitor');
    } else if (g.task?.type === 'monitor') {
      if (!g.path) {
        g.task = null;
        g.speed = 3;
      }
    }
  }

  syncOrders() {
    const sim = this.sim;
    for (const [id, a] of sim.active) {
      if (!WORK[id]) continue;
      // A jam detected on its own is handled by traffic control; a broken-down truck needs a mechanic.
      if (id === 'traffic_jam' && !sim.stallTruck && !sim.pendingStall) continue;
      if (this.orders.some((o) => o.problem === id && !['resuelta', 'cancelada'].includes(o.status))) continue;
      const w = WORK[id];
      const o = {
        id: `OT-${String(this.seq++).padStart(4, '0')}`, problem: id, name: PROBLEM_BY_ID[id].name, short: w.short, area: w.area, origin: a.origin,
        status: 'abierta', created: sim.t, since: a.since, techs: [], need: [...w.skills], arrivedAt: null, repairUntil: null, resolvedAt: null,
        complained: false, escalated: false, inspector: null, managerSent: false, unassignedWarned: false,
      };
      this.orders.push(o);
      sim.log(1, `${o.id} abierta: ${o.name} (${o.origin === 'manual' ? 'manual' : 'aleatoria'})`, PROBLEM_BY_ID[id].src, 'ot');
    }
    // Problems cleared from outside (manual switch-off, fallback): close their orders.
    for (const o of this.orders) {
      if (['resuelta', 'cancelada'].includes(o.status)) continue;
      if (!sim.active.has(o.problem)) this.close(o, o.status === 'en_espera' || o.status === 'en_reparacion' ? 'resuelta' : 'cancelada', 'normalizada desde el panel');
    }
    if (this.orders.length > 80) this.orders = this.orders.filter((o) => !['resuelta', 'cancelada'].includes(o.status) || sim.t - o.resolvedAt < 240);
  }

  dispatch() {
    const sim = this.sim;
    for (const o of this.orders) {
      if (!['abierta', 'asignada', 'en_camino'].includes(o.status) || !o.need.length) continue;
      const loc = this.location(o.problem);
      for (const skill of [...o.need]) {
        const free = this.people('tech').filter((p) => p.skills.includes(skill) && (!p.task || p.task.type === 'return'));
        if (!free.length) continue;
        free.sort((a, b) => Math.hypot(a.x - loc.x, a.z - loc.z) - Math.hypot(b.x - loc.x, b.z - loc.z));
        const t = free[0];
        const to = this.spot(loc.x, loc.z, o.techs.length + 1);
        this.walk(t, to, { type: 'work', order: o.id });
        o.techs.push(t.staffId);
        o.need.splice(o.need.indexOf(skill), 1);
        const eta = Math.max(1, Math.round((t.path ? pathLen(t) : 0) / t.speed));
        o.eta = sim.t + eta;
        o.status = 'en_camino';
        if (!o.assignedAt) o.assignedAt = sim.t;
        this.say(t, 'tech', { x: o.short });
        sim.log(0, `${o.id}: ${t.name} asignado (${SKILL_NAME[skill]}), ETA ${eta} min`, PROBLEM_BY_ID[o.problem].src, 'ot');
        sim.outbox.push({ problem: o.problem, kind: 'assign', message: `${o.id}: ${t.name} asignado (${SKILL_NAME[skill]}), ETA ${eta} min` });
      }
    }
    // Tow truck for collisions (as soon as there is a crash and a team assigned).
    for (const o of this.orders) {
      if (WORK[o.problem]?.tow && !o.tow && sim.collision && o.techs.length && !['resuelta', 'cancelada'].includes(o.status)) o.tow = sim.spawnTow(sim.collision);
    }
  }

  progress() {
    const sim = this.sim;
    for (const o of this.orders) {
      if (!['en_camino', 'en_reparacion', 'en_espera'].includes(o.status)) continue;
      const techs = o.techs.map((id) => this.byId(id));
      if (o.status === 'en_camino') {
        const there = techs.filter((t) => t.task?.order === o.id && !t.path).length;
        const loc = this.location(o.problem);
        // Moving targets (a truck with no brakes): re-route if it left.
        for (const t of techs) if (t.task?.order === o.id && !t.path && Math.hypot(t.x - loc.x, t.z - loc.z) > 22) this.walk(t, this.spot(loc.x, loc.z, 1), t.task);
        const waitingMissing = o.need.length && sim.t - o.created > 30; // start with who is there
        const collisionReady = o.problem !== 'vehicle_collision' || !!sim.collision;
        if (there === techs.length && there > 0 && (!o.need.length || waitingMissing) && collisionReady) {
          o.status = 'en_reparacion';
          o.arrivedAt = sim.t;
          const [a, b] = WORK[o.problem].repair;
          o.repairUntil = sim.t + r(a, b) * (o.need.length ? 1.5 : 1);
          for (const t of techs) this.say(t, 'tech', { x: o.short });
          sim.outbox.push({ problem: o.problem, kind: 'message', message: `${o.id}: técnicos en sitio, reparación en curso (≈${Math.round(o.repairUntil - sim.t)} min)` });
        }
      } else if (o.status === 'en_reparacion' && sim.t >= o.repairUntil) {
        const a = sim.active.get(o.problem);
        const canFix = a && (a.origin === 'random' || sim.realism.techsRepairManual);
        this.say(techs[0], 'done', { x: o.short });
        if (o.problem === 'brake_fail') {
          const v = sim.vehicles.find((x) => x.id === sim.brakeTruck);
          if (v) v.brakeFail = false;
        }
        if (canFix) {
          sim.setProblem(o.problem, false, 'manual', `reparado por ${techs.map((t) => t.name).join(' y ')} (${o.id})`);
          this.close(o, 'resuelta', `reparado por ${techs.map((t) => t.name).join(' y ')}`);
        } else {
          o.status = 'en_espera';
          sim.log(0, `${o.id}: reparado en sitio; la falla manual sigue activa hasta normalizarla desde el panel`, PROBLEM_BY_ID[o.problem].src, 'ot');
          sim.outbox.push({ problem: o.problem, kind: 'message', message: `${o.id}: reparación terminada; esperando normalización manual` });
        }
      }
      // A truck with failed brakes that left the plant takes its problem with it.
      if (o.problem === 'brake_fail' && sim.brakeTruck && !sim.vehicles.some((v) => v.id === sim.brakeTruck) && sim.active.has('brake_fail')) {
        sim.setProblem('brake_fail', false, 'manual', 'el camión salió de planta; reportado al transportista');
      }
    }
  }

  close(o, status, why) {
    const sim = this.sim;
    o.status = status;
    o.resolvedAt = sim.t;
    for (const id of o.techs) {
      const t = this.byId(id);
      if (t?.task?.order === o.id) this.walk(t, this.spot(WORKSHOP[0], WORKSHOP[1], Math.random() * 6), { type: 'return' });
    }
    if (o.tow) sim.sendTowBack(o.tow);
    const insp = o.inspector && this.byId(o.inspector);
    if (insp?.task?.order === o.id) {
      if (status === 'resuelta') this.say(insp, 'thanks');
      insp.task = null;
      insp.path = null;
    }
    const mgr = this.byId('GER');
    if (mgr?.task?.order === o.id) {
      mgr.task = null;
      mgr.path = null;
    }
    if (status === 'resuelta') {
      sim.counters.woCompleted++;
      sim.counters.woRepairMin += o.resolvedAt - o.created;
      if (o.arrivedAt) {
        sim.counters.woResponseMin += o.arrivedAt - o.created;
        sim.counters.woResponded++;
      }
      sim.outbox.push({ problem: o.problem, kind: 'resolve', message: `${o.id} cerrada: ${why} en ${Math.round(o.resolvedAt - o.created)} min` });
    }
    sim.log(0, `${o.id} ${STATUS[status].toLowerCase()}: ${why}`, PROBLEM_BY_ID[o.problem].src, 'ot');
  }

  supervise() {
    const sim = this.sim;
    const cfg = sim.realism;
    for (const o of this.orders) {
      if (['resuelta', 'cancelada'].includes(o.status)) continue;
      const age = sim.t - o.created;
      const loc = this.location(o.problem);
      // Area chief goes to look.
      if (!o.inspector) {
        const c = this.chiefFor(o.area);
        if (c && !c.task) {
          o.inspector = c.staffId;
          this.walk(c, this.spot(loc.x, loc.z, 4), { type: 'inspect', order: o.id });
          this.say(c, 'inspect', { x: o.short });
        }
      }
      if (!o.complained && age >= cfg.escalation1) {
        o.complained = true;
        const c = (o.inspector && this.byId(o.inspector)) || this.chiefFor(o.area);
        this.say(c, 'complain', { x: o.short, m: Math.round(age) }, 2, { problem: o.problem, kind: 'message' });
      }
      if (!o.escalated && age >= cfg.escalation2) {
        o.escalated = true;
        sim.counters.escalations++;
        const g = this.byId('GER');
        if (g && !g.task && !sim.monitorPresence) this.walk(g, this.spot(loc.x, loc.z, 6), { type: 'inspect', order: o.id });
        this.say(g, 'escalate', { x: o.short, m: Math.round(age) }, 3, { problem: o.problem, kind: 'escalate' });
      }
      if (o.status === 'abierta' && !o.techs.length && age > 10 && !o.unassignedWarned) {
        o.unassignedWarned = true;
        this.say(this.byId('JMANT'), 'unassigned', { x: o.short }, 2);
      }
    }
  }

  evacuation() {
    const sim = this.sim;
    const danger = sim.proc.lel > 25;
    if (danger && !this.evacuating) {
      this.evacuating = true;
      sim.counters.evacuations++;
      this.say(this.byId('JHSE'), 'evac', {}, 4);
      for (const p of sim.people) {
        if (p.kind === 'tech' && p.skills.includes('seguridad')) continue;
        const near = Math.hypot(p.x - 18, p.z - 38 * -1) < 45 || p.zone === 'extraccion';
        if (!near) continue;
        p.evac = true;
        this.walk(p, this.spot(MEETING_POINT[0], MEETING_POINT[1], Math.random() * 6), { type: 'evac', prev: p.task });
      }
    } else if (!danger && this.evacuating && sim.proc.lel < 10) {
      this.evacuating = false;
      sim.log(0, 'Fin de la evacuación: LEL normalizado, el personal vuelve a sus puestos', 'EXT', 'seguridad');
      for (const p of sim.people) {
        if (!p.evac) continue;
        p.evac = false;
        p.task = p.task?.prev && p.task.prev.type === 'work' ? p.task.prev : null;
        if (p.task) {
          const o = this.orders.find((x) => x.id === p.task.order);
          const loc = o ? this.location(o.problem) : null;
          if (loc) this.walk(p, this.spot(loc.x, loc.z, 2), p.task);
        }
        p.path = p.task ? p.path : null;
      }
    }
  }

  // Hooks from traffic.
  nearMiss() {
    this.say(this.byId('JHSE'), 'nearMiss', {}, 2);
  }
  flagman() {
    this.say(this.sim.people.find((p) => p.kind === 'supervisor'), 'flagman', {}, 0);
  }

  metrics() {
    const sim = this.sim;
    const open = this.orders.filter((o) => !['resuelta', 'cancelada'].includes(o.status));
    const c = sim.counters;
    const unassigned = open.filter((o) => !o.techs.length).map((o) => sim.t - o.created);
    return {
      wo_open: open.length,
      wo_in_progress: open.filter((o) => ['en_camino', 'en_reparacion'].includes(o.status)).length,
      wo_completed_today: c.woCompleted,
      wo_mttr_min: c.woCompleted ? Number((c.woRepairMin / c.woCompleted).toFixed(1)) : 0,
      wo_response_min: c.woResponded ? Number((c.woResponseMin / c.woResponded).toFixed(1)) : 0,
      wo_unassigned_max_min: unassigned.length ? Math.round(Math.max(...unassigned)) : 0,
      staff_technicians_busy: this.people('tech').filter((p) => p.task?.type === 'work').length,
      staff_escalations_today: c.escalations,
      staff_evacuation: this.evacuating ? 1 : 0,
    };
  }

  snapshot() {
    const sim = this.sim;
    const name = (id) => this.byId(id)?.name ?? id;
    return this.orders
      .filter((o) => !['resuelta', 'cancelada'].includes(o.status) || sim.t - o.resolvedAt < 120)
      .slice(-25)
      .reverse()
      .map((o) => ({
        id: o.id, problem: o.problem, name: o.name, status: o.status, statusText: STATUS[o.status], origin: o.origin,
        techs: o.techs.map(name), need: o.need.map((s) => SKILL_NAME[s]), ageMin: Math.round((o.resolvedAt ?? sim.t) - o.created),
        etaMin: o.status === 'en_camino' && o.eta ? Math.max(0, Math.round(o.eta - sim.t)) : null,
        repairLeftMin: o.status === 'en_reparacion' ? Math.max(0, Math.round(o.repairUntil - sim.t)) : null,
        escalated: o.escalated,
      }));
  }
}

function pathLen(p) {
  let d = 0;
  let x = p.x;
  let z = p.z;
  for (let i = p.pi; i < p.path.length; i++) {
    d += Math.hypot(p.path[i].x - x, p.path[i].z - z);
    x = p.path[i].x;
    z = p.path[i].z;
  }
  return d;
}

export const WORKSHOP_SPOT = WORKSHOP;
