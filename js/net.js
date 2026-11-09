// Data source: live server (SSE) or, if no server is reachable, a local
// simulation running in the browser. Both produce the same frames (js/sim/frames.js).
//
// Playback runs on the simulation clock, not on arrival times: frames come over
// the network in bursts (a 600 ms pause and then three at once is common through
// a proxy), so the renderer keeps its own clock a little behind the newest
// frame and interpolates between the frames around it — AI Town's "historical"
// buffers, plus an adaptive delay that absorbs the measured jitter.

export const TICK_MS = 200;
const MIN_DELAY = 0.35; // s of real time kept as cushion
const MAX_DELAY = 1.0;
const MAX_EXTRAPOLATE = 0.3; // s of dead reckoning when the buffer runs dry

export class SnapshotBuffer {
  constructor() {
    this.buf = [];
    this.playT = null; // simulated minutes being shown
    this.gaps = [];
    this.lastArrival = 0;
    this.delay = 0.5;
  }

  push(s) {
    const now = performance.now();
    if (this.lastArrival) {
      this.gaps.push(now - this.lastArrival);
      if (this.gaps.length > 60) this.gaps.shift();
      const sorted = [...this.gaps].sort((a, b) => a - b);
      const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? TICK_MS;
      const want = Math.min(MAX_DELAY, Math.max(MIN_DELAY, (p95 + 120) / 1000));
      // Grow fast, shrink slowly.
      this.delay = want > this.delay ? want : this.delay + (want - this.delay) * 0.02;
    }
    this.lastArrival = now;
    const last = this.latest;
    if (last && s.t <= last.t) {
      if (s.t < last.t - 5) this.reset(); // simulation restarted
      else return; // duplicate / out of order
    }
    this.buf.push(s);
    if (this.buf.length > 40) this.buf.shift();
  }

  reset() {
    this.buf = [];
    this.playT = null;
  }

  get latest() {
    return this.buf[this.buf.length - 1];
  }

  // Advances the playback clock by dt real seconds; nudges it (at most ±8 %) toward
  // "newest frame minus the cushion" so bursts and pauses never show as jumps.
  advance(dt) {
    const last = this.latest;
    if (!last) return;
    const rate = last.speed || 0; // simulated minutes per real second
    const target = last.t - this.delay * rate;
    if (this.playT === null || rate === 0 || Math.abs(target - this.playT) > Math.max(1.5, 2.5 * rate)) {
      this.playT = rate === 0 ? last.t : target;
      return;
    }
    const err = (target - this.playT) / Math.max(1e-6, rate); // seconds
    const k = Math.max(-0.08, Math.min(0.08, err * 0.5));
    this.playT += dt * rate * (1 + k);
    // Never run past the newest frame by more than the dead-reckoning allowance.
    this.playT = Math.min(this.playT, last.t + MAX_EXTRAPOLATE * rate);
  }

  // Frames around the playback time: p0, a, b, p3 (for curves) and alpha in [0, 1]
  // between a and b — above 1 while extrapolating past the newest frame.
  sample() {
    const b = this.buf;
    if (!b.length) return null;
    const t = this.playT ?? b[b.length - 1].t;
    if (t <= b[0].t) return { p0: b[0], a: b[0], b: b[0], p3: b[Math.min(1, b.length - 1)], alpha: 0 };
    for (let i = b.length - 1; i > 0; i--) {
      if (b[i - 1].t <= t) {
        const a = b[i - 1];
        const c = b[i];
        if (t >= c.t) {
          // Past the newest frame: extrapolate from the last two.
          const span = Math.max(1e-6, c.t - a.t);
          return { p0: b[i - 2] || a, a, b: c, p3: c, alpha: Math.min(1 + MAX_EXTRAPOLATE, (t - a.t) / span) };
        }
        return { p0: b[i - 2] || a, a, b: c, p3: b[i + 1] || c, alpha: (t - a.t) / Math.max(1e-6, c.t - a.t) };
      }
    }
    return { p0: b[0], a: b[0], b: b[0], p3: b[0], alpha: 0 };
  }
}

export async function connect({ onSnapshot, onMode, askToken }) {
  let control = async () => ({ ok: false });
  let problems = async () => ({ ok: false });

  const startLocal = async (reason) => {
    const { Simulation } = await import('./sim/simulation.js');
    const { FAST_KEYS, urgentSignature } = await import('./sim/frames.js');
    const sim = new Simulation({ randomFaults: true });
    let n = 0;
    let sig = '';
    setInterval(() => {
      sim.advance((TICK_MS / 1000) * sim.speed);
      const snap = sim.snapshot();
      const s2 = urgentSignature(snap);
      if (++n % 5 === 0 || s2 !== sig) onSnapshot(snap);
      else onSnapshot(Object.fromEntries([['k', 'f'], ...FAST_KEYS.map((k) => [k, snap[k]])]));
      sig = s2;
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
  let api = async () => ({ ok: false, error: 'Sin servidor: la configuración de Zabbix, IoT y CEP requiere el servidor.' });
  if (live) {
    // Calls with the admin key (asked once through the modal and remembered in this browser).
    const getKey = () => {
      try {
        return localStorage.getItem('controlToken') || '';
      } catch {
        return '';
      }
    };
    const setKey = (k) => {
      try {
        k ? localStorage.setItem('controlToken', k) : localStorage.removeItem('controlToken');
      } catch {}
    };
    api = async (method, url, body) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const headers = { 'Content-Type': 'application/json' };
        const key = getKey();
        if (key) headers['x-control-token'] = key;
        const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        if (r.status !== 401) {
          const j = await r.json().catch(() => ({}));
          return r.ok ? j : { ...j, ok: false, status: r.status };
        }
        setKey('');
        const k = await askToken?.(attempt ? 'Clave incorrecta, intenta de nuevo.' : '');
        if (!k) return { ok: false, cancelled: true, error: 'Se requiere la clave de administrador.' };
        setKey(k);
      }
      return { ok: false, error: 'Clave incorrecta.' };
    };
    control = (cmd) => api('POST', 'api/control', cmd);
    problems = (cmd) => api('POST', 'api/problems', cmd);
  } else {
    await startLocal('sin servidor');
  }
  return { live, control: (cmd) => control(cmd), problems: (cmd) => problems(cmd), api: (m, u, b) => api(m, u, b) };
}
