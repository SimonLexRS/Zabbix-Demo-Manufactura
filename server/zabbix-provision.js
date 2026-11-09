// Creates/updates the sender template and the plant host in Zabbix through the
// JSON-RPC API (token auth). Idempotent: safe to run on every start.
import { readFileSync } from 'node:fs';

export const SENDER_TEMPLATE = 'Planta Aceitera Demo by Zabbix sender';

export async function provision({ url, token, host, group = 'Manufactura', templateFile }) {
  const rpc = async (method, params, auth = true) => {
    const headers = { 'Content-Type': 'application/json-rpc' };
    if (auth) headers.Authorization = `Bearer ${token}`;
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }), signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`${method}: HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message} ${j.error.data ?? ''}`.trim());
    return j.result;
  };

  const version = await rpc('apiinfo.version', {}, false);
  await rpc('configuration.import', {
    format: 'yaml',
    source: readFileSync(templateFile, 'utf8'),
    rules: {
      template_groups: { createMissing: true, updateExisting: true },
      templates: { createMissing: true, updateExisting: true },
      items: { createMissing: true, updateExisting: true, deleteMissing: true },
      triggers: { createMissing: true, updateExisting: true, deleteMissing: true },
      discoveryRules: { createMissing: true, updateExisting: true, deleteMissing: true },
      valueMaps: { createMissing: true, updateExisting: true },
    },
  });

  const [tpl] = await rpc('template.get', { filter: { host: [SENDER_TEMPLATE] }, output: ['templateid'] });
  if (!tpl) throw new Error(`no se encontró el template "${SENDER_TEMPLATE}" tras importar`);

  let [g] = await rpc('hostgroup.get', { filter: { name: [group] }, output: ['groupid'] });
  if (!g) g = { groupid: (await rpc('hostgroup.create', { name: group })).groupids[0] };

  const [h] = await rpc('host.get', { filter: { host: [host] }, output: ['hostid'], selectParentTemplates: ['templateid'] });
  let hostid;
  let action;
  if (!h) {
    hostid = (
      await rpc('host.create', {
        host,
        description: 'Gemelo digital de planta aceitera (acopio y molienda de soya). Datos por Zabbix sender. https://github.com/SimonLexRS/Zabbix-Demo-Manufactura',
        groups: [{ groupid: g.groupid }],
        templates: [{ templateid: tpl.templateid }],
        tags: [{ tag: 'site', value: 'planta-aceitera' }],
      })
    ).hostids[0];
    action = 'host creado';
  } else {
    hostid = h.hostid;
    const linked = h.parentTemplates.some((t) => t.templateid === tpl.templateid);
    if (!linked) {
      await rpc('host.update', { hostid, templates: [...h.parentTemplates.map((t) => ({ templateid: t.templateid })), { templateid: tpl.templateid }] });
      action = 'template vinculado al host existente';
    } else {
      action = 'host ya existía con el template';
    }
  }
  return { version, hostid, templateid: tpl.templateid, action };
}
