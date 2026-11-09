// Plant layout data (shared by the simulation server and the 3D client).
// Coordinates: X = east (+), Z = south (+). 1 unit ≈ 1.5 m.
// Inspired by the aerial photo of a soybean/sunflower crushing plant next to RN4:
// highway on the east, river on the west, offices north, process in the middle,
// grain storage (galpones + silos) and truck yard to the south.

export const SITE = { x0: -64, z0: -140, x1: 60, z1: 130 };
export const GRID_BOUNDS = { minX: -84, minZ: -184, maxX: 96, maxZ: 184, cell: 2 };

// Truck-drivable rectangles [x0, z0, x1, z1]
export const ROADS = [
  { id: 'RN4', rect: [66, -184, 82, 184], highway: true },
  { id: 'ACCESO', rect: [58, 66, 66, 76] },
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
  GATE: { id: 'GATE', name: 'Portería / Control de acceso', x: 62, z: 71, cap: 1 },
  SAMP: { id: 'SAMP', name: 'Calador automático (muestreo)', x: 38, z: 49, cap: 1 },
  BAL_IN: { id: 'BAL_IN', name: 'Balanza de ingreso (bruto)', x: 24, z: 49, cap: 1 },
  BAL_OUT: { id: 'BAL_OUT', name: 'Balanza de salida (tara)', x: 38, z: 93, cap: 1 },
  BAL_D: { id: 'BAL_D', name: 'Balanza de despacho (tara)', x: 26, z: 3, cap: 1 },
  BAL_DS: { id: 'BAL_DS', name: 'Balanza de despacho (bruto)', x: 56, z: 30, cap: 1 },
  H1: { id: 'H1', name: 'Volcadora / Tolva 1 (silos)', x: -40, z: 93, cap: 1 },
  H2: { id: 'H2', name: 'Volcadora / Tolva 2 (galpones)', x: -44, z: 49, cap: 1 },
  OL: { id: 'OL', name: 'Carga de aceite (cisternas)', x: 46, z: 3, cap: 1 },
  ML: { id: 'ML', name: 'Carga de harina', x: -14, z: 3, cap: 1 },
};

export const SPAWN = {
  south: { x: 74, z: 182 },
  north: { x: 74, z: -182 },
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
  { id: 'OFI', type: 'building', name: 'Oficinas administración', x: 26, z: -112, w: 12, d: 16, h: 7, roof: 'red', block: true },
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
  { id: 'GAR', type: 'gatehouse', name: 'Portería', x: 62, z: 81, w: 4, d: 5, h: 4, roof: 'white', block: true },
];

// Points of interest for the "Proceso" tour.
export const TOUR = [
  { id: 'recepcion', title: '1. Recepción de camiones', desc: 'Ingreso por RN4, portería y playa de espera.', target: [40, 0, 70], dist: 70 },
  { id: 'calado', title: '2. Calado y pesaje', desc: 'Muestreo (humedad, impurezas) y balanza de ingreso.', target: [30, 0, 49], dist: 45 },
  { id: 'descarga', title: '3. Descarga y acopio', desc: 'Volcadoras, norias, silos y galpones graneleros.', target: [-10, 0, 90], dist: 110 },
  { id: 'prep', title: '4. Preparación', desc: 'Limpieza, quebrado, descascarado, acondicionado y laminado.', target: [10, 0, -70], dist: 70 },
  { id: 'ext', title: '5. Extracción con hexano', desc: 'Extractor, desolventizador-tostador y destilación de miscela.', target: [18, 0, -32], dist: 60 },
  { id: 'sf', title: '6. Sala de fuerza', desc: 'Calderas, vapor de proceso, chimenea y torre de enfriamiento.', target: [44, 0, -45], dist: 60 },
  { id: 'despacho', title: '7. Almacén y despacho', desc: 'Tanques de aceite, galpón de harina y carga de cisternas.', target: [20, 0, 5], dist: 90 },
];
