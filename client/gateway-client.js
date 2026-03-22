/**
 * COCKPIT GATEWAY CLIENT v5.6.12
 * Bug fix: Removed crash on undefined actions.
 * Added: Clearer authentication diagnostics.
 */

import { createRequire } from 'module';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const tr064Lib = require('tr-064');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 1. CONFIG RESOLUTION (ENV > cockpit.config.json > Defaults)
let GATEWAY_IP = process.env.GATEWAY_IP;
let GATEWAY_USER = process.env.GATEWAY_USER;
let GATEWAY_PASS = process.env.GATEWAY_PASS;
let DB_URL = process.env.DB_URL || 'http://127.0.0.1:3001';

// Try to read config if variables are missing
try {
  const configPath = path.join(__dirname, '../config.json');
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    
    // Support custom DB_URL from config for remote clients
    if (!process.env.DB_URL && config.db_url) {
      log.info(`Using DB_URL from config: ${config.db_url}`);
      DB_URL = config.db_url;
    }

    const gateways = config.gateways || [];
    
    // Find either the matching IP or just pick the first one if ENV is empty
    const match = GATEWAY_IP 
      ? gateways.find(g => g.ip === GATEWAY_IP) 
      : gateways[0];

    if (match) {
      if (!GATEWAY_IP) GATEWAY_IP = match.ip;
      if (!GATEWAY_USER) GATEWAY_USER = match.user;
      if (!GATEWAY_PASS) GATEWAY_PASS = match.password;
    }
  }
} catch (e) {
  // Silent fail, use ENVs or defaults
}

// Final defaults
GATEWAY_IP = GATEWAY_IP || '192.168.188.1';
GATEWAY_USER = GATEWAY_USER || 'admin';
GATEWAY_PASS = GATEWAY_PASS || '';

const HOSTNAME = process.env.HOSTNAME || `${GATEWAY_IP}-gateway-client`;
const POLL_INTERVAL = 15000;

const log = {
  info: (msg) => console.log(`[${new Date().toLocaleTimeString()}] ℹ️  ${msg}`),
  diag: (msg) => console.log(`[${new Date().toLocaleTimeString()}] 🔍 DIALOG: ${msg}`),
  success: (msg) => console.log(`[${new Date().toLocaleTimeString()}] ✅ ${msg}`),
  warn: (msg) => console.log(`[${new Date().toLocaleTimeString()}] ⚠️  ${msg}`),
  error: (msg) => console.log(`[${new Date().toLocaleTimeString()}] ❌ ${msg}`),
  report: (msg) => console.log(`[${new Date().toLocaleTimeString()}] 📤 ${msg}`)
};

log.info(`v5.6.3: Initializing for ${GATEWAY_IP}`);

let prevStats = { rx: 0, tx: 0, time: Date.now() };

async function safeCall(service, action, actionName = "Unknown") {
  if (!service || !action) {
    log.diag(`Skipping ${actionName} (Service/Action not found)`);
    return null;
  }
  
  log.diag(`Calling ${actionName}...`);
  try {
    const fn = promisify(action.bind(service));
    const res = await fn();
    log.success(`${actionName} successful.`);
    return res;
  } catch (err) {
    if (err.message.includes('401')) {
      log.error(`${actionName} FAILED with 401 CUSTOMER: Check your PASSWORD or if this action is restricted!`);
    } else {
      log.error(`${actionName} FAILED: ${err.message}`);
    }
    return null;
  }
}

async function fetchStats() {
  const tr064 = new tr064Lib.TR064();
  const initDevice = promisify(tr064.initTR064Device.bind(tr064));
  
  const stats = {
    uptime: 0,
    model: "Fritz!Box",
    dsl_sync: "Unknown",
    vpn_active: false,
    rx_sec: 0,
    tx_sec: 0,
    logs: ""
  };

  try {
    log.diag(`Connecting to ${GATEWAY_IP}...`);
    const dev = await initDevice(GATEWAY_IP, 49000);
    
    log.diag(`Attempting login for user: ${GATEWAY_USER}`);
    dev.login(GATEWAY_USER, GATEWAY_PASS);

    // 1. Device Info & Uptime
    const deviceInfo = dev.services['urn:dslforum-org:service:DeviceInfo:1'];
    const res = await safeCall(deviceInfo, deviceInfo?.actions?.GetInfo, 'GetInfo');
    if (res) {
      stats.uptime = parseInt(res.NewUpTime || 0);
      stats.model = res.NewModelName || "Fritz!Box";
    } else if (stats.uptime === 0) {
      log.warn("Could not fetch GetInfo. This is usually due to WRONG CREDENTIALS.");
    }

    // 2. DSL Sync Status
    const commonLink = dev.services['urn:dslforum-org:service:WANCommonInterfaceConfig:1'];
    const syncRes = await safeCall(commonLink, commonLink?.actions?.GetCommonLinkProperties, 'GetCommonLinkProperties');
    if (syncRes) stats.dsl_sync = syncRes.NewPhysicalLinkStatus || "Unknown";

    // 3. Traffic Counters
    const rxRes = await safeCall(commonLink, commonLink?.actions?.GetTotalBytesReceived, 'GetTotalBytesReceived');
    const txRes = await safeCall(commonLink, commonLink?.actions?.GetTotalBytesSent, 'GetTotalBytesSent');
    
    if (rxRes && txRes) {
      const now = Date.now();
      const rx = parseInt(rxRes.NewTotalBytesReceived || 0);
      const tx = parseInt(txRes.NewTotalBytesSent || 0);
      
      if (prevStats.rx > 0) {
        const dt = (now - prevStats.time) / 1000;
        if (dt > 0) {
          stats.rx_sec = Math.max(0, (rx - prevStats.rx) / 1024 / dt);
          stats.tx_sec = Math.max(0, (tx - prevStats.tx) / 1024 / dt);
        }
      }
      prevStats = { rx, tx, time: now };
    }

    // 4. VPN Status (v5.6.12: Improved check)
    const vpn = dev.services['urn:dslforum-org:service:X_AVM-DE_VPN:1'];
    if (vpn) {
      const vpnRes = await safeCall(vpn, vpn?.actions?.GetVPNInfo, 'GetVPNInfo');
      if (vpnRes) {
        const info = JSON.stringify(vpnRes);
        stats.vpn_active = info.includes('Connected') || info.includes('"1"') || info.includes('true');
      }
    } else {
      log.diag("VPN service (X_AVM-DE_VPN) not available on this gateway.");
    }

    // 5. Gateway Logs (v5.6.12: Dual-mode fallback)
    const deviceConfig = dev.services['urn:dslforum-org:service:DeviceConfig:1'];
    // deviceInfo is already defined on line 117
    
    let logRes = await safeCall(deviceConfig, deviceConfig?.actions?.GetLogs, 'GetLogs (Primary)');
    if (!logRes) {
      logRes = await safeCall(deviceInfo, deviceInfo?.actions?.GetDeviceLog, 'GetDeviceLog (Fallback)');
    }
    
    if (logRes) {
      stats.logs = logRes.NewLogData || logRes.NewDeviceLog || "";
    }

    return stats;
  } catch (err) {
    throw new Error(`Device Initialization failed: ${err.message}`);
  }
}

async function report() {
  try {
    const stats = await fetchStats();
    
    const payload = {
      hostname: HOSTNAME,
      reported_at: new Date().toISOString(),
      system_info: { model: stats.model, platform: 'fritzbox', version: '5.5.1' },
      stats: {
        cpu: { load: 0, temp: 0 },
        memory: { total: 0, used: 0, percent: 0 },
        network: { tx_sec: stats.tx_sec, rx_sec: stats.rx_sec },
        storage: { root: { total: 0, used: 0, percent: 0 } },
        uptime: stats.uptime,
        gateway: { dsl_sync: stats.dsl_sync, vpn_active: stats.vpn_active, model: stats.model, logs: stats.logs }
      }
    };

    const res = await fetch(`${DB_URL}/rpc/report_client_metrics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'params=single-object' },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      log.report(`Reporting Successful for ${HOSTNAME}`);
    } else {
      log.error(`DB Error: ${res.statusText}`);
    }
  } catch (err) {
    log.error(`Cycle failed: ${err.message}`);
  }
}

setTimeout(() => {
  setInterval(report, POLL_INTERVAL);
  report();
}, 2000);
