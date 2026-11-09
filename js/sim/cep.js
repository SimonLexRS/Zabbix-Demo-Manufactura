// Complex Event Processing (CEP): correlates problems and metrics inside a time
// window into a single composite event ("root cause"), sent to Zabbix as
// planta.cep.active[<rule>] (0 = inactive, 1..5 = severity) + planta.cep.last_event.
//
// Condition shapes:
//   { type: 'problem', id }                         problem point active (manual or random)
//   { type: 'metric', key, op: '>'|'<'|'=', value } any Zabbix key the app sends
//   { type: 'any', of: [conditions] }               OR group
// Rule: { id, name, desc, enabled, logic: 'AND'|'OR', windowMin, sev (0..4), conditions }
// AND rules fire when every condition was true at some point in the last windowMin
// simulated minutes and at least one is still true; OR rules fire while any is true.

import { PROBLEMS } from './problems.js';

export const DEFAULT_RULES = [
  {
    id: 'red_balanza', name: 'Causa raíz: red de balanza de ingreso', sev: 3, logic: 'AND', windowMin: 5, enabled: true,
    desc: 'La caída de red en la balanza deja camiones detenidos sobre ella.',
    conditions: [{ type: 'problem', id: 'bal_in_net' }, { type: 'metric', key: 'planta.station.trucks_stopped[BAL_IN]', op: '>', value: 0 }],
  },
  {
    id: 'vapor_molienda', name: 'Pérdida de vapor afecta la molienda', sev: 3, logic: 'AND', windowMin: 15, enabled: true,
    desc: 'Caldera fuera de servicio + presión de vapor baja + molienda bajo 70 %.',
    conditions: [
      { type: 'any', of: [{ type: 'problem', id: 'boiler_B1' }, { type: 'problem', id: 'boiler_B2' }] },
      { type: 'metric', key: 'planta.steam_pressure_bar', op: '<', value: 8 },
      { type: 'metric', key: 'planta.crush_pct', op: '<', value: 70 },
    ],
  },
  {
    id: 'seguridad_ext', name: 'Riesgo de seguridad en extracción', sev: 4, logic: 'AND', windowMin: 10, enabled: true,
    desc: 'LEL de hexano sobre 12 % con el extractor detenido o el PLC sin comunicación.',
    conditions: [
      { type: 'metric', key: 'planta.lel_pct', op: '>', value: 12 },
      { type: 'any', of: [{ type: 'metric', key: 'planta.extractor_running', op: '=', value: 0 }, { type: 'problem', id: 'plc_ext_comm' }] },
    ],
  },
  {
    id: 'cuello_recepcion', name: 'Cuello de botella en recepción', sev: 2, logic: 'AND', windowMin: 30, enabled: true,
    desc: 'Equipo de recepción fuera de servicio y cola de camiones en RN4.',
    conditions: [
      { type: 'any', of: ['noria_N1', 'noria_N2', 'bal_in_net', 'bal_out_net', 'gate_net', 'samp_fault'].map((id) => ({ type: 'problem', id })) },
      { type: 'metric', key: 'planta.trucks_waiting_road', op: '>', value: 4 },
    ],
  },
  {
    id: 'calidad_grano', name: 'Riesgo de calidad de grano en Silo 2', sev: 3, logic: 'AND', windowMin: 60, enabled: true,
    desc: 'Temperatura de grano sobre 32 °C con humedad sobre 12 %.',
    conditions: [
      { type: 'metric', key: 'planta.silo.temp_c[S2]', op: '>', value: 32 },
      { type: 'metric', key: 'planta.silo.humidity_pct[S2]', op: '>', value: 12 },
    ],
  },
];

// Metrics offered in the rule editor (any sender key also works through the API).
export const CEP_METRICS = [
  ['planta.steam_pressure_bar', 'Presión de vapor (bar)'],
  ['planta.crush_pct', 'Molienda (% capacidad)'],
  ['planta.lel_pct', 'LEL hexano (%)'],
  ['planta.extractor_running', 'Extractor en marcha (0/1)'],
  ['planta.trucks_waiting_road', 'Camiones en RN4'],
  ['planta.trucks_waiting_yard', 'Camiones en playa'],
  ['planta.oil_stock_pct', 'Tanques de aceite (%)'],
  ['planta.meal_stock_pct', 'Galpón de harina (%)'],
  ['planta.hexane_stock_pct', 'Tanque de hexano (%)'],
  ['planta.meal_residual_hexane_ppm', 'Hexano residual en harina (ppm)'],
  ['planta.soy_stock_pct', 'Ocupación de acopio (%)'],
  ['planta.station.trucks_stopped[BAL_IN]', 'Camiones detenidos en balanza de ingreso'],
  ['planta.station.trucks_stopped[BAL_OUT]', 'Camiones detenidos en balanza de salida'],
  ['planta.station.available[H1]', 'Tolva 1 disponible (0/1)'],
  ['planta.station.available[H2]', 'Tolva 2 disponible (0/1)'],
  ['planta.boiler.status[B1]', 'Caldera 1 en servicio (0/1)'],
  ['planta.boiler.status[B2]', 'Caldera 2 en servicio (0/1)'],
  ...['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'].map((s) => [`planta.silo.temp_c[${s}]`, `Temperatura grano ${s} (°C)`]),
];

const PROBLEM_IDS = new Set(PROBLEMS.map((p) => p.id));
const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);

function validCondition(c, depth = 0) {
  if (!c || typeof c !== 'object' || depth > 2) return null;
  if (c.type === 'problem' && PROBLEM_IDS.has(c.id)) return { type: 'problem', id: c.id };
  if (c.type === 'metric' && typeof c.key === 'string' && /^planta\.[\w.[\]]+$/.test(c.key) && ['>', '<', '='].includes(c.op) && Number.isFinite(Number(c.value)))
    return { type: 'metric', key: c.key, op: c.op, value: Number(c.value) };
  if (c.type === 'any' && Array.isArray(c.of)) {
    const of = c.of.map((x) => validCondition(x, depth + 1)).filter(Boolean).slice(0, 8);
    return of.length ? { type: 'any', of } : null;
  }
  return null;
}

// Sanitises rules coming from the config API.
export function validateRules(rules) {
  if (!Array.isArray(rules)) return null;
  const seen = new Set();
  const out = [];
  for (const r of rules.slice(0, 30)) {
    const id = slug(r.id || r.name);
    if (!id || seen.has(id)) continue;
    const conditions = (r.conditions || []).map((c) => validCondition(c)).filter(Boolean).slice(0, 6);
    if (!conditions.length) continue;
    seen.add(id);
    out.push({
      id,
      name: String(r.name || id).slice(0, 80),
      desc: String(r.desc || '').slice(0, 200),
      enabled: r.enabled !== false,
      logic: r.logic === 'OR' ? 'OR' : 'AND',
      windowMin: Math.max(1, Math.min(1440, Number(r.windowMin) || 5)),
      sev: Math.max(0, Math.min(4, Math.round(Number(r.sev) || 0))),
      conditions,
    });
  }
  return out;
}

export function describeCondition(c) {
  if (c.type === 'problem') return `falla «${PROBLEMS.find((p) => p.id === c.id)?.name ?? c.id}»`;
  if (c.type === 'metric') return `${c.key} ${c.op} ${c.value}`;
  if (c.type === 'any') return `(${c.of.map(describeCondition).join(' o ')})`;
  return '?';
}

export class CepEngine {
  constructor(rules = DEFAULT_RULES) {
    this.enabled = true;
    this.setRules(rules);
    this.lastEvent = null;
  }

  setRules(rules) {
    const valid = validateRules(rules) ?? DEFAULT_RULES;
    const prev = this.state || {};
    this.rules = valid;
    this.state = Object.fromEntries(valid.map((r) => [r.id, prev[r.id] && prev[r.id].n === r.conditions.length ? prev[r.id] : { n: r.conditions.length, lastTrue: [], active: false, since: null, fired: 0 }]));
  }

  test(c, facts) {
    if (c.type === 'problem') return facts.problems.has(c.id);
    if (c.type === 'metric') {
      const v = facts.metrics[c.key];
      if (v === undefined) return false;
      return c.op === '>' ? v > c.value : c.op === '<' ? v < c.value : v === c.value;
    }
    if (c.type === 'any') return c.of.some((x) => this.test(x, facts));
    return false;
  }

  // facts: { t, problems: Set<id>, metrics: { key: number } }
  evaluate(sim, facts) {
    for (const r of this.rules) {
      const st = this.state[r.id];
      let active = false;
      if (this.enabled && r.enabled) {
        const now = r.conditions.map((c) => this.test(c, facts));
        now.forEach((ok, i) => ok && (st.lastTrue[i] = facts.t));
        this.lastT = facts.t;
        active = r.logic === 'OR' ? now.some(Boolean) : now.some(Boolean) && r.conditions.every((_, i) => st.lastTrue[i] !== undefined && facts.t - st.lastTrue[i] <= r.windowMin);
      }
      if (active && !st.active) {
        st.active = true;
        st.since = facts.t;
        st.fired++;
        const text = `CEP: ${r.name}`;
        this.lastEvent = { t: facts.t, rule: r.id, text };
        sim.log(r.sev, text, 'CEP', 'cep');
      } else if (!active && st.active) {
        st.active = false;
        sim.log(0, `CEP resuelto: ${r.name} (${Math.round(facts.t - st.since)} min)`, 'CEP', 'resuelto');
        st.since = null;
      }
    }
  }

  senderItems(clockLabel) {
    const out = this.rules.map((r) => ({ key: `planta.cep.active[${r.id}]`, value: this.state[r.id].active ? r.sev + 1 : 0 }));
    out.push({ key: 'planta.cep.active_count', value: this.rules.filter((r) => this.state[r.id].active).length });
    if (this.lastEvent) out.push({ key: 'planta.cep.last_event', value: `${clockLabel(this.lastEvent.t)} · ${this.lastEvent.text}` });
    return out;
  }

  discovery() {
    return this.rules.map((r) => ({ '{#RULE}': r.id, '{#NAME}': r.name }));
  }

  summary(clockLabel) {
    return {
      enabled: this.enabled,
      lastEvent: this.lastEvent ? { ...this.lastEvent, time: clockLabel(this.lastEvent.t) } : null,
      rules: this.rules.map((r) => ({ ...r, active: this.state[r.id].active, fired: this.state[r.id].fired, sinceMin: this.state[r.id].since !== null ? Math.round(this.lastT - this.state[r.id].since) : null, text: r.conditions.map(describeCondition).join(r.logic === 'OR' ? ' o ' : ' y ') })),
    };
  }
}
