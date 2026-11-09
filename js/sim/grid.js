// Walkability grid + A* pathfinding.
// Same idea as AI Town's convex/aiTown/movement.ts (findRoute + MinHeap + blocked()):
// the world is a grid, agents path over walkable cells, the route is compressed
// into corner points and the agent then moves along the segments every tick.

import { ROADS } from './layout.js';

export class MinHeap {
  constructor(less) {
    this.a = [];
    this.less = less;
  }
  get size() {
    return this.a.length;
  }
  push(v) {
    const a = this.a;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l], a[m])) m = l;
        if (r < a.length && this.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

export class Grid {
  constructor({ minX, minZ, maxX, maxZ, cell }) {
    this.minX = minX;
    this.minZ = minZ;
    this.cell = cell;
    this.w = Math.ceil((maxX - minX) / cell);
    this.h = Math.ceil((maxZ - minZ) / cell);
    this.cells = new Uint8Array(this.w * this.h);
    this.cost = null; // optional extra cost per cell (e.g. pedestrians avoid walking along roads)
  }

  idx(i, j) {
    return j * this.w + i;
  }
  inside(i, j) {
    return i >= 0 && j >= 0 && i < this.w && j < this.h;
  }
  walkable(i, j) {
    return this.inside(i, j) && this.cells[this.idx(i, j)] === 1;
  }
  toCell(x, z) {
    return { i: Math.floor((x - this.minX) / this.cell), j: Math.floor((z - this.minZ) / this.cell) };
  }
  center(i, j) {
    return { x: this.minX + (i + 0.5) * this.cell, z: this.minZ + (j + 0.5) * this.cell };
  }

  paintRect(x0, z0, x1, z1, value) {
    const a = this.toCell(Math.min(x0, x1), Math.min(z0, z1));
    const b = this.toCell(Math.max(x0, x1) - 1e-6, Math.max(z0, z1) - 1e-6);
    for (let j = Math.max(0, a.j); j <= Math.min(this.h - 1, b.j); j++)
      for (let i = Math.max(0, a.i); i <= Math.min(this.w - 1, b.i); i++) this.cells[this.idx(i, j)] = value;
  }

  nearestWalkable(x, z, maxR = 12) {
    const c = this.toCell(x, z);
    if (this.walkable(c.i, c.j)) return c;
    for (let r = 1; r <= maxR; r++) {
      let best = null;
      let bestD = Infinity;
      for (let dj = -r; dj <= r; dj++)
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const i = c.i + di;
          const j = c.j + dj;
          if (!this.walkable(i, j)) continue;
          const p = this.center(i, j);
          const d = (p.x - x) ** 2 + (p.z - z) ** 2;
          if (d < bestD) {
            bestD = d;
            best = { i, j };
          }
        }
      if (best) return best;
    }
    return null;
  }

  // A* with 4-neighbours and a small turn penalty (keeps vehicles on straight roads).
  findPath(from, to) {
    const s = this.nearestWalkable(from.x, from.z);
    const g = this.nearestWalkable(to.x, to.z);
    if (!s || !g) return null;
    const W = this.w;
    const N = this.w * this.h;
    const cost = new Float32Array(N).fill(Infinity);
    const prev = new Int32Array(N).fill(-1);
    const dirOf = new Int8Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const sI = this.idx(s.i, s.j);
    const gI = this.idx(g.i, g.j);
    const heap = new MinHeap((a, b) => a.f < b.f);
    cost[sI] = 0;
    heap.push({ n: sI, f: 0 });
    const D = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    let found = false;
    let guard = 0;
    while (heap.size && guard++ < 200000) {
      const { n } = heap.pop();
      if (closed[n]) continue;
      closed[n] = 1;
      if (n === gI) {
        found = true;
        break;
      }
      const ci = n % W;
      const cj = (n / W) | 0;
      for (let d = 0; d < 4; d++) {
        const ni = ci + D[d][0];
        const nj = cj + D[d][1];
        if (!this.walkable(ni, nj)) continue;
        const nn = nj * W + ni;
        if (closed[nn]) continue;
        const turn = dirOf[n] !== -1 && dirOf[n] !== d ? 0.6 : 0;
        const c = cost[n] + 1 + turn + (this.cost ? this.cost[nn] : 0);
        if (c < cost[nn]) {
          cost[nn] = c;
          prev[nn] = n;
          dirOf[nn] = d;
          const h = Math.abs(ni - g.i) + Math.abs(nj - g.j);
          heap.push({ n: nn, f: c + h });
        }
      }
    }
    if (!found) return null;
    const cellsPath = [];
    for (let n = gI; n !== -1; n = prev[n]) cellsPath.push(n);
    cellsPath.reverse();
    // Compress collinear cells into corner points.
    const pts = [];
    for (let k = 0; k < cellsPath.length; k++) {
      const n = cellsPath[k];
      const p = this.center(n % W, (n / W) | 0);
      if (k > 0 && k < cellsPath.length - 1) {
        const a = cellsPath[k - 1];
        const b = cellsPath[k + 1];
        if (b - n === n - a) continue;
      }
      pts.push(p);
    }
    pts[0] = { x: from.x, z: from.z };
    if (pts.length === 1) pts.push({ x: to.x, z: to.z });
    else pts[pts.length - 1] = { x: to.x, z: to.z };
    return pts;
  }
}

// Shift a polyline to the right-hand side (vehicles keep their lane on two-way roads).
export function offsetRight(pts, off) {
  if (pts.length < 2) return pts;
  const out = [];
  for (let k = 0; k < pts.length; k++) {
    const a = pts[Math.max(0, k - 1)];
    const b = pts[Math.min(pts.length - 1, k + 1)];
    const p = pts[k];
    // Direction of incoming and outgoing segments.
    const din = k > 0 ? norm(p.x - a.x, p.z - a.z) : norm(b.x - p.x, b.z - p.z);
    const dout = k < pts.length - 1 ? norm(b.x - p.x, b.z - p.z) : din;
    // Right normal in X/Z (Z grows south): right of (dx,dz) is (-dz, dx).
    let nx = -din.z - dout.z;
    let nz = din.x + dout.x;
    const l = Math.hypot(nx, nz) || 1;
    nx /= l;
    nz /= l;
    const cos = Math.max(0.5, (din.x * dout.x + din.z * dout.z + 1) / 2) ** 0.5;
    out.push({ x: p.x + (nx * off) / cos, z: p.z + (nz * off) / cos });
  }
  return out;
}

function norm(x, z) {
  const l = Math.hypot(x, z) || 1;
  return { x: x / l, z: z / l };
}

// Lane path for a vehicle: shift the route to the right-hand lane and move into it
// within the first few metres (instead of drifting diagonally along the whole segment).
// Moves the inner corners of a road route onto the centre line of the road(s) they lie on,
// so the lane offset puts traffic in each direction on its own side regardless of which grid
// column A* happened to choose.
const LANE_ROADS = ROADS.filter((r) => !r.yard).map((r) => ({ r: r.rect, vertical: r.rect[3] - r.rect[1] > r.rect[2] - r.rect[0] }));
export function snapToRoads(raw) {
  if (!raw || raw.length < 3) return raw;
  const out = [raw[0]];
  for (let i = 1; i < raw.length - 1; i++) {
    let { x, z } = raw[i];
    for (const { r, vertical } of LANE_ROADS) {
      if (raw[i].x < r[0] || raw[i].x > r[2] || raw[i].z < r[1] || raw[i].z > r[3]) continue;
      if (vertical) x = (r[0] + r[2]) / 2;
      else z = (r[1] + r[3]) / 2;
    }
    const prev = out[out.length - 1];
    if (Math.hypot(x - prev.x, z - prev.z) > 0.5) out.push({ x, z });
  }
  out.push(raw[raw.length - 1]);
  // Drop collinear inner points.
  const res = [out[0]];
  for (let i = 1; i < out.length - 1; i++) {
    const a = res[res.length - 1];
    const b = out[i];
    const c = out[i + 1];
    const cross = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
    if (Math.abs(cross) > 1e-6) res.push(b);
  }
  res.push(out[out.length - 1]);
  return res;
}

export function lanePath(raw, from, off = 1.7) {
  if (!raw || raw.length < 2) return raw;
  raw = snapToRoads(raw);
  const lane = offsetRight(raw, off);
  const dx = raw[1].x - raw[0].x;
  const dz = raw[1].z - raw[0].z;
  const len = Math.hypot(dx, dz) || 1;
  const k = Math.min(6, len / 2) / len;
  const merge = { x: lane[0].x + dx * k, z: lane[0].z + dz * k };
  return [{ x: from.x, z: from.z }, merge, ...lane.slice(1)];
}
