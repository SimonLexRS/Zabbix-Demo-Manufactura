// Catalog of problem points that can be switched on/off by hand (they stay
// active until switched off) or fired by the random fault generator (they
// resolve on their own). Each one has a physical effect in the simulation and
// is reported to Zabbix as planta.problem[<id>] (0 normal, 1 manual, 2 aleatorio).
//
// effect.type is what Simulation.hasFault() looks for:
//   station_down  → the station stops: the truck on it is frozen, nobody else enters
//   boiler_trip   → boiler out of service (less steam → reduced crushing)
//   hexane_lel    → LEL rises in extraction, safety interlock stops the extractor
//   noria_jam     → bucket elevator jammed: its hopper is out of service
//   silo_hotspot  → grain temperature rises in that silo
//   prep_power    → preparation MCC tripped: crushing stops
//   plc_comm      → PLC data lost: extraction items stop being sent (nodata in Zabbix)
//   jam           → a truck breaks down on a road and blocks it (traffic jam behind it)

export const PROBLEMS = [
  { id: 'bal_in_net', name: 'Caída de red en balanza de ingreso', desc: 'El camión queda detenido sobre la balanza y no ingresa nadie más.', sev: 3, src: 'BAL_IN', effect: { type: 'station_down', target: 'BAL_IN' } },
  { id: 'bal_out_net', name: 'Caída de red en balanza de salida', desc: 'Camiones detenidos en tara; las volcadoras se llenan.', sev: 3, src: 'BAL_OUT', effect: { type: 'station_down', target: 'BAL_OUT' } },
  { id: 'gate_net', name: 'Portería sin sistema de control', desc: 'No se autoriza el ingreso: cola de camiones en RN4.', sev: 2, src: 'GATE', effect: { type: 'station_down', target: 'GATE' } },
  { id: 'samp_fault', name: 'Calador automático fuera de servicio', desc: 'No se muestrea: la playa de espera se llena.', sev: 2, src: 'SAMP', effect: { type: 'station_down', target: 'SAMP' } },
  { id: 'boiler_B1', name: 'Disparo de Caldera 1', desc: 'Menos vapor: la molienda se reduce.', sev: 2, src: 'B1', effect: { type: 'boiler_trip', target: 'B1' } },
  { id: 'boiler_B2', name: 'Disparo de Caldera 2', desc: 'Menos vapor: la molienda se reduce.', sev: 2, src: 'B2', effect: { type: 'boiler_trip', target: 'B2' } },
  { id: 'hexane_leak', name: 'Fuga de hexano en extracción', desc: 'El LEL supera 25 % y el interlock detiene el extractor.', sev: 4, src: 'EXT', effect: { type: 'hexane_lel', target: 'EXT' } },
  { id: 'noria_N1', name: 'Atasco en Noria 1', desc: 'Tolva 1 fuera de servicio (silos 1–4).', sev: 3, src: 'N1', effect: { type: 'noria_jam', target: 'N1' } },
  { id: 'noria_N2', name: 'Atasco en Noria 2', desc: 'Tolva 2 fuera de servicio (silos 5–7 y galpones).', sev: 3, src: 'N2', effect: { type: 'noria_jam', target: 'N2' } },
  { id: 'silo_hot_S2', name: 'Punto caliente en Silo 2', desc: 'La termometría sube hasta ~38 °C.', sev: 3, src: 'S2', effect: { type: 'silo_hotspot', target: 'S2' } },
  { id: 'prep_power', name: 'Corte de energía en preparación', desc: 'Se dispara el CCM: la molienda se detiene.', sev: 3, src: 'PREP', effect: { type: 'prep_power', target: 'PREP' } },
  { id: 'ol_arm', name: 'Brazo de carga de aceite bloqueado', desc: 'La cisterna queda detenida en el punto de carga.', sev: 2, src: 'OL', effect: { type: 'station_down', target: 'OL' } },
  { id: 'plc_ext_comm', name: 'PLC de extracción sin comunicación', desc: 'Se dejan de enviar los datos de extracción a Zabbix (nodata).', sev: 3, src: 'EXT', effect: { type: 'plc_comm', target: 'EXT' } },
  { id: 'brake_fail', name: 'Falla de frenos en camión', desc: 'Un camión en marcha pierde los frenos: no se detiene detrás de otros y puede chocar.', sev: 3, src: 'VIA', effect: { type: 'brake_fail', target: 'VIA' } },
  { id: 'vehicle_collision', name: 'Colisión en vía interna', desc: 'Choque entre camiones: la vía queda bloqueada hasta que mantenimiento y la grúa la despejen.', sev: 3, src: 'VIA', effect: { type: 'collision', target: 'VIA' } },
  { id: 'traffic_jam', name: 'Atasco en vía', desc: 'Un camión queda varado y bloquea la vía: se forma la cola detrás. Se despeja reparándolo o con «Despejar atasco». También se activa sola cuando el tránsito se traba.', sev: 3, src: 'VIA', effect: { type: 'jam', target: 'VIA' } },
];

export const PROBLEM_BY_ID = Object.fromEntries(PROBLEMS.map((p) => [p.id, p]));

// Items that depend on the extraction PLC (not sent while plc_ext_comm is active).
export const PLC_EXT_FIELDS = ['extractor_temp_c', 'dt_temp_c', 'miscella_pct', 'lel_pct', 'extractor_running', 'hexane_loss_l_per_t', 'meal_residual_hexane_ppm'];
