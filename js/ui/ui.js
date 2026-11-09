// HUD: KPIs, Zabbix-style problem/event feed, details panel, controls.
import { STORAGES, OIL_TANKS, BUILDINGS, STATIONS, BOILERS, TOUR } from '../sim/layout.js';

const $ = (s) => document.querySelector(s);
const SEV = ['Información', 'Advertencia', 'Promedio', 'Alta', 'Desastre'];
const SEV_CLASS = ['info', 'warning', 'average', 'high', 'disaster'];
const fmt = (v, d = 0) => (v === undefined || v === null || Number.isNaN(v) ? '—' : Number(v).toLocaleString('es-BO', { minimumFractionDigits: d, maximumFractionDigits: d }));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export class UI {
  constructor(handlers) {
    this.h = handlers;
    this.history = new Map();
    this.lastHist = 0;
    this.feedTab = 'problems';
    this.feedSig = '';
    this.selected = null;
    this.openPop = null;
    this.buildControls();
  }

  // ───────────── controls ─────────────
  buildControls() {
    const speeds = [
      [0, '❚❚'],
      [1, '1×'],
      [5, '5×'],
      [15, '15×'],
      [30, '30×'],
    ];
    const sp = $('#speeds');
    for (const [v, l] of speeds) {
      const b = document.createElement('button');
      b.textContent = l;
      b.dataset.speed = v;
      b.title = v === 0 ? 'Pausar simulación' : `Velocidad ${l} (1× = 1 min simulado por segundo)`;
      b.onclick = () => this.h.onSpeed(v);
      sp.appendChild(b);
    }
    const tour = $('#tourItems');
    for (const t of TOUR) {
      const b = document.createElement('button');
      b.className = 'menu-item';
      b.innerHTML = `<b>${esc(t.title)}</b><span>${esc(t.desc)}</span>`;
      b.onclick = () => {
        this.closeMenus();
        this.h.onTour(t);
      };
      tour.appendChild(b);
    }
    // Fault panel rows (rendered from the live catalog in each snapshot).
    $('#faultItems').addEventListener('click', (e) => {
      const row = e.target.closest('[data-problem]');
      if (row) this.h.onProblem(row.dataset.problem, row.dataset.state === '0');
      if (e.target.closest('#clearProblems')) this.h.onClearProblems();
    });
    $('#randomToggle').onclick = () => this.h.onRandomFaults(!this.last?.randomFaults);

    // Bottom-bar popups: the same button toggles, only one open at a time,
    // closed by ✕, Esc or any pointer press outside (the 3D canvas included).
    for (const btn of document.querySelectorAll('[data-menu]')) {
      btn.onclick = () => {
        const pop = document.getElementById(btn.dataset.menu);
        const wasOpen = this.openPop === pop;
        this.closeMenus();
        if (!wasOpen) this.openMenu(btn, pop);
      };
    }
    for (const x of document.querySelectorAll('.pop-close')) x.onclick = () => this.closeMenus();
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (this.openPop && !e.target.closest('.menu-pop') && !e.target.closest('[data-menu]')) this.closeMenus();
      },
      true,
    );
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('#authModal').classList.contains('hidden')) return;
      if (this.openPop) this.closeMenus();
      else this.h.onEscape?.();
    });
    window.addEventListener('resize', () => this.openPop && this.positionPop());

    $('#btnLabels').onclick = (e) => {
      const on = e.currentTarget.classList.toggle('active');
      this.h.onLabels(on);
    };
    $('#btnHome').onclick = () => this.h.onHome();
    $('#btnConfig').onclick = () => {
      this.closeMenus();
      this.h.onConfig();
    };
    $('#detailsClose').onclick = () => this.h.onSelect(null);
    for (const t of document.querySelectorAll('.feed-tabs button')) {
      t.onclick = () => {
        this.feedTab = t.dataset.tab;
        document.querySelectorAll('.feed-tabs button').forEach((x) => x.classList.toggle('active', x === t));
        this.feedSig = '';
        this.renderFeed(this.last);
      };
    }
    $('#feedToggle').onclick = () => $('#feed').classList.toggle('collapsed');
    if (window.innerWidth < 1280) $('#feed').classList.add('collapsed');
    // The navigation hint fades after a while (and whenever a popup opens).
    setTimeout(() => $('#hint').classList.add('gone'), 14000);
    this.buildAuthModal();
    // HUD offsets come from real sizes (fonts and wrapping change them), not fixed numbers.
    const relayout = () => this.layoutHud();
    window.addEventListener('resize', relayout);
    document.fonts?.ready.then(relayout);
    relayout();
  }

  layoutHud() {
    const root = document.documentElement.style;
    const b = $('.brand').getBoundingClientRect();
    root.setProperty('--brand-r', `${Math.round(b.right)}px`);
    root.setProperty('--brand-b', `${Math.round(b.bottom)}px`);
    // KPIs move only after the variables above apply; measure them on the next frame.
    requestAnimationFrame(() => {
      const k = $('#kpis').getBoundingClientRect();
      const bottom = Math.max(k.bottom, b.bottom);
      root.setProperty('--hud-b', `${Math.round(bottom + 10)}px`);
    });
  }

  openMenu(btn, pop) {
    this.openPop = pop;
    this.openBtn = btn;
    pop.classList.add('open');
    btn.classList.add('open');
    $('#hint').classList.add('gone');
    this.positionPop();
  }

  // Anchor the popup above its button, kept inside the viewport.
  positionPop() {
    const pop = this.openPop;
    const r = this.openBtn.getBoundingClientRect();
    const w = pop.offsetWidth;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    pop.style.left = `${left}px`;
    pop.style.bottom = `${window.innerHeight - r.top + 10}px`;
    pop.style.maxHeight = `${Math.max(160, r.top - 24)}px`;
  }

  closeMenus() {
    document.querySelectorAll('.menu-pop.open').forEach((m) => m.classList.remove('open'));
    document.querySelectorAll('[data-menu].open').forEach((b) => b.classList.remove('open'));
    this.openPop = null;
    this.openBtn = null;
  }

  // Admin key modal: resolves with the typed key, or null if cancelled.
  buildAuthModal() {
    const modal = $('#authModal');
    const input = $('#authInput');
    const finish = (v) => {
      modal.classList.add('hidden');
      const r = this.authResolve;
      this.authResolve = null;
      r?.(v);
    };
    $('#authForm').onsubmit = (e) => {
      e.preventDefault();
      if (input.value.trim()) finish(input.value.trim());
    };
    $('#authCancel').onclick = () => finish(null);
    modal.addEventListener('keydown', (e) => e.key === 'Escape' && finish(null));
  }

  askToken(errorMsg = '') {
    return new Promise((resolve) => {
      this.authResolve = resolve;
      $('#authError').textContent = errorMsg;
      $('#authInput').value = '';
      $('#authModal').classList.remove('hidden');
      setTimeout(() => $('#authInput').focus(), 30);
    });
  }

  setMode({ mode }) {
    const el = $('#mode');
    el.className = `mode ${mode}`;
    el.textContent = { server: 'Servidor en vivo · métricas Zabbix', local: 'Simulación local (sin servidor)', reconnecting: 'Reconectando…' }[mode] || mode;
  }

  toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this.toastT);
    this.toastT = setTimeout(() => t.classList.remove('show'), 2800);
  }

  // ───────────── per snapshot ─────────────
  update(s) {
    this.last = s;
    this.recordHistory(s);
    $('#clock').textContent = s.clock.label;
    document.querySelectorAll('#speeds button').forEach((b) => b.classList.toggle('active', Number(b.dataset.speed) === s.speed));
    this.renderKpis(s);
    this.renderFeed(s);
    this.renderProblems(s);
    this.renderZabbix(s);
    if (this.selected) this.renderDetails(this.selected, s);
  }

  // Fault points: switch per problem (manual = stays until switched off).
  renderProblems(s) {
    const cat = s.problemCatalog || [];
    const active = cat.filter((p) => p.state > 0).length;
    const label = `Fallas${active ? ` <span class="count on">${active}</span>` : ''}`;
    const btn = $('#btnProblems');
    if (btn.innerHTML !== label) btn.innerHTML = label;
    const list = $('#faultItems');
    // Build the rows once; afterwards only update them in place so clicks are never lost.
    const ids = cat.map((p) => p.id).join(',');
    if (list.dataset.ids !== ids) {
      list.dataset.ids = ids;
      list.innerHTML = `${cat
        .map(
          (p) => `<button type="button" class="pp sev-${SEV_CLASS[p.sev]}" data-problem="${p.id}" data-state="0" title="${esc(p.desc)}">
            <i class="dot"></i><span class="pp-txt"><b>${esc(p.name)}</b><small></small></span><i class="switch"></i></button>`,
        )
        .join('')}
        <button id="clearProblems" type="button" class="menu-item ok"><b>Desactivar todas</b><span>Normaliza manuales y aleatorias</span></button>`;
    }
    const rnd = $('#randomToggle');
    rnd.setAttribute('aria-pressed', String(!!s.randomFaults));
    rnd.querySelector('.switch').classList.toggle('on', !!s.randomFaults);
    for (const p of cat) {
      const row = list.querySelector(`[data-problem="${p.id}"]`);
      if (!row) continue;
      row.dataset.state = String(p.state);
      row.classList.toggle('on', p.state > 0);
      row.querySelector('.switch').classList.toggle('on', p.state > 0);
      row.setAttribute('aria-pressed', String(p.state > 0));
      const meta = p.state === 2 ? `Aleatoria · se resuelve en ${p.leftMin} min` : p.state === 1 ? `Manual · activa hace ${p.sinceMin} min (hasta desactivarla)` : p.desc;
      const small = row.querySelector('small');
      if (small.textContent !== meta) small.textContent = meta;
    }
    $('#clearProblems').disabled = !active;
  }

  renderZabbix(s) {
    const z = s.zabbix;
    const el = $('#zbx');
    if (!z || !z.enabled) {
      el.className = 'zbx off';
      el.textContent = s.zabbix ? 'Zabbix sender: deshabilitado' : '';
      return;
    }
    const l = z.last;
    let cls = 'zbx';
    let txt = `Zabbix sender → ${z.server} · esperando primer envío`;
    if (l?.error) {
      cls += ' bad';
      txt = `Zabbix sender: ${l.error}`;
    } else if (l) {
      const ago = Math.max(0, Math.round((Date.now() - Date.parse(l.at)) / 1000));
      const iotFailed = z.iot?.failed ?? 0;
      cls += l.failed > 0 || iotFailed > 0 || z.iot?.error ? ' warn' : ' ok';
      const devs = s.iot?.devices || [];
      const online = devs.filter((d) => d.online).length;
      txt = `Zabbix · ${l.processed} ok · ${l.failed} fallidos${s.iot?.enabled && devs.length ? ` · IoT ${online}/${devs.length} en línea` : ''} · hace ${ago} s`;
    }
    if (z.provision === 'error') txt += ' · alta con error';
    el.className = cls;
    el.textContent = txt;
    el.title = `Host "${z.host}" en ${z.server}. Alta automática: ${z.provision}. Correlación: ${z.correlation}.${z.iot ? ` IoT: ${z.iot.processed} ok / ${z.iot.failed} fallidos.` : ''}`;
  }

  recordHistory(s) {
    const now = performance.now();
    if (now - this.lastHist < 1000) return;
    this.lastHist = now;
    const put = (k, v) => {
      let a = this.history.get(k);
      if (!a) this.history.set(k, (a = []));
      a.push(v);
      if (a.length > 300) a.shift();
    };
    for (const st of s.storages) {
      put(`st.${st.id}.pct`, st.pct);
      put(`st.${st.id}.temp`, st.temp);
    }
    for (const t of s.tanks) put(`tk.${t.id}.pct`, t.pct);
    for (const b of s.boilers) put(`b.${b.id}.load`, b.load);
    for (const [k, v] of Object.entries(s.proc)) if (typeof v === 'number') put(`proc.${k}`, v);
    for (const [k, v] of Object.entries(s.kpi)) put(`kpi.${k}`, v);
  }

  renderKpis(s) {
    const k = s.kpi;
    const items = [
      ['Recepción hoy', `${fmt(k.receivedT)} t`, `${fmt(k.trucksIn)} camiones · ${fmt(k.rejected)} rechazados`, ''],
      ['Stock soya', `${fmt(k.soyStock)} t`, `${fmt(k.soyPct, 1)}% de ${fmt(k.soyCap / 1000)} kt`, k.soyPct > 92 ? 'warn' : ''],
      ['Molienda', `${fmt(k.crushRateTpd)} t/d`, `${fmt(k.crushPct)}% capacidad · ${fmt(k.crushedT)} t hoy`, k.crushPct < 70 ? 'bad' : ''],
      ['Aceite crudo', `${fmt(k.oilStock)} t`, `${fmt(k.oilPct)}% · ${fmt(k.oilT)} t hoy`, k.oilPct > 90 ? 'warn' : ''],
      ['Harina', `${fmt(k.mealStock)} t`, `${fmt(k.mealPct)}% · ${fmt(k.mealT)} t hoy`, k.mealPct > 90 ? 'warn' : ''],
      ['Hexano', `${fmt(k.hexane)} m³`, `${fmt(s.proc.hexLoss, 2)} L/t pérdida`, k.hexanePct < 25 ? 'warn' : ''],
      ['Vapor', `${fmt(k.steam, 1)} bar`, `${s.boilers.filter((b) => b.on).length}/2 calderas`, k.steam < 8 ? 'bad' : ''],
      ['Camiones', `${fmt(k.trucksInPlant)} en planta`, `${fmt(k.trucksWaitingYard)} en playa · ${fmt(k.roadQueue)} en RN4`, k.roadQueue > 4 ? 'warn' : ''],
    ];
    const el = $('#kpis');
    if (!el.children.length) {
      el.innerHTML = items.map(() => '<div class="kpi"><span class="k"></span><b class="v"></b><small class="s"></small></div>').join('');
      requestAnimationFrame(() => this.layoutHud());
    }
    items.forEach(([label, v, sub, cls], i) => {
      const c = el.children[i];
      c.className = `kpi ${cls}`;
      c.children[0].textContent = label;
      c.children[1].textContent = v;
      c.children[2].textContent = sub;
    });
  }

  renderFeed(s) {
    if (!s) return;
    const sig = this.feedTab + (this.feedTab === 'problems' ? s.problems.map((p) => p.key + p.durMin).join() : s.events[0]?.id);
    $('#probCount').textContent = s.problems.length;
    $('#probCount').className = `count ${s.problems.length ? 'on' : ''}`;
    if (sig === this.feedSig) return;
    this.feedSig = sig;
    const list = $('#feedList');
    if (this.feedTab === 'problems') {
      if (!s.problems.length) {
        list.innerHTML = '<div class="empty">Sin problemas activos. Usa <b>Fallas</b> para activar fallas y probar los triggers de Zabbix.</div>';
        return;
      }
      list.innerHTML = [...s.problems]
        .sort((a, b) => b.sev - a.sev)
        .map((p) => `<div class="ev sev-${SEV_CLASS[p.sev]}" data-src="${esc(p.src)}"><i></i><div><b>${esc(p.name)}</b><small>${SEV[p.sev]} · desde ${esc(p.since)} · ${p.durMin} min</small></div></div>`)
        .join('');
    } else {
      list.innerHTML = s.events
        .map((e) => `<div class="ev sev-${SEV_CLASS[e.sev]} k-${e.kind}" data-src="${esc(e.src)}"><i></i><div><b>${esc(e.msg)}</b><small>${esc(e.time)}</small></div></div>`)
        .join('');
    }
    for (const row of list.querySelectorAll('.ev')) row.onclick = () => this.h.onSource(row.dataset.src);
  }

  // ───────────── details panel ─────────────
  showDetails(pick) {
    this.selected = pick;
    $('#details').classList.toggle('hidden', !pick);
    if (pick && this.last) this.renderDetails(pick, this.last);
  }

  renderDetails(pick, s) {
    const d = describe(pick, s);
    if (!d) {
      this.h.onSelect(null);
      return;
    }
    $('#detailsKind').textContent = d.kind;
    $('#detailsTitle').textContent = d.title;
    $('#detailsSub').textContent = d.sub || '';
    $('#detailsStatus').className = `status ${d.statusClass || ''}`;
    $('#detailsStatus').textContent = d.status || '';
    $('#detailsRows').innerHTML = d.rows
      .map(([l, v, key]) => `<tr><td>${esc(l)}</td><td class="num">${esc(v)}</td><td class="key">${key ? `<code>${esc(key)}</code>` : ''}</td></tr>`)
      .join('');
    const act = $('#detailsActions');
    const sig = JSON.stringify(d.actions || []);
    if (act.dataset.sig !== sig) {
      act.dataset.sig = sig;
      act.innerHTML = '';
      for (const a of d.actions || []) {
        const b = document.createElement('button');
        b.textContent = a.label;
        b.onclick = () => this.h.onAction(a, pick);
        act.appendChild(b);
      }
    }
    const chart = $('#detailsChart');
    if (d.chart && this.history.get(d.chart.key)?.length > 1) {
      chart.parentElement.classList.remove('hidden');
      $('#chartLabel').textContent = d.chart.label;
      sparkline(chart, this.history.get(d.chart.key), d.chart);
    } else {
      chart.parentElement.classList.add('hidden');
    }
  }
}

function sparkline(canvas, data, { min, max, unit = '' }) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  const lo = min ?? Math.min(...data);
  const hi = max ?? Math.max(...data);
  const span = hi - lo || 1;
  const x = (i) => (i / (data.length - 1)) * (w - 2) + 1;
  const y = (v) => h - 4 - ((v - lo) / span) * (h - 10);
  g.strokeStyle = 'rgba(255,255,255,0.08)';
  g.lineWidth = 1;
  for (let i = 0; i <= 2; i++) {
    g.beginPath();
    g.moveTo(0, 3 + (i * (h - 8)) / 2);
    g.lineTo(w, 3 + (i * (h - 8)) / 2);
    g.stroke();
  }
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(41,211,255,0.35)');
  grad.addColorStop(1, 'rgba(41,211,255,0)');
  g.beginPath();
  g.moveTo(x(0), h);
  data.forEach((v, i) => g.lineTo(x(i), y(v)));
  g.lineTo(x(data.length - 1), h);
  g.fillStyle = grad;
  g.fill();
  g.beginPath();
  data.forEach((v, i) => (i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v))));
  g.strokeStyle = '#29d3ff';
  g.lineWidth = 2;
  g.stroke();
  const last = data[data.length - 1];
  g.fillStyle = '#e8eef3';
  g.font = '600 11px "JetBrains Mono", monospace';
  g.textAlign = 'right';
  g.fillText(`${fmt(last, 1)}${unit}`, w - 4, 12);
}

// Problem point linked to an asset (detail panel shows a toggle for it).
const ASSET_PROBLEM = { BAL_IN: 'bal_in_net', BAL_OUT: 'bal_out_net', GATE: 'gate_net', SAMP: 'samp_fault', OL: 'ol_arm', H1: 'noria_N1', H2: 'noria_N2', N1: 'noria_N1', N2: 'noria_N2', B1: 'boiler_B1', B2: 'boiler_B2', EXT: 'hexane_leak', PREP: 'prep_power', S2: 'silo_hot_S2' };

function problemActions(s, ...ids) {
  return ids
    .map((id) => (s.problemCatalog || []).find((p) => p.id === id))
    .filter(Boolean)
    .map((p) => ({ label: p.state ? `Desactivar: ${p.name}` : `Activar: ${p.name}`, problem: p.id, active: !p.state }));
}

// Builds the details model for any selectable thing.
export function describe(pick, s) {
  const { kind, id } = pick;
  const p = s.proc;
  const k = s.kpi;
  if (kind === 'storage') {
    const def = STORAGES.find((x) => x.id === id);
    const st = s.storages.find((x) => x.id === id);
    if (!def || !st) return null;
    const hot = st.temp > 32;
    return {
      kind: def.kind === 'silo' ? 'Silo metálico' : 'Galpón granelero',
      title: def.name,
      sub: `Soya en grano · recibe por ${STATIONS[def.hopper].name}`,
      status: hot ? 'Punto caliente' : st.pct > 95 ? 'Casi lleno' : st.outflow > 0 ? 'Despachando a preparación' : 'Almacenando',
      statusClass: hot ? 'bad' : st.pct > 95 ? 'warn' : 'ok',
      rows: [
        ['Nivel', `${fmt(st.pct, 1)} %`, `planta.silo.level_pct[${id}]`],
        ['Stock', `${fmt(st.stock)} t`, `planta.silo.stock_t[${id}]`],
        ['Capacidad', `${fmt(st.cap)} t`, `planta.silo.capacity_t[${id}]`],
        ['Temperatura de grano', `${fmt(st.temp, 1)} °C`, `planta.silo.temp_c[${id}]`],
        ['Humedad de grano', `${fmt(st.hum, 1)} %`, `planta.silo.humidity_pct[${id}]`],
        ['Extracción a preparación', `${fmt(st.outflow * 60, 1)} t/h`, ''],
      ],
      chart: { key: `st.${id}.pct`, label: 'Nivel (%) — últimos minutos', min: 0, max: 100, unit: '%' },
      actions: problemActions(s, ASSET_PROBLEM[id]),
    };
  }
  if (kind === 'tank') {
    const def = OIL_TANKS.find((x) => x.id === id);
    const t = s.tanks.find((x) => x.id === id);
    return {
      kind: 'Tanque de almacenamiento',
      title: def.name,
      sub: 'Aceite crudo de soya',
      status: t.filling ? 'Recibiendo de extracción' : 'En espera',
      statusClass: t.pct > 95 ? 'warn' : 'ok',
      rows: [
        ['Nivel', `${fmt(t.pct, 1)} %`, `planta.tank.level_pct[${id}]`],
        ['Stock', `${fmt(t.stock)} t`, `planta.tank.stock_t[${id}]`],
        ['Capacidad', `${fmt(t.cap)} t`, `planta.tank.capacity_t[${id}]`],
        ['Temperatura', `${fmt(t.temp, 1)} °C`, `planta.tank.temp_c[${id}]`],
      ],
      chart: { key: `tk.${id}.pct`, label: 'Nivel (%)', min: 0, max: 100, unit: '%' },
    };
  }
  if (kind === 'dayTank') {
    const t = s.dayTanks.find((x) => x.id === id);
    return { kind: 'Tanque diario', title: `Tanque diario ${id.slice(2)}`, sub: 'Aceite desgomado / producto del día', status: 'Operativo', statusClass: 'ok', rows: [['Nivel', `${fmt(t?.pct, 1)} %`, '']] };
  }
  if (kind === 'boiler') {
    const def = BOILERS.find((x) => x.id === id);
    const b = s.boilers.find((x) => x.id === id);
    return {
      kind: 'Caldera · Sala de fuerza',
      title: def.name,
      sub: `Capacidad ${def.cap} t/h de vapor`,
      status: b.on ? 'En servicio' : 'Disparada / fuera de servicio',
      statusClass: b.on ? 'ok' : 'bad',
      rows: [
        ['Estado', b.on ? '1 (en servicio)' : '0 (detenida)', `planta.boiler.status[${id}]`],
        ['Carga', `${fmt(b.load, 1)} %`, `planta.boiler.load_pct[${id}]`],
        ['Temp. gases de chimenea', `${fmt(b.flue)} °C`, `planta.boiler.flue_temp_c[${id}]`],
        ['Presión de vapor (colector)', `${fmt(p.steam, 2)} bar`, 'planta.steam_pressure_bar'],
        ['Demanda de vapor', `${fmt(p.steamDemand, 1)} t/h`, 'planta.steam_demand_tph'],
      ],
      chart: { key: `b.${id}.load`, label: 'Carga (%)', min: 0, max: 100, unit: '%' },
      actions: problemActions(s, ASSET_PROBLEM[id]),
    };
  }
  if (kind === 'station') {
    const def = STATIONS[id];
    const st = s.stations[id];
    const down = st?.down;
    const flowing = s.flows[id];
    const extra = [];
    if (id === 'H1' || id === 'H2') extra.push(['Descargando', flowing ? 'Sí' : 'No', '']);
    if (id === 'SAMP') extra.push(['Rechazos hoy', fmt(k.rejected), 'planta.trucks_rejected_today']);
    if (id === 'GATE') extra.push(['Camiones en RN4', fmt(k.roadQueue), 'planta.trucks_waiting_road'], ['Ingresos hoy', fmt(k.trucksIn), 'planta.trucks_received_today']);
    return {
      kind: 'Punto de operación',
      title: def.name,
      sub: id.startsWith('BAL') ? 'Balanza para camiones, 80 t' : id.startsWith('H') ? 'Volcadora hidráulica + tolva + noria' : '',
      status: down ? (st?.stopped ? `Fuera de servicio · ${st.stopped} camión detenido` : 'Fuera de servicio') : st?.busy ? 'Ocupada' : 'Libre',
      statusClass: down ? 'bad' : st?.busy ? 'warn' : 'ok',
      rows: [
        ['Disponible', down ? '0' : '1', `planta.station.available[${id}]`],
        ['Red / comunicación', down && !['H1', 'H2'].includes(id) ? '0 (sin red)' : '1 (en línea)', `planta.station.network[${id}]`],
        ['Camiones en uso', `${st?.busy ?? 0} / ${st?.cap ?? 1}`, `planta.station.busy[${id}]`],
        ['Camiones detenidos', fmt(st?.stopped ?? 0), `planta.station.trucks_stopped[${id}]`],
        ['Operaciones hoy', fmt(st?.ops), `planta.station.operations_today[${id}]`],
        ...extra,
      ],
      actions: problemActions(s, ASSET_PROBLEM[id]),
    };
  }
  if (kind === 'truck') {
    const v = s.vehicles.find((x) => x.id === id);
    if (!v) return null;
    const type = { soy: 'Camión granelero · soya', oil: 'Cisterna · aceite crudo', meal: 'Camión · harina de soya' }[v.kind];
    const rows = [
      ['Patente', v.plate, ''],
      ['Chofer', v.driver, ''],
      [v.kind === 'soy' ? 'Origen' : 'Destino', v.origin, ''],
      ['Carga neta', `${fmt(v.net, 1)} t`, ''],
      ['Tara', `${fmt(v.tare, 1)} t`, ''],
      ['Llenado', `${fmt(v.loaded * 100)} %`, ''],
      ['Tiempo en planta', `${v.sinceMin} min`, ''],
    ];
    if (v.sample) rows.push(['Calado: humedad', `${fmt(v.sample.hum, 1)} %`, ''], ['Calado: impurezas', `${fmt(v.sample.imp, 1)} %`, '']);
    if (v.target) rows.push(['Destino de descarga', STORAGES.find((x) => x.id === v.target)?.name ?? v.target, '']);
    return { kind: type, title: v.plate, sub: v.label, status: v.rejected ? 'Rechazado' : v.moving ? 'En movimiento' : 'Detenido', statusClass: v.rejected ? 'bad' : 'ok', rows, actions: [{ label: 'Seguir con cámara', follow: id }] };
  }
  if (kind === 'person') {
    const pr = s.people.find((x) => x.id === id);
    return { kind: 'Operario', title: pr.name, sub: pr.role, status: pr.moving ? 'Caminando' : 'En su puesto', statusClass: 'ok', rows: [['Actividad', pr.label, ''], ['EPP', 'Casco, chaleco, botas', '']], actions: [{ label: 'Seguir con cámara', follow: id, person: true }] };
  }
  if (kind === 'building') {
    const def = BUILDINGS.find((x) => x.id === id);
    const base = { kind: 'Instalación', title: def.name, sub: '', status: 'Operativa', statusClass: 'ok', rows: [] };
    const crushing = p.feed > 0.05;
    switch (id) {
      case 'PREP':
        return { ...base, kind: 'Proceso', sub: 'Limpieza → quebrado → descascarado → acondicionado → laminado', status: crushing ? 'Procesando' : 'Detenida', statusClass: crushing ? (k.crushPct < 70 ? 'warn' : 'ok') : 'bad',
          rows: [
            ['Alimentación', `${fmt(p.feed * 60, 1)} t/h`, 'planta.crush_rate_tpd'],
            ['Capacidad utilizada', `${fmt(k.crushPct, 1)} %`, 'planta.crush_pct'],
            ['Molido hoy', `${fmt(k.crushedT)} t`, 'planta.crushed_today_t'],
            ['Temp. acondicionador', `${fmt(p.prepTemp, 1)} °C`, 'planta.prep_conditioner_temp_c'],
            ['Silo pulmón', `${fmt(s.buffer.stock)} t`, 'planta.buffer_silo_t'],
            ['Potencia eléctrica', `${fmt(p.power, 2)} MW`, 'planta.power_mw'],
          ], chart: { key: 'kpi.crushPct', label: 'Capacidad utilizada (%)', min: 0, max: 110, unit: '%' },
          actions: problemActions(s, 'prep_power') };
      case 'EXT':
        return { ...base, kind: 'Proceso · zona clasificada', sub: 'Extractor, desolventizador-tostador (DT) y destilación de miscela', status: p.extractorRun ? (crushing ? 'Extrayendo' : 'En espera') : 'Interlock: extractor detenido', statusClass: p.extractorRun ? (p.lel > 12 ? 'warn' : 'ok') : 'bad',
          rows: [
            ['Extractor en marcha', p.extractorRun ? '1' : '0', 'planta.extractor_running'],
            ['LEL hexano (ambiente)', `${fmt(p.lel, 1)} %`, 'planta.lel_pct'],
            ['Temp. extractor', `${fmt(p.extractorTemp, 1)} °C`, 'planta.extractor_temp_c'],
            ['Temp. DT', `${fmt(p.dtTemp, 1)} °C`, 'planta.dt_temp_c'],
            ['Concentración miscela', `${fmt(p.miscella, 1)} %`, 'planta.miscella_pct'],
            ['Pérdida de hexano', `${fmt(p.hexLoss, 2)} L/t`, 'planta.hexane_loss_l_per_t'],
            ['Hexano residual en harina', `${fmt(p.residualHexane)} ppm`, 'planta.meal_residual_hexane_ppm'],
            ['Producción de aceite', `${fmt(p.oilRate, 1)} t/h`, 'planta.oil_produced_today_t'],
          ], chart: { key: 'proc.lel', label: 'LEL hexano (%)', min: 0, max: 40, unit: '%' },
          actions: problemActions(s, 'hexane_leak', 'plc_ext_comm') };
      case 'HEX':
        return { ...base, kind: 'Almacenamiento de solvente', sub: 'n-Hexano · dique de contención', status: k.hexanePct < 25 ? 'Stock bajo' : 'Normal', statusClass: k.hexanePct < 25 ? 'warn' : 'ok',
          rows: [
            ['Stock', `${fmt(s.hexane.stock, 1)} m³`, 'planta.hexane_stock_m3'],
            ['Nivel', `${fmt(k.hexanePct, 1)} %`, 'planta.hexane_stock_pct'],
            ['Consumo específico', `${fmt(p.hexLoss, 2)} L/t`, 'planta.hexane_loss_l_per_t'],
          ], chart: { key: 'kpi.hexane', label: 'Stock hexano (m³)', unit: ' m³' } };
      case 'SF':
      case 'CHIM':
      case 'TE': {
        const on = s.boilers.filter((b) => b.on).length;
        return { ...base, kind: 'Energía', sub: 'Calderas, vapor de proceso, aire comprimido y energía', status: p.steam < 8 ? 'Presión baja' : 'Normal', statusClass: p.steam < 8 ? 'bad' : on < 2 ? 'warn' : 'ok',
          rows: [
            ['Presión de vapor', `${fmt(p.steam, 2)} bar`, 'planta.steam_pressure_bar'],
            ['Demanda de vapor', `${fmt(p.steamDemand, 1)} t/h`, 'planta.steam_demand_tph'],
            ['Calderas en servicio', `${on} / 2`, 'planta.boiler.status[B*]'],
            ['Potencia eléctrica', `${fmt(p.power, 2)} MW`, 'planta.power_mw'],
            ['Cascarilla (combustible)', `${fmt(s.hulls.stock)} t`, 'planta.hulls_stock_t'],
          ], chart: { key: 'proc.steam', label: 'Presión de vapor (bar)', min: 0, max: 12, unit: ' bar' },
          actions: problemActions(s, 'boiler_B1', 'boiler_B2') };
      }
      case 'GH':
        return { ...base, kind: 'Almacén de producto', sub: 'Harina de soya 46–48 % proteína', status: k.mealPct > 90 ? 'Casi lleno' : 'Normal', statusClass: k.mealPct > 90 ? 'warn' : 'ok',
          rows: [
            ['Stock', `${fmt(s.meal.stock)} t`, 'planta.meal_stock_t'],
            ['Nivel', `${fmt(k.mealPct, 1)} %`, 'planta.meal_stock_pct'],
            ['Proteína', `${fmt(p.mealProtein, 1)} %`, 'planta.meal_protein_pct'],
            ['Humedad', `${fmt(p.mealHumidity, 1)} %`, 'planta.meal_humidity_pct'],
            ['Aceite residual', `${fmt(p.residualOil, 2)} %`, 'planta.meal_residual_oil_pct'],
            ['Despachado hoy', `${fmt(k.mealDispatchedT)} t`, 'planta.meal_dispatched_today_t'],
          ], chart: { key: 'kpi.mealStock', label: 'Stock de harina (t)', unit: ' t' } };
      case 'GC':
        return { ...base, kind: 'Subproducto', sub: 'Cascarilla de soya (combustible de Caldera 1 / pellets)', rows: [['Stock', `${fmt(s.hulls.stock)} t`, 'planta.hulls_stock_t']] };
      case 'SP':
        return { ...base, kind: 'Silo pulmón', sub: 'Regula la alimentación a preparación', rows: [['Stock', `${fmt(s.buffer.stock)} t`, 'planta.buffer_silo_t'], ['Capacidad', `${fmt(s.buffer.cap)} t`, '']] };
      case 'N1':
      case 'N2': {
        const jam = (s.problemCatalog || []).some((p) => p.id === ASSET_PROBLEM[id] && p.state > 0);
        return { ...base, kind: 'Transporte de granos', sub: id === 'N1' ? 'Tolva 1 → galería → Silos 1–4' : 'Tolva 2 → Silos 5–7 y galpones', status: jam ? 'Atascada' : s.flows[id === 'N1' ? 'H1' : 'H2'] ? 'Transportando' : 'En vacío', statusClass: jam ? 'bad' : 'ok',
          rows: [['Capacidad', '250 t/h', ''], ['Disponible', jam ? '0' : '1', `planta.station.available[${id === 'N1' ? 'H1' : 'H2'}]`]],
          actions: problemActions(s, ASSET_PROBLEM[id]) };
      }
      case 'LAB':
        return { ...base, kind: 'Calidad', sub: 'Humedad, impurezas, granos dañados, proteína y aceite residual', rows: [['Camiones analizados hoy', fmt(s.stations.SAMP?.ops), ''], ['Rechazados hoy', fmt(k.rejected), 'planta.trucks_rejected_today'], ['Proteína harina', `${fmt(p.mealProtein, 1)} %`, 'planta.meal_protein_pct']] };
      default:
        return { ...base, sub: 'Resumen de planta', rows: [
          ['Recibido hoy', `${fmt(k.receivedT)} t`, 'planta.soy_received_today_t'],
          ['Molido hoy', `${fmt(k.crushedT)} t`, 'planta.crushed_today_t'],
          ['Aceite producido hoy', `${fmt(k.oilT)} t`, 'planta.oil_produced_today_t'],
          ['Harina producida hoy', `${fmt(k.mealT)} t`, 'planta.meal_produced_today_t'],
          ['Problemas activos', fmt(k.problems), 'planta.problems_active'],
        ] };
    }
  }
  return null;
}
