/**
 * COCKPIT GATEWAY CLIENT v5.4.0
 * Fetches metrics from Fritz!Box via TR-064 library.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tr064Lib = require('tr-064');

const GATEWAY_IP = process.env.GATEWAY_IP || '192.168.188.1';
const GATEWAY_USER = process.env.GATEWAY_USER || 'admin';
const GATEWAY_PASS = process.env.GATEWAY_PASS || '';
const DB_URL = process.env.DB_URL || 'http://localhost:3001';
const HOSTNAME = process.env.HOSTNAME || `${GATEWAY_IP}-gateway-client`;
const POLL_INTERVAL = 15000;

// Logging Utility
const log = {
  info: (msg) => console.log(`[${new Date().toLocaleTimeString()}] ℹ️  ${msg}`),
  success: (msg) => console.log(`[${new Date().toLocaleTimeString()}] ✅ ${msg}`),
  warn: (msg) => console.log(`[${new Date().toLocaleTimeString()}] ⚠️  ${msg}`),
  error: (msg) => console.log(`[${new Date().toLocaleTimeString()}] ❌ ${msg}`),
  report: (msg) => console.log(`[${new Date().toLocaleTimeString()}] 📤 ${msg}`),
  update: (msg) => console.log(`[${new Date().toLocaleTimeString()}] 🔄 ${msg}`)
};

log.info(`Cockpit Gateway Client v5.3.7 starting for ${GATEWAY_IP}`);
const tr064 = new tr064Lib.TR064();

// Global state for delta calculation
let prevStats = {
  rx_total: 0,
  tx_total: 0,
  time: Date.now()
};

async function getFritzBoxData() {
  return new Promise((resolve, reject) => {
    tr064.initTR064Device(GATEWAY_IP, 49000, (err, dev) => {
      if (err) return reject(new Error(`Fritz!Box Init failed: ${err.message}`));
      dev.login(GATEWAY_USER, GATEWAY_PASS);
      
      const stats = {
        uptime: 0,
        model: "Fritz!Box",
        dsl_sync: "Unknown",
        rx_sec: 0,
        tx_sec: 0,
        vpn_active: false
      };

      const devInfo = dev.services['urn:dslforum-org:service:DeviceInfo:1'];
      if (!devInfo) return reject(new Error('DeviceInfo service not found.'));

      devInfo.actions.GetInfo((err, result) => {
        if (!err && result) {
          stats.uptime = parseInt(result.NewUpTime || 0);
          stats.model = result.NewModelName || "Fritz!Box";
        }

        const commonLink = dev.services['urn:dslforum-org:service:WANCommonInterfaceConfig:1'];
        if (commonLink) {
          commonLink.actions.GetCommonLinkProperties((err, linkResult) => {
            if (!err && linkResult) stats.dsl_sync = linkResult.NewPhysicalLinkStatus || "Unknown";

            // Use Total Bytes delta for reliable speed calculation (v5.3.6)
            commonLink.actions.GetTotalBytesReceived((err, rxResult) => {
              commonLink.actions.GetTotalBytesSent((err, txResult) => {
                const now = Date.now();
                const rx_total = parseInt(rxResult?.NewTotalBytesReceived || 0);
                const tx_total = parseInt(txResult?.NewTotalBytesSent || 0);
                
                if (prevStats.rx_total > 0) {
                  const dt = (now - prevStats.time) / 1000;
                  if (dt > 0) {
                    stats.rx_sec = Math.max(0, (rx_total - prevStats.rx_total) / 1024 / dt);
                    stats.tx_sec = Math.max(0, (tx_total - prevStats.tx_total) / 1024 / dt);
                  }
                }
                
                prevStats = { rx_total, tx_total, time: now };
                processVPN(dev, stats, resolve);
              });
            });
          });
        } else {
          resolve(stats);
        }
      });
    });
  });
}

function processVPN(dev, stats, resolve) {
  const vpnService = dev.services['urn:dslforum-org:service:X_AVM-DE_VPN:1'];
  if (vpnService && vpnService.actions.GetVPNInfo) {
    vpnService.actions.GetVPNInfo((err, vpnResult) => {
      if (!err && vpnResult) {
        const info = JSON.stringify(vpnResult);
        stats.vpn_active = info.includes('Connected') || info.includes('"1"') || info.includes('true');
      }
      resolve(stats);
    });
  } else {
    resolve(stats);
  }
}

async function report() {
  try {
    const fbData = await getFritzBoxData();
    const deviceConfig = dev.services['urn:dslforum-org:service:DeviceConfig:1'];

    // Collect Logs (v5.3.23)
    let fbLogs = "";
    if (deviceConfig) {
      try {
        const getLogs = promisify(deviceConfig.actions.GetLogs);
        const logRes = await getLogs();
        fbLogs = logRes.NewLogData || "";
      } catch (e) {}
    }

    const payload = {
      hostname: HOSTNAME,
      stats: {
        cpu: { load: 0, temp: 0 },
        memory: { total: 0, used: 0, percent: 0 },
        network: { tx_sec: fbData.tx_sec, rx_sec: fbData.rx_sec },
        storage: { root: { total: 0, used: 0, percent: 0 } },
        uptime: fbData.uptime,
        gateway: {
          dsl_sync: fbData.dsl_sync,
          vpn_active: fbData.vpn_active,
          model: fbData.model,
          logs: fbLogs
        }
      },
      reported_at: new Date().toISOString(),
      system_info: {
        model: fbData.model,
        platform: 'fritzbox',
        version: '5.3.23'
      }
    };

    const response = await fetch(`${DB_URL}/rpc/report_client_metrics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'params=single-object' },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      const result = await response.json();
      log.report(`Reporting Successful | Table: ${result.table} | ID: ${result.new_id || '?'} | Total: ${result.history_count || '?'} rows`);
    }
  } catch (err) {
    log.error(`Collection Cycle failed: ${err.message}`);
  }
}

setTimeout(() => {
  setInterval(report, POLL_INTERVAL);
  report();
}, 2000);
