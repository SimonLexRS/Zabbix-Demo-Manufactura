// Generates zabbix/template_planta_aceitera.yaml (Zabbix 7.0 export format).
// Run: node tools/gen-zabbix-template.mjs
//
// One HTTP agent master item pulls /api/metrics every 30 s; every metric is a
// dependent item (JSONPath), and silos/tanks/boilers/stations come from LLD.
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const T = 'Planta Aceitera Demo by HTTP';
const GROUP = 'Templates/Manufacturing';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Stable UUIDv4-shaped ids derived from a seed, so regenerating doesn't churn.
const uuid = (seed) => {
  const h = createHash('md5').update(`planta:${seed}`).digest('hex').split('');
  h[12] = '4';
  h[16] = '89ab'[parseInt(h[16], 16) % 4];
  return h.join('');
};

// field, name, units, value type, component tag
const PLANT = [
  ['soy_stock_t', 'Stock de soya', 't', 'FLOAT', 'acopio'],
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

const ref = (key) => `/${T}/${key}`;
const PLANT_TRIGGERS = {
  steam_pressure_bar: [{ expression: `max(${ref('planta.steam_pressure_bar')},2m)<{$PLANTA.STEAM.MIN}`, name: 'Presión de vapor baja (< {$PLANTA.STEAM.MIN} bar)', priority: 'HIGH' }],
  lel_pct: [
    { expression: `last(${ref('planta.lel_pct')})>{$PLANTA.LEL.MAX}`, name: 'LEL de hexano sobre {$PLANTA.LEL.MAX}% en extracción', priority: 'DISASTER' },
    { expression: `last(${ref('planta.lel_pct')})>{$PLANTA.LEL.WARN}`, name: 'LEL de hexano elevado (> {$PLANTA.LEL.WARN}%)', priority: 'WARNING' },
  ],
  extractor_running: [{ expression: `last(${ref('planta.extractor_running')})=0`, name: 'Extractor detenido', priority: 'HIGH' }],
  crush_pct: [{ expression: `max(${ref('planta.crush_pct')},5m)<{$PLANTA.CRUSH.MIN}`, name: 'Molienda bajo {$PLANTA.CRUSH.MIN}% de capacidad por 5 min', priority: 'AVERAGE' }],
  hexane_stock_pct: [{ expression: `last(${ref('planta.hexane_stock_pct')})<{$PLANTA.HEXANE.MIN}`, name: 'Stock de hexano bajo (< {$PLANTA.HEXANE.MIN}%)', priority: 'WARNING' }],
  meal_residual_hexane_ppm: [{ expression: `min(${ref('planta.meal_residual_hexane_ppm')},5m)>{$PLANTA.MEAL.HEXANE.MAX}`, name: 'Hexano residual en harina > {$PLANTA.MEAL.HEXANE.MAX} ppm', priority: 'AVERAGE' }],
  oil_stock_pct: [{ expression: `last(${ref('planta.oil_stock_pct')})>{$PLANTA.OIL.MAX}`, name: 'Tanques de aceite sobre {$PLANTA.OIL.MAX}%', priority: 'WARNING' }],
  trucks_waiting_road: [{ expression: `last(${ref('planta.trucks_waiting_road')})>{$PLANTA.ROADQ.MAX}`, name: 'Cola de camiones en RN4 (> {$PLANTA.ROADQ.MAX})', priority: 'WARNING' }],
};

const tags = (component) => [{ tag: 'component', value: component }];
const dep = (key, jsonpath) => ({ type: 'DEPENDENT', key, delay: '0', preprocessing: [{ type: 'JSONPATH', parameters: [jsonpath] }], master_item: { key: 'planta.raw' } });

const items = [
  {
    uuid: uuid('raw'), name: 'Planta: datos crudos (/api/metrics)', type: 'HTTP_AGENT', key: 'planta.raw', delay: '{$PLANTA.INTERVAL}',
    history: '0', value_type: 'TEXT', trends: '0', url: '{$PLANTA.URL}/api/metrics', timeout: '10s',
    description: 'Ítem maestro: JSON completo del simulador. El resto de ítems son dependientes.',
    tags: tags('raw'),
  },
  {
    uuid: uuid('sim_minutes'), name: 'Planta: reloj de simulación', ...dep('planta.sim_minutes', '$.sim_minutes'), value_type: 'FLOAT', units: 'm',
    tags: tags('general'),
    triggers: [{ uuid: uuid('t:nodata'), expression: `nodata(${ref('planta.sim_minutes')},5m)=1`, name: 'Sin datos de la planta por 5 minutos', priority: 'AVERAGE', description: 'El endpoint /api/metrics no responde o el servidor está detenido.' }],
  },
  { uuid: uuid('speed'), name: 'Planta: velocidad de simulación', ...dep('planta.speed', '$.speed'), value_type: 'FLOAT', units: 'x', tags: tags('general') },
  ...PLANT.map(([field, name, units, vt, comp]) => {
    const it = { uuid: uuid(`plant:${field}`), name: `Planta: ${name}`, ...dep(`planta.${field}`, `$.plant.${field}`), value_type: vt, tags: tags(comp) };
    if (units) it.units = units;
    if (field === 'extractor_running') it.valuemap = { name: 'Estado de equipo' };
    const trg = PLANT_TRIGGERS[field];
    if (trg) it.triggers = trg.map((t) => ({ uuid: uuid(`t:${t.name}`), ...t, name: `Planta: ${t.name}` }));
    return it;
  }),
];

function lld(id, name, list, prototypes) {
  return {
    uuid: uuid(`lld:${id}`),
    name,
    type: 'DEPENDENT',
    key: `planta.${id}.discovery`,
    delay: '0',
    item_prototypes: prototypes.map(([field, pname, units, vt, trig, extra]) => {
      const key = `planta.${id.replace(/s$/, '')}.${field}[{#ID}]`;
      const it = {
        uuid: uuid(`proto:${id}:${field}`),
        name: `{#NAME}: ${pname}`,
        ...dep(key, `$.${list}['{#ID}'].${field}`),
        value_type: vt,
        tags: [{ tag: 'component', value: id }, { tag: id.replace(/s$/, ''), value: '{#ID}' }],
        ...(extra || {}),
      };
      if (units) it.units = units;
      if (trig) it.trigger_prototypes = trig.map((t) => ({ uuid: uuid(`tp:${id}:${field}:${t.name}`), ...t, expression: t.expression.replace('KEY', `${ref(key)}`) }));
      return it;
    }),
    master_item: { key: 'planta.raw' },
    preprocessing: [{ type: 'JSONPATH', parameters: [`$.discovery.${list}`] }],
  };
}

const discovery = [
  lld('silos', 'Silos y galpones graneleros', 'silos', [
    ['level_pct', 'Nivel', '%', 'FLOAT', [{ expression: 'last(KEY)>{$PLANTA.SILO.LEVEL.MAX}', name: '{#NAME}: casi lleno (> {$PLANTA.SILO.LEVEL.MAX}%)', priority: 'WARNING' }]],
    ['stock_t', 'Stock', 't', 'FLOAT'],
    ['capacity_t', 'Capacidad', 't', 'FLOAT'],
    ['temp_c', 'Temperatura de grano', '°C', 'FLOAT', [{ expression: 'last(KEY)>{$PLANTA.SILO.TEMP.MAX}', name: '{#NAME}: punto caliente (> {$PLANTA.SILO.TEMP.MAX} °C)', priority: 'HIGH' }]],
    ['humidity_pct', 'Humedad de grano', '%', 'FLOAT'],
  ]),
  lld('tanks', 'Tanques de aceite crudo', 'tanks', [
    ['level_pct', 'Nivel', '%', 'FLOAT', [{ expression: 'last(KEY)>{$PLANTA.TANK.LEVEL.MAX}', name: '{#NAME}: nivel alto (> {$PLANTA.TANK.LEVEL.MAX}%)', priority: 'WARNING' }]],
    ['stock_t', 'Stock', 't', 'FLOAT'],
    ['temp_c', 'Temperatura', '°C', 'FLOAT'],
  ]),
  lld('boilers', 'Calderas', 'boilers', [
    ['status', 'Estado', '', 'UNSIGNED', [{ expression: 'last(KEY)=0', name: '{#NAME}: fuera de servicio', priority: 'AVERAGE' }], { valuemap: { name: 'Estado de equipo' } }],
    ['load_pct', 'Carga', '%', 'FLOAT'],
    ['flue_temp_c', 'Temp. gases de chimenea', '°C', 'FLOAT'],
  ]),
  lld('stations', 'Puntos de operación (balanzas, calador, volcadoras, carga)', 'stations', [
    ['available', 'Disponible', '', 'UNSIGNED', [{ expression: 'max(KEY,2m)=0', name: '{#NAME}: fuera de servicio', priority: 'AVERAGE' }], { valuemap: { name: 'Estado de equipo' } }],
    ['busy', 'Camiones en uso', '', 'UNSIGNED'],
    ['operations_today', 'Operaciones hoy', '', 'UNSIGNED'],
  ]),
];

const macros = [
  ['{$PLANTA.URL}', 'http://planta-aceitera:8080', 'URL base del simulador (sin barra final).'],
  ['{$PLANTA.INTERVAL}', '30s', 'Intervalo de consulta del ítem maestro.'],
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
].map(([macro, value, description]) => ({ macro, value, description }));

const doc = {
  zabbix_export: {
    version: '7.0',
    template_groups: [{ uuid: uuid('group'), name: GROUP }],
    templates: [
      {
        uuid: uuid('template'),
        template: T,
        name: T,
        description: 'Monitoreo del gemelo digital de planta aceitera (acopio y molienda de soya). Fuente: https://github.com/SimonLexRS/Zabbix-Demo-Manufactura',
        groups: [{ name: GROUP }],
        items,
        discovery_rules: discovery,
        tags: [{ tag: 'class', value: 'manufacturing' }, { tag: 'target', value: 'planta-aceitera' }],
        macros,
        valuemaps: [{ uuid: uuid('vm:estado'), name: 'Estado de equipo', mappings: [{ value: '0', newvalue: 'Detenido / fuera de servicio' }, { value: '1', newvalue: 'En servicio' }] }],
      },
    ],
  },
};

// Minimal YAML emitter (all scalars single-quoted, so no escaping surprises).
function yaml(v, indent = 0) {
  const pad = ' '.repeat(indent);
  const scalar = (s) => `'${String(s).replace(/'/g, "''")}'`;
  if (Array.isArray(v)) {
    return v
      .map((x) => {
        if (x !== null && typeof x === 'object') {
          const inner = yaml(x, indent + 2).replace(/^\s+/, '');
          return `${pad}- ${inner}`;
        }
        return `${pad}- ${scalar(x)}`;
      })
      .join('\n');
  }
  return Object.entries(v)
    .filter(([, x]) => x !== undefined)
    .map(([k, x]) => {
      if (x !== null && typeof x === 'object') return `${pad}${k}:\n${yaml(x, indent + 2)}`;
      return `${pad}${k}: ${scalar(x)}`;
    })
    .join('\n');
}

mkdirSync(path.join(ROOT, 'zabbix'), { recursive: true });
const out = path.join(ROOT, 'zabbix', 'template_planta_aceitera.yaml');
writeFileSync(out, yaml(doc) + '\n');
const protos = discovery.reduce((a, d) => a + d.item_prototypes.length, 0);
console.log(`OK ${out}\n  ítems: ${items.length}, reglas LLD: ${discovery.length}, prototipos: ${protos}`);
