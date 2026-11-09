// Data source: live server (SSE) or, if no server is reachable, a local
// simulation running in the browser. Both produce identical snapshots.
//
// Snapshots arrive every 200 ms; the renderer draws ~250 ms in the past and
// interpolates between the two snapshots that bracket that time — the same
// trick AI Town uses with its "historical" buffers to get smooth motion.

export const TICK_MS = 200;
const RENDER_DELAY = 260;

export class SnapshotBuffer {
  constructor() {
    this.buf = [];
  }
  push(s) {
    s._at = performance.now();
    this.buf.push(s);
    if (this.buf.length > 8) this.buf.shift();
  }
  get latest() {
    return this.buf[this.buf.length - 1];
  }
  sample(now = performance.now()) {
    const b = this.buf;
    if (!b.length) return null;
    const t = now - RENDER_DELAY;
    for (let i = b.length - 1; i > 0; i--) {
      if (b[i - 1]._at <= t) {
        const a = b[i - 1];
        const c = b[i];
        const alpha = Math.min(1, Math.max(0, (t - a._at) / Math.max(1, c._at - a._at)));
        return { a, b: c, alpha };
      }
    }
    return { a: b[0], b: b[0], alpha: 1 };
  }
}

export async function connect({ onSnapshot, onMode }) {
  let control = async () => ({ ok: false });
  let problems = async () => ({ ok: false });

  const startLocal = async (reason) => {
    const { Simulation } = await import('./sim/simulation.js');
    const sim = new Simulation({ randomFaults: true });
    setInterval(() => {
      sim.advance((TICK_MS / 1000) * sim.speed);
      onSnapshot(sim.snapshot());
    }, TICK_MS);
    control = async (cmd) => ({ ok: sim.control(cmd), speed: sim.speed });
    problems = async (cmd) => {
      let ok = true;
      if (cmd.clearAll) sim.clearFaults();
      else if (cmd.randomFaults !== undefined) sim.setRandomFaults(cmd.randomFaults);
      else ok = sim.setProblem(cmd.id, cmd.active !== false);
      onSnapshot(sim.snapshot());
      return { ok, randomFaults: sim.randomFaults, problems: sim.problemStates() };
    };
    onMode({ mode: 'local', reason });
  };

  const tryServer = () =>
    new Promise((resolve) => {
      if (!('EventSource' in window) || !location.protocol.startsWith('http')) return resolve(false);
      const es = new EventSource('api/stream');
      let got = false;
      const timer = setTimeout(() => {
        if (!got) {
          es.close();
          resolve(false);
        }
      }, 3000);
      es.onmessage = (e) => {
        if (!got) {
          got = true;
          clearTimeout(timer);
          resolve(true);
          onMode({ mode: 'server' });
        }
        onSnapshot(JSON.parse(e.data));
      };
      es.onerror = () => {
        if (!got) {
          clearTimeout(timer);
          es.close();
          resolve(false);
        } else {
          onMode({ mode: 'reconnecting' });
        }
      };
      es.onopen = () => got && onMode({ mode: 'server' });
    });

  const live = await tryServer();
  if (live) {
    // POST with the optional CONTROL_TOKEN (asked once and remembered).
    const post = async (url, cmd) => {
      const headers = { 'Content-Type': 'application/json' };
      let token = null;
      try {
        token = localStorage.getItem('controlToken');
      } catch {}
      if (token) headers['x-control-token'] = token;
      let r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(cmd) });
      if (r.status === 401) {
        const t = window.prompt('Token de control del servidor (CONTROL_TOKEN):');
        if (!t) return { ok: false };
        try {
          localStorage.setItem('controlToken', t);
        } catch {}
        headers['x-control-token'] = t;
        r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(cmd) });
      }
      return r.json();
    };
    control = (cmd) => post('api/control', cmd);
    problems = (cmd) => post('api/problems', cmd);
  } else {
    await startLocal('sin servidor');
  }
  return { control: (cmd) => control(cmd), problems: (cmd) => problems(cmd) };
}
