/**
 * COCKPIT FRITZ!BOX DEBUGGER
 * Usage: node client/debug-fritz.js [IP]
 * If no IP is provided, it uses the first one in config.json
 */

import { createRequire } from 'module';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const tr064Lib = require('tr-064');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function debug() {
  let targetIp = process.argv[2];
  let targetUser = 'admin';
  let targetPass = '';

  // 1. Try to load defaults from config.json
  const configPath = path.join(__dirname, '../config.json');
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const gw = targetIp ? config.gateways.find(g => g.ip === targetIp) : config.gateways[0];
    if (gw) {
      targetIp = gw.ip;
      targetUser = gw.user;
      targetPass = gw.password;
    }
  }

  if (!targetIp) {
    console.error("❌ No IP provided and no config.json found!");
    process.exit(1);
  }

  console.log(`\n🔍 DEBUGGING FRITZ!BOX: ${targetIp}`);
  console.log(`👤 User: ${targetUser}\n`);

  const tr064 = new tr064Lib.TR064();
  const initDevice = promisify(tr064.initTR064Device.bind(tr064));

  try {
    console.log("📡 Connecting...");
    const dev = await initDevice(targetIp, 49000);
    
    console.log("🔐 Logging in...");
    dev.login(targetUser, targetPass);

    console.log("\n✅ SERVICES DISCOVERED:");
    const serviceIds = Object.keys(dev.services);
    serviceIds.forEach(id => {
      console.log(` - ${id}`);
    });

    console.log("\n🧪 TESTING FAILING ACTIONS:");

    // Helper to test an action
    async function testAction(serviceId, actionName) {
      const service = dev.services[serviceId];
      if (!service) {
        console.log(` ❌ Service [${serviceId}] NOT FOUND on this device.`);
        return;
      }
      
      const action = service.actions[actionName];
      if (!action) {
        console.log(` ❌ Action [${actionName}] NOT FOUND in service [${serviceId}].`);
        return;
      }

      console.log(` 🚀 Calling ${serviceId} -> ${actionName}...`);
      try {
        const fn = promisify(action.bind(service));
        const res = await fn();
        console.log(` ✨ SUCCESS:`, JSON.stringify(res, null, 2));
      } catch (err) {
        console.log(` 🛑 ERROR ${err.message}`);
        if (err.message.includes('401')) {
          console.log(`    💡 Rationale: 401 means "Insufficient Rights". Check Fritz!Box User permissions (App access).`);
        } else if (err.message.includes('500')) {
          console.log(`    💡 Rationale: 500 means "Internal Error" or "Invalid Action". This service might exist but be blocked or unsupported.`);
        }
      }
    }

    await testAction('urn:dslforum-org:service:DeviceInfo:1', 'GetInfo');
    await testAction('urn:dslforum-org:service:WANCommonInterfaceConfig:1', 'GetCommonLinkProperties');
    await testAction('urn:dslforum-org:service:WANCommonInterfaceConfig:1', 'GetTotalBytesReceived');
    
    console.log("\n💡 DONE. If 'DeviceInfo' worked but others didn't, it's definitely a permission issue in your Fritz!Box UI.");

  } catch (err) {
    console.error(`\n❌ FAILED TO INITIALIZE: ${err.message}`);
  }
}

debug();
