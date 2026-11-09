// Zabbix 8.0 Complex Event Processing (CEP): the plant's event correlation runs inside
// Zabbix as CEP rules (Data collection → Event processing, API ceprule.*) created by the app.
//
// The rules work on the tags of the template triggers (tools/gen-zabbix-template.mjs):
//   area      plant area          rol       causa | sintoma
//   problema  fault id or symptom type
//
// Only rules whose name starts with PREFIX are managed (created, updated, deleted); any
// other CEP rule on the server is left untouched. The legacy global correlation created by
// earlier versions of the app (correlation.*) is removed.

export const PREFIX = 'Planta Aceitera · ';
export const LEGACY_CORRELATION = 'Planta Aceitera: la causa raíz cierra los síntomas';

// API codes (Zabbix 8.0 ceprule object).
const WIN = { none: 0, cause: 2, pattern: 4 };
const C = { tagName: 25, tagValue: 26, hostGroup: 37, opened: 30, first: 31, symptom: 33, cloned: 34 };
const OP = { equals: 0, notEquals: 1, contains: 2, isTrue: 10, isFalse: 11 };
const WHEN = { occurred: 0, added: 1, matched: 4 };
const SCOPE = { current: 0, all: 2 };
const T = { setName: 1, discard: 3, setSeverity: 4, addTag: 11, setTag: 12, closeWindow: 18 };

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// Filter from a list of conditions and an expression over their letters ("(A or B) and C").
function filter(conds, formula) {
  if (!conds.length) return { evaltype: 0, conditions: [] };
  // Zabbix only accepts formula ids with a custom expression (evaltype 3).
  if (!formula) return { evaltype: 1, conditions: conds.map((c) => ({ operator: OP.equals, ...c })) };
  return { evaltype: 3, formula, conditions: conds.map((c, i) => ({ operator: OP.equals, ...c, formulaid: LETTERS[i] })) };
}
const tagIs = (tag, value, operator = OP.equals) => ({ type: C.tagValue, tag, tag_value: value, operator });
const flag = (type, yes) => ({ type, operator: yes ? OP.isTrue : OP.isFalse });

// Rule filter: events of the plant host group(s) + extra conditions.
function plantFilter(groups, extra = [], extraFormula) {
  const g = groups.map((name) => ({ type: C.hostGroup, host_group_name: name }));
  const gLetters = g.map((_, i) => LETTERS[i]).join(' or ');
  const xLetters = extra.map((_, i) => LETTERS[g.length + i]);
  let formula = g.length > 1 ? `(${gLetters})` : gLetters;
  if (extra.length) formula += ` and ${extraFormula ? extraFormula.replace(/[A-Z]/g, (l) => xLetters[LETTERS.indexOf(l)]) : xLetters.join(' and ')}`;
  return filter([...g, ...extra], formula);
}

const op = (o) => ({ sortorder: o.sortorder, execute_when: o.when, type: o.type, scope: o.scope ?? SCOPE.current, filter: o.filter || filter([]), scope_filter: o.scopeFilter || filter([]), ...o.fields });
const window = (w = {}) => ({ duration: '10m', capacity: 0, group_by_host_group: 0, group_by_host: 0, group_by_tags: 0, tags: [], event_count_tag: '', script: '', ...w });

// Pattern-match script: true when, among the open (not copied) events of the window, there is
// a cause matching `cause` and at least `min` symptoms in `symptoms`.
function patternScript(cause, symptoms, min = 1) {
  return `// Generado por la app Planta Aceitera.
var ev = cep_get_events();
function tag(e, name) {
    for (var i = 0; i < e.tags.length; i++) { if (e.tags[i].tag === name) { return e.tags[i].value; } }
    return '';
}
var cause = false, symptoms = 0;
for (var i = 0; i < ev.length; i++) {
    if (ev[i].is_copied || !ev[i].is_open) { continue; }
    var p = tag(ev[i], 'problema');
    if (${cause}) { cause = true; }
    else if (${JSON.stringify(symptoms)}.indexOf(p) !== -1) { symptoms++; }
}
return cause && symptoms >= ${min};`;
}

// Operations of an incident: rename (optional), set severity and tag the cause events.
function incidentOps({ name, severity, tag, causeFilter }) {
  const scopeFilter = filter([...causeFilter, flag(C.opened, true), flag(C.cloned, false)]);
  const ops = [];
  let n = 1;
  if (name) ops.push(op({ sortorder: n++, when: WHEN.matched, scope: SCOPE.all, type: T.setName, scopeFilter, fields: { event_name: name } }));
  ops.push(op({ sortorder: n++, when: WHEN.matched, scope: SCOPE.all, type: T.setSeverity, scopeFilter, fields: { severity } }));
  ops.push(op({ sortorder: n++, when: WHEN.matched, scope: SCOPE.all, type: T.setTag, scopeFilter, fields: { tag: 'incidente', tag_value: tag } }));
  return ops;
}

// The plant's CEP rules. `groups`: host groups of the plant host and the IoT devices.
export function buildRules({ groups }) {
  const responsable = [
    [['recepcion', 'despacho'], 'Jefe de producción'],
    [['extraccion', 'transito'], 'Jefe de seguridad (HSE)'],
    [['energia', 'acopio', 'produccion', 'mantenimiento'], 'Jefe de mantenimiento'],
    [['iot'], 'Técnico de redes / TI'],
  ];
  return [
    {
      name: `${PREFIX}Enriquecer: responsable por área`,
      description: 'Sin ventana: a cada evento de la planta le pone el tag "responsable" según su área, para filtrar y notificar en Zabbix.',
      sortorder: 1, stop: 0, window_type: WIN.none, window: window(),
      filter: plantFilter(groups, [{ type: C.tagName, tag: 'area' }]),
      operations: responsable.map(([areas, who], i) =>
        op({ sortorder: i + 1, when: WHEN.occurred, type: T.setTag, filter: filter(areas.map((a) => tagIs('area', a)), areas.map((_, k) => LETTERS[k]).join(' or ')), fields: { tag: 'responsable', tag_value: who } })),
    },
    {
      name: `${PREFIX}Casi accidentes repetidos`,
      description: 'Ventana causa/síntomas de 15 min: se queda con el primer casi accidente y descarta los repetidos; el tag "repeticiones" cuenta cuántos hubo.',
      sortorder: 2, stop: 1, window_type: WIN.cause, window: window({ duration: '15m', group_by_host: 1, event_count_tag: 'repeticiones' }),
      filter: plantFilter(groups, [tagIs('problema', 'casi_accidente')]),
      operations: [op({ sortorder: 1, when: WHEN.occurred, type: T.discard, filter: filter([flag(C.symptom, true)]) })],
    },
    {
      name: `${PREFIX}Causa y síntomas por área`,
      description: 'Ventana causa/síntomas de 45 min por área: la primera falla del área es la causa y lo que aparece después en esa área son sus síntomas (tag "sintomas" con la cantidad). Si la ventana la abre un síntoma, se cierra para esperar una causa real.',
      sortorder: 3, stop: 0, window_type: WIN.cause, window: window({ duration: '45m', group_by_host: 1, group_by_tags: 1, tags: ['area'], event_count_tag: 'sintomas' }),
      filter: plantFilter(groups, [{ type: C.tagName, tag: 'rol' }, tagIs('problema', 'casi_accidente', OP.notEquals)]),
      operations: [op({ sortorder: 1, when: WHEN.added, type: T.closeWindow, filter: filter([flag(C.first, true), tagIs('rol', 'sintoma')]) })],
    },
    {
      name: `${PREFIX}Incidente de seguridad en extracción`,
      description: 'Patrón (15 min): fuga de hexano abierta con LEL sobre el límite o evacuación → la fuga pasa a "INCIDENTE" con severidad Desastre.',
      sortorder: 4, stop: 0, window_type: WIN.pattern,
      window: window({ duration: '15m', group_by_host: 1, script: patternScript("p === 'hexane_leak'", ['lel_alto', 'evacuacion']) }),
      filter: plantFilter(groups, [tagIs('area', 'extraccion')]),
      operations: incidentOps({ name: 'INCIDENTE: fuga de hexano con riesgo de explosión (LEL / evacuación)', severity: 5, tag: 'seguridad_extraccion', causeFilter: [tagIs('problema', 'hexane_leak')] }),
    },
    {
      name: `${PREFIX}Bloqueo vial interno`,
      description: 'Patrón (20 min): colisión abierta con tránsito detenido o cola en RN4 → la colisión pasa a "INCIDENTE" con severidad Desastre.',
      sortorder: 5, stop: 0, window_type: WIN.pattern,
      window: window({ duration: '20m', group_by_host: 1, script: patternScript("p === 'vehicle_collision'", ['transito_detenido', 'cola_rn4']) }),
      filter: plantFilter(groups, [tagIs('area', 'transito'), tagIs('problema', 'cola_rn4')], 'A or B'),
      operations: incidentOps({ name: 'INCIDENTE: bloqueo vial interno (colisión con tránsito detenido)', severity: 5, tag: 'bloqueo_vial', causeFilter: [tagIs('problema', 'vehicle_collision')] }),
    },
    {
      name: `${PREFIX}Recepción paralizada`,
      description: 'Patrón (30 min): una falla de recepción con 2 o más síntomas (camiones detenidos, cola en RN4) → la falla queda marcada incidente=recepcion_paralizada con severidad Alta.',
      sortorder: 6, stop: 0, window_type: WIN.pattern,
      window: window({ duration: '30m', group_by_host: 1, script: patternScript("tag(ev[i], 'rol') === 'causa'", ['camion_detenido', 'cola_rn4'], 2) }),
      filter: plantFilter(groups, [tagIs('area', 'recepcion')]),
      operations: incidentOps({ severity: 4, tag: 'recepcion_paralizada', causeFilter: [tagIs('rol', 'causa')] }),
    },
    {
      name: `${PREFIX}Pérdida de vapor afecta la molienda`,
      description: 'Patrón (30 min): disparo de caldera con presión de vapor baja o molienda baja → la caldera pasa a "INCIDENTE" con severidad Alta.',
      sortorder: 7, stop: 0, window_type: WIN.pattern,
      window: window({ duration: '30m', group_by_host: 1, script: patternScript("p.indexOf('boiler_') === 0", ['vapor_bajo', 'molienda_baja']) }),
      filter: plantFilter(groups, [tagIs('area', 'energia'), tagIs('area', 'produccion')], 'A or B'),
      operations: incidentOps({ name: 'INCIDENTE: pérdida de vapor afecta la molienda', severity: 4, tag: 'vapor_molienda', causeFilter: [tagIs('problema', 'boiler_', OP.contains)] }),
    },
  ];
}

// Creates / updates / deletes the managed rules and removes the legacy correlation.
export async function applyCep(rpc, { groups, enable = true }) {
  const out = { state: 'activa', rules: [], legacyRemoved: false };
  try {
    const legacy = await rpc('correlation.get', { filter: { name: [LEGACY_CORRELATION] }, output: ['correlationid'] });
    if (legacy.length) {
      await rpc('correlation.delete', legacy.map((c) => c.correlationid));
      out.legacyRemoved = true;
    }
  } catch {
    // correlation.* may be gone in later versions: nothing to remove.
  }
  const current = await rpc('ceprule.get', { output: ['cep_ruleid', 'name'], search: { name: PREFIX }, startSearch: true });
  const byName = new Map(current.map((r) => [r.name, r.cep_ruleid]));
  const wanted = enable ? buildRules({ groups }) : [];
  for (const rule of wanted) {
    const id = byName.get(rule.name);
    const body = { ...rule, status: 0 };
    if (id) await rpc('ceprule.update', { cep_ruleid: id, ...body });
    else await rpc('ceprule.create', body);
    byName.delete(rule.name);
  }
  if (byName.size) await rpc('ceprule.delete', [...byName.values()]);
  out.rules = await cepStatus(rpc);
  if (!enable) out.state = 'deshabilitada';
  else if (out.rules.some((r) => r.error)) out.state = 'con errores';
  return out;
}

// Managed rules as Zabbix sees them (status and processing error).
export async function cepStatus(rpc) {
  const rules = await rpc('ceprule.get', { output: ['cep_ruleid', 'name', 'status', 'error', 'window_type', 'sortorder'], search: { name: PREFIX }, startSearch: true, sortfield: 'sortorder' });
  const kind = { 0: 'evento', 1: 'ventana simple', 2: 'causa y síntomas', 3: 'ventana simple', 4: 'patrón' };
  return rules.map((r) => ({ id: r.cep_ruleid, name: r.name.slice(PREFIX.length), enabled: r.status === '0', error: r.error || '', kind: kind[r.window_type] || r.window_type }));
}

// What the CEP did with the plant's open problems: causes with their symptoms, incidents
// and discarded repetitions.
export async function cepResults(rpc, hostids) {
  const probs = await rpc('problem.get', { hostids, output: ['eventid', 'name', 'severity', 'clock', 'cause_eventid'], selectTags: 'extend', recent: false, sortfield: ['eventid'], sortorder: 'DESC', limit: 200 });
  const tagOf = (p, t) => p.tags.find((x) => x.tag === t)?.value;
  const symptomsOf = new Map();
  for (const p of probs) if (p.cause_eventid && p.cause_eventid !== '0') symptomsOf.set(p.cause_eventid, [...(symptomsOf.get(p.cause_eventid) || []), p]);
  const groups = probs
    .filter((p) => !p.cause_eventid || p.cause_eventid === '0')
    .map((p) => ({
      eventid: p.eventid, name: p.name, severity: Number(p.severity), clock: Number(p.clock), area: tagOf(p, 'area') || '', problema: tagOf(p, 'problema') || '', responsable: tagOf(p, 'responsable') || '',
      incidente: tagOf(p, 'incidente') || '', repeticiones: Number(tagOf(p, 'repeticiones') || 0) || 0,
      symptoms: (symptomsOf.get(p.eventid) || []).map((s) => ({ name: s.name, severity: Number(s.severity) })),
    }))
    .filter((g) => g.symptoms.length || g.incidente || g.repeticiones || g.area);
  return {
    at: Date.now(),
    open: probs.length,
    symptoms: probs.filter((p) => p.cause_eventid && p.cause_eventid !== '0').length,
    incidents: groups.filter((g) => g.incidente).length,
    groups: groups.slice(0, 20),
  };
}
