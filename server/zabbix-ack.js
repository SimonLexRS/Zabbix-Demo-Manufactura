// Registers staff actions on the matching Zabbix problem (event.acknowledge):
//   assign   → acknowledge + message ("Técnico de redes asignado, ETA 8 min")
//   message  → message (complaints, progress)
//   escalate → message + severity +1 (plant manager escalation)
//   resolve  → message on the (possibly already resolved) event
// The problem event is found by host + trigger tag problem=<id>. It may not exist yet
// right after a fault starts (sender interval + trigger evaluation), so items retry.

const ACTION = { CLOSE: 1, ACK: 2, MESSAGE: 4, SEVERITY: 8 };

export class ZabbixAck {
  constructor({ rpc, hostId }) {
    this.rpc = rpc; // () => rpc function (throws if the API is not configured)
    this.hostId = hostId; // () => hostid of the plant host or null
    this.queue = [];
    this.stats = { sent: 0, failed: 0, dropped: 0, last: null, lastError: null };
    this.busy = false;
  }

  push(items) {
    for (const it of items) this.queue.push({ ...it, tries: 0, notBefore: 0 });
    if (this.queue.length > 200) this.queue.splice(0, this.queue.length - 200);
  }

  async findEvent(api, problem, includeResolved) {
    const params = {
      hostids: [this.hostId()],
      tags: [{ tag: 'problem', value: problem, operator: 1 }],
      output: ['eventid', 'severity', 'acknowledged', 'r_eventid'],
      sortfield: ['eventid'],
      sortorder: 'DESC',
      limit: 1,
    };
    if (includeResolved) params.recent = true;
    const [p] = await api('problem.get', params);
    return p || null;
  }

  async flush() {
    if (this.busy || !this.queue.length || !this.hostId()) return;
    this.busy = true;
    let api;
    try {
      api = this.rpc();
    } catch (e) {
      this.busy = false;
      return;
    }
    const now = Date.now();
    const keep = [];
    for (const it of this.queue.splice(0, 20)) {
      if (it.notBefore > now) {
        keep.push(it);
        continue;
      }
      try {
        const ev = await this.findEvent(api, it.problem, it.kind === 'resolve');
        if (!ev) throw Object.assign(new Error('evento aún no existe en Zabbix'), { retry: true });
        let action = ACTION.MESSAGE;
        const params = { eventids: [ev.eventid], message: it.message.slice(0, 2000) };
        if (it.kind === 'assign' && ev.acknowledged !== '1') action |= ACTION.ACK;
        if (it.kind === 'escalate') {
          const sev = Math.min(5, Number(ev.severity) + 1);
          if (sev > Number(ev.severity)) {
            action |= ACTION.SEVERITY;
            params.severity = sev;
          }
        }
        params.action = action;
        await api('event.acknowledge', params);
        this.stats.sent++;
        this.stats.last = { at: new Date().toISOString(), kind: it.kind, problem: it.problem, message: it.message };
      } catch (e) {
        it.tries++;
        if (it.tries < 10 && (e.retry || /temporar|timeout|fetch/i.test(e.message))) {
          it.notBefore = now + 15000;
          keep.push(it);
        } else {
          this.stats.failed++;
          this.stats.lastError = `${it.kind} ${it.problem}: ${e.message}`;
          if (e.retry) this.stats.dropped++;
        }
      }
    }
    this.queue.unshift(...keep);
    this.busy = false;
  }

  status() {
    return { ...this.stats, pending: this.queue.length };
  }
}
