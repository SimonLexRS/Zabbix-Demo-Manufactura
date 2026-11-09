// Runtime configuration: defaults from environment variables, overrides edited
// from the configuration panel and persisted to DATA_DIR/config.json (a Docker
// volume in production). Every value is validated before it is applied.
import fs from 'node:fs';
import path from 'node:path';
import { validateRules } from '../js/sim/cep.js';
import { IOT_BY_ID } from '../js/sim/iot.js';

const off = (v) => ['0', 'false', 'no', 'off'].includes(String(v ?? '').toLowerCase());
const num = (v, min, max, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
};
const str = (v, re, max = 200) => {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s.length <= max && re.test(s) ? s : undefined;
};

export function defaultsFromEnv(env = process.env) {
  return {
    zabbix: {
      enabled: !!env.ZABBIX_SERVER,
      server: env.ZABBIX_SERVER || 'zabbix-server',
      port: num(env.ZABBIX_PORT, 1, 65535, 10051),
      host: env.ZABBIX_HOST || 'Planta Aceitera',
      hostGroup: env.ZABBIX_HOST_GROUP || 'Manufactura',
      sendInterval: num(env.ZABBIX_SEND_INTERVAL, 2, 3600, 10),
      lldInterval: num(env.ZABBIX_LLD_INTERVAL, 60, 86400, 600),
      apiUrl: env.ZABBIX_API_URL || '',
      apiToken: env.ZABBIX_API_TOKEN || '',
      trapperAllowedHosts: env.ZABBIX_TRAPPER_ALLOWED_HOSTS || '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.1,::1',
    },
    iot: { enabled: !off(env.IOT_ENABLED ?? '1'), hostPrefix: env.IOT_HOST_PREFIX || 'iot-', group: env.IOT_HOST_GROUP || 'Manufactura/IoT', randomDropouts: true, devices: {} },
    cep: { enabled: true, rules: null, zabbixCorrelation: false },
    sim: { randomFaults: !off(env.RANDOM_FAULTS), speed: num(env.SIM_SPEED, 0, 30, 1) },
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
  if (z.server !== undefined) set(c.zabbix, 'server', str(z.server, /^[A-Za-z0-9][A-Za-z0-9.-]*$/, 253), 'servidor Zabbix');
  if (z.port !== undefined) c.zabbix.port = num(z.port, 1, 65535, c.zabbix.port);
  if (z.host !== undefined) set(c.zabbix, 'host', str(z.host, /^[\w .-]+$/, 128), 'nombre de host');
  if (z.hostGroup !== undefined) set(c.zabbix, 'hostGroup', str(z.hostGroup, /^[\p{L}\w ./-]+$/u, 128), 'grupo de hosts');
  if (z.sendInterval !== undefined) c.zabbix.sendInterval = num(z.sendInterval, 2, 3600, c.zabbix.sendInterval);
  if (z.lldInterval !== undefined) c.zabbix.lldInterval = num(z.lldInterval, 60, 86400, c.zabbix.lldInterval);
  if (z.apiUrl !== undefined) set(c.zabbix, 'apiUrl', z.apiUrl === '' ? '' : str(z.apiUrl, /^https?:\/\/[^\s]+$/, 300), 'URL de la API');
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
  if (e.zabbixCorrelation !== undefined) c.cep.zabbixCorrelation = !!e.zabbixCorrelation;
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
    // The env token always wins if the saved one is empty (first deploy with token in Dokploy).
    const { config } = applyPatch(this.defaults, saved);
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
    c.zabbix.apiToken = c.zabbix.apiToken ? `••••${c.zabbix.apiToken.slice(-4)}` : '';
    return { ...c, persisted: this.persisted, persistError: this.persistError, file: this.file };
  }
}
