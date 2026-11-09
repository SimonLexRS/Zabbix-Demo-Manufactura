// Zabbix API helpers (token auth): import templates, create/update the plant host
// and the IoT device hosts. Event correlation (Zabbix 8.0 CEP) lives in zabbix-cep.js.
// Everything is idempotent: safe to run on every start or from the config panel.
import { readFileSync } from 'node:fs';

export const SENDER_TEMPLATE = 'Planta Aceitera Demo by Zabbix sender';
export const IOT_TEMPLATE = 'Planta Aceitera IoT device by Zabbix sender';
const TRAPPER_MACRO = '{$TRAPPER.ALLOWED_HOSTS}';

export function makeRpc(url, token) {
  return async (method, params = {}, auth = true) => {
    const headers = { 'Content-Type': 'application/json-rpc' };
    if (auth) headers.Authorization = `Bearer ${token}`;
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }), signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`${method}: HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message} ${j.error.data ?? ''}`.trim());
    return j.result;
  };
}

const IMPORT_RULES = {
  template_groups: { createMissing: true, updateExisting: true },
  templates: { createMissing: true, updateExisting: true },
  items: { createMissing: true, updateExisting: true, deleteMissing: true },
  triggers: { createMissing: true, updateExisting: true, deleteMissing: true },
  discoveryRules: { createMissing: true, updateExisting: true, deleteMissing: true },
  valueMaps: { createMissing: true, updateExisting: true, deleteMissing: true },
};

async function ensureGroup(rpc, name) {
  const [g] = await rpc('hostgroup.get', { filter: { name: [name] }, output: ['groupid'] });
  return g ? g.groupid : (await rpc('hostgroup.create', { name })).groupids[0];
}

async function templateId(rpc, name) {
  const [t] = await rpc('template.get', { filter: { host: [name] }, output: ['templateid'] });
  if (!t) throw new Error(`no se encontró el template "${name}" tras importar`);
  return t.templateid;
}

// Creates or updates a host so that it is in `groupid`, linked to `templateid`, with the trapper macro.
async function upsertHost(rpc, { host, name, groupid, templateid, macros, tags, status = 0, description }) {
  const [h] = await rpc('host.get', { filter: { host: [host] }, output: ['hostid', 'status'], selectParentTemplates: ['templateid'], selectHostGroups: ['groupid'] });
  if (!h) {
    const hostid = (await rpc('host.create', { host, name, description, groups: [{ groupid }], templates: [{ templateid }], macros, tags, status })).hostids[0];
    return { hostid, action: 'creado' };
  }
  const templates = h.parentTemplates.map((t) => ({ templateid: t.templateid }));
  if (!templates.some((t) => t.templateid === templateid)) templates.push({ templateid });
  const groups = h.hostgroups.map((g) => ({ groupid: g.groupid }));
  if (!groups.some((g) => g.groupid === groupid)) groups.push({ groupid });
  await rpc('host.update', { hostid: h.hostid, name, templates, groups, macros, status });
  return { hostid: h.hostid, action: 'actualizado' };
}

// cfg: { zabbix: {host, hostGroup, trapperAllowedHosts}, iot: {enabled, hostPrefix, group}, iotDevices: [{id, name, type, asset, enabled}] }
export async function provision(rpc, cfg, { templateFile, iotTemplateFile }) {
  const version = await rpc('apiinfo.version', {}, false);
  await rpc('configuration.import', { format: 'yaml', source: readFileSync(templateFile, 'utf8'), rules: IMPORT_RULES });
  await rpc('configuration.import', { format: 'yaml', source: readFileSync(iotTemplateFile, 'utf8'), rules: IMPORT_RULES });
  const plantTpl = await templateId(rpc, SENDER_TEMPLATE);
  const iotTpl = await templateId(rpc, IOT_TEMPLATE);
  const macros = cfg.zabbix.trapperAllowedHosts ? [{ macro: TRAPPER_MACRO, value: cfg.zabbix.trapperAllowedHosts, description: 'Orígenes permitidos para Zabbix sender (panel de configuración de la planta).' }] : [];

  const groupid = await ensureGroup(rpc, cfg.zabbix.hostGroup);
  const plant = await upsertHost(rpc, {
    host: cfg.zabbix.host, name: cfg.zabbix.host, groupid, templateid: plantTpl, macros,
    tags: [{ tag: 'site', value: 'planta-aceitera' }],
    description: 'Gemelo digital de planta aceitera (acopio y molienda de soya). Datos por Zabbix sender. https://github.com/SimonLexRS/Zabbix-Demo-Manufactura',
  });

  // IoT devices: one host each; disabled devices (or IoT off) are left unmonitored. Visible
  // names are unique in Zabbix, so another plant (other prefix) adds its own name.
  const iotGroupid = await ensureGroup(rpc, cfg.iot.group);
  const iot = { created: 0, updated: 0, disabled: 0 };
  for (const d of cfg.iotDevices) {
    const on = cfg.iot.enabled && d.enabled;
    const r = await upsertHost(rpc, {
      host: `${cfg.iot.hostPrefix}${d.id}`, name: cfg.iot.hostPrefix === 'iot-' ? `IoT · ${d.name}` : `IoT · ${d.name} (${cfg.zabbix.host})`, groupid: iotGroupid, templateid: iotTpl, macros, status: on ? 0 : 1,
      tags: [{ tag: 'site', value: 'planta-aceitera' }, { tag: 'iot-type', value: d.type }, { tag: 'asset', value: d.asset }],
      description: `${d.type} · activo ${d.asset}. Dispositivo IoT simulado que reporta por Zabbix sender.`,
    });
    if (!on) iot.disabled++;
    else if (r.action === 'creado') iot.created++;
    else iot.updated++;
  }
  return { version, hostid: plant.hostid, action: `host ${plant.action}`, iot };
}
