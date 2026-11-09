// Values (and LLD JSON) over the Zabbix API: history.push (Zabbix 7.0+) to trapper items and
// trapper discovery rules. Only needs the Zabbix URL and an API token — no trapper port, no
// shared Docker network. Returns the same shape as sendValues() in zabbix-sender.js.
const BATCH = 500;

export async function pushValues(rpc, items) {
  let processed = 0;
  let failed = 0;
  const errors = {};
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH).map((d) => ({ host: d.host, key: d.key, value: typeof d.value === 'string' ? d.value : String(d.value), ...(d.clock ? { clock: d.clock } : {}) }));
    const r = await rpc('history.push', batch);
    const data = Array.isArray(r?.data) ? r.data : [];
    if (!data.length) {
      processed += batch.length; // older format without per-item results
      continue;
    }
    for (const x of data) {
      if (x.error) {
        failed++;
        errors[x.error] = (errors[x.error] || 0) + 1;
      } else processed++;
    }
  }
  const top = Object.entries(errors).sort((a, b) => b[1] - a[1])[0];
  return { processed, failed, total: items.length, info: top ? `${failed} rechazados: ${top[0]}` : 'ok', errors };
}
