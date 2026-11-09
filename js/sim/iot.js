// Simulated IoT field devices. Each one becomes its own Zabbix host and reports
// through Zabbix sender: health items (online, battery, RSSI, uptime) plus the
// readings it measures, derived from the live plant state with sensor noise.

const r = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// metrics: [key, name, units, decimals]
const THERMO = [
  ['temp_avg_c', 'Temperatura media', '°C', 1],
  ['temp_max_c', 'Temperatura máxima', '°C', 1],
  ['humidity_pct', 'Humedad de grano', '%', 1],
];
const RADAR = [
  ['level_pct', 'Nivel', '%', 1],
  ['level_m', 'Altura de producto', 'm', 2],
  ['temp_c', 'Temperatura de producto', '°C', 1],
];

export const IOT_DEVICES = [
  ...['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'].map((s) => ({ id: `term-${s.toLowerCase()}`, name: `Termometría Silo ${s.slice(1)}`, type: 'Termometría (cables)', asset: s, interval: 30, metrics: THERMO })),
  ...['TA1', 'TA2', 'TA3'].map((t) => ({ id: `radar-${t.toLowerCase()}`, name: `Radar de nivel ${t}`, type: 'Radar de nivel 80 GHz', asset: t, interval: 20, metrics: RADAR })),
  { id: 'flow-oil', name: 'Caudalímetro de aceite crudo', type: 'Caudalímetro Coriolis', asset: 'EXT', interval: 10, metrics: [['flow_tph', 'Caudal', 't/h', 2], ['totalizer_t', 'Totalizador', 't', 1], ['density_kgm3', 'Densidad', 'kg/m³', 1]] },
  { id: 'pwr-prep', name: 'Medidor de energía Preparación', type: 'Medidor de energía', asset: 'PREP', interval: 15, metrics: [['power_kw', 'Potencia activa', 'kW', 0], ['energy_kwh', 'Energía acumulada', 'kWh', 0], ['pf', 'Factor de potencia', '', 2]] },
  { id: 'pwr-sf', name: 'Medidor de energía Sala de fuerza', type: 'Medidor de energía', asset: 'SF', interval: 15, metrics: [['power_kw', 'Potencia activa', 'kW', 0], ['energy_kwh', 'Energía acumulada', 'kWh', 0], ['pf', 'Factor de potencia', '', 2]] },
  { id: 'gas-ext', name: 'Detector de gas Extracción', type: 'Detector LEL / O₂', asset: 'EXT', interval: 10, metrics: [['lel_pct', 'LEL hexano', '%', 1], ['o2_pct', 'Oxígeno', '%', 1]] },
  { id: 'wx-01', name: 'Estación meteorológica', type: 'Estación meteorológica', asset: 'OFI', interval: 60, metrics: [['temp_c', 'Temperatura ambiente', '°C', 1], ['humidity_pct', 'Humedad relativa', '%', 0], ['wind_kmh', 'Viento', 'km/h', 0], ['rain_mm', 'Lluvia (hoy)', 'mm', 1]] },
];

export const IOT_BY_ID = Object.fromEntries(IOT_DEVICES.map((d) => [d.id, d]));

export class IoTFleet {
  constructor() {
    this.state = Object.fromEntries(
      IOT_DEVICES.map((d) => [
        d.id,
        { enabled: true, interval: d.interval, noise: 1, offline: false, lowBattery: false, battery: r(55, 100), rssi: r(-82, -58), uptime: Math.floor(r(1e5, 2e6)), acc: {}, randomUntil: null },
      ]),
    );
    this.enabled = true;
    this.randomDropouts = true;
  }

  // Apply persisted config: { enabled, randomDropouts, devices: { id: {enabled, interval, noise, offline, lowBattery} } }
  configure(cfg = {}) {
    if (cfg.enabled !== undefined) this.enabled = !!cfg.enabled;
    if (cfg.randomDropouts !== undefined) this.randomDropouts = !!cfg.randomDropouts;
    for (const [id, c] of Object.entries(cfg.devices || {})) {
      const s = this.state[id];
      if (!s) continue;
      if (c.enabled !== undefined) s.enabled = !!c.enabled;
      if (c.interval !== undefined) s.interval = clamp(Number(c.interval) || 10, 5, 3600);
      if (c.noise !== undefined) s.noise = clamp(Number(c.noise) || 0, 0, 20);
      if (c.offline !== undefined) s.offline = !!c.offline;
      if (c.lowBattery !== undefined) {
        s.lowBattery = !!c.lowBattery;
        if (!s.lowBattery && s.battery < 20) s.battery = r(70, 100);
      }
    }
  }

  // Advance device health (dt in simulated minutes).
  step(sim, dt) {
    for (const d of IOT_DEVICES) {
      const s = this.state[d.id];
      s.uptime += dt * 60;
      s.battery = s.lowBattery ? Math.max(3, Math.min(s.battery, 9) - dt * 0.01) : Math.max(5, s.battery - dt * 0.0015);
      s.rssi = clamp(s.rssi + r(-0.6, 0.6) * Math.min(1, dt), -105, -45);
      if (s.randomUntil && sim.t >= s.randomUntil) {
        s.randomUntil = null;
        sim.log(0, `IoT: ${d.name} volvió a reportar`, d.asset, 'mantenimiento');
      }
    }
    // Random radio dropouts (when random faults are on).
    if (this.enabled && this.randomDropouts && sim.randomFaults && Math.random() < dt / 300) {
      const cands = IOT_DEVICES.filter((d) => this.state[d.id].enabled && !this.isOffline(d.id));
      if (cands.length) {
        const d = cands[Math.floor(Math.random() * cands.length)];
        this.state[d.id].randomUntil = sim.t + r(15, 60);
        sim.log(1, `IoT: ${d.name} sin conexión (falla aleatoria de radio)`, d.asset, 'falla');
      }
    }
  }

  isOffline(id) {
    const s = this.state[id];
    return s.offline || !!s.randomUntil;
  }

  // Readings for one device from the plant state.
  readings(sim, d) {
    const s = this.state[d.id];
    const n = (v, scale = 1) => v + (Math.random() - 0.5) * 2 * (s.noise / 100) * scale;
    const hour = (sim.t % 1440) / 60;
    let v = {};
    if (d.id.startsWith('term-')) {
      const st = sim.storages.find((x) => x.id === d.asset);
      const hot = sim.hasFault('silo_hotspot', d.asset);
      v = { temp_avg_c: n(st.temp, st.temp), temp_max_c: n(st.temp + (hot ? 4.5 : 1.6), st.temp), humidity_pct: n(st.hum, st.hum) };
    } else if (d.id.startsWith('radar-')) {
      const t = sim.tanks.find((x) => x.id === d.asset);
      const pct = (t.stock / t.cap) * 100;
      v = { level_pct: clamp(n(pct, 5), 0, 100), level_m: clamp(n((pct / 100) * 22.5, 1), 0, 22.5), temp_c: n(t.temp, t.temp) };
    } else if (d.id === 'flow-oil') {
      v = { flow_tph: Math.max(0, n(sim.proc.oilRate, Math.max(1, sim.proc.oilRate))), totalizer_t: 18250 + sim.counters.oilT, density_kgm3: n(918, 20) };
    } else if (d.id === 'pwr-prep') {
      const kw = sim.hasFault('prep_power') ? 0 : sim.proc.power * 620;
      s.acc.kwh = (s.acc.kwh ?? 4.8e6) + (kw * (sim.t - (s.acc.t ?? sim.t))) / 60;
      s.acc.t = sim.t;
      v = { power_kw: Math.max(0, n(kw, kw)), energy_kwh: s.acc.kwh, pf: kw > 0 ? clamp(n(0.91, 1), 0.7, 1) : 0 };
    } else if (d.id === 'pwr-sf') {
      const kw = 180 + sim.boilers.reduce((a, b) => a + (b.on ? b.load * 4.2 : 0), 0);
      s.acc.kwh = (s.acc.kwh ?? 2.1e6) + (kw * (sim.t - (s.acc.t ?? sim.t))) / 60;
      s.acc.t = sim.t;
      v = { power_kw: n(kw, kw), energy_kwh: s.acc.kwh, pf: clamp(n(0.88, 1), 0.7, 1) };
    } else if (d.id === 'gas-ext') {
      v = { lel_pct: Math.max(0, n(sim.proc.lel, Math.max(2, sim.proc.lel))), o2_pct: n(20.9 - sim.proc.lel * 0.04, 2) };
    } else if (d.id === 'wx-01') {
      v = { temp_c: n(27 + 6 * Math.sin(((hour - 9) / 24) * Math.PI * 2), 30), humidity_pct: clamp(n(68 - 15 * Math.sin(((hour - 9) / 24) * Math.PI * 2), 70), 20, 100), wind_kmh: Math.max(0, n(12 + 6 * Math.sin(sim.t / 97), 15)), rain_mm: 0 };
    }
    const out = {};
    for (const [k, , , dec] of d.metrics) out[k] = Number((v[k] ?? 0).toFixed(dec));
    return out;
  }

  // Sender payload for the given device ids: [{host, key, value}] (offline devices send nothing).
  senderItems(sim, ids, hostPrefix = 'iot-') {
    const out = [];
    for (const id of ids) {
      const d = IOT_BY_ID[id];
      const s = this.state[id];
      if (!d || !s.enabled || this.isOffline(id)) continue;
      const host = `${hostPrefix}${d.id}`;
      out.push(
        { host, key: 'iot.online', value: 1 },
        { host, key: 'iot.battery_pct', value: Number(s.battery.toFixed(1)) },
        { host, key: 'iot.rssi_dbm', value: Math.round(s.rssi) },
        { host, key: 'iot.uptime', value: Math.floor(s.uptime) },
      );
      for (const [k, v] of Object.entries(this.readings(sim, d))) out.push({ host, key: `iot.metric[${k}]`, value: v });
    }
    return out;
  }

  discoveryItems(ids, hostPrefix = 'iot-') {
    return ids
      .filter((id) => this.state[id]?.enabled)
      .map((id) => {
        const d = IOT_BY_ID[id];
        return { host: `${hostPrefix}${d.id}`, key: 'iot.metrics.discovery', value: JSON.stringify(d.metrics.map(([m, name, units]) => ({ '{#METRIC}': m, '{#NAME}': name, '{#UNITS}': units, '{#LABEL}': units ? `${name} (${units})` : name }))) };
      });
  }

  // For the UI/config panel.
  summary(sim) {
    return IOT_DEVICES.map((d) => {
      const s = this.state[d.id];
      return {
        id: d.id, name: d.name, type: d.type, asset: d.asset, enabled: s.enabled, interval: s.interval, noise: s.noise,
        offline: s.offline, randomOffline: !!s.randomUntil, lowBattery: s.lowBattery, online: s.enabled && !this.isOffline(d.id),
        battery: Math.round(s.battery), rssi: Math.round(s.rssi), readings: s.enabled ? this.readings(sim, d) : {},
      };
    });
  }

  config() {
    return {
      enabled: this.enabled,
      randomDropouts: this.randomDropouts,
      devices: Object.fromEntries(Object.entries(this.state).map(([id, s]) => [id, { enabled: s.enabled, interval: s.interval, noise: s.noise, offline: s.offline, lowBattery: s.lowBattery }])),
    };
  }
}
