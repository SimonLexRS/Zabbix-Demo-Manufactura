// Generates two Zabbix 7.0-format templates (importable in Zabbix 7.0 and 8.0):
//
//  zabbix/template_planta_aceitera_sender.yaml  "Planta Aceitera Demo by Zabbix sender"
//     Trapper items + trapper LLD. The app pushes values with the Zabbix sender
//     protocol (ZABBIX_SERVER). This is the one auto-imported by the app.
//
//  zabbix/template_planta_aceitera.yaml          "Planta Aceitera Demo by HTTP"
//     One HTTP agent master item polling /api/metrics + dependent items (pull).
//
// Use only one of them per host (they share item keys).
// Run: node tools/gen-zabbix-template.mjs
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PROBLEMS, PLC_EXT_FIELDS } from '../js/sim/problems.js';

const GROUP = 'Templates/Manufacturing';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRIORITY = ['INFO', 'WARNING', 'AVERAGE', 'HIGH', 'DISASTER'];

// field, name, units, value type, component tag
const PLANT = [
  ['soy_stock_t', 'Stock de soya', 't', 'FLOAT', 'acopio'],
  ['soy_capacity_t', 'Capacidad de acopio', 't', 'FLOAT', 'acopio'],
  ['soy_stock_pct', 'Ocupación de acopio', '%', 'FLOAT', 'acopio'],
  ['soy_received_today_t', 'Soya recibida hoy', 't', 'FLOAT', 'recepcion'],
  ['trucks_received_today', 'Camiones recibidos hoy', '', 'UNSIGNED', 'recepcion'],
  ['trucks_rejected_today', 'Camiones rechazados hoy', '', 'UNSIGNED', 'recepcion'],
  ['trucks_in_plant', 'Camiones en planta', '', 'UNSIGNED', 'recepcion'],
  ['trucks_waiting_yard', 'Camiones en playa', '', 'UNSIGNED', 'recepcion'],
  ['trucks_waiting_road', 'Camiones esperando en RN4', '', 'UNSIGNED', 'recepcion'],
  ['crush_rate_tpd', 'Tasa de molienda', 't/d', 'FLOAT', 'produccion'],
  ['crush_pct', 'Capacidad de molienda utilizada', '%', 'FLOAT', 'produccion'],
  ['crushed_today_t', 'Soya molida hoy', 't', 'FLOAT', 'produccion'],
  ['buffer_silo_t', 'Silo pulmón', 't', 'FLOAT', 'produccion'],
  ['prep_conditioner_temp_c', 'Temp. acondicionador', '°C', 'FLOAT', 'produccion'],
  ['extractor_temp_c', 'Temp. extractor', '°C', 'FLOAT', 'extraccion'],
  ['dt_temp_c', 'Temp. desolventizador-tostador', '°C', 'FLOAT', 'extraccion'],
  ['miscella_pct', 'Concentración de miscela', '%', 'FLOAT', 'extraccion'],
  ['lel_pct', 'LEL hexano en extracción', '%', 'FLOAT', 'seguridad'],
  ['extractor_running', 'Extractor en marcha', '', 'UNSIGNED', 'extraccion'],
  ['hexane_stock_m3', 'Stock de hexano', 'm³', 'FLOAT', 'extraccion'],
  ['hexane_stock_pct', 'Nivel tanque de hexano', '%', 'FLOAT', 'extraccion'],
  ['hexane_loss_l_per_t', 'Pérdida de hexano', 'L/t', 'FLOAT', 'extraccion'],
  ['oil_stock_t', 'Stock de aceite crudo', 't', 'FLOAT', 'despacho'],
  ['oil_stock_pct', 'Ocupación tanques de aceite', '%', 'FLOAT', 'despacho'],
  ['oil_produced_today_t', 'Aceite producido hoy', 't', 'FLOAT', 'produccion'],
  ['oil_dispatched_today_t', 'Aceite despachado hoy', 't', 'FLOAT', 'despacho'],
  ['meal_stock_t', 'Stock de harina', 't', 'FLOAT', 'despacho'],
  ['meal_stock_pct', 'Ocupación galpón de harina', '%', 'FLOAT', 'despacho'],
  ['meal_produced_today_t', 'Harina producida hoy', 't', 'FLOAT', 'produccion'],
  ['meal_dispatched_today_t', 'Harina despachada hoy', 't', 'FLOAT', 'despacho'],
  ['meal_protein_pct', 'Proteína en harina', '%', 'FLOAT', 'calidad'],
  ['meal_humidity_pct', 'Humedad de harina', '%', 'FLOAT', 'calidad'],
  ['meal_residual_oil_pct', 'Aceite residual en harina', '%', 'FLOAT', 'calidad'],
  ['meal_residual_hexane_ppm', 'Hexano residual en harina', 'ppm', 'FLOAT', 'calidad'],
  ['hulls_stock_t', 'Stock de cascarilla', 't', 'FLOAT', 'energia'],
  ['steam_pressure_bar', 'Presión de vapor', 'bar', 'FLOAT', 'energia'],
  ['steam_demand_tph', 'Demanda de vapor', 't/h', 'FLOAT', 'energia'],
  ['power_mw', 'Potencia eléctrica', 'MW', 'FLOAT', 'energia'],
  ['tankers_dispatched_today', 'Cisternas despachadas hoy', '', 'UNSIGNED', 'despacho'],
  ['meal_trucks_dispatched_today', 'Camiones de harina despachados hoy', '', 'UNSIGNED', 'despacho'],
  ['problems_active', 'Problemas activos (simulador)', '', 'UNSIGNED', 'general'],
];

const macros = [
  ['{$PLANTA.STEAM.MIN}', '8', 'Presión mínima de vapor (bar).'],
  ['{$PLANTA.LEL.MAX}', '25', 'LEL de hexano: umbral de desastre (%).'],
  ['{$PLANTA.LEL.WARN}', '12', 'LEL de hexano: umbral de advertencia (%).'],
  ['{$PLANTA.CRUSH.MIN}', '70', 'Capacidad de molienda mínima (%).'],
  ['{$PLANTA.HEXANE.MIN}', '25', 'Nivel mínimo de tanque de hexano (%).'],
  ['{$PLANTA.MEAL.HEXANE.MAX}', '300', 'Hexano residual máximo en harina (ppm).'],
  ['{$PLANTA.OIL.MAX}', '90', 'Ocupación máxima de tanques de aceite (%).'],
  ['{$PLANTA.ROADQ.MAX}', '4', 'Camiones máximos esperando en RN4.'],
  ['{$PLANTA.SILO.LEVEL.MAX}', '95', 'Nivel máximo de silo/galpón (%).'],
  ['{$PLANTA.SILO.TEMP.MAX}', '32', 'Temperatura máxima de grano (°C).'],
  ['{$PLANTA.TANK.LEVEL.MAX}', '95', 'Nivel máximo de tanque de aceite (%).'],
  ['{$PLANTA.NODATA}', '2m', 'Tiempo sin datos antes de alertar.'],
];

// Zabbix 8.0 ships the global macro {$TRAPPER.ALLOWED_HOSTS} = 127.0.0.1,::1, so trapper
// items reject data sent from containers. The sender template overrides it with the
// private ranges used by Docker networks (edit it on the host to restrict further).
const SENDER_MACROS = [['{$TRAPPER.ALLOWED_HOSTS}', '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.1,::1', 'Orígenes permitidos para los ítems trapper (Zabbix sender). Redes privadas de Docker por defecto.']];

function build(mode) {
  const sender = mode === 'sender';
  const T = sender ? 'Planta Aceitera Demo by Zabbix sender' : 'Planta Aceitera Demo by HTTP';
  // Stable UUIDv4-shaped ids derived from a seed, so regenerating doesn't churn.
  const uuid = (seed) => {
    const h = createHash('md5').update(`planta:${mode}:${seed}`).digest('hex').split('');
    h[12] = '4';
    h[16] = '89ab'[parseInt(h[16], 16) % 4];
    return h.join('');
  };
  const ref = (key) => `/${T}/${key}`;
  const tags = (component) => [{ tag: 'component', value: component }];
  // Item source: trapper (sender) or dependent on the HTTP master item.
  const src = (key, jsonpath) =>
    sender ? { type: 'TRAP', key } : { type: 'DEPENDENT', key, delay: '0', preprocessing: [{ type: 'JSONPATH', parameters: [jsonpath] }], master_item: { key: 'planta.raw' } };

  const plantTriggers = {
    steam_pressure_bar: [{ expression: `max(${ref('planta.steam_pressure_bar')},2m)<{$PLANTA.STEAM.MIN}`, _id: 'steam_low', name: 'Presión de vapor baja (< {$PLANTA.STEAM.MIN} bar)', priority: 'HIGH' }],
    lel_pct: [
      { expression: `last(${ref('planta.lel_pct')})>{$PLANTA.LEL.MAX}`, _id: 'lel_disaster', name: 'LEL de hexano sobre {$PLANTA.LEL.MAX}% en extracción', priority: 'DISASTER' },
      { expression: `last(${ref('planta.lel_pct')})>{$PLANTA.LEL.WARN}`, _id: 'lel_warn', name: 'LEL de hexano elevado (> {$PLANTA.LEL.WARN}%)', priority: 'WARNING' },
    ],
    extractor_running: [{ expression: `last(${ref('planta.extractor_running')})=0`, _id: 'extractor_stopped', name: 'Extractor detenido', priority: 'HIGH' }],
    extractor_temp_c: sender ? [{ expression: `nodata(${ref('planta.extractor_temp_c')},{$PLANTA.NODATA})=1`, _id: 'plc_nodata', name: 'Sin datos del PLC de extracción', priority: 'HIGH' }] : null,
    crush_pct: [{ expression: `max(${ref('planta.crush_pct')},5m)<{$PLANTA.CRUSH.MIN}`, _id: 'crush_low', name: 'Molienda bajo {$PLANTA.CRUSH.MIN}% de capacidad por 5 min', priority: 'AVERAGE' }],
    hexane_stock_pct: [{ expression: `last(${ref('planta.hexane_stock_pct')})<{$PLANTA.HEXANE.MIN}`, _id: 'hexane_low', name: 'Stock de hexano bajo (< {$PLANTA.HEXANE.MIN}%)', priority: 'WARNING' }],
    meal_residual_hexane_ppm: [{ expression: `min(${ref('planta.meal_residual_hexane_ppm')},5m)>{$PLANTA.MEAL.HEXANE.MAX}`, _id: 'meal_hex', name: 'Hexano residual en harina > {$PLANTA.MEAL.HEXANE.MAX} ppm', priority: 'AVERAGE' }],
    oil_stock_pct: [{ expression: `last(${ref('planta.oil_stock_pct')})>{$PLANTA.OIL.MAX}`, _id: 'oil_full', name: 'Tanques de aceite sobre {$PLANTA.OIL.MAX}%', priority: 'WARNING' }],
    trucks_waiting_road: [{ expression: `last(${ref('planta.trucks_waiting_road')})>{$PLANTA.ROADQ.MAX}`, _id: 'road_queue', name: 'Cola de camiones en RN4 (> {$PLANTA.ROADQ.MAX})', priority: 'WARNING' }],
  };

  const items = [];
  if (!sender) {
    items.push({
      uuid: uuid('raw'), name: 'Planta: datos crudos (/api/metrics)', type: 'HTTP_AGENT', key: 'planta.raw', delay: '{$PLANTA.INTERVAL}',
      history: '0', value_type: 'TEXT', trends: '0', url: '{$PLANTA.URL}/api/metrics', timeout: '10s',
      description: 'Ítem maestro: JSON completo del simulador. El resto de ítems son dependientes.', tags: tags('raw'),
    });
  }
  items.push(
    {
      uuid: uuid('sim_minutes'), name: 'Planta: reloj de simulación', ...src('planta.sim_minutes', '$.sim_minutes'), value_type: 'FLOAT', units: 'm', tags: tags('general'),
      triggers: [{ uuid: uuid('t:nodata'), expression: `nodata(${ref('planta.sim_minutes')},{$PLANTA.NODATA})=1`, name: 'Planta: sin datos del simulador', priority: 'AVERAGE', description: sender ? 'La app dejó de enviar con Zabbix sender (app detenida o sin red hacia el server).' : 'El endpoint /api/metrics no responde.' }],
    },
    { uuid: uuid('speed'), name: 'Planta: velocidad de simulación', ...src('planta.speed', '$.speed'), value_type: 'FLOAT', units: 'x', tags: tags('general') },
    { uuid: uuid('random_faults'), name: 'Planta: fallas aleatorias habilitadas', ...src('planta.random_faults', '$.random_faults'), value_type: 'UNSIGNED', valuemap: { name: 'Planta: sí/no' }, tags: tags('general') },
  );
  for (const [field, name, units, vt, comp] of PLANT) {
    const it = { uuid: uuid(`plant:${field}`), name: `Planta: ${name}`, ...src(`planta.${field}`, `$.plant.${field}`), value_type: vt, tags: tags(comp) };
    if (units) it.units = units;
    if (field === 'extractor_running') it.valuemap = { name: 'Estado de equipo' };
    if (sender && PLC_EXT_FIELDS.includes(field)) it.tags = [...it.tags, { tag: 'plc', value: 'extraccion' }];
    const trg = plantTriggers[field];
    if (trg) it.triggers = trg.map((t) => ({ uuid: uuid(`t:${t.name}`), ...t, name: `Planta: ${t.name}` }));
    items.push(it);
  }
  // One item per problem point (0 normal, 1 manual, 2 aleatoria) with its trigger.
  for (const p of PROBLEMS) {
    const key = `planta.problem[${p.id}]`;
    items.push({
      uuid: uuid(`problem:${p.id}`), name: `Falla: ${p.name}`, ...src(key, `$.problem_states.${p.id}`), value_type: 'UNSIGNED', valuemap: { name: 'Origen de falla' },
      description: p.desc, tags: [{ tag: 'component', value: 'fallas' }, { tag: 'scope', value: p.src }],
      triggers: [{ _id: `problem:${p.id}`, uuid: uuid(`t:problem:${p.id}`), expression: `last(${ref(key)})>0`, name: `${p.name} ({ITEM.LASTVALUE})`, priority: PRIORITY[p.sev], description: p.desc }],
    });
  }

  function lld(id, name, list, prototypes) {
    const rule = {
      uuid: uuid(`lld:${id}`), name, ...(sender ? { type: 'TRAP', key: `planta.${id}.discovery` } : { type: 'DEPENDENT', key: `planta.${id}.discovery`, delay: '0' }),
      item_prototypes: prototypes.map(([field, pname, units, vt, trig, extra]) => {
        const key = `planta.${id.replace(/s$/, '')}.${field}[{#ID}]`;
        const it = {
          uuid: uuid(`proto:${id}:${field}`), name: `{#NAME}: ${pname}`, ...src(key, `$.${list}['{#ID}'].${field}`), value_type: vt,
          tags: [{ tag: 'component', value: id }, { tag: id.replace(/s$/, ''), value: '{#ID}' }], ...(extra || {}),
        };
        if (units) it.units = units;
        if (trig) it.trigger_prototypes = trig.map((t) => ({ uuid: uuid(`tp:${id}:${field}:${t.name}`), ...t, expression: t.expression.replace('KEY', ref(key)) }));
        return it;
      }),
    };
    if (!sender) {
      rule.master_item = { key: 'planta.raw' };
      rule.preprocessing = [{ type: 'JSONPATH', parameters: [`$.discovery.${list}`] }];
    }
    return rule;
  }

  const discovery = [
    lld('silos', 'Silos y galpones graneleros', 'silos', [
      ['level_pct', 'Nivel', '%', 'FLOAT', [{ expression: 'last(KEY)>{$PLANTA.SILO.LEVEL.MAX}', name: '{#NAME}: casi lleno (> {$PLANTA.SILO.LEVEL.MAX}%)', priority: 'WARNING' }]],
      ['stock_t', 'Stock', 't', 'FLOAT'],
      ['capacity_t', 'Capacidad', 't', 'FLOAT'],
      ['temp_c', 'Temperatura de grano', '°C', 'FLOAT', [{ expression: 'last(KEY)>{$PLANTA.SILO.TEMP.MAX}', _id: 'silo_temp', name: '{#NAME}: temperatura de grano alta (> {$PLANTA.SILO.TEMP.MAX} °C)', priority: 'HIGH' }]],
      ['humidity_pct', 'Humedad de grano', '%', 'FLOAT'],
    ]),
    lld('tanks', 'Tanques de aceite crudo', 'tanks', [
      ['level_pct', 'Nivel', '%', 'FLOAT', [{ expression: 'last(KEY)>{$PLANTA.TANK.LEVEL.MAX}', name: '{#NAME}: nivel alto (> {$PLANTA.TANK.LEVEL.MAX}%)', priority: 'WARNING' }]],
      ['stock_t', 'Stock', 't', 'FLOAT'],
      ['capacity_t', 'Capacidad', 't', 'FLOAT'],
      ['temp_c', 'Temperatura', '°C', 'FLOAT'],
    ]),
    lld('boilers', 'Calderas', 'boilers', [
      ['status', 'Estado', '', 'UNSIGNED', null, { valuemap: { name: 'Estado de equipo' } }],
      ['load_pct', 'Carga', '%', 'FLOAT'],
      ['flue_temp_c', 'Temp. gases de chimenea', '°C', 'FLOAT'],
    ]),
    lld('stations', 'Puntos de operación (portería, balanzas, calador, volcadoras, carga)', 'stations', [
      ['available', 'Disponible', '', 'UNSIGNED', null, { valuemap: { name: 'Estado de equipo' } }],
      ['network', 'Red / comunicación', '', 'UNSIGNED', null, { valuemap: { name: 'Estado de red' } }],
      ['busy', 'Camiones en uso', '', 'UNSIGNED'],
      ['trucks_stopped', 'Camiones detenidos', '', 'UNSIGNED', [{ expression: 'last(KEY)>0', _id: 'trucks_stopped', name: '{#NAME}: camión detenido', priority: 'AVERAGE' }]],
      ['operations_today', 'Operaciones hoy', '', 'UNSIGNED'],
    ]),
  ];

  // CEP (sender only): composite events from the app's correlation engine.
  if (sender) {
    const cepKey = 'planta.cep.active[{#RULE}]';
    discovery.push({
      uuid: uuid('lld:cep'), name: 'Reglas CEP (correlación de eventos)', type: 'TRAP', key: 'planta.cep.discovery',
      item_prototypes: [{
        uuid: uuid('proto:cep:active'), name: 'CEP: {#NAME}', type: 'TRAP', key: cepKey, value_type: 'UNSIGNED', valuemap: { name: 'Severidad CEP' },
        description: '0 = inactiva; 1..5 = severidad del evento compuesto detectado por la regla.',
        tags: [{ tag: 'component', value: 'cep' }, { tag: 'cep', value: '{#RULE}' }],
        trigger_prototypes: PRIORITY.map((prio, i) => ({
          uuid: uuid(`tp:cep:${prio}`), expression: `last(${ref(cepKey)})=${i + 1}`, name: 'CEP: {#NAME}', priority: prio,
          description: 'Evento compuesto (CEP) generado por la app al correlacionar fallas y métricas dentro de una ventana de tiempo.',
          tags: [{ tag: 'scope', value: 'cep' }, { tag: 'rootcause', value: 'cep' }],
        })),
      }],
    });
    items.push(
      { uuid: uuid('cep:count'), name: 'CEP: reglas activas', type: 'TRAP', key: 'planta.cep.active_count', value_type: 'UNSIGNED', tags: tags('cep') },
      { uuid: uuid('cep:last'), name: 'CEP: último evento compuesto', type: 'TRAP', key: 'planta.cep.last_event', value_type: 'TEXT', trends: '0', tags: tags('cep') },
    );
  }

  // Event correlation inside Zabbix: tags (scope + rootcause/symptom) and trigger dependencies
  // so a symptom is suppressed while its cause is in problem state.
  const SCOPE = {
    steam_low: 'energia', crush_low: 'produccion', meal_hex: 'produccion', lel_disaster: 'extraccion', lel_warn: 'extraccion', extractor_stopped: 'extraccion',
    plc_nodata: 'extraccion', hexane_low: 'extraccion', oil_full: 'despacho', road_queue: 'recepcion', trucks_stopped: 'recepcion', silo_temp: 'acopio',
  };
  const PROBLEM_SCOPE = { BAL_IN: 'recepcion', BAL_OUT: 'recepcion', GATE: 'recepcion', SAMP: 'recepcion', N1: 'recepcion', N2: 'recepcion', B1: 'energia', B2: 'energia', EXT: 'extraccion', S2: 'acopio', PREP: 'produccion', OL: 'despacho' };
  for (const p of PROBLEMS) SCOPE[`problem:${p.id}`] = PROBLEM_SCOPE[p.src] || 'planta';
  const recepcionCauses = ['bal_in_net', 'bal_out_net', 'gate_net', 'samp_fault', 'noria_N1', 'noria_N2'].map((id) => `problem:${id}`);
  const DEPS = {
    trucks_stopped: [...recepcionCauses, 'problem:ol_arm'],
    road_queue: recepcionCauses,
    steam_low: ['problem:boiler_B1', 'problem:boiler_B2'],
    crush_low: ['steam_low', 'problem:prep_power', 'problem:hexane_leak', 'extractor_stopped'],
    meal_hex: ['steam_low'],
    extractor_stopped: ['problem:hexane_leak', 'lel_disaster'],
    lel_warn: ['lel_disaster'],
    plc_nodata: ['problem:plc_ext_comm'],
    silo_temp: ['problem:silo_hot_S2'],
  };
  const allTriggers = [
    ...items.flatMap((i) => i.triggers || []),
    ...discovery.flatMap((d) => d.item_prototypes.flatMap((p) => p.trigger_prototypes || [])),
  ];
  const byId = Object.fromEntries(allTriggers.filter((t) => t._id).map((t) => [t._id, t]));
  for (const t of allTriggers) {
    if (!t._id) continue;
    const isCause = t._id.startsWith('problem:');
    t.tags = [...(t.tags || []), { tag: 'scope', value: SCOPE[t._id] || 'planta' }, isCause ? { tag: 'rootcause', value: 'yes' } : { tag: 'symptom', value: 'yes' }];
    const deps = (DEPS[t._id] || []).map((id) => byId[id]).filter(Boolean);
    if (deps.length) t.dependencies = deps.map((d) => ({ name: d.name, expression: d.expression }));
  }
  for (const t of allTriggers) delete t._id;

  const allMacros = [
    ...(sender
      ? SENDER_MACROS
      : [
          ['{$PLANTA.URL}', 'http://planta-aceitera:8080', 'URL base del simulador (sin barra final).'],
          ['{$PLANTA.INTERVAL}', '30s', 'Intervalo de consulta del ítem maestro.'],
        ]),
    ...macros,
  ].map(([macro, value, description]) => ({ macro, value, description }));

  const valuemaps = [
    { uuid: uuid('vm:estado'), name: 'Estado de equipo', mappings: [{ value: '0', newvalue: 'Detenido / fuera de servicio' }, { value: '1', newvalue: 'En servicio' }] },
    { uuid: uuid('vm:red'), name: 'Estado de red', mappings: [{ value: '0', newvalue: 'Sin red' }, { value: '1', newvalue: 'En línea' }] },
    { uuid: uuid('vm:origen'), name: 'Origen de falla', mappings: [{ value: '0', newvalue: 'Normal' }, { value: '1', newvalue: 'Manual' }, { value: '2', newvalue: 'Aleatoria' }] },
    { uuid: uuid('vm:sino'), name: 'Planta: sí/no', mappings: [{ value: '0', newvalue: 'No' }, { value: '1', newvalue: 'Sí' }] },
    ...(sender ? [{ uuid: uuid('vm:cep'), name: 'Severidad CEP', mappings: ['Inactiva', 'Información', 'Advertencia', 'Promedio', 'Alta', 'Desastre'].map((n, i) => ({ value: String(i), newvalue: n })) }] : []),
  ];

  const doc = {
    zabbix_export: {
      version: '7.0',
      template_groups: [{ uuid: uuid('group'), name: GROUP }],
      templates: [
        {
          uuid: uuid('template'),
          template: T,
          name: T,
          description: `Gemelo digital de planta aceitera (acopio y molienda de soya). ${sender ? 'Datos enviados por la app con el protocolo Zabbix sender (ítems trapper).' : 'Datos obtenidos por HTTP agent desde /api/metrics.'} Fuente: https://github.com/SimonLexRS/Zabbix-Demo-Manufactura`,
          groups: [{ name: GROUP }],
          items,
          discovery_rules: discovery,
          tags: [{ tag: 'class', value: 'manufacturing' }, { tag: 'target', value: 'planta-aceitera' }],
          macros: allMacros,
          valuemaps,
        },
      ],
    },
  };
  return { doc, stats: { items: items.length, lld: discovery.length, protos: discovery.reduce((a, d) => a + d.item_prototypes.length, 0) } };
}

// Minimal YAML emitter (all scalars single-quoted, so no escaping surprises).
function yaml(v, indent = 0) {
  const pad = ' '.repeat(indent);
  const scalar = (s) => `'${String(s).replace(/'/g, "''")}'`;
  if (Array.isArray(v)) {
    return v
      .map((x) => (x !== null && typeof x === 'object' ? `${pad}- ${yaml(x, indent + 2).replace(/^\s+/, '')}` : `${pad}- ${scalar(x)}`))
      .join('\n');
  }
  return Object.entries(v)
    .filter(([, x]) => x !== undefined && x !== null)
    .map(([k, x]) => (x !== null && typeof x === 'object' ? `${pad}${k}:\n${yaml(x, indent + 2)}` : `${pad}${k}: ${scalar(x)}`))
    .join('\n');
}

// Generic template for every simulated IoT device (one Zabbix host per device).
function buildIot() {
  const T = 'Planta Aceitera IoT device by Zabbix sender';
  const uuid = (seed) => {
    const h = createHash('md5').update(`planta:iot:${seed}`).digest('hex').split('');
    h[12] = '4';
    h[16] = '89ab'[parseInt(h[16], 16) % 4];
    return h.join('');
  };
  const ref = (key) => `/${T}/${key}`;
  const tg = (scope, kind) => [{ tag: 'scope', value: scope }, { tag: kind, value: 'yes' }];
  const offline = { uuid: uuid('t:offline'), expression: `nodata(${ref('iot.online')},{$IOT.NODATA})=1`, name: '{HOST.NAME}: sin conexión', priority: 'AVERAGE', description: 'El dispositivo dejó de reportar (sin radio, sin energía o deshabilitado).', tags: tg('iot', 'rootcause') };
  const dep = [{ name: offline.name, expression: offline.expression }];
  const items = [
    { uuid: uuid('online'), name: 'Conectado', type: 'TRAP', key: 'iot.online', value_type: 'UNSIGNED', valuemap: { name: 'IoT conectado' }, tags: [{ tag: 'component', value: 'salud' }], triggers: [offline] },
    {
      uuid: uuid('battery'), name: 'Batería', type: 'TRAP', key: 'iot.battery_pct', value_type: 'FLOAT', units: '%', tags: [{ tag: 'component', value: 'salud' }],
      triggers: [{ uuid: uuid('t:battery'), expression: `last(${ref('iot.battery_pct')})<{$IOT.BATTERY.MIN}`, name: '{HOST.NAME}: batería baja (< {$IOT.BATTERY.MIN}%)', priority: 'WARNING', dependencies: dep, tags: tg('iot', 'symptom') }],
    },
    {
      uuid: uuid('rssi'), name: 'Señal de radio (RSSI)', type: 'TRAP', key: 'iot.rssi_dbm', value_type: 'FLOAT', units: 'dBm', tags: [{ tag: 'component', value: 'salud' }],
      triggers: [{ uuid: uuid('t:rssi'), expression: `max(${ref('iot.rssi_dbm')},5m)<{$IOT.RSSI.MIN}`, name: '{HOST.NAME}: señal débil (< {$IOT.RSSI.MIN} dBm)', priority: 'WARNING', dependencies: dep, tags: tg('iot', 'symptom') }],
    },
    { uuid: uuid('uptime'), name: 'Tiempo encendido', type: 'TRAP', key: 'iot.uptime', value_type: 'UNSIGNED', units: 'uptime', tags: [{ tag: 'component', value: 'salud' }] },
  ];
  const doc = {
    zabbix_export: {
      version: '7.0',
      template_groups: [{ uuid: uuid('group'), name: GROUP }],
      templates: [{
        uuid: uuid('template'), template: T, name: T,
        description: 'Dispositivo IoT simulado de la planta aceitera (termometría, radar, caudalímetro, energía, gas, meteorología). Reporta por Zabbix sender; sus lecturas se descubren con LLD.',
        groups: [{ name: GROUP }],
        items,
        discovery_rules: [{
          uuid: uuid('lld'), name: 'Lecturas del dispositivo', type: 'TRAP', key: 'iot.metrics.discovery',
          item_prototypes: [{ uuid: uuid('proto'), name: '{#LABEL}', type: 'TRAP', key: 'iot.metric[{#METRIC}]', value_type: 'FLOAT', tags: [{ tag: 'component', value: 'lectura' }, { tag: 'metric', value: '{#METRIC}' }] }],
        }],
        tags: [{ tag: 'class', value: 'iot' }, { tag: 'target', value: 'planta-aceitera' }],
        macros: [
          ...SENDER_MACROS,
          ['{$IOT.NODATA}', '3m', 'Tiempo sin reportes antes de considerar el dispositivo sin conexión.'],
          ['{$IOT.BATTERY.MIN}', '15', 'Batería mínima (%).'],
          ['{$IOT.RSSI.MIN}', '-95', 'Señal mínima (dBm).'],
        ].map(([macro, value, description]) => ({ macro, value, description })),
        valuemaps: [{ uuid: uuid('vm:online'), name: 'IoT conectado', mappings: [{ value: '0', newvalue: 'Desconectado' }, { value: '1', newvalue: 'Conectado' }] }],
      }],
    },
  };
  return { doc, stats: { items: items.length, lld: 1, protos: 1 } };
}

mkdirSync(path.join(ROOT, 'zabbix'), { recursive: true });
for (const [file, make] of [
  ['template_planta_aceitera_sender.yaml', () => build('sender')],
  ['template_planta_aceitera.yaml', () => build('http')],
  ['template_planta_aceitera_iot.yaml', buildIot],
]) {
  const { doc, stats } = make();
  writeFileSync(path.join(ROOT, 'zabbix', file), yaml(doc) + '\n');
  console.log(`OK zabbix/${file} — ítems: ${stats.items}, reglas LLD: ${stats.lld}, prototipos: ${stats.protos}`);
}
