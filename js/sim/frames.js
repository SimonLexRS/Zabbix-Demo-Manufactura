// Wire format of the live stream (shared by the server and the browser).
//
// Every 200 ms the server sends a small "fast" frame with what moves (vehicles,
// people, flows, stations, traffic). Once per second — or right away when a
// problem or work order changes — it sends the "full" snapshot.

export const FAST_KEYS = ['tick', 't', 'clock', 'speed', 'vehicles', 'people', 'flows', 'stations', 'traffic', 'gates'];

// 3 decimals are plenty for positions (1 u ≈ 1.5 m) and keep the JSON small.
const round = (_k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v);

export function encodeFrame(snap, { full = false } = {}) {
  let obj;
  if (full) obj = { ...snap, k: 'F' };
  else {
    obj = { k: 'f' };
    for (const key of FAST_KEYS) obj[key] = snap[key];
  }
  return JSON.stringify(obj, round);
}

// What makes the next frame "full" without waiting for the 1 s cadence.
export function urgentSignature(snap) {
  return JSON.stringify([
    (snap.problems || []).map((p) => `${p.id}:${p.origin}`),
    (snap.orders || []).map((o) => `${o.id}:${o.status}`),
    snap.randomFaults,
    snap.speed,
    snap.traffic?.collision ? 1 : 0,
  ]);
}

// Merges a received frame into the current client state.
export function mergeFrame(state, msg) {
  if (msg.k === 'f') return state ? { ...state, ...msg } : null;
  return msg;
}
