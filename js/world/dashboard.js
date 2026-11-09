// Video wall of the monitoring room: three screens drawn on canvases with the look of the
// Zabbix dark theme and the live data the app has (plant KPIs, Zabbix sender status, the open
// problems read back from Zabbix with what the CEP rules did, and short trends).
// A real Zabbix dashboard cannot be embedded (it needs a session and blocks iframes); clicking
// the wall opens the real one in Zabbix.
import * as THREE from 'three';

const W = 1280;
const H = 720;
const C = {
  bg: '#1b1d1f', panel: '#2b2d30', panel2: '#323538', line: '#3d4146', text: '#f2f2f2', muted: '#9aa3ab',
  red: '#d64e4e', ok: '#59db8f', sev: ['#97aab3', '#7499ff', '#ffc859', '#ffa059', '#e97659', '#e45959'],
};
const SEV_NAME = ['No clasificado', 'Información', 'Advertencia', 'Promedio', 'Alta', 'Desastre'];

function screen() {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
  return { canvas, ctx: canvas.getContext('2d'), tex, mat };
}

export class DashboardWall {
  constructor() {
    this.screens = [screen(), screen(), screen()];
    this.hist = [];
    this.lastHist = -1;
    for (const s of this.screens) this.blank(s.ctx, 'Conectando con Zabbix…');
    for (const s of this.screens) s.tex.needsUpdate = true;
  }

  get materials() {
    return this.screens.map((s) => s.mat);
  }

  // Called with every full state (1 Hz).
  update(s) {
    if (!s) return;
    if (s.t !== this.lastHist) {
      this.lastHist = s.t;
      this.hist.push({ t: s.t, crush: s.kpi?.crushPct ?? 0, steam: s.kpi?.steam ?? s.proc?.steam ?? 0, speed: s.traffic?.traffic_avg_speed_kmh ?? 0, trucks: s.kpi?.trucksInPlant ?? s.vehicles?.filter((v) => v.kind !== 'car').length ?? 0 });
      if (this.hist.length > 180) this.hist.shift();
    }
    const [a, b, c] = this.screens;
    this.status(a.ctx, s);
    this.problems(b.ctx, s);
    this.trends(c.ctx, s);
    for (const x of this.screens) x.tex.needsUpdate = true;
  }

  // ───────── drawing helpers ─────────
  header(ctx, title, s) {
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#16181a';
    ctx.fillRect(0, 0, W, 64);
    ctx.fillStyle = C.red;
    ctx.fillRect(18, 12, 40, 40);
    ctx.fillStyle = '#fff';
    ctx.font = '700 30px Inter, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Z', 38, 43);
    ctx.textAlign = 'left';
    ctx.font = '600 26px Inter, Arial, sans-serif';
    ctx.fillText(title, 74, 42);
    ctx.textAlign = 'right';
    ctx.font = '500 20px Inter, Arial, sans-serif';
    ctx.fillStyle = C.muted;
    ctx.fillText(s?.clock?.label ?? '', W - 20, 40);
    ctx.textAlign = 'left';
  }

  blank(ctx, text) {
    this.header(ctx, 'Zabbix', null);
    ctx.fillStyle = C.muted;
    ctx.font = '500 28px Inter, Arial, sans-serif';
    ctx.fillText(text, 40, 140);
  }

  tile(ctx, x, y, w, h, label, value, unit, color) {
    ctx.fillStyle = C.panel;
    roundRect(ctx, x, y, w, h, 8);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillRect(x, y, 6, h);
    ctx.fillStyle = C.muted;
    ctx.font = '500 19px Inter, Arial, sans-serif';
    ctx.fillText(label, x + 20, y + 32);
    ctx.fillStyle = C.text;
    ctx.font = '700 46px Inter, Arial, sans-serif';
    ctx.fillText(value, x + 20, y + h - 26);
    const vw = ctx.measureText(value).width;
    ctx.font = '500 22px Inter, Arial, sans-serif';
    ctx.fillStyle = C.muted;
    ctx.fillText(unit, x + 28 + vw, y + h - 28);
  }

  // Screen 1: plant status (as the "Estado de planta" page of the Zabbix dashboard).
  status(ctx, s) {
    this.header(ctx, 'Planta Aceitera · Estado y CEP', s);
    const k = s.kpi || {};
    const crush = k.crushPct ?? 0;
    const lel = s.proc?.lel ?? 0;
    const steam = k.steam ?? s.proc?.steam ?? 0;
    const soyPct = k.soyPct ?? 0;
    const oilPct = k.oilPct ?? 0;
    const wo = (s.orders || []).filter((o) => !['resuelta', 'cancelada'].includes(o.status)).length;
    const trucks = (s.vehicles || []).filter((v) => v.kind !== 'car' && v.x < 64).length;
    const tiles = [
      ['Molienda', crush.toFixed(0), '%', crush < 70 ? C.sev[5] : crush < 90 ? C.sev[2] : C.ok],
      ['Presión de vapor', steam.toFixed(1), 'bar', steam < 8 ? C.sev[5] : C.ok],
      ['LEL hexano', lel.toFixed(0), '%', lel > 25 ? C.sev[5] : lel > 12 ? C.sev[2] : C.ok],
      ['Acopio de soya', soyPct.toFixed(0), '%', soyPct > 92 ? C.sev[2] : C.ok],
      ['Tanques de aceite', oilPct.toFixed(0), '%', oilPct > 90 ? C.sev[2] : C.ok],
      ['Camiones en planta', String(trucks), '', C.sev[1]],
      ['OT abiertas', String(wo), '', wo ? C.sev[3] : C.ok],
      ['Problemas en Zabbix', String(s.zabbix?.cep?.results?.open ?? '—'), '', s.zabbix?.cep?.results?.open ? C.sev[4] : C.ok],
    ];
    const tw = (W - 40 - 30) / 4;
    tiles.forEach(([l, v, u, col], i) => this.tile(ctx, 20 + (i % 4) * (tw + 10), 84 + Math.floor(i / 4) * 150, tw, 136, l, v, u, col));
    // Sender / CEP status strip.
    const z = s.zabbix || {};
    const last = z.last;
    ctx.fillStyle = C.panel;
    roundRect(ctx, 20, 394, W - 40, 300, 8);
    ctx.fill();
    ctx.font = '600 22px Inter, Arial, sans-serif';
    ctx.fillStyle = C.text;
    ctx.fillText('Integración con Zabbix', 40, 432);
    const rows = [
      ['Zabbix sender', last ? (last.error ? `error: ${last.error}` : `${last.processed} procesados · ${last.failed} fallidos`) : 'sin envíos'],
      ['Host / servidor', `${z.host ?? '—'} · ${z.server ?? '—'}`],
      ['Alta (API)', String(z.provision ?? '—')],
      ['CEP nativo (8.0)', `${z.cep?.state ?? '—'}${z.cep?.rules?.length ? ` · ${z.cep.rules.length} reglas` : ''}`],
      ['Correlación', z.cep?.results ? `${z.cep.results.symptoms} síntomas agrupados · ${z.cep.results.incidents} incidentes` : '—'],
    ];
    ctx.font = '500 21px Inter, Arial, sans-serif';
    rows.forEach(([a, b2], i) => {
      ctx.fillStyle = C.muted;
      ctx.fillText(a, 40, 478 + i * 42);
      ctx.fillStyle = /error|fallid[^o]* [1-9]/.test(b2) ? C.sev[5] : C.text;
      ctx.fillText(b2, 300, 478 + i * 42);
    });
  }

  // Screen 2: open problems in Zabbix, with the CEP grouping.
  problems(ctx, s) {
    this.header(ctx, 'Problemas · Zabbix (CEP)', s);
    const res = s.zabbix?.cep?.results;
    const list = res?.problems?.length ? res.problems : (s.problems || []).map((p) => ({ name: p.name, severity: p.sev + 1, symptom: false, age: p.durMin * 60 }));
    ctx.font = '600 18px Inter, Arial, sans-serif';
    ctx.fillStyle = C.muted;
    ctx.fillText('Severidad', 30, 96);
    ctx.fillText('Problema', 210, 96);
    ctx.fillText('Duración', W - 160, 96);
    if (!list.length) {
      ctx.fillStyle = C.ok;
      ctx.font = '600 34px Inter, Arial, sans-serif';
      ctx.fillText('Sin problemas activos', 30, 180);
      ctx.fillStyle = C.muted;
      ctx.font = '500 22px Inter, Arial, sans-serif';
      ctx.fillText('Activa fallas desde la app para verlas aquí y en Zabbix.', 30, 222);
      return;
    }
    list.slice(0, 11).forEach((p, i) => {
      const y = 112 + i * 54;
      ctx.fillStyle = i % 2 ? C.panel : C.panel2;
      ctx.fillRect(20, y, W - 40, 50);
      const sev = Math.max(0, Math.min(5, p.severity ?? 0));
      ctx.fillStyle = C.sev[sev];
      ctx.fillRect(20, y, 172, 50);
      ctx.fillStyle = '#1b1d1f';
      ctx.font = '600 18px Inter, Arial, sans-serif';
      ctx.fillText(SEV_NAME[sev], 30, y + 32);
      ctx.fillStyle = p.incident ? '#ffd27a' : C.text;
      ctx.font = `${p.incident ? 700 : 500} 21px Inter, Arial, sans-serif`;
      const name = `${p.symptom ? '   ↳ ' : ''}${p.name}${p.sintomas ? `  (síntomas: ${p.sintomas})` : ''}`;
      ctx.fillText(clip(ctx, name, W - 420), 210, y + 32);
      ctx.fillStyle = C.muted;
      ctx.font = '500 19px Inter, Arial, sans-serif';
      ctx.fillText(dur(p.age), W - 160, y + 32);
    });
  }

  // Screen 3: short trends.
  trends(ctx, s) {
    this.header(ctx, 'Tendencias de planta', s);
    const h = this.hist;
    this.chart(ctx, 20, 84, W - 40, 190, 'Molienda (% capacidad)', h.map((x) => x.crush), 0, 110, '#3ee6ff');
    this.chart(ctx, 20, 294, (W - 50) / 2, 190, 'Presión de vapor (bar)', h.map((x) => x.steam), 0, 12, '#ffa059');
    this.chart(ctx, 30 + (W - 50) / 2, 294, (W - 50) / 2, 190, 'Camiones en planta', h.map((x) => x.trucks), 0, 20, '#7499ff');
    this.chart(ctx, 20, 504, W - 40, 190, 'Velocidad media en vías internas (km/h)', h.map((x) => x.speed), 0, 40, '#59db8f');
  }

  chart(ctx, x, y, w, h, title, data, min, max, color) {
    ctx.fillStyle = C.panel;
    roundRect(ctx, x, y, w, h, 8);
    ctx.fill();
    ctx.fillStyle = C.muted;
    ctx.font = '500 18px Inter, Arial, sans-serif';
    ctx.fillText(title, x + 16, y + 28);
    const last = data[data.length - 1];
    if (last !== undefined) {
      ctx.textAlign = 'right';
      ctx.fillStyle = C.text;
      ctx.font = '700 24px Inter, Arial, sans-serif';
      ctx.fillText(last.toFixed(1), x + w - 16, y + 30);
      ctx.textAlign = 'left';
    }
    const px = x + 16;
    const py = y + 44;
    const pw = w - 32;
    const ph = h - 60;
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
      ctx.beginPath();
      ctx.moveTo(px, py + (ph * i) / 3);
      ctx.lineTo(px + pw, py + (ph * i) / 3);
      ctx.stroke();
    }
    if (data.length < 2) return;
    const n = 180;
    const pts = data.map((v, i) => [px + pw - ((data.length - 1 - i) / (n - 1)) * pw, py + ph - ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * ph]);
    ctx.beginPath();
    pts.forEach(([a, b], i) => (i ? ctx.lineTo(a, b) : ctx.moveTo(a, b)));
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.lineTo(pts[pts.length - 1][0], py + ph);
    ctx.lineTo(pts[0][0], py + ph);
    ctx.closePath();
    ctx.fillStyle = `${color}33`;
    ctx.fill();
  }
}

function dur(sec) {
  if (sec === undefined || sec === null) return '';
  const m = Math.floor(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m ${Math.floor(sec % 60)}s`;
}
function clip(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 4 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
