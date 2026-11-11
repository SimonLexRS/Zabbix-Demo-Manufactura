// Headless smoke test: runs the simulation for N simulated days and reports flow health.
import { Simulation } from '../js/sim/simulation.js';

const days = Number(process.argv[2] ?? 2);
const sim = new Simulation();
const t0 = Date.now();
let maxStuck = 0;
const lastMove = new Map();
let samples = 0;
for (let i = 0; i < days * 1440 * 5; i++) {
  sim.advance(0.2);
  if (i % 25 === 0) {
    samples++;
    for (const v of sim.vehicles) {
      const key = `${v.x.toFixed(1)},${v.z.toFixed(1)}`;
      const prev = lastMove.get(v.id);
      if (!prev || prev.key !== key) lastMove.set(v.id, { key, t: sim.t });
      else maxStuck = Math.max(maxStuck, sim.t - prev.t);
    }
  }
  if (i % (1440 * 5 / 4) === 0) {
    const k = sim.kpis();
    console.log(sim.clock().label, `veh=${sim.vehicles.length} yard=${k.trucksWaitingYard} road=${k.roadQueue} recv=${k.receivedT.toFixed(0)} crush=${k.crushedT.toFixed(0)} soy%=${k.soyPct.toFixed(1)} oil%=${k.oilPct.toFixed(1)} meal%=${k.mealPct.toFixed(1)} hex=${k.hexane.toFixed(0)} jams=${k.jams}/${k.jamsCleared} steam=${sim.proc.steam.toFixed(1)} probs=${[...sim.problems.keys()].join(',')}`);
  }
}
const snap = JSON.stringify(sim.snapshot());
const met = JSON.stringify(sim.metrics());
console.log(`\nrun ${(Date.now() - t0)}ms, snapshot ${snap.length}B, metrics ${met.length}B, max stationary vehicle ${maxStuck.toFixed(0)} min`);
console.log('vehicles now:', sim.vehicles.map((v) => `${v.id}:${v.kind}:${v.plan[v.step]}:${v.label}`).join(' | '));
console.log('last events:', sim.events.slice(0, 12).map((e) => `[${e.sev}] ${sim.clock(e.t).label} ${e.msg}`).join('\n'));
