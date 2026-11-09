// Native implementation of the Zabbix sender protocol (same wire format as the
// zabbix_sender binary): TCP to the server/proxy trapper port (10051).
//
//   "ZBXD" | 0x01 | uint32LE data length | uint32LE reserved | JSON
//   {"request":"sender data","data":[{"host","key","value","clock","ns"}],"clock","ns"}
//
// Response: {"response":"success","info":"processed: N; failed: M; total: T; seconds spent: S"}
import net from 'node:net';

const HEADER = Buffer.from('ZBXD\x01', 'latin1');

export function encode(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const len = Buffer.alloc(8);
  len.writeUInt32LE(body.length, 0);
  len.writeUInt32LE(0, 4);
  return Buffer.concat([HEADER, len, body]);
}

export function decode(buf) {
  if (buf.length < 13 || buf.toString('latin1', 0, 4) !== 'ZBXD') throw new Error('respuesta inválida (sin cabecera ZBXD)');
  const flags = buf[4];
  if (flags & 0x02) throw new Error('respuesta comprimida no soportada');
  const large = flags & 0x04;
  const off = large ? 21 : 13;
  const len = large ? Number(buf.readBigUInt64LE(5)) : buf.readUInt32LE(5);
  return JSON.parse(buf.toString('utf8', off, off + len));
}

export function parseInfo(info = '') {
  const n = (k) => Number((info.match(new RegExp(`${k}:\\s*([\\d.]+)`)) || [])[1] ?? NaN);
  return { processed: n('processed'), failed: n('failed'), total: n('total'), seconds: n('seconds spent') };
}

// data: [{ host, key, value, clock? }]
export function sendValues({ server, port = 10051, timeoutMs = 5000 }, data) {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    const clock = Math.floor(now / 1000);
    const ns = (now % 1000) * 1e6;
    const payload = encode({
      request: 'sender data',
      data: data.map((d) => ({ host: d.host, key: d.key, value: String(d.value), clock: d.clock ?? clock, ns })),
      clock,
      ns,
    });
    const chunks = [];
    const sock = net.createConnection({ host: server, port }, () => sock.end(payload));
    sock.setTimeout(timeoutMs, () => sock.destroy(new Error(`timeout ${timeoutMs} ms conectando a ${server}:${port}`)));
    sock.on('data', (c) => chunks.push(c));
    sock.on('error', reject);
    sock.on('close', (hadError) => {
      if (hadError) return;
      try {
        const res = decode(Buffer.concat(chunks));
        if (res.response !== 'success') return reject(new Error(`Zabbix respondió: ${res.response} ${res.info ?? ''}`));
        resolve({ ...parseInfo(res.info), info: res.info });
      } catch (e) {
        reject(e);
      }
    });
  });
}
