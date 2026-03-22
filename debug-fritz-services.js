import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tr064Lib = require('tr-064');
const promisify = require('util').promisify;

const GATEWAY_IP = process.env.GATEWAY_IP || '192.168.188.1';
const GATEWAY_USER = process.env.GATEWAY_USER || 'admin';
const GATEWAY_PASS = process.env.GATEWAY_PASS || '';

console.log(`Connecting to Fritz!Box at ${GATEWAY_IP}...`);
const tr064 = new tr064Lib.TR064();

async function discover() {
  try {
    const initDevice = promisify(tr064.initTR064Device.bind(tr064));
    const dev = await initDevice(GATEWAY_IP, 49000);
    dev.login(GATEWAY_USER, GATEWAY_PASS);

    console.log('\n--- Available Services ---');
    Object.keys(dev.services).forEach(s => {
      console.log(`[*] Service: ${s}`);
      const actions = Object.keys(dev.services[s].actions || {});
      if (actions.length > 0) {
        console.log(`    Actions: ${actions.join(', ')}`);
      }
    });
    console.log('\n--- Discovery Complete ---');
  } catch (err) {
    console.error('Discovery failed:', err.message);
  }
}

discover();
