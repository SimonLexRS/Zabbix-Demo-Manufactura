// Planta aceitera demo — authoritative simulation server (no dependencies).
//
// Like AI Town's Convex backend, the server owns the world and runs the engine
// loop; browsers only render the snapshots they receive (Server-Sent Events).
//
//   GET  /                         3D client (static files)
//   GET  /api/stream               SSE snapshots (5 Hz) for the 3D client
//   GET  /api/state                current snapshot (JSON)
//   GET  /api/metrics              flat metrics for Zabbix HTTP agent (pull alternative)
//   GET  /api/zabbix/discovery/{silos|tanks|boilers|stations}  LLD JSON
//   GET  /metrics                  Prometheus exposition format
//   GET  /api/problems             problem points (0 normal, 1 manual, 2 aleatoria)
//   POST /api/problems             {"id":"bal_in_net","active":true} | {"randomFaults":false} | {"clearAll":true}
//   POST /api/control              {"speed":5}
//   GET  /api/config               runtime config (Zabbix, IoT, CEP) without secrets
//   PUT  /api/config               partial update, applied live and persisted in DATA_DIR
//   POST /api/zabbix/test | /api/zabbix/provision | /api/zabbix/send-now | /api/zabbix/correlation
//   POST /api/auth/check           validates the admin token
//   GET  /api/zabbix/status        sender / provisioning status
//   GET  /healthz
//
// Every POST/PUT requires the header x-control-token = CONTROL_TOKEN (when set).

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Simulation } from '../js/sim/simulation.js';
import { IOT_DEVICES } from '../js/sim/iot.js';
import { DEFAULT_RULES, CEP_METRICS } from '../js/sim/cep.js';
import { PROBLEMS } from '../js/sim/problems.js';
import { sendValues } from './zabbix-sender.js';
import { makeRpc, provision, setCorrelation, getCorrelation } from './zabbix-provision.js';
import { ZabbixAck } from './zabbix-ack.js';
import { ConfigStore } from './config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8080);
const TICK_MS = 200;
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
  correlation: { state: 'desconocida' },
};
let lastDiscoveryAt = 0;
let discoveryFast = true; // resend LLD every 60 s until Zabbix accepts it
const iotLastSent = {};
const target = () => ({ server: cfg().zabbix.server, port: cfg().zabbix.port });
const stamp = () => new Date().toISOString();

async function zabbixSend(reason = 'intervalo') {
  const z = cfg().zabbix;
  if (!z.enabled) return;
  try {
    const now = Date.now();
    if (now - lastDiscoveryAt >= (discoveryFast ? 60_000 : z.lldInterval * 1000)) {
      lastDiscoveryAt = now;
      const ids = IOT_DEVICES.map((d) => d.id);
      const lld = [...sim.discoveryData().map((d) => ({ ...d, host: z.host })), ...(cfg().iot.enabled ? sim.iot.discoveryItems(ids, cfg().iot.hostPrefix) : [])];
      const r = await sendValues(target(), lld);
      zbx.lastDiscovery = { at: stamp(), processed: r.processed, failed: r.failed, total: r.total };
      discoveryFast = r.failed > 0;
    }
    const r = await sendValues(target(), sim.senderItems().map((d) => ({ ...d, host: z.host })));
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
  const now = Date.now();
  const due = IOT_DEVICES.filter((d) => force || now - (iotLastSent[d.id] ?? 0) >= sim.iot.state[d.id].interval * 1000).map((d) => d.id);
  if (!due.length) return;
  const items = sim.iot.senderItems(sim, due, cfg().iot.hostPrefix);
  for (const id of due) iotLastSent[id] = now;
  if (!items.length) return;
  try {
    const r = await sendValues(target(), items);
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
async function zabbixProvision() {
  clearTimeout(provisionRetry);
  const z = cfg().zabbix;
  if (!z.apiUrl || !z.apiToken) {
    zbx.provision = { state: 'deshabilitado', detail: 'Falta URL de API o token de Zabbix' };
    return zbx.provision;
  }
  zbx.provision = { state: 'en curso' };
  try {
    const api = rpc();
    const r = await provision(api, { ...cfg(), iotDevices: IOT_DEVICES.map((d) => ({ ...d, enabled: sim.iot.state[d.id].enabled })) }, TEMPLATES);
    zbx.provision = { state: 'ok', at: stamp(), ...r };
    console.log(`Zabbix ${r.version}: templates importados, ${r.action} (hostid ${r.hostid}); IoT ${JSON.stringify(r.iot)}`);
    try {
      zbx.correlation = cfg().cep.zabbixCorrelation ? await setCorrelation(api, true) : await getCorrelation(api);
    } catch (e) {
      zbx.correlation = { state: 'error', detail: e.message };
    }
    lastDiscoveryAt = 0;
    discoveryFast = true;
    setTimeout(() => {
      zabbixSend('provisión');
      iotSend(true);
    }, 2000);
  } catch (e) {
    zbx.provision = { state: 'error', at: stamp(), detail: e.message };
    console.error('Provisión Zabbix falló:', e.message, '— reintento en 60 s');
    provisionRetry = setTimeout(zabbixProvision, 60_000);
  }
  return zbx.provision;
}
zabbixProvision();

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
  try {
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
  correlation: zbx.correlation.state,
  ack: ack.status(),
});
const withZabbix = (snap) => ({ ...snap, zabbix: zabbixSummary() });
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
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`retry: 2000\ndata: ${JSON.stringify(lastSnapshot)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p === '/api/zabbix/status' && req.method === 'GET') return json(res, 200, { ...zabbixSummary(), detail: zbx });
    if (p === '/api/problems' && req.method === 'GET') return json(res, 200, { randomFaults: sim.randomFaults, problems: sim.problemStates() });
    if (p === '/api/config' && req.method === 'GET') return json(res, 200, configResponse());

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
        const before = JSON.stringify({ z: cfg().zabbix, iotOn: cfg().iot.enabled, prefix: cfg().iot.hostPrefix, group: cfg().iot.group, dev: Object.fromEntries(Object.entries(cfg().iot.devices).map(([k, v]) => [k, v.enabled])), corr: cfg().cep.zabbixCorrelation });
        const prevRandom = cfg().sim.randomFaults;
        const errors = store.update(body);
        applyToSim();
        if (prevRandom !== cfg().sim.randomFaults) sim.setRandomFaults(cfg().sim.randomFaults);
        const after = JSON.stringify({ z: cfg().zabbix, iotOn: cfg().iot.enabled, prefix: cfg().iot.hostPrefix, group: cfg().iot.group, dev: Object.fromEntries(Object.entries(cfg().iot.devices).map(([k, v]) => [k, v.enabled])), corr: cfg().cep.zabbixCorrelation });
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
      if (p === '/api/zabbix/correlation') {
        try {
          const enable = body.enable !== false;
          store.update({ cep: { zabbixCorrelation: enable } });
          zbx.correlation = await setCorrelation(rpc(), enable);
        } catch (e) {
          zbx.correlation = { state: 'error', detail: e.message };
        }
        return json(res, 200, zbx.correlation);
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
console.log(`Config: ${store.file} · Zabbix sender ${cfg().zabbix.enabled ? `→ ${cfg().zabbix.server}:${cfg().zabbix.port} host "${cfg().zabbix.host}" cada ${cfg().zabbix.sendInterval}s` : 'deshabilitado'}`);
server.listen(PORT, () => console.log(`Planta aceitera demo escuchando en http://0.0.0.0:${PORT}`));
