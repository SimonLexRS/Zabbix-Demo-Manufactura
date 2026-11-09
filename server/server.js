// Planta aceitera demo — authoritative simulation server (no dependencies).
//
// Like AI Town's Convex backend, the server owns the world and runs the engine
// loop; browsers only render the snapshots they receive (Server-Sent Events).
//
//   GET  /                         3D client (static files)
//   GET  /api/stream               SSE frames for the 3D client (5 Hz fast + 1 Hz full, gzip)
//   GET  /api/state                current snapshot (JSON)
//   GET  /api/metrics              flat metrics for Zabbix HTTP agent (pull alternative)
//   GET  /api/zabbix/discovery/{silos|tanks|boilers|stations}  LLD JSON
//   GET  /metrics                  Prometheus exposition format
//   GET  /api/problems             problem points (0 normal, 1 manual, 2 aleatoria)
//   POST /api/problems             {"id":"bal_in_net","active":true} | {"randomFaults":false} | {"clearAll":true}
//   POST /api/control              {"speed":5}
//   GET  /api/config               runtime config (Zabbix, IoT, CEP) without secrets
//   PUT  /api/config               partial update, applied live and persisted in DATA_DIR
//   POST /api/zabbix/test | /api/zabbix/provision | /api/zabbix/send-now | /api/zabbix/cep
//   POST /api/auth/check           validates the admin token
//   GET  /api/zabbix/status        sender / provisioning status
//   POST /api/presence             someone is in the monitoring room (the manager comes)
//   GET  /healthz
//
// Every POST/PUT requires the header x-control-token = CONTROL_TOKEN (when set).

import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Simulation } from '../js/sim/simulation.js';
import { IOT_DEVICES } from '../js/sim/iot.js';
import { DEFAULT_RULES, CEP_METRICS } from '../js/sim/cep.js';
import { PROBLEMS } from '../js/sim/problems.js';
import { sendValues } from './zabbix-sender.js';
import { pushValues } from './zabbix-push.js';
import { makeRpc, provision } from './zabbix-provision.js';
import { applyCep, cepStatus, cepResults } from './zabbix-cep.js';
import { upsertDashboard } from './zabbix-dashboard.js';
import { ZabbixAck } from './zabbix-ack.js';
import { ConfigStore } from './config.js';
import { encodeFrame, urgentSignature } from '../js/sim/frames.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8080);
// Self-signed certificate on the target Zabbix (ZABBIX_TLS_INSECURE=1).
if (process.env.ZABBIX_TLS_INSECURE === '1') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const TICK_MS = 200;
const FULL_EVERY = 5; // full snapshot every 5 ticks (1 s)
const CONTROL_TOKEN = process.env.CONTROL_TOKEN || '';
const TEMPLATES = { templateFile: path.join(ROOT, 'zabbix', 'template_planta_aceitera_sender.yaml'), iotTemplateFile: path.join(ROOT, 'zabbix', 'template_planta_aceitera_iot.yaml') };
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

const store = new ConfigStore({ dataDir: process.env.DATA_DIR || path.join(ROOT, 'data') });
const cfg = () => store.config;
const sim = new Simulation({ randomFaults: cfg().sim.randomFaults, realism: cfg().realism });
const clients = new Set();

function applyToSim() {
  const c = cfg();
  sim.randomFaults = c.sim.randomFaults;
  sim.speed = c.sim.speed;
  sim.iot.configure(c.iot);
  sim.cep.enabled = c.cep.enabled;
  sim.cep.setRules(c.cep.rules ?? DEFAULT_RULES);
  sim.configureRealism(c.realism);
}
applyToSim();

// ───────────── Zabbix sender (plant host + IoT hosts) ─────────────
const zbx = {
  sends: 0,
  last: null, // { at, reason, processed, failed, total, error }
  lastDiscovery: null,
  iot: { sends: 0, last: null },
  provision: { state: 'pendiente' },
  cep: { state: 'desconocida', rules: [], results: null },
};
let lastDiscoveryAt = 0;
let discoveryFast = true; // resend LLD every 60 s until Zabbix accepts it
const iotLastSent = {};
const target = () => ({ server: cfg().zabbix.server, port: cfg().zabbix.port });
// Transport: Zabbix API (history.push, default) or Zabbix sender (trapper port).
const send = (items) => (cfg().zabbix.transport === 'sender' ? sendValues(target(), items) : pushValues(rpc(), items));
const stamp = () => new Date().toISOString();

async function zabbixSend(reason = 'intervalo') {
  const z = cfg().zabbix;
  if (!z.enabled) return;
  try {
    const now = Date.now();
    if (z.transport !== 'sender' && zbx.provision.state !== 'ok') return;
    if (now - lastDiscoveryAt >= (discoveryFast ? 60_000 : z.lldInterval * 1000)) {
      lastDiscoveryAt = now;
      const ids = IOT_DEVICES.map((d) => d.id);
      const lld = [...sim.discoveryData().map((d) => ({ ...d, host: z.host })), ...(cfg().iot.enabled ? sim.iot.discoveryItems(ids, cfg().iot.hostPrefix) : [])];
      const r = await send(lld);
      zbx.lastDiscovery = { at: stamp(), processed: r.processed, failed: r.failed, total: r.total };
      discoveryFast = r.failed > 0;
    }
    // Values are only accepted once the host exists in Zabbix (API transport).
    if (z.transport !== 'sender' && zbx.provision.state !== 'ok') return;
    const r = await send(sim.senderItems().map((d) => ({ ...d, host: z.host })));
    zbx.sends++;
    zbx.last = { at: stamp(), reason, processed: r.processed, failed: r.failed, total: r.total, error: null };
    if (r.failed > 0) discoveryFast = true;
  } catch (e) {
    zbx.last = { at: stamp(), reason, processed: 0, failed: 0, total: 0, error: e.message };
  }
}

// IoT devices report on their own interval (checked every 5 s), batched in one sender request.
async function iotSend(force = false) {
  const z = cfg().zabbix;
  if (!z.enabled || !cfg().iot.enabled) return;
  if (z.transport !== 'sender' && zbx.provision.state !== 'ok') return;
  const now = Date.now();
  const due = IOT_DEVICES.filter((d) => force || now - (iotLastSent[d.id] ?? 0) >= sim.iot.state[d.id].interval * 1000).map((d) => d.id);
  if (!due.length) return;
  const items = sim.iot.senderItems(sim, due, cfg().iot.hostPrefix);
  for (const id of due) iotLastSent[id] = now;
  if (!items.length) return;
  try {
    const r = await send(items);
    zbx.iot.sends++;
    zbx.iot.last = { at: stamp(), devices: new Set(items.map((i) => i.host)).size, processed: r.processed, failed: r.failed, total: r.total, error: null };
    if (r.failed > 0) discoveryFast = true;
  } catch (e) {
    zbx.iot.last = { at: stamp(), devices: 0, processed: 0, failed: 0, total: 0, error: e.message };
  }
}

let sendTimer = null;
function scheduleSend(delay = cfg().zabbix.sendInterval * 1000) {
  clearTimeout(sendTimer);
  sendTimer = setTimeout(async () => {
    await zabbixSend();
    scheduleSend();
  }, delay);
}
setInterval(() => iotSend(), 5000);
scheduleSend(3000);

function rpc() {
  const z = cfg().zabbix;
  if (!z.apiUrl || !z.apiToken) throw new Error('Configura la URL de la API y el token de Zabbix');
  return makeRpc(z.apiUrl, z.apiToken);
}

let provisionRetry = null;
let provisionTries = 0;
async function zabbixProvision() {
  clearTimeout(provisionRetry);
  const z = cfg().zabbix;
  if (!z.apiUrl || !z.apiToken) {
    zbx.provision = { state: 'deshabilitado', detail: 'Falta URL de API o token de Zabbix' };
    return zbx.provision;
  }
  zbx.provision = { state: 'en curso', step: 'conectando con la API' };
  try {
    const api = rpc();
    // Zabbix may still be starting (same deploy): wait for the API before anything else.
    const version = await api('apiinfo.version', {}, false);
    if (z.transport !== 'sender' && Number(version.split('.')[0]) < 7) throw new Error(`Zabbix ${version}: el envío por API (history.push) requiere Zabbix 7.0 o superior; usa ZABBIX_TRANSPORT=sender`);
    zbx.provision.step = 'templates, host e IoT';
    const r = await provision(api, { ...cfg(), iotDevices: IOT_DEVICES.map((d) => ({ ...d, enabled: sim.iot.state[d.id].enabled })) }, TEMPLATES);
    console.log(`Zabbix ${r.version}: templates importados, ${r.action} (hostid ${r.hostid}); IoT ${JSON.stringify(r.iot)}`);
    zbx.provision = { state: 'en curso', step: 'reglas CEP', ...r };
    await zabbixCep();
    zbx.provision.step = 'dashboard';
    try {
      const d = await upsertDashboard(api, { hostName: z.host, groupName: z.hostGroup });
      zbx.dashboardId = d.id;
      zbx.dashboard = { state: d.action, name: d.name, id: d.id };
      console.log(`Zabbix dashboard ${d.action}: ${d.name} (id ${d.id})`);
    } catch (e) {
      zbx.dashboard = { state: 'error', detail: e.message };
      console.error('Dashboard Zabbix:', e.message);
    }
    zbx.provision = { state: 'ok', at: stamp(), ...r, dashboard: zbx.dashboard?.state, transport: z.transport };
    provisionTries = 0;
    lastDiscoveryAt = 0;
    discoveryFast = true;
    setTimeout(() => {
      zabbixSend('provisión');
      iotSend(true);
    }, 2000);
  } catch (e) {
    // Back off: 10 s, 20 s, 40 s, then every 60 s (Zabbix may come up after the app).
    const wait = Math.min(60_000, 10_000 * 2 ** provisionTries++);
    zbx.provision = { state: 'error', at: stamp(), detail: e.message, step: zbx.provision.step };
    console.error(`Provisión Zabbix falló (${zbx.provision.step ?? ''}):`, e.message, `— reintento en ${wait / 1000} s`);
    provisionRetry = setTimeout(zabbixProvision, wait);
  }
  return zbx.provision;
}
zabbixProvision();

// Event correlation in Zabbix 8.0: native CEP rules (Data collection → Event processing).
async function zabbixCep() {
  const z = cfg().zabbix;
  try {
    const r = await applyCep(rpc(), { groups: [z.hostGroup, cfg().iot.group], enable: cfg().cep.zabbixCep });
    zbx.cep = { ...zbx.cep, ...r, detail: r.legacyRemoved ? 'se quitó la correlación global antigua' : undefined, at: stamp() };
    console.log(`Zabbix CEP: ${r.state} · ${r.rules.length} reglas${r.legacyRemoved ? ' · correlación antigua eliminada' : ''}`);
  } catch (e) {
    const missing = /ceprule.*(not found|Incorrect API)/i.test(e.message);
    zbx.cep = { ...zbx.cep, state: missing ? 'no disponible' : 'error', detail: missing ? 'este Zabbix no tiene CEP (requiere 8.0)' : e.message };
  }
  return zbx.cep;
}

// What Zabbix CEP did with the plant's problems (causes/symptoms, incidents), every 10 s;
// rule status (enabled, processing errors) every minute.
let cepTick = 0;
setInterval(async () => {
  if (zbx.provision.state !== 'ok' || !cfg().cep.zabbixCep || !['activa', 'con errores'].includes(zbx.cep.state)) return;
  try {
    const api = rpc();
    zbx.cep.results = await cepResults(api, [zbx.provision.hostid]);
    if (cepTick++ % 6 === 0) zbx.cep.rules = await cepStatus(api, cfg().zabbix.hostGroup);
  } catch (e) {
    zbx.cep.results = { ...(zbx.cep.results || {}), error: e.message };
  }
}, 10_000);

// Staff actions (work orders, complaints, escalations) → acknowledge on the Zabbix problem.
const ack = new ZabbixAck({ rpc: () => rpc(), hostId: () => (zbx.provision.state === 'ok' ? zbx.provision.hostid : null) });
setInterval(() => {
  const items = sim.outbox.splice(0);
  if (cfg().realism.ackEvents && cfg().zabbix.apiToken) ack.push(items);
  ack.flush().catch(() => {});
}, 8000);

// Connectivity test: trapper port (empty sender request) + API version + token.
async function zabbixTest() {
  const z = cfg().zabbix;
  const out = { trapper: null, api: null, token: null };
  if (z.transport !== 'sender') out.trapper = { ok: true, detail: 'no se usa: los valores van por la API de Zabbix (history.push)' };
  else try {
    const t0 = Date.now();
    await new Promise((resolve, reject) => {
      const s = net.createConnection({ host: z.server, port: z.port }, () => {
        s.destroy();
        resolve();
      });
      s.setTimeout(4000, () => s.destroy(new Error('timeout')));
      s.on('error', reject);
    });
    const r = await sendValues(target(), []);
    out.trapper = { ok: true, detail: `${z.server}:${z.port} responde (${Date.now() - t0} ms, ${r.info ?? 'ok'})` };
  } catch (e) {
    out.trapper = { ok: false, detail: `${z.server}:${z.port} — ${e.message}` };
  }
  if (!z.apiUrl) out.api = { ok: false, detail: 'sin URL de API' };
  else {
    try {
      const v = await makeRpc(z.apiUrl, '')('apiinfo.version', {}, false);
      out.api = { ok: true, detail: `Zabbix ${v}` };
    } catch (e) {
      out.api = { ok: false, detail: e.message };
    }
  }
  if (!z.apiToken) out.token = { ok: false, detail: 'sin token' };
  else if (out.api?.ok) {
    try {
      const [h] = await rpc()('host.get', { filter: { host: [z.host] }, output: ['hostid'] });
      out.token = { ok: true, detail: h ? `válido · host "${z.host}" existe (id ${h.hostid})` : `válido · host "${z.host}" aún no existe` };
    } catch (e) {
      out.token = { ok: false, detail: e.message };
    }
  }
  return out;
}

const zabbixSummary = () => ({
  enabled: cfg().zabbix.enabled,
  server: `${cfg().zabbix.server}:${cfg().zabbix.port}`,
  host: cfg().zabbix.host,
  last: zbx.last,
  iot: zbx.iot.last,
  provision: zbx.provision.state,
  cep: { state: zbx.cep.state, rules: zbx.cep.rules, results: zbx.cep.results },
  dashboardUrl: cfg().zabbix.webUrl && zbx.dashboardId ? `${cfg().zabbix.webUrl.replace(/\/$/, '')}/zabbix.php?action=dashboard.view&dashboardid=${zbx.dashboardId}` : null,
  ack: ack.status(),
});
const withZabbix = (snap) => ({ ...snap, zabbix: zabbixSummary() });
let lastSnapshot = withZabbix(sim.snapshot());

// Engine loop. Each tick sends a small "fast" frame (what moves); the full snapshot goes
// once per second or as soon as a problem / work order changes (see js/sim/frames.js).
// The JSON is built once per tick and shared by every client.
let tickN = 0;
let lastSig = '';
let nextTick = Date.now() + TICK_MS;
let lastPresence = 0;
function tick() {
  sim.monitorPresence = Date.now() - lastPresence < 25000;
  sim.advance((TICK_MS / 1000) * sim.speed);
  lastSnapshot = withZabbix(sim.snapshot());
  const sig = urgentSignature(lastSnapshot);
  const full = ++tickN % FULL_EVERY === 0 || sig !== lastSig;
  lastSig = sig;
  if (clients.size) {
    const payload = `data: ${encodeFrame(lastSnapshot, { full })}\n\n`;
    for (const c of clients) c.write(payload);
  }
  // Drift-corrected timer: ticks stay on a 200 ms grid even if one runs late.
  nextTick += TICK_MS;
  const now = Date.now();
  if (nextTick < now - TICK_MS * 5) nextTick = now + TICK_MS;
  setTimeout(tick, Math.max(0, nextTick - now));
}
setTimeout(tick, TICK_MS);

// Keep proxies (Traefik in Dokploy) from closing idle SSE connections.
setInterval(() => {
  for (const c of clients) c.write(': ping\n\n');
}, 15000);

// One SSE client; gzip (flushed after every message) when the browser accepts it.
function openStream(req, res) {
  const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const headers = { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' };
  if (gzip) {
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }
  res.writeHead(200, headers);
  let out = res;
  if (gzip) {
    out = zlib.createGzip({ level: 6 });
    out.pipe(res);
    out.on('error', () => {});
  }
  const c = {
    write(s) {
      out.write(s);
      if (gzip) out.flush(zlib.constants.Z_SYNC_FLUSH);
    },
    close() {
      if (gzip) out.end();
    },
  };
  c.write(`retry: 2000\ndata: ${encodeFrame(lastSnapshot, { full: true })}\n\n`);
  clients.add(c);
  req.on('close', () => {
    clients.delete(c);
    c.close();
  });
}

// ───────────── HTTP ─────────────
function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
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
      if (data.length > 200_000) req.destroy();
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
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
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

const authorized = (req) => !CONTROL_TOKEN || req.headers['x-control-token'] === CONTROL_TOKEN;

function configResponse() {
  return {
    ...store.publicView(),
    adminRequired: !!CONTROL_TOKEN,
    catalog: {
      iot: sim.iot.summary(sim),
      cepRules: sim.cep.summary((t) => sim.clock(t).label),
      defaultRules: DEFAULT_RULES,
      problems: PROBLEMS.map(({ id, name }) => ({ id, name })),
      metrics: CEP_METRICS,
    },
    status: { ...zbx, ack: ack.status() },
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p === '/healthz') return json(res, 200, { ok: true, sim_time: sim.clock().label, clients: clients.size });
    if (p === '/api/state') return json(res, 200, lastSnapshot);
    if (p === '/api/metrics') return json(res, 200, sim.metrics());
    if (p.startsWith('/api/zabbix/discovery/')) {
      const d = sim.metrics().discovery[p.split('/').pop()];
      return d ? json(res, 200, d) : json(res, 404, { error: 'unknown discovery' });
    }
    if (p === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(prometheus());
    }
    if (p === '/api/stream') {
      openStream(req, res);
      return;
    }
    if (p === '/api/zabbix/status' && req.method === 'GET') return json(res, 200, { ...zabbixSummary(), detail: zbx });
    if (p === '/api/problems' && req.method === 'GET') return json(res, 200, { randomFaults: sim.randomFaults, problems: sim.problemStates() });
    if (p === '/api/config' && req.method === 'GET') return json(res, 200, configResponse());

    // Someone is looking at the monitoring room: the plant manager goes there. Harmless, so it
    // needs no admin key; rate-limited.
    if (p === '/api/presence' && req.method === 'POST') {
      const now = Date.now();
      if (now - lastPresence > 1500) lastPresence = now;
      return json(res, 200, { ok: true });
    }
    if (p.startsWith('/api/')) {
      if (!['POST', 'PUT'].includes(req.method)) return json(res, 405, { error: 'método no permitido' });
      if (!authorized(req)) return json(res, 401, { error: 'clave de administrador requerida' });
      const body = await readBody(req);

      if (p === '/api/auth/check') return json(res, 200, { ok: true });
      if (p === '/api/problems') {
        let ok;
        if (body.clearAll) ok = (sim.clearFaults(), true);
        else if (body.randomFaults !== undefined) {
          store.update({ sim: { randomFaults: !!body.randomFaults } });
          sim.setRandomFaults(!!body.randomFaults);
          ok = true;
        } else ok = sim.setProblem(String(body.id), body.active !== false);
        zabbixSend('cambio de problema');
        lastSnapshot = withZabbix(sim.snapshot());
        return json(res, 200, { ok, speed: sim.speed, randomFaults: sim.randomFaults, problems: sim.problemStates() });
      }
      if (p === '/api/control') {
        const ok = sim.control(body);
        if (body.speed !== undefined) store.update({ sim: { speed: sim.speed } });
        return json(res, 200, { ok, speed: sim.speed });
      }
      if (p === '/api/config' && req.method === 'PUT') {
        const before = JSON.stringify({ z: cfg().zabbix, iotOn: cfg().iot.enabled, prefix: cfg().iot.hostPrefix, group: cfg().iot.group, dev: Object.fromEntries(Object.entries(cfg().iot.devices).map(([k, v]) => [k, v.enabled])), cep: cfg().cep.zabbixCep });
        const prevRandom = cfg().sim.randomFaults;
        const errors = store.update(body);
        applyToSim();
        if (prevRandom !== cfg().sim.randomFaults) sim.setRandomFaults(cfg().sim.randomFaults);
        const after = JSON.stringify({ z: cfg().zabbix, iotOn: cfg().iot.enabled, prefix: cfg().iot.hostPrefix, group: cfg().iot.group, dev: Object.fromEntries(Object.entries(cfg().iot.devices).map(([k, v]) => [k, v.enabled])), cep: cfg().cep.zabbixCep });
        if (before !== after) {
          // Zabbix-side objects depend on these settings: re-provision and resend LLD.
          lastDiscoveryAt = 0;
          discoveryFast = true;
          zabbixProvision();
        }
        scheduleSend(1000);
        return json(res, errors.length ? 400 : 200, { ok: !errors.length, errors, config: configResponse() });
      }
      if (p === '/api/zabbix/test') return json(res, 200, await zabbixTest());
      if (p === '/api/zabbix/provision') return json(res, 200, await zabbixProvision());
      if (p === '/api/zabbix/send-now') {
        await zabbixSend('manual');
        await iotSend(true);
        return json(res, 200, { last: zbx.last, iot: zbx.iot.last });
      }
      if (p === '/api/zabbix/cep' || p === '/api/zabbix/correlation') {
        store.update({ cep: { zabbixCep: body.enable !== false } });
        return json(res, 200, await zabbixCep());
      }
      return json(res, 404, { error: 'not found' });
    }
    return serveStatic(req, res, p);
  } catch (e) {
    console.error(e);
    json(res, 500, { error: 'internal error' });
  }
});

if (!CONTROL_TOKEN) console.warn('CONTROL_TOKEN no definido: el panel de configuración y las fallas quedan abiertos a cualquiera.');
{
  const z = cfg().zabbix;
  const how = z.transport === 'sender' ? `sender → ${z.server}:${z.port}` : `API (history.push) → ${z.apiUrl}`;
  console.log(`Config: ${store.file} · Zabbix ${z.enabled ? `${how} · host "${z.host}" cada ${z.sendInterval}s${z.apiToken ? '' : ' · FALTA ZABBIX_API_TOKEN'}` : 'deshabilitado (define ZABBIX_URL y ZABBIX_API_TOKEN)'}`);
}
server.listen(PORT, () => console.log(`Planta aceitera demo escuchando en http://0.0.0.0:${PORT}`));
