// Creates or updates the Zabbix dashboard "<host> · Estado y CEP" by hand. The app already does
// it on every provisioning; this is for running it on its own.
//
//   ZABBIX_URL=https://zabbix.example.com ZABBIX_API_TOKEN=... node tools/create-zabbix-dashboard.mjs
//   optional: ZABBIX_HOST (default "Planta Aceitera"), ZABBIX_HOST_GROUP (default "Manufactura")
import { makeRpc } from '../server/zabbix-provision.js';
import { apiFromUrl } from '../server/config.js';
import { upsertDashboard } from '../server/zabbix-dashboard.js';

if (!process.env.ZABBIX_URL || !process.env.ZABBIX_API_TOKEN) {
  console.error('Define ZABBIX_URL y ZABBIX_API_TOKEN');
  process.exit(1);
}
const rpc = makeRpc(apiFromUrl(process.env.ZABBIX_URL), process.env.ZABBIX_API_TOKEN);
const r = await upsertDashboard(rpc, { hostName: process.env.ZABBIX_HOST || 'Planta Aceitera', groupName: process.env.ZABBIX_HOST_GROUP || 'Manufactura' });
console.log(`${r.action}: ${r.name} (id ${r.id})`);
