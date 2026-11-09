// Configuration drawer: Zabbix sender, IoT devices, CEP rules and appearance.
// Talks to the server config API (admin key asked by net.js when needed).

const $ = (s, root = document) => root.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const SEV = ['Información', 'Advertencia', 'Promedio', 'Alta', 'Desastre'];
const ago = (iso) => (iso ? `hace ${Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))} s` : '—');
const sw = (on) => `<i class="switch ${on ? 'on' : ''}"></i>`;

export class ConfigPanel {
  constructor({ api, toast, appearance }) {
    this.api = api;
    this.toast = toast;
    this.appearance = appearance; // { get(): {pixel, pixelSize}, set(patch) }
    this.el = $('#config');
    this.body = $('#configBody');
    this.tab = 'zabbix';
    this.data = null;
    this.lastLive = 0;
    for (const b of this.el.querySelectorAll('[data-cfg]')) b.onclick = () => this.show(b.dataset.cfg);
    $('#configClose').onclick = () => this.close();
    this.body.addEventListener('click', (e) => this.onClick(e));
    this.body.addEventListener('change', (e) => this.onChange(e));
  }

  get isOpen() {
    return !this.el.classList.contains('hidden');
  }

  async open(tab = this.tab) {
    this.el.classList.remove('hidden');
    $('#btnConfig').classList.add('open');
    await this.show(tab);
  }

  close() {
    this.el.classList.add('hidden');
    $('#btnConfig').classList.remove('open');
  }

  async show(tab) {
    this.tab = tab;
    for (const b of this.el.querySelectorAll('[data-cfg]')) b.classList.toggle('active', b.dataset.cfg === tab);
    if (tab !== 'look') await this.load();
    this.render();
  }

  async load() {
    const r = await this.api('GET', 'api/config');
    this.data = r && r.zabbix ? r : null;
    this.loadError = this.data ? null : r?.error || 'No se pudo leer la configuración.';
  }

  async save(patch, okMsg = 'Configuración guardada y aplicada') {
    const r = await this.api('PUT', 'api/config', patch);
    if (r.cancelled) return false;
    if (r.ok === false) {
      this.toast(r.errors?.join(' · ') || r.error || 'No se pudo guardar');
      return false;
    }
    if (r.config) this.data = r.config;
    this.toast(okMsg);
    this.render();
    return true;
  }

  render() {
    if (this.tab === 'look') return (this.body.innerHTML = this.lookHtml());
    if (!this.data) return (this.body.innerHTML = `<p class="note">${esc(this.loadError)}</p>`);
    this.body.innerHTML = { zabbix: this.zabbixHtml, iot: this.iotHtml, cep: this.cepHtml }[this.tab].call(this);
  }

  // ───────────── Zabbix ─────────────
  zabbixHtml() {
    const z = this.data.zabbix;
    return `
      <h3>Envío con Zabbix sender</h3>
      <button class="cfg-switch" data-act="z-enabled"><span>Enviar datos a Zabbix</span>${sw(z.enabled)}</button>
      <div class="form" id="zform">
        <label>Servidor / proxy<input name="server" value="${esc(z.server)}" /></label>
        <label>Puerto trapper<input name="port" type="number" min="1" max="65535" value="${z.port}" /></label>
        <label>Host en Zabbix<input name="host" value="${esc(z.host)}" /></label>
        <label>Grupo de hosts<input name="hostGroup" value="${esc(z.hostGroup)}" /></label>
        <label>Intervalo de envío (s)<input name="sendInterval" type="number" min="2" max="3600" value="${z.sendInterval}" /></label>
        <label>Reenvío de LLD (s)<input name="lldInterval" type="number" min="60" max="86400" value="${z.lldInterval}" /></label>
        <label class="wide">URL de la API<input name="apiUrl" value="${esc(z.apiUrl)}" placeholder="http://zabbix-web:8080/api_jsonrpc.php" /></label>
        <label class="wide">Token de API ${z.hasToken ? `(guardado: ${esc(z.apiToken)})` : '(no configurado)'}<input name="apiToken" type="password" autocomplete="off" placeholder="${z.hasToken ? 'Dejar vacío para mantener el actual' : 'Pega el token de Zabbix'}" /></label>
        <label class="wide">Orígenes permitidos de trapper ({$TRAPPER.ALLOWED_HOSTS})<input name="trapperAllowedHosts" value="${esc(z.trapperAllowedHosts)}" /></label>
      </div>
      <div class="row-actions">
        <button class="primary" data-act="z-save">Guardar y aplicar</button>
        <button data-act="z-test">Probar conexión</button>
        <button data-act="z-provision">Re-provisionar</button>
        <button data-act="z-send">Enviar ahora</button>
      </div>
      <div id="zresult" class="result hidden"></div>
      <h3>Estado</h3>
      <div class="kv" id="zstatus">${this.zabbixStatus()}</div>
      <p class="note">${this.data.persisted ? 'La configuración se guarda en el servidor y sobrevive reinicios.' : `La configuración se aplica pero no se pudo guardar en disco${this.data.persistError ? ` (${esc(this.data.persistError)})` : ''}.`}</p>`;
  }

  zabbixStatus() {
    const s = this.data.status || {};
    const l = s.last;
    const iot = s.iot?.last;
    const send = l ? (l.error ? `error: ${l.error}` : `${l.processed} ok / ${l.failed} fallidos · ${ago(l.at)}`) : 'sin envíos aún';
    const iotTxt = iot ? (iot.error ? `error: ${iot.error}` : `${iot.devices} disp. · ${iot.processed} ok / ${iot.failed} fallidos · ${ago(iot.at)}`) : '—';
    const lld = s.lastDiscovery ? `${s.lastDiscovery.processed} ok / ${s.lastDiscovery.failed} fallidos · ${ago(s.lastDiscovery.at)}` : '—';
    const p = s.provision || {};
    const prov = p.state === 'ok' ? `ok · Zabbix ${p.version} · ${p.action}${p.iot ? ` · IoT +${p.iot.created} / ~${p.iot.updated} / off ${p.iot.disabled}` : ''}` : `${p.state}${p.detail ? ` · ${p.detail}` : ''}`;
    return `<span>Planta</span><span>${esc(send)}</span><span>IoT</span><span>${esc(iotTxt)}</span><span>LLD</span><span>${esc(lld)}</span><span>Alta</span><span>${esc(prov)}</span><span>Correlación</span><span>${esc(s.correlation?.state ?? '—')}${s.correlation?.detail ? ` · ${esc(s.correlation.detail)}` : ''}</span>`;
  }

  zabbixForm() {
    const f = $('#zform', this.body);
    const v = (n) => f.querySelector(`[name="${n}"]`).value.trim();
    const z = { server: v('server'), port: Number(v('port')), host: v('host'), hostGroup: v('hostGroup'), sendInterval: Number(v('sendInterval')), lldInterval: Number(v('lldInterval')), apiUrl: v('apiUrl'), trapperAllowedHosts: v('trapperAllowedHosts') };
    if (v('apiToken')) z.apiToken = v('apiToken');
    return z;
  }

  showResult(html) {
    const r = $('#zresult', this.body);
    if (!r) return;
    r.innerHTML = html;
    r.classList.remove('hidden');
  }

  // ───────────── IoT ─────────────
  iotHtml() {
    const i = this.data.iot;
    const devs = this.data.catalog.iot;
    return `
      <h3>Sensores IoT</h3>
      <p class="note">Cada dispositivo es un host propio en Zabbix (<code>${esc(i.hostPrefix)}&lt;id&gt;</code>, grupo <code>${esc(i.group)}</code>) que reporta por Zabbix sender: conexión, batería, RSSI y sus lecturas.</p>
      <button class="cfg-switch" data-act="iot-enabled"><span>Enviar dispositivos IoT</span>${sw(i.enabled)}</button>
      <button class="cfg-switch" data-act="iot-random"><span>Cortes de radio aleatorios (con fallas aleatorias)</span>${sw(i.randomDropouts)}</button>
      <div class="form" id="iform">
        <label>Prefijo de host<input name="hostPrefix" value="${esc(i.hostPrefix)}" /></label>
        <label>Grupo de hosts<input name="group" value="${esc(i.group)}" /></label>
      </div>
      <div class="row-actions"><button class="primary" data-act="iot-save">Guardar</button></div>
      <h3>Dispositivos (${devs.length})</h3>
      ${devs.map((d) => this.deviceHtml(d)).join('')}`;
  }

  deviceHtml(d) {
    return `
      <div class="dev" data-dev="${d.id}">
        <div class="dev-top"><b>${esc(d.name)}</b>${this.devBadge(d)}<button class="cfg-switch" style="width:auto" data-act="dev-enabled" title="Habilitar">${sw(d.enabled)}</button></div>
        <div class="dev-meta">${esc(d.type)} · host <code>${esc(this.data.iot.hostPrefix + d.id)}</code></div>
        <div class="dev-read">${this.devReadings(d)}</div>
        <div class="dev-ctl">
          <label>cada <input type="number" min="5" max="3600" data-field="interval" value="${d.interval}" /> s</label>
          <label>ruido <input type="number" min="0" max="20" step="0.5" data-field="noise" value="${d.noise}" /> %</label>
          <button class="btn ${d.offline ? 'on' : ''}" data-act="dev-offline">${d.offline ? 'Reconectar' : 'Sin conexión'}</button>
          <button class="btn ${d.lowBattery ? 'on' : ''}" data-act="dev-battery">${d.lowBattery ? 'Cambiar batería' : 'Batería baja'}</button>
        </div>
      </div>`;
  }

  devBadge(d) {
    if (!d.enabled) return '<span class="badge">deshabilitado</span>';
    return d.online ? `<span class="badge on">online · ${d.battery}% · ${d.rssi} dBm</span>` : `<span class="badge off">${d.randomOffline ? 'sin conexión (aleatoria)' : 'sin conexión'}</span>`;
  }

  devReadings(d) {
    const r = Object.entries(d.readings || {});
    return r.length ? r.map(([k, v]) => `${esc(k)}=${esc(v)}`).join(' · ') : '—';
  }

  // ───────────── CEP ─────────────
  cepHtml() {
    const c = this.data.cep;
    const rules = this.data.catalog.cepRules.rules;
    const last = this.data.catalog.cepRules.lastEvent;
    const corr = this.data.status?.correlation || {};
    return `
      <h3>Motor CEP de la app</h3>
      <p class="note">Correlaciona fallas y métricas dentro de una ventana de tiempo y genera un evento compuesto. Se envía a Zabbix como <code>planta.cep.active[regla]</code> (0 = inactiva, 1–5 = severidad) con su trigger.</p>
      <button class="cfg-switch" data-act="cep-enabled"><span>Evaluar reglas CEP</span>${sw(c.enabled)}</button>
      <p class="note">Último evento: <b>${last ? `${esc(last.time)} · ${esc(last.text)}` : '—'}</b></p>
      <div id="rules">${rules.map((r) => this.ruleHtml(r)).join('')}</div>
      <div class="row-actions"><button data-act="cep-reset">Restaurar reglas por defecto</button></div>

      <h3>Nueva regla</h3>
      <div class="form" id="newrule">
        <label class="wide">Nombre<input name="name" placeholder="Ej.: Balanza y calador caídos" /></label>
        <label>Lógica<select name="logic"><option value="AND">Todas (Y) dentro de la ventana</option><option value="OR">Cualquiera (O)</option></select></label>
        <label>Ventana (min simulados)<input name="windowMin" type="number" min="1" max="1440" value="10" /></label>
        <label class="wide">Severidad<select name="sev">${SEV.map((s, i) => `<option value="${i}" ${i === 3 ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
      </div>
      <div id="conds" style="margin-top:8px">${this.condHtml()}${this.condHtml()}</div>
      <div class="row-actions"><button data-act="cond-add">+ Condición</button><button class="primary" data-act="rule-create">Crear regla</button></div>

      <h3>Correlación en Zabbix</h3>
      <p class="note">El template ya trae <b>dependencias de triggers</b> (el síntoma se oculta mientras su causa está en problema) y tags <code>scope</code> + <code>rootcause</code>/<code>symptom</code>. La <b>correlación global</b> cierra síntomas antiguos cuando llega su causa raíz en la misma área (requiere token Super admin).</p>
      <div class="kv"><span>Estado</span><span id="corrState">${esc(corr.state ?? '—')}${corr.detail ? ` · ${esc(corr.detail)}` : ''}</span></div>
      <div class="row-actions"><button class="primary" data-act="corr-on">Activar en Zabbix</button><button data-act="corr-off">Quitar</button></div>`;
  }

  ruleHtml(r) {
    return `
      <div class="rule ${r.active ? 'active' : ''}" data-rule="${esc(r.id)}">
        <div class="rule-top"><b>${esc(r.name)}</b><span class="badge ${r.active ? 'off' : ''}">${r.active ? 'ACTIVA' : `${r.fired}×`}</span><button class="cfg-switch" style="width:auto" data-act="rule-enabled" title="Habilitar">${sw(r.enabled)}</button></div>
        <div class="rule-text">${esc(r.desc)}${r.desc ? '<br>' : ''}Si ${r.logic === 'OR' ? 'cualquiera' : 'todas'}: ${esc(r.text)}</div>
        <div class="dev-ctl">
          <label>ventana <input type="number" min="1" max="1440" data-rfield="windowMin" value="${r.windowMin}" /> min</label>
          <label>severidad <select data-rfield="sev" class="btn" style="padding:2px 4px">${SEV.map((s, i) => `<option value="${i}" ${i === r.sev ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
          <button class="btn danger" data-act="rule-delete">Eliminar</button>
        </div>
      </div>`;
  }

  condHtml() {
    const probs = this.data.catalog.problems;
    const mets = this.data.catalog.metrics;
    return `
      <div class="cond">
        <select data-c="type"><option value="problem">Falla activa</option><option value="metric">Métrica</option></select>
        <select data-c="problem">${probs.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
        <select data-c="key" class="hidden">${mets.map(([k, l]) => `<option value="${esc(k)}">${esc(l)}</option>`).join('')}</select>
        <select data-c="op" class="hidden"><option>&gt;</option><option>&lt;</option><option>=</option></select>
        <input data-c="value" type="number" step="any" value="0" class="hidden" />
        <button class="icon" data-act="cond-del" aria-label="Quitar condición">✕</button>
      </div>`;
  }

  rulesPayload(mutate) {
    const rules = this.data.catalog.cepRules.rules.map(({ id, name, desc, enabled, logic, windowMin, sev, conditions }) => ({ id, name, desc, enabled, logic, windowMin, sev, conditions }));
    return mutate(rules);
  }

  // ───────────── Apariencia ─────────────
  lookHtml() {
    const a = this.appearance.get();
    return `
      <h3>Apariencia</h3>
      <button class="cfg-switch" data-act="look-pixel"><span>Modo pixel art (render pixelado con contornos)</span>${sw(a.pixel)}</button>
      <div class="form">
        <label class="wide">Tamaño de píxel: <b id="pxv">${a.pixelSize}</b><input type="range" min="2" max="6" step="1" value="${a.pixelSize}" data-look="pixelSize" /></label>
      </div>
      <p class="note">La preferencia se guarda solo en este navegador. Con el modo pixel desactivado la escena usa la resolución completa de la pantalla.</p>`;
  }

  // ───────────── events ─────────────
  async onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    const dev = b.closest('[data-dev]')?.dataset.dev;
    const rule = b.closest('[data-rule]')?.dataset.rule;
    const z = this.data?.zabbix;
    switch (act) {
      case 'z-enabled':
        return this.save({ zabbix: { enabled: !z.enabled } }, z.enabled ? 'Envío a Zabbix pausado' : 'Envío a Zabbix activado');
      case 'z-save':
        return this.save({ zabbix: this.zabbixForm() });
      case 'z-test': {
        this.showResult('Probando…');
        const r = await this.api('POST', 'api/zabbix/test', {});
        if (r.cancelled) return;
        const line = (n, x) => `<div><b>${n}:</b> <span class="${x?.ok ? 'ok' : 'bad'}">${x?.ok ? '✔' : '✖'} ${esc(x?.detail ?? r.error ?? '')}</span></div>`;
        return this.showResult(line('Trapper (sender)', r.trapper) + line('API', r.api) + line('Token', r.token));
      }
      case 'z-provision': {
        this.showResult('Importando templates y creando hosts…');
        const r = await this.api('POST', 'api/zabbix/provision', {});
        if (r.cancelled) return;
        await this.load();
        this.render();
        return this.showResult(r.state === 'ok' ? `<span class="ok">✔ ${esc(r.action)} · IoT +${r.iot?.created ?? 0} / ~${r.iot?.updated ?? 0} / off ${r.iot?.disabled ?? 0}</span>` : `<span class="bad">✖ ${esc(r.detail || r.state || r.error)}</span>`);
      }
      case 'z-send': {
        const r = await this.api('POST', 'api/zabbix/send-now', {});
        if (r.cancelled) return;
        const s = (x) => (x ? (x.error ? `error: ${x.error}` : `${x.processed} ok / ${x.failed} fallidos`) : '—');
        return this.showResult(`Planta: ${esc(s(r.last))}<br>IoT: ${esc(s(r.iot))}`);
      }
      case 'iot-enabled':
        return this.save({ iot: { enabled: !this.data.iot.enabled } });
      case 'iot-random':
        return this.save({ iot: { randomDropouts: !this.data.iot.randomDropouts } });
      case 'iot-save': {
        const f = $('#iform', this.body);
        return this.save({ iot: { hostPrefix: f.querySelector('[name="hostPrefix"]').value.trim(), group: f.querySelector('[name="group"]').value.trim() } });
      }
      case 'dev-enabled':
      case 'dev-offline':
      case 'dev-battery': {
        const d = this.data.catalog.iot.find((x) => x.id === dev);
        const field = { 'dev-enabled': 'enabled', 'dev-offline': 'offline', 'dev-battery': 'lowBattery' }[act];
        return this.save({ iot: { devices: { [dev]: { [field]: !d[field] } } } }, `${d.name}: actualizado`);
      }
      case 'cep-enabled':
        return this.save({ cep: { enabled: !this.data.cep.enabled } });
      case 'cep-reset':
        return this.save({ cep: { rules: null } }, 'Reglas por defecto restauradas');
      case 'rule-enabled':
        return this.save({ cep: { rules: this.rulesPayload((rs) => rs.map((r) => (r.id === rule ? { ...r, enabled: !r.enabled } : r))) } });
      case 'rule-delete':
        return this.save({ cep: { rules: this.rulesPayload((rs) => rs.filter((r) => r.id !== rule)) } }, 'Regla eliminada');
      case 'cond-add':
        return $('#conds', this.body).insertAdjacentHTML('beforeend', this.condHtml());
      case 'cond-del':
        return b.closest('.cond').remove();
      case 'rule-create':
        return this.createRule();
      case 'corr-on':
      case 'corr-off': {
        const r = await this.api('POST', 'api/zabbix/correlation', { enable: act === 'corr-on' });
        if (r.cancelled) return;
        $('#corrState', this.body).textContent = `${r.state ?? 'error'}${r.detail ? ` · ${r.detail}` : ''}`;
        return this.toast(r.state === 'error' ? `Correlación: ${r.detail}` : `Correlación en Zabbix: ${r.state}`);
      }
      case 'look-pixel': {
        const a = this.appearance.get();
        this.appearance.set({ pixel: !a.pixel });
        return this.render();
      }
    }
  }

  async onChange(e) {
    const t = e.target;
    if (t.dataset.c === 'type') {
      const row = t.closest('.cond');
      const metric = t.value === 'metric';
      row.querySelector('[data-c="problem"]').classList.toggle('hidden', metric);
      for (const k of ['key', 'op', 'value']) row.querySelector(`[data-c="${k}"]`).classList.toggle('hidden', !metric);
      return;
    }
    if (t.dataset.look === 'pixelSize') {
      this.appearance.set({ pixelSize: Number(t.value) });
      $('#pxv', this.body).textContent = t.value;
      return;
    }
    const dev = t.closest('[data-dev]')?.dataset.dev;
    if (dev && t.dataset.field) return this.save({ iot: { devices: { [dev]: { [t.dataset.field]: Number(t.value) } } } }, 'Dispositivo actualizado');
    const rule = t.closest('[data-rule]')?.dataset.rule;
    if (rule && t.dataset.rfield) {
      const val = Number(t.value);
      return this.save({ cep: { rules: this.rulesPayload((rs) => rs.map((r) => (r.id === rule ? { ...r, [t.dataset.rfield]: val } : r))) } }, 'Regla actualizada');
    }
  }

  createRule() {
    const f = $('#newrule', this.body);
    const name = f.querySelector('[name="name"]').value.trim();
    if (!name) return this.toast('Ponle un nombre a la regla');
    const conditions = [...this.body.querySelectorAll('#conds .cond')].map((row) => {
      const g = (k) => row.querySelector(`[data-c="${k}"]`).value;
      return g('type') === 'problem' ? { type: 'problem', id: g('problem') } : { type: 'metric', key: g('key'), op: g('op'), value: Number(g('value')) };
    });
    if (!conditions.length) return this.toast('Agrega al menos una condición');
    const rule = { name, logic: f.querySelector('[name="logic"]').value, windowMin: Number(f.querySelector('[name="windowMin"]').value), sev: Number(f.querySelector('[name="sev"]').value), enabled: true, desc: 'Regla creada desde el panel.', conditions };
    return this.save({ cep: { rules: this.rulesPayload((rs) => [...rs, rule]) } }, `Regla «${name}» creada`);
  }

  // Live refresh of status, device badges and rule states (from the 5 Hz snapshot).
  updateLive(s) {
    if (!this.isOpen || !this.data || performance.now() - this.lastLive < 1000) return;
    this.lastLive = performance.now();
    if (s.zabbix) {
      this.data.status = { ...(this.data.status || {}), last: s.zabbix.last, iot: { ...(this.data.status?.iot || {}), last: s.zabbix.iot }, provision: { ...(this.data.status?.provision || {}), state: s.zabbix.provision }, correlation: { ...(this.data.status?.correlation || {}), state: s.zabbix.correlation } };
      const zs = $('#zstatus', this.body);
      if (zs) zs.innerHTML = this.zabbixStatus();
    }
    if (this.tab === 'iot' && s.iot) {
      for (const d of s.iot.devices) {
        const el = this.body.querySelector(`[data-dev="${d.id}"]`);
        if (!el) continue;
        const cur = this.data.catalog.iot.find((x) => x.id === d.id);
        Object.assign(cur, d);
        el.querySelector('.badge').outerHTML = this.devBadge(d);
        el.querySelector('.dev-read').innerHTML = this.devReadings(d);
      }
    }
    if (this.tab === 'cep' && s.cep) {
      for (const r of s.cep.rules) {
        const el = this.body.querySelector(`[data-rule="${CSS.escape(r.id)}"]`);
        if (!el) continue;
        el.classList.toggle('active', r.active);
        const badge = el.querySelector('.badge');
        badge.className = `badge ${r.active ? 'off' : ''}`;
        badge.textContent = r.active ? 'ACTIVA' : `${r.fired}×`;
      }
    }
  }
}
