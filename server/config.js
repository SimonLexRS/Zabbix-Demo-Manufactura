// Runtime configuration: defaults from environment variables, overrides edited
// from the configuration panel and persisted to DATA_DIR/config.json (a Docker
// volume in production). Every value is validated before it is applied.
import fs from 'node:fs';
import path from 'node:path';
import { validateRules } from '../js/sim/cep.js';
import { IOT_BY_ID } from '../js/sim/iot.js';

const off = (v) => ['0', 'false', 'no', 'off'].includes(String(v ?? '').toLowerCase());
const on = (v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').toLowerCase());
export const CONFIG_VERSION = 2;
const num = (v, min, max, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
};
const str = (v, re, max = 200) => {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s.length <= max && re.test(s) ? s : undefined;
};

// ZABBIX_URL is the frontend base URL (https://zabbix.example.com or http://zabbix-web:8080);
// the API URL and the dashboard link are derived from it.
export const apiFromUrl = (u) => (u ? (/api_jsonrpc\.php$/.test(u) ? u : `${u.replace(/\/+$/, '')}/api_jsonrpc.php`) : '');
export const webFromUrl = (u) => (u ? u.replace(/\/?api_jsonrpc\.php$/, '').replace(/\/+$/, '') : '');

export function defaultsFromEnv(env = process.env) {
  const url = webFromUrl(env.ZABBIX_URL || '');
  return {
    zabbix: {
      enabled: !!(url || env.ZABBIX_SERVER || env.ZABBIX_API_URL),
      // 'api': values and LLD over the Zabbix API (history.push, Zabbix 7.0+) — only URL + token.
      // 'sender': Zabbix sender protocol to ZABBIX_SERVER:10051 (needs the trapper port reachable).
      transport: env.ZABBIX_TRANSPORT === 'sender' || (!url && env.ZABBIX_SERVER && !env.ZABBIX_TRANSPORT) ? 'sender' : 'api',
      url,
      server: env.ZABBIX_SERVER || 'zabbix-server',
      port: num(env.ZABBIX_PORT, 1, 65535, 10051),
      host: env.ZABBIX_HOST || 'Planta Aceitera',
      hostGroup: env.ZABBIX_HOST_GROUP || 'Manufactura',
      sendInterval: num(env.ZABBIX_SEND_INTERVAL, 2, 3600, 10),
      lldInterval: num(env.ZABBIX_LLD_INTERVAL, 60, 86400, 600),
      apiUrl: url ? apiFromUrl(url) : env.ZABBIX_API_URL || '',
      apiToken: env.ZABBIX_API_TOKEN || '',
      webUrl: env.ZABBIX_WEB_URL || url, // public Zabbix frontend (link to the dashboard)
      trapperAllowedHosts: env.ZABBIX_TRAPPER_ALLOWED_HOSTS || '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.1,::1',
    },
    iot: { enabled: !off(env.IOT_ENABLED ?? '1'), hostPrefix: env.IOT_HOST_PREFIX || 'iot-', group: env.IOT_HOST_GROUP || 'Manufactura/IoT', randomDropouts: true, devices: {} },
    // zabbixCep: event correlation inside Zabbix 8.0 with native CEP rules (server/zabbix-cep.js).
    cep: { enabled: true, rules: null, zabbixCep: !off(env.ZABBIX_CEP ?? '1') },
    // Faults are activated by hand by default (RANDOM_FAULTS=1 turns on the random generator).
    sim: { randomFaults: on(env.RANDOM_FAULTS), speed: num(env.SIM_SPEED, 0, 30, 1) },
    realism: {
      collisions: !off(env.COLLISIONS ?? '1'),
      distractionPerHour: 0.15, // chance per truck-hour of a short driver distraction
      incidentsPerDay: num(env.ROAD_INCIDENTS, 0, 48, 8), // brake failures / distracted drivers per simulated day (with random faults on)
      speedFactor: 1,
      techsRepairManual: on(env.TECHS_REPAIR_MANUAL), // manual faults stay until switched off
      escalation1: 15,
      escalation2: 40,
      ackEvents: !off(env.ZABBIX_ACK ?? '1'),
    },
  };
}

// Applies a partial update; returns { config, errors[] }. Invalid fields are ignored and reported.
export function applyPatch(cfg, patch = {}) {
  const c = structuredClone(cfg);
  const errors = [];
  const set = (obj, key, val, label) => {
    if (val === undefined) errors.push(`valor inválido: ${label}`);
    else obj[key] = val;
  };
  const z = patch.zabbix || {};
  if (z.enabled !== undefined) c.zabbix.enabled = !!z.enabled;
  if (z.transport !== undefined) set(c.zabbix, 'transport', ['api', 'sender'].includes(z.transport) ? z.transport : undefined, 'transporte');
  if (z.url !== undefined) {
    set(c.zabbix, 'url', z.url === '' ? '' : str(z.url, /^https?:\/\/[^\s]+$/, 300), 'URL de Zabbix');
    if (c.zabbix.url) {
      c.zabbix.url = webFromUrl(c.zabbix.url);
      c.zabbix.apiUrl = apiFromUrl(c.zabbix.url);
      if (z.webUrl === undefined && !c.zabbix.webUrl) c.zabbix.webUrl = c.zabbix.url;
    }
  }
  if (z.server !== undefined) set(c.zabbix, 'server', str(z.server, /^[A-Za-z0-9][A-Za-z0-9.-]*$/, 253), 'servidor Zabbix');
  if (z.port !== undefined) c.zabbix.port = num(z.port, 1, 65535, c.zabbix.port);
  if (z.host !== undefined) set(c.zabbix, 'host', str(z.host, /^[\w .-]+$/, 128), 'nombre de host');
  if (z.hostGroup !== undefined) set(c.zabbix, 'hostGroup', str(z.hostGroup, /^[\p{L}\w ./-]+$/u, 128), 'grupo de hosts');
  if (z.sendInterval !== undefined) c.zabbix.sendInterval = num(z.sendInterval, 2, 3600, c.zabbix.sendInterval);
  if (z.lldInterval !== undefined) c.zabbix.lldInterval = num(z.lldInterval, 60, 86400, c.zabbix.lldInterval);
  if (z.apiUrl !== undefined) set(c.zabbix, 'apiUrl', z.apiUrl === '' ? '' : str(z.apiUrl, /^https?:\/\/[^\s]+$/, 300), 'URL de la API');
  if (z.webUrl !== undefined) set(c.zabbix, 'webUrl', z.webUrl === '' ? '' : str(z.webUrl, /^https?:\/\/[^\s]+$/, 300), 'URL web de Zabbix');
  if (z.apiToken !== undefined) set(c.zabbix, 'apiToken', z.apiToken === '' ? '' : str(z.apiToken, /^[A-Za-z0-9]{32,128}$/, 128), 'token de API');
  if (z.trapperAllowedHosts !== undefined) set(c.zabbix, 'trapperAllowedHosts', str(z.trapperAllowedHosts, /^[0-9A-Za-z.:/,\s{}$_-]+$/, 500), 'allowed hosts');

  const i = patch.iot || {};
  if (i.enabled !== undefined) c.iot.enabled = !!i.enabled;
  if (i.randomDropouts !== undefined) c.iot.randomDropouts = !!i.randomDropouts;
  if (i.hostPrefix !== undefined) set(c.iot, 'hostPrefix', str(i.hostPrefix, /^[a-z0-9_-]{0,20}$/, 20), 'prefijo de host IoT');
  if (i.group !== undefined) set(c.iot, 'group', str(i.group, /^[\p{L}\w ./-]+$/u, 128), 'grupo IoT');
  if (i.devices && typeof i.devices === 'object') {
    for (const [id, d] of Object.entries(i.devices)) {
      if (!IOT_BY_ID[id] || typeof d !== 'object') continue;
      const cur = (c.iot.devices[id] ||= {});
      for (const k of ['enabled', 'offline', 'lowBattery']) if (d[k] !== undefined) cur[k] = !!d[k];
      if (d.interval !== undefined) cur.interval = num(d.interval, 5, 3600, 30);
      if (d.noise !== undefined) cur.noise = num(d.noise, 0, 20, 1);
    }
  }

  const e = patch.cep || {};
  if (e.enabled !== undefined) c.cep.enabled = !!e.enabled;
  if (e.zabbixCep !== undefined) c.cep.zabbixCep = !!e.zabbixCep;
  delete c.cep.zabbixCorrelation; // legacy global correlation (replaced by Zabbix CEP)
  if (e.rules !== undefined) {
    if (e.rules === null) c.cep.rules = null;
    else {
      const v = validateRules(e.rules);
      if (v && v.length) c.cep.rules = v;
      else errors.push('reglas CEP inválidas');
    }
  }

  const s = patch.sim || {};
  if (s.randomFaults !== undefined) c.sim.randomFaults = !!s.randomFaults;
  if (s.speed !== undefined && [0, 1, 5, 15, 30].includes(Number(s.speed))) c.sim.speed = Number(s.speed);

  const r = patch.realism || {};
  for (const k of ['collisions', 'techsRepairManual', 'ackEvents']) if (r[k] !== undefined) c.realism[k] = !!r[k];
  if (r.distractionPerHour !== undefined) c.realism.distractionPerHour = num(r.distractionPerHour, 0, 3, c.realism.distractionPerHour);
  if (r.incidentsPerDay !== undefined) c.realism.incidentsPerDay = num(r.incidentsPerDay, 0, 48, c.realism.incidentsPerDay);
  if (r.speedFactor !== undefined) c.realism.speedFactor = num(r.speedFactor, 0.5, 1.5, c.realism.speedFactor);
  if (r.escalation1 !== undefined) c.realism.escalation1 = num(r.escalation1, 2, 240, c.realism.escalation1);
  if (r.escalation2 !== undefined) c.realism.escalation2 = num(r.escalation2, 5, 480, c.realism.escalation2);
  if (c.realism.escalation2 <= c.realism.escalation1) errors.push('la escalación a gerencia debe ser posterior al reclamo del jefe');
  return { config: c, errors };
}

export class ConfigStore {
  constructor({ env = process.env, dataDir = env.DATA_DIR || path.resolve('data') } = {}) {
    this.file = path.join(dataDir, 'config.json');
    this.defaults = defaultsFromEnv(env);
    this.persisted = false;
    this.persistError = null;
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {}
    // v2: faults are manual by default and stay until switched off. Older saved files carry the
    // previous defaults, so those two values are reset once (later changes are respected).
    if ((saved.configVersion ?? 1) < 2) {
      if (saved.sim) delete saved.sim.randomFaults;
      if (saved.realism) delete saved.realism.techsRepairManual;
    }
    // With ZABBIX_URL the environment is the source of truth for the Zabbix connection: a new
    // Dokploy / Zabbix only needs ZABBIX_URL + ZABBIX_API_TOKEN (whatever was saved before).
    this.envLocked = !!env.ZABBIX_URL;
    if (this.envLocked && saved.zabbix) {
      for (const k of ['url', 'apiUrl', 'transport', 'enabled']) delete saved.zabbix[k];
      if (env.ZABBIX_API_TOKEN) delete saved.zabbix.apiToken;
      if (env.ZABBIX_WEB_URL || !saved.zabbix.webUrl) delete saved.zabbix.webUrl;
    }
    // The env token always wins if the saved one is empty (first deploy with token in Dokploy).
    const { config } = applyPatch(this.defaults, saved);
    config.configVersion = CONFIG_VERSION;
    if (!config.zabbix.apiToken && this.defaults.zabbix.apiToken) config.zabbix.apiToken = this.defaults.zabbix.apiToken;
    this.config = config;
  }

  update(patch) {
    const { config, errors } = applyPatch(this.config, patch);
    if (errors.length) return errors; // all-or-nothing: never apply half a change
    this.config = config;
    this.save();
    return errors;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.config, null, 2), { mode: 0o600 });
      this.persisted = true;
      this.persistError = null;
    } catch (e) {
      this.persisted = false;
      this.persistError = e.message;
    }
  }

  // Safe view for the browser: never returns the API token.
  publicView() {
    const c = structuredClone(this.config);
    c.zabbix.hasToken = !!c.zabbix.apiToken;
    c.zabbix.fromEnv = this.envLocked;
    c.zabbix.apiToken = c.zabbix.apiToken ? `••••${c.zabbix.apiToken.slice(-4)}` : '';
    return { ...c, persisted: this.persisted, persistError: this.persistError, file: this.file };
  }
}
