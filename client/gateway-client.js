/**
 * COCKPIT GATEWAY CLIENT v5.5.0
 * Bulletproof TR-064 fetcher with silent error suppression and diagnostic logging.
 */

import { createRequire } from 'module';
import { promisify } from 'util';
const require = createRequire(import.meta.url);
const tr064Lib = require('tr-064');

const GATEWAY_IP = process.env.GATEWAY_IP || '192.168.188.1';
const GATEWAY_USER = process.env.GATEWAY_USER || 'admin';
const GATEWAY_PASS = process.env.GATEWAY_PASS || '';
const DB_URL = process.env.DB_URL || 'http://localhost:3001';
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

log.info(`v5.5.0: Diagnostic Mode for ${GATEWAY_IP}`);
log.diag(`Using credentials for user: ${GATEWAY_USER}`);

let prevStats = { rx: 0, tx: 0, time: Date.now() };

async function safeCall(service, action, params = []) {
  if (!service) return null;
  const actionName = action.name || "Unknown";
  log.diag(`Calling ${actionName}...`);
  try {
    const fn = promisify(action.bind(service));
    const res = await fn(...params);
    log.success(`${actionName} returned data.`);
    return res;
  } catch (err) {
    log.error(`${actionName} FAILED: ${err.message}`);
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
    log.diag(`Initializing connection to ${GATEWAY_IP}...`);
    const dev = await initDevice(GATEWAY_IP, 49000);
    
    log.diag(`Performing login for ${GATEWAY_USER}...`);
    dev.login(GATEWAY_USER, GATEWAY_PASS);

    // 1. Device Info & Uptime
    const deviceInfo = dev.services['urn:dslforum-org:service:DeviceInfo:1'];
    if (deviceInfo) {
      const res = await safeCall(deviceInfo, deviceInfo.actions.GetInfo);
      if (res) {
        stats.uptime = parseInt(res.NewUpTime || 0);
        stats.model = res.NewModelName || "Fritz!Box";
      }
    }

    // 2. DSL Sync Status
    const commonLink = dev.services['urn:dslforum-org:service:WANCommonInterfaceConfig:1'];
    if (commonLink) {
      const res = await safeCall(commonLink, commonLink.actions.GetCommonLinkProperties);
      if (res) stats.dsl_sync = res.NewPhysicalLinkStatus || "Unknown";
    }

    // 3. Traffic Counters
    if (commonLink) {
      const rxRes = await safeCall(commonLink, commonLink.actions.GetTotalBytesReceived);
      const txRes = await safeCall(commonLink, commonLink.actions.GetTotalBytesSent);
      
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
    }

    // 4. VPN Status
    const vpn = dev.services['urn:dslforum-org:service:X_AVM-DE_VPN:1'];
    if (vpn) {
      const res = await safeCall(vpn, vpn.actions.GetVPNInfo);
      if (res) {
        const info = JSON.stringify(res);
        stats.vpn_active = info.includes('Connected') || info.includes('"1"') || info.includes('true');
      }
    }

    // 5. Gateway Logs
    const config = dev.services['urn:dslforum-org:service:DeviceConfig:1'];
    if (config) {
      const res = await safeCall(config, config.actions.GetLogs);
      if (res) stats.logs = res.NewLogData || "";
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
      system_info: { model: stats.model, platform: 'fritzbox', version: '5.5.0' },
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
