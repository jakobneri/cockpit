/**
 * COCKPIT GATEWAY CLIENT v5.4.5
 * Bulletproof TR-064 fetcher with silent error suppression for incompatible models.
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
  success: (msg) => console.log(`[${new Date().toLocaleTimeString()}] ✅ ${msg}`),
  warn: (msg) => console.log(`[${new Date().toLocaleTimeString()}] ⚠️  ${msg}`),
  error: (msg) => console.log(`[${new Date().toLocaleTimeString()}] ❌ ${msg}`),
  report: (msg) => console.log(`[${new Date().toLocaleTimeString()}] 📤 ${msg}`)
};

log.info(`v5.4.5: Initializing for ${GATEWAY_IP}`);

let prevStats = { rx: 0, tx: 0, time: Date.now() };

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
    const dev = await initDevice(GATEWAY_IP, 49000);
    dev.login(GATEWAY_USER, GATEWAY_PASS);

    // 1. Device Info & Uptime
    try {
      const deviceInfo = dev.services['urn:dslforum-org:service:DeviceInfo:1'];
      if (deviceInfo) {
        const getInfo = promisify(deviceInfo.actions.GetInfo);
        const res = await getInfo();
        stats.uptime = parseInt(res.NewUpTime || 0);
        stats.model = res.NewModelName || "Fritz!Box";
      }
    } catch (e) {}

    // 2. DSL Sync Status
    try {
      const commonLink = dev.services['urn:dslforum-org:service:WANCommonInterfaceConfig:1'];
      if (commonLink) {
        const getProps = promisify(commonLink.actions.GetCommonLinkProperties);
        const res = await getProps();
        stats.dsl_sync = res.NewPhysicalLinkStatus || "Unknown";
      }
    } catch (e) {}

    // 3. Traffic Counters & Speed
    try {
      const commonLink = dev.services['urn:dslforum-org:service:WANCommonInterfaceConfig:1'];
      if (commonLink) {
        const getRx = promisify(commonLink.actions.GetTotalBytesReceived);
        const getTx = promisify(commonLink.actions.GetTotalBytesSent);
        const [rxRes, txRes] = await Promise.all([getRx(), getTx()]);
        
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
    } catch (e) {}

    // 4. VPN Status
    try {
      const vpn = dev.services['urn:dslforum-org:service:X_AVM-DE_VPN:1'];
      if (vpn) {
        const getVpn = promisify(vpn.actions.GetVPNInfo);
        const res = await getVpn();
        const info = JSON.stringify(res);
        stats.vpn_active = info.includes('Connected') || info.includes('"1"') || info.includes('true');
      }
    } catch (e) {}

    // 5. Gateway Logs
    try {
      const config = dev.services['urn:dslforum-org:service:DeviceConfig:1'];
      if (config) {
        const getLogs = promisify(config.actions.GetLogs);
        const res = await getLogs();
        stats.logs = res.NewLogData || "";
      }
    } catch (e) {}

    return stats;
  } catch (err) {
    throw new Error(`Connection failed: ${err.message}`);
  }
}

async function report() {
  try {
    const stats = await fetchStats();
    
    const payload = {
      hostname: HOSTNAME,
      reported_at: new Date().toISOString(),
      system_info: { model: stats.model, platform: 'fritzbox', version: '5.4.5' },
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
      log.report(`Successful | Sync: ${stats.dsl_sync} | Speed: ${stats.rx_sec.toFixed(1)}k/s`);
    } else {
      log.error(`DB Error: ${res.statusText}`);
    }
  } catch (err) {
    log.error(`Cycle failed: ${err.message}`);
  }
}

// Initial delay to let PM2 settle
setTimeout(() => {
  setInterval(report, POLL_INTERVAL);
  report();
}, 2000);
