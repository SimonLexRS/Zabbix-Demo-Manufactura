// Planta aceitera demo — authoritative simulation server (no dependencies).
//
// Like AI Town's Convex backend, the server owns the world and runs the engine
// loop; browsers only render the snapshots they receive (Server-Sent Events).
// Zabbix polls the HTTP endpoints below.
//
//   GET  /                      3D client (static files)
//   GET  /api/stream            SSE snapshots (5 Hz) for the 3D client
//   GET  /api/state             current snapshot (JSON)
//   GET  /api/metrics           flat metrics for Zabbix HTTP agent (master item)
//   GET  /api/zabbix/discovery/{silos|tanks|boilers|stations}  LLD JSON
//   GET  /metrics               Prometheus exposition format
//   POST /api/control           {"speed":5} | {"fault":"boiler_trip","target":"B1"} | {"clearFaults":true}
//   GET  /healthz

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Simulation } from '../js/sim/simulation.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8080);
const TICK_MS = 200;
const CONTROL_TOKEN = process.env.CONTROL_TOKEN || '';
const PUBLIC = new Set(['index.html', 'css', 'js', 'favicon.svg']);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

const sim = new Simulation();
sim.speed = Number(process.env.SIM_SPEED || 1);
const clients = new Set();
let lastSnapshot = sim.snapshot();

setInterval(() => {
  sim.advance((TICK_MS / 1000) * sim.speed);
  lastSnapshot = sim.snapshot();
  const payload = `data: ${JSON.stringify(lastSnapshot)}\n\n`;
  for (const res of clients) res.write(payload);
}, TICK_MS);

// Keep proxies (Traefik in Dokploy) from closing idle SSE connections.
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 15000);

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

function prometheus() {
  const m = sim.metrics();
  const lines = [];
  const g = (name, help, samples) => {
    lines.push(`# HELP planta_${name} ${help}`, `# TYPE planta_${name} gauge`);
    for (const [labels, v] of samples) lines.push(`planta_${name}${labels} ${v}`);
  };
  for (const [k, v] of Object.entries(m.plant)) g(k, k.replace(/_/g, ' '), [['', v]]);
  g('silo_level_pct', 'Nivel de silo/galpón', Object.entries(m.silos).map(([id, s]) => [`{id="${id}"}`, s.level_pct]));
  g('silo_temp_c', 'Temperatura de grano', Object.entries(m.silos).map(([id, s]) => [`{id="${id}"}`, s.temp_c]));
  g('tank_level_pct', 'Nivel tanque de aceite', Object.entries(m.tanks).map(([id, t]) => [`{id="${id}"}`, t.level_pct]));
  g('boiler_status', 'Caldera en servicio', Object.entries(m.boilers).map(([id, b]) => [`{id="${id}"}`, b.status]));
  g('boiler_load_pct', 'Carga de caldera', Object.entries(m.boilers).map(([id, b]) => [`{id="${id}"}`, b.load_pct]));
  return lines.join('\n') + '\n';
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 10000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
  const top = rel.split('/')[0];
  if (!PUBLIC.has(top)) {
    res.writeHead(404);
    return res.end('Not found');
  }
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(file);
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    headers['Cache-Control'] = rel.includes('/vendor/') ? 'public, max-age=604800, immutable' : 'no-cache';
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p === '/healthz') return json(res, 200, { ok: true, sim_time: sim.clock().label, clients: clients.size });
    if (p === '/api/state') return json(res, 200, lastSnapshot);
    if (p === '/api/metrics') return json(res, 200, sim.metrics());
    if (p.startsWith('/api/zabbix/discovery/')) {
      const kind = p.split('/').pop();
      const d = sim.metrics().discovery[kind];
      return d ? json(res, 200, d) : json(res, 404, { error: 'unknown discovery' });
    }
    if (p === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(prometheus());
    }
    if (p === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`retry: 2000\ndata: ${JSON.stringify(lastSnapshot)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p === '/api/control') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
      if (CONTROL_TOKEN && req.headers['x-control-token'] !== CONTROL_TOKEN) return json(res, 401, { error: 'token requerido' });
      const body = await readBody(req);
      const ok = sim.control(body);
      return json(res, 200, { ok, speed: sim.speed, faults: sim.faults.map((f) => ({ type: f.type, target: f.target })) });
    }
    if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    return serveStatic(req, res, p);
  } catch (e) {
    console.error(e);
    json(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, () => console.log(`Planta aceitera demo escuchando en http://0.0.0.0:${PORT}`));
