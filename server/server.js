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
//   GET  /api/problems          catalog of problem points with their state (0 normal, 1 manual, 2 aleatorio)
//   POST /api/problems          {"id":"bal_in_net","active":true} | {"randomFaults":false} | {"clearAll":true}
//   POST /api/control           {"speed":5}
//   GET  /api/zabbix/status     Zabbix sender / provisioning status
//   GET  /healthz
//
// Zabbix sender (push): when ZABBIX_SERVER is set, every ZABBIX_SEND_INTERVAL
// seconds all state & quantity values are sent to the trapper items of host
// ZABBIX_HOST; LLD data is sent at start and periodically. With ZABBIX_API_URL +
// ZABBIX_API_TOKEN the template and host are created automatically.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Simulation } from '../js/sim/simulation.js';
import { sendValues } from './zabbix-sender.js';
import { provision } from './zabbix-provision.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8080);
const TICK_MS = 200;
const CONTROL_TOKEN = process.env.CONTROL_TOKEN || '';
const ZBX = {
  server: process.env.ZABBIX_SERVER || '',
  port: Number(process.env.ZABBIX_PORT || 10051),
  host: process.env.ZABBIX_HOST || 'Planta Aceitera',
  intervalMs: Math.max(2, Number(process.env.ZABBIX_SEND_INTERVAL || 10)) * 1000,
  apiUrl: process.env.ZABBIX_API_URL || '',
  apiToken: process.env.ZABBIX_API_TOKEN || '',
  group: process.env.ZABBIX_HOST_GROUP || 'Manufactura',
};
const envOff = (v) => ['0', 'false', 'no', 'off'].includes(String(v ?? '').toLowerCase());
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

const sim = new Simulation({ randomFaults: !envOff(process.env.RANDOM_FAULTS) });
sim.speed = Number(process.env.SIM_SPEED || 1);
const clients = new Set();

// ───────────── Zabbix sender + provisioning ─────────────
const zbx = {
  enabled: !!ZBX.server,
  server: ZBX.server ? `${ZBX.server}:${ZBX.port}` : null,
  host: ZBX.host,
  intervalSec: ZBX.intervalMs / 1000,
  sends: 0,
  last: null, // { at, processed, failed, total, error }
  lastDiscovery: null,
  provision: ZBX.apiUrl && ZBX.apiToken ? { state: 'pendiente' } : { state: 'deshabilitado', detail: 'Define ZABBIX_API_URL y ZABBIX_API_TOKEN para crear template y host automáticamente' },
};
let discoveryEvery = 60_000; // fast until items exist, then every 10 min
let lastDiscoveryAt = 0;

async function zabbixSend(reason = 'intervalo') {
  if (!zbx.enabled) return;
  const now = Date.now();
  try {
    if (now - lastDiscoveryAt >= discoveryEvery) {
      lastDiscoveryAt = now;
      const r = await sendValues(ZBX, sim.discoveryData().map((d) => ({ ...d, host: ZBX.host })));
      zbx.lastDiscovery = { at: new Date().toISOString(), ...r };
      if (r.failed === 0) discoveryEvery = 600_000;
    }
    const items = sim.senderItems().map((d) => ({ ...d, host: ZBX.host }));
    const r = await sendValues(ZBX, items);
    zbx.sends++;
    zbx.last = { at: new Date().toISOString(), reason, processed: r.processed, failed: r.failed, total: r.total, error: null };
    if (r.failed > 0) discoveryEvery = 60_000; // items not created yet (host missing or LLD pending)
  } catch (e) {
    zbx.last = { at: new Date().toISOString(), reason, processed: 0, failed: 0, total: 0, error: e.message };
  }
}

async function zabbixProvision() {
  if (!(ZBX.apiUrl && ZBX.apiToken)) return;
  zbx.provision = { state: 'en curso' };
  try {
    const r = await provision({ url: ZBX.apiUrl, token: ZBX.apiToken, host: ZBX.host, group: ZBX.group, templateFile: path.join(ROOT, 'zabbix', 'template_planta_aceitera_sender.yaml') });
    zbx.provision = { state: 'ok', at: new Date().toISOString(), ...r };
    console.log(`Zabbix ${r.version}: template importado, ${r.action} (hostid ${r.hostid})`);
    lastDiscoveryAt = 0;
    discoveryEvery = 60_000;
    setTimeout(() => zabbixSend('provisión'), 2000);
  } catch (e) {
    zbx.provision = { state: 'error', at: new Date().toISOString(), detail: e.message };
    console.error('Provisión Zabbix falló:', e.message, '— reintento en 60 s');
    setTimeout(zabbixProvision, 60_000);
  }
}

if (zbx.enabled) {
  console.log(`Zabbix sender → ${zbx.server} host "${ZBX.host}" cada ${zbx.intervalSec}s`);
  setTimeout(() => zabbixSend('inicio'), 3000);
  setInterval(() => zabbixSend(), ZBX.intervalMs);
}
zabbixProvision();

const withZabbix = (snap) => ({ ...snap, zabbix: { enabled: zbx.enabled, server: zbx.server, host: zbx.host, last: zbx.last, provision: zbx.provision.state } });
let lastSnapshot = withZabbix(sim.snapshot());

setInterval(() => {
  sim.advance((TICK_MS / 1000) * sim.speed);
  lastSnapshot = withZabbix(sim.snapshot());
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
    if (p === '/api/zabbix/status') return json(res, 200, zbx);
    if (p === '/api/problems' && req.method === 'GET') return json(res, 200, { randomFaults: sim.randomFaults, problems: sim.problemStates() });
    if (p === '/api/control' || p === '/api/problems') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
      if (CONTROL_TOKEN && req.headers['x-control-token'] !== CONTROL_TOKEN) return json(res, 401, { error: 'token requerido' });
      const body = await readBody(req);
      let ok;
      if (p === '/api/problems') {
        if (body.clearAll) ok = (sim.clearFaults(), true);
        else if (body.randomFaults !== undefined) ok = (sim.setRandomFaults(body.randomFaults), true);
        else ok = sim.setProblem(String(body.id), body.active !== false);
        zabbixSend('cambio de problema'); // push the new state right away
      } else {
        ok = sim.control(body);
      }
      lastSnapshot = withZabbix(sim.snapshot());
      return json(res, 200, { ok, speed: sim.speed, randomFaults: sim.randomFaults, problems: sim.problemStates() });
    }
    if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    return serveStatic(req, res, p);
  } catch (e) {
    console.error(e);
    json(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, () => console.log(`Planta aceitera demo escuchando en http://0.0.0.0:${PORT}`));
