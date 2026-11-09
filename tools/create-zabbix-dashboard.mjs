// Creates or updates the Zabbix dashboard "Planta Aceitera · Estado y CEP" (2 pages:
// plant status and CEP / correlation) for the plant host provisioned by the app.
//
//   ZABBIX_URL=https://zabbix.example.com ZABBIX_API_TOKEN=... node tools/create-zabbix-dashboard.mjs
//   optional: ZABBIX_HOST (default "Planta Aceitera"), ZABBIX_HOST_GROUP (default "Manufactura")
const Z = `${(process.env.ZABBIX_URL || '').replace(/\/$/, '')}/api_jsonrpc.php`;
const T = process.env.ZABBIX_API_TOKEN;
if (!process.env.ZABBIX_URL || !T) {
  console.error('Define ZABBIX_URL y ZABBIX_API_TOKEN');
  process.exit(1);
}
const rpc = async (method, params) => {
  const r = await fetch(Z, { method: 'POST', headers: { 'Content-Type': 'application/json-rpc', Authorization: `Bearer ${T}` }, body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message} ${j.error.data}`);
  return j.result;
};
const HOST = process.env.ZABBIX_HOST || 'Planta Aceitera';
const [host] = await rpc('host.get', { filter: { host: [HOST] }, output: ['hostid'] });
const [grp] = await rpc('hostgroup.get', { filter: { name: [process.env.ZABBIX_HOST_GROUP || 'Manufactura'] }, output: ['groupid'] });
const items = await rpc('item.get', { hostids: [host.hostid], output: ['itemid', 'key_'] });
const id = (k) => {
  const i = items.find((x) => x.key_ === k);
  if (!i) throw new Error(`falta ítem ${k}`);
  return i.itemid;
};
let refN = 0;
const ref = () => `PLA${String.fromCharCode(65 + Math.floor(refN / 26))}${String.fromCharCode(65 + (refN++ % 26))}`;
const f = (type, name, value) => ({ type, name, value: String(value) });
const I = (type, name, value) => ({ type, name, value });

// Item value tile with thresholds [[value, color], …].
const tile = (x, y, w, h, key, desc, { dec = 1, th = [] } = {}) => ({
  type: 'item', name: desc, x, y, width: w, height: h, view_mode: 0,
  fields: [I(4, 'itemid.0', id(key)), f(1, 'description', desc), f(0, 'show.0', 1), f(0, 'show.1', 2), f(0, 'show.2', 4), f(0, 'decimal_places', dec), f(0, 'desc_size', 12), f(0, 'value_size', 40),
    ...th.flatMap(([v, c], i) => [f(1, `thresholds.${i}.threshold`, v), f(1, `thresholds.${i}.color`, c)])],
});
const gauge = (x, y, w, h, key, desc, min, max, th) => ({
  type: 'gauge', name: desc, x, y, width: w, height: h,
  fields: [I(4, 'itemid.0', id(key)), f(1, 'min', min), f(1, 'max', max), f(0, 'angle', 270), f(1, 'description', desc), f(0, 'show.0', 1), f(0, 'show.1', 2), f(0, 'show.2', 3), f(0, 'show.3', 4), f(0, 'show.4', 5),
    ...th.flatMap(([v, c], i) => [f(1, `thresholds.${i}.threshold`, v), f(1, `thresholds.${i}.color`, c)])],
});
// SVG graph: datasets [{items:[name pattern], color, axis(0 left/1 right), fill}]
const graph = (x, y, w, h, title, sets, { problems = false } = {}) => ({
  type: 'svggraph', name: title, x, y, width: w, height: h,
  fields: [
    ...sets.flatMap((s, i) => [f(1, `ds.${i}.hosts.0`, HOST), ...s.items.map((it, k) => f(1, `ds.${i}.items.${k}`, it)), f(1, `ds.${i}.color`, s.color), f(0, `ds.${i}.type`, 0), f(0, `ds.${i}.width`, 2), f(0, `ds.${i}.fill`, s.fill ?? 1), f(0, `ds.${i}.axisy`, s.axis ?? 0), f(0, `ds.${i}.transparency`, 3)]),
    f(0, 'legend', 1), f(0, 'show_problems', problems ? 1 : 0), ...(problems ? [f(1, 'problemhosts.0', HOST)] : []), f(1, 'reference', ref()),
  ],
});
const problems = (x, y, w, h, title, tags = [], { show = 3 } = {}) => ({
  type: 'problems', name: title, x, y, width: w, height: h,
  fields: [I(3, 'hostids.0', host.hostid), f(0, 'show', show), f(0, 'show_tags', 3), f(0, 'show_lines', 12), f(0, 'show_opdata', 1), f(0, 'highlight_row', 1),
    ...tags.flatMap(([tag, value], i) => [f(1, `tags.${i}.tag`, tag), f(0, `tags.${i}.operator`, 1), f(1, `tags.${i}.value`, value)]), f(1, 'reference', ref())],
});
const bySeverity = (x, y, w, h) => ({ type: 'problemsbysv', name: 'Problemas por severidad', x, y, width: w, height: h, fields: [I(2, 'groupids.0', grp.groupid), f(0, 'show_type', 1), f(0, 'layout', 1), f(1, 'reference', ref())] });

const RED = 'E45959', ORANGE = 'FFA059', YELLOW = 'FFC859', GREEN = '59DB8F', BLUE = '7499FF', CYAN = '3EE6FF', GRAY = '97AAB3';

const page1 = {
  name: 'Estado de planta',
  widgets: [
    tile(0, 0, 9, 3, 'planta.crush_pct', 'Molienda (% capacidad)', { th: [[0, RED], [70, YELLOW], [90, GREEN]] }),
    tile(9, 0, 9, 3, 'planta.steam_pressure_bar', 'Presión de vapor', { th: [[0, RED], [8, GREEN]] }),
    tile(18, 0, 9, 3, 'planta.lel_pct', 'LEL hexano', { th: [[0, GREEN], [12, YELLOW], [25, RED]] }),
    tile(27, 0, 9, 3, 'planta.soy_stock_pct', 'Acopio de soya', { th: [[0, GREEN], [92, YELLOW]] }),
    tile(36, 0, 9, 3, 'planta.oil_stock_pct', 'Tanques de aceite', { th: [[0, GREEN], [90, YELLOW]] }),
    tile(45, 0, 9, 3, 'planta.meal_stock_pct', 'Galpón de harina', { th: [[0, GREEN], [90, YELLOW]] }),
    tile(54, 0, 9, 3, 'planta.trucks_in_plant', 'Camiones en planta', { dec: 0 }),
    tile(63, 0, 9, 3, 'planta.wo_open', 'Órdenes de trabajo abiertas', { dec: 0, th: [[0, GREEN], [1, YELLOW], [3, RED]] }),
    gauge(0, 3, 12, 5, 'planta.steam_pressure_bar', 'Vapor (bar)', 0, 12, [[0, RED], [8, GREEN]]),
    gauge(12, 3, 12, 5, 'planta.crush_pct', 'Molienda (%)', 0, 110, [[0, RED], [70, YELLOW], [90, GREEN]]),
    gauge(24, 3, 12, 5, 'planta.lel_pct', 'LEL hexano (%)', 0, 40, [[0, GREEN], [12, YELLOW], [25, RED]]),
    problems(36, 3, 36, 5, 'Problemas activos de la planta'),
    graph(0, 8, 24, 5, 'Molienda y vapor', [{ items: ['Planta: Tasa de molienda'], color: CYAN }, { items: ['Planta: Presión de vapor'], color: ORANGE, axis: 1, fill: 0 }], { problems: true }),
    graph(24, 8, 24, 5, 'Nivel de silos y galpones', [{ items: ['*: Nivel'], color: BLUE, fill: 0 }]),
    graph(48, 8, 24, 5, 'Stocks de soya, aceite y harina (%)', [{ items: ['Planta: Ocupación de acopio'], color: YELLOW, fill: 0 }, { items: ['Planta: Ocupación tanques de aceite'], color: ORANGE, fill: 0 }, { items: ['Planta: Ocupación galpón de harina'], color: GRAY, fill: 0 }]),
    tile(0, 13, 8, 3, 'planta.soy_received_today_t', 'Soya recibida hoy (t)', { dec: 0 }),
    tile(8, 13, 8, 3, 'planta.crushed_today_t', 'Soya molida hoy (t)', { dec: 0 }),
    tile(16, 13, 8, 3, 'planta.traffic_avg_speed_kmh', 'Velocidad media (km/h)', { dec: 1 }),
    tile(24, 13, 8, 3, 'planta.traffic_vehicles_stopped', 'Vehículos detenidos', { dec: 0, th: [[0, GREEN], [2, YELLOW], [4, RED]] }),
    tile(32, 13, 8, 3, 'planta.traffic_collisions_today', 'Colisiones hoy', { dec: 0, th: [[0, GREEN], [1, RED]] }),
    tile(40, 13, 8, 3, 'planta.traffic_near_misses_today', 'Casi accidentes hoy', { dec: 0, th: [[0, GREEN], [1, YELLOW], [3, RED]] }),
    tile(48, 13, 8, 3, 'planta.wo_mttr_min', 'MTTR (min)', { dec: 0 }),
    tile(56, 13, 8, 3, 'planta.wo_response_min', 'Respuesta técnicos (min)', { dec: 0 }),
    tile(64, 13, 8, 3, 'planta.staff_escalations_today', 'Escalamientos a gerencia', { dec: 0, th: [[0, GREEN], [1, YELLOW], [3, RED]] }),
  ],
};

const page2 = {
  name: 'CEP y correlación',
  widgets: [
    tile(0, 0, 12, 3, 'planta.cep.active_count', 'Reglas CEP activas', { dec: 0, th: [[0, GREEN], [1, ORANGE], [3, RED]] }),
    tile(12, 0, 36, 3, 'planta.cep.last_event', 'Último evento compuesto (CEP)', { dec: 0 }),
    tile(48, 0, 12, 3, 'planta.problems_active', 'Problemas activos (simulador)', { dec: 0, th: [[0, GREEN], [1, YELLOW], [4, RED]] }),
    tile(60, 0, 12, 3, 'planta.wo_open', 'OT abiertas', { dec: 0, th: [[0, GREEN], [1, YELLOW], [3, RED]] }),
    problems(0, 3, 36, 6, 'Eventos compuestos CEP', [['scope', 'cep']], { show: 2 }),
    problems(36, 3, 36, 6, 'Causas raíz (rootcause = yes)', [['rootcause', 'yes']], { show: 2 }),
    graph(0, 9, 36, 5, 'Reglas CEP en el tiempo (0 inactiva · 1–5 severidad)', [{ items: ['CEP: *'], color: CYAN, fill: 0 }]),
    bySeverity(36, 9, 18, 5),
    graph(54, 9, 18, 5, 'Órdenes de trabajo', [{ items: ['Planta: Mantenimiento: órdenes de trabajo abiertas'], color: ORANGE, fill: 2 }, { items: ['Planta: Personal: técnicos ocupados'], color: GREEN, fill: 0 }]),
    graph(0, 14, 36, 4, 'Tránsito interno', [{ items: ['Planta: Tránsito: vehículos detenidos en vías'], color: RED, fill: 2 }, { items: ['Planta: Tránsito: velocidad media'], color: BLUE, axis: 1, fill: 0 }], { problems: true }),
    problems(36, 14, 36, 4, 'Síntomas (symptom = yes)', [['symptom', 'yes']], { show: 2 }),
  ],
};

const name = 'Planta Aceitera · Estado y CEP';
const [existing] = await rpc('dashboard.get', { filter: { name: [name] }, output: ['dashboardid'] });
const body = { name, display_period: 60, auto_start: 0, pages: [page1, page2] };
const res = existing ? await rpc('dashboard.update', { dashboardid: existing.dashboardid, ...body }) : await rpc('dashboard.create', body);
console.log(existing ? 'actualizado' : 'creado', JSON.stringify(res));
