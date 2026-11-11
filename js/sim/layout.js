// Plant layout data (shared by the simulation server and the 3D client).
// Coordinates: X = east (+), Z = south (+). 1 unit ≈ 1.5 m.
// Inspired by the aerial photo of a soybean/sunflower crushing plant next to RN4:
// highway on the east, river on the west, offices north, process in the middle,
// grain storage (galpones + silos) and truck yard to the south.

export const SITE = { x0: -64, z0: -140, x1: 60, z1: 130 };
export const GRID_BOUNDS = { minX: -84, minZ: -184, maxX: 116, maxZ: 184, cell: 2 };

// Everything west of this is inside the plant (the access road and RN4 are outside).
export const PLANT_EDGE_X = 64;

// RN4: divided highway (two carriageways and a central median). The plant is on the west,
// so every movement is a right turn; the U-turns (retornos) let trucks change direction.
//  - southbound carriageway (next to the plant): x 82..90, shoulder lane x 84, driving lane x 87.5
//  - median: x 90..100, with an opening at each retorno
//  - northbound carriageway: x 100..108, driving lane x 102.5, shoulder x 106
export const RN4 = {
  sX0: 82, sX1: 90, nX0: 100, nX1: 108,
  sLane: 87.5, sShoulder: 84, nLane: 102.5, nShoulder: 106,
  medianX: 95, turnR: 7.5,
  retN: -1, // retorno norte: northbound → southbound (soy trucks coming from the south)
  retS: 140, // retorno sur: southbound → northbound (trucks leaving towards the north)
};

// U-turn through a median opening as a list of points (the first one is on the lane the
// vehicle arrives on, the last one on the opposite carriageway). Each point carries a speed
// cap so the truck slows down for the turn.
export function uTurn(which) {
  const pts = [];
  const N = 8;
  const { medianX: cx, turnR: r } = RN4;
  for (let i = 0; i <= N; i++) {
    const th = (Math.PI * i) / N;
    if (which === 'N') pts.push({ x: cx + r * Math.cos(th), z: RN4.retN - r * Math.sin(th), vmax: 4 }); // from x 102.5 heading north to x 87.5 heading south
    else pts.push({ x: cx - r * Math.cos(th), z: RN4.retS + r * Math.sin(th), vmax: 4 }); // from x 87.5 heading south to x 102.5 heading north
  }
  return pts;
}

// Gate (portería): one barrier per lane of the access road. A truck stops with its front
// bumper just before the boom, so it never drives through a closed barrier.
export const GATE_LANES = {
  in: { z: 69.3, boomX: 66, stopX: 72.5, post: 66.3 }, // inbound (westbound) lane
  out: { z: 72.7, boomX: 76, stopX: 69.5, post: 75.7 }, // outbound (eastbound) lane
};

// Truck-drivable rectangles [x0, z0, x1, z1]
export const ROADS = [
  { id: 'RN4_S', rect: [82, -184, 90, 184], highway: true, dir: 's' },
  { id: 'RN4_N', rect: [100, -184, 108, 184], highway: true, dir: 'n' },
  { id: 'RET_N', rect: [90, -10, 100, 1], highway: true, median: true },
  { id: 'RET_S', rect: [90, 138, 100, 149], highway: true, median: true },
  { id: 'ACCESO', rect: [58, 66, 82, 76] },
  { id: 'ANILLO_E', rect: [52, -140, 60, 130] },
  { id: 'ANILLO_O', rect: [-64, -140, -56, 130] },
  { id: 'ANILLO_N', rect: [-64, -140, 60, -132] },
  { id: 'ANILLO_S', rect: [-64, 122, 60, 130] },
  { id: 'C1', rect: [-64, -92, 60, -86] },
  { id: 'C2', rect: [-64, 0, 60, 6] },
  { id: 'C3', rect: [-64, 46, 60, 52] },
  { id: 'C4', rect: [-64, 90, 60, 96] },
  { id: 'INTERNA', rect: [12, 0, 18, 130] },
  { id: 'PLAYA', rect: [20, 52, 52, 90], yard: true },
];

// Truck stops. `cap` = trucks that can use it simultaneously.
export const STATIONS = {
  GATE: { id: 'GATE', name: 'Portería / Control de acceso', x: 71, z: 71, cap: 1 },
  // Soy reception circuit, one way: C3 westbound (calador → balanza → volcadora 2), ANILLO_O
  // southbound, C4 eastbound (volcadora 1 → balanza de salida), ANILLO_E northbound to the gate.
  SAMP: { id: 'SAMP', name: 'Calador automático (muestreo)', x: 4, z: 49, cap: 1 },
  BAL_IN: { id: 'BAL_IN', name: 'Balanza de ingreso (bruto)', x: -16, z: 49, cap: 1 },
  BAL_OUT: { id: 'BAL_OUT', name: 'Balanza de salida (tara)', x: 38, z: 93, cap: 1 },
  // Dispatch circuit, one way: ANILLO_E northbound (tara), C2 westbound (carga → bruto),
  // ANILLO_O southbound, C4 eastbound, ANILLO_E northbound to the gate.
  BAL_D: { id: 'BAL_D', name: 'Balanza de despacho (tara)', x: 56, z: 30, cap: 1 },
  BAL_DS: { id: 'BAL_DS', name: 'Balanza de despacho (bruto)', x: -34, z: 3, cap: 1 },
  H1: { id: 'H1', name: 'Volcadora / Tolva 1 (silos)', x: -40, z: 93, cap: 1 },
  H2: { id: 'H2', name: 'Volcadora / Tolva 2 (galpones)', x: -44, z: 49, cap: 1 },
  OL: { id: 'OL', name: 'Carga de aceite (cisternas)', x: 46, z: 3, cap: 1 },
  ML: { id: 'ML', name: 'Carga de harina', x: -14, z: 3, cap: 1 },
};

// Trucks arrive in the driving lane: soy from the south (northbound), dispatch from the north.
export const SPAWN = {
  south: { x: 102.5, z: 182 },
  north: { x: 87.5, z: -182 },
};

// Junctions every route of a circuit goes through (road centres), so trucks follow the
// circuit in one direction instead of the shortest way.
export const NODES = {
  C3_E: { x: 56, z: 49 }, // ANILLO_E × C3
  C3_W: { x: -60, z: 49 }, // ANILLO_O × C3
  C2_W: { x: -60, z: 3 }, // ANILLO_O × C2
  C4_W: { x: -60, z: 93 }, // ANILLO_O × C4
  C4_E: { x: 56, z: 93 }, // ANILLO_E × C4
};

// Yard parking slots (trucks wait here for the calador). The back row is staggered so
// its trucks drive in and out straight through the gaps of the front row.
export const YARD_SLOTS = (() => {
  const s = [];
  for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++) s.push({ x: 25 + c * 7.5 - (r ? 3.75 : 0), z: 62 + r * 16 });
  return s;
})();
export const YARD_AISLE_Z = 49; // C3 road, north of the yard: entry and exit point of every bay

// Grain storage receiving soy from the hoppers.
export const STORAGES = [
  { id: 'S1', kind: 'silo', name: 'Silo 1', x: -24, z: 109, r: 9, h: 26, cap: 12000, hopper: 'H1' },
  { id: 'S2', kind: 'silo', name: 'Silo 2', x: -4, z: 109, r: 9, h: 26, cap: 12000, hopper: 'H1' },
  { id: 'S3', kind: 'silo', name: 'Silo 3', x: 16, z: 109, r: 9, h: 26, cap: 12000, hopper: 'H1' },
  { id: 'S4', kind: 'silo', name: 'Silo 4', x: 36, z: 109, r: 9, h: 26, cap: 12000, hopper: 'H1' },
  { id: 'S5', kind: 'silo', name: 'Silo 5', x: -46, z: 14, r: 5.5, h: 20, cap: 3000, hopper: 'H2' },
  { id: 'S6', kind: 'silo', name: 'Silo 6', x: -46, z: 27, r: 5.5, h: 20, cap: 3000, hopper: 'H2' },
  { id: 'S7', kind: 'silo', name: 'Silo 7', x: -46, z: 40, r: 5.5, h: 20, cap: 3000, hopper: 'H2' },
  { id: 'G1', kind: 'galpon', name: 'Galpón granelero 1', x: -10, z: 26, w: 36, d: 34, h: 14, cap: 20000, hopper: 'H2' },
  { id: 'G2', kind: 'galpon', name: 'Galpón granelero 2', x: 30, z: 26, w: 20, d: 32, h: 13, cap: 12000, hopper: 'H2' },
  { id: 'G3', kind: 'galpon', name: 'Galpón granelero 3', x: -8, z: 70, w: 36, d: 34, h: 14, cap: 20000, hopper: 'H2' },
];

export const OIL_TANKS = [
  { id: 'TA1', name: 'Tanque aceite crudo 1', x: 46.5, z: 12, r: 4, h: 15, cap: 2500 },
  { id: 'TA2', name: 'Tanque aceite crudo 2', x: 46.5, z: 21.5, r: 4, h: 15, cap: 2500 },
  { id: 'TA3', name: 'Tanque aceite crudo 3', x: 46.5, z: 31, r: 4, h: 15, cap: 2500 },
];

// Small tank farm (north-east) — day tanks / degummed oil.
export const DAY_TANKS = (() => {
  const t = [];
  let n = 1;
  for (let c = 0; c < 2; c++) for (let r = 0; r < 4; r++) t.push({ id: `TD${n}`, name: `Tanque diario ${n++}`, x: 39 + c * 7.5, z: -126 + r * 7.5, r: 3, h: 9, cap: 250 });
  return t;
})();

export const BOILERS = [
  { id: 'B1', name: 'Caldera 1 (biomasa/cascarilla)', x: 40.5, z: -41, cap: 25 },
  { id: 'B2', name: 'Caldera 2 (gas natural)', x: 47.5, z: -41, cap: 25 },
];

// Buildings & equipment rendered by the client. `block` = pedestrians walk around it.
export const BUILDINGS = [
  { id: 'OFI', type: 'controlRoom', name: 'Oficinas y sala de monitoreo (Zabbix)', x: 26, z: -112, w: 12, d: 16, h: 6, roof: 'red', block: false },
  { id: 'ALM', type: 'warehouse', name: 'Almacén general y repuestos', x: -14, z: -112, w: 40, d: 28, h: 9, roof: 'mixed', block: true },
  { id: 'TAL', type: 'building', name: 'Taller de mantenimiento', x: -46, z: -112, w: 10, d: 20, h: 6, roof: 'orange', block: true },
  { id: 'PREP', type: 'prep', name: 'Preparación (limpieza, quebrado, descascarado, acondicionado, laminado)', x: 18, z: -72, w: 26, d: 18, h: 16, roof: 'red', block: true },
  { id: 'EXT', type: 'extraction', name: 'Extracción por solvente (hexano)', x: 18, z: -38, w: 22, d: 20, h: 24, block: true },
  { id: 'HEX', type: 'hexane', name: 'Tanque de hexano (zona clasificada)', x: 22, z: -14, w: 12, d: 8, h: 4, block: true },
  { id: 'SF', type: 'power', name: 'Sala de fuerza (calderas, vapor, energía)', x: 44, z: -60, w: 12, d: 16, h: 10, block: true },
  { id: 'CHIM', type: 'chimney', name: 'Chimenea calderas', x: 44, z: -49, r: 1.6, h: 38, block: true },
  { id: 'TE', type: 'cooling', name: 'Torre de enfriamiento', x: 44, z: -24, w: 12, d: 8, h: 7, block: true },
  { id: 'GH', type: 'warehouse', name: 'Galpón de harina de soya', x: -14, z: -30, w: 32, d: 26, h: 11, roof: 'gray', block: true },
  { id: 'GC', type: 'warehouse', name: 'Galpón de cascarilla / pellets', x: -14, z: -66, w: 32, d: 16, h: 8, roof: 'gray', block: true },
  { id: 'SP', type: 'bufferSilo', name: 'Silo pulmón de preparación', x: -46, z: -60, r: 7, h: 22, block: true },
  { id: 'SEC1', type: 'dryer', name: 'Secadora de granos 1', x: -46, z: -40, w: 6, d: 6, h: 24, block: true },
  { id: 'SEC2', type: 'dryer', name: 'Secadora de granos 2', x: -46, z: 72, w: 6, d: 6, h: 22, block: true },
  { id: 'N1', type: 'noria', name: 'Noria 1 (elevador de cangilones)', x: -40, z: 102, w: 3, d: 3, h: 34, block: true },
  { id: 'N2', type: 'noria', name: 'Noria 2 (elevador de cangilones)', x: -50, z: 56, w: 3, d: 3, h: 30, block: true },
  { id: 'LAB', type: 'building', name: 'Laboratorio de calidad', x: 46, z: 41, w: 9, d: 7, h: 5, roof: 'white', block: true },
  { id: 'GAR', type: 'gatehouse', name: 'Portería', x: 71, z: 79.5, w: 4, d: 5, h: 4, roof: 'white', block: true },
];

// Monitoring room inside the offices: video wall on the north wall (facing +z), the plant
// manager's place in front of it, door on the south side.
export const MONITOR_ROOM = {
  x: 26, z: -112, w: 12, d: 16,
  seat: { x: 26, z: -108.5, h: -Math.PI / 2 }, // looking north, at the wall
  door: { x: 26, z: -102 },
  view: { pos: [26.6, 2.7, -99.5], target: [26, 2.3, -119.6] }, // through the door, eye level, the manager in front
};

// Points of interest for the "Proceso" tour.
export const TOUR = [
  { id: 'recepcion', title: '1. Recepción de camiones', desc: 'RN4 en doble vía con retornos, portería con barreras y playa de espera.', target: [62, 0, 60], dist: 95 },
  { id: 'calado', title: '2. Calado y pesaje', desc: 'Muestreo (humedad, impurezas) y balanza de ingreso.', target: [-6, 0, 49], dist: 45 },
  { id: 'descarga', title: '3. Descarga y acopio', desc: 'Volcadoras, norias, silos y galpones graneleros.', target: [-10, 0, 90], dist: 110 },
  { id: 'prep', title: '4. Preparación', desc: 'Limpieza, quebrado, descascarado, acondicionado y laminado.', target: [10, 0, -70], dist: 70 },
  { id: 'ext', title: '5. Extracción con hexano', desc: 'Extractor, desolventizador-tostador y destilación de miscela.', target: [18, 0, -32], dist: 60 },
  { id: 'sf', title: '6. Sala de fuerza', desc: 'Calderas, vapor de proceso, chimenea y torre de enfriamiento.', target: [44, 0, -45], dist: 60 },
  { id: 'despacho', title: '7. Almacén y despacho', desc: 'Tanques de aceite, galpón de harina y carga de cisternas.', target: [20, 0, 5], dist: 90 },
  { id: 'monitor', title: '8. Sala de monitoreo (Zabbix)', desc: 'Dashboard de Zabbix en el muro de video; el gerente de planta lo sigue en vivo.', monitor: true, target: [26, 0, -112], dist: 30 },
];
