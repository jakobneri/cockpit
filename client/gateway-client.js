/**
 * COCKPIT GATEWAY CLIENT v5.0.1
 * Fetches metrics from Fritz!Box via TR-064 library.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tr064 = require('tr-064');

const GATEWAY_IP = process.env.GATEWAY_IP || '192.168.188.1';
const GATEWAY_USER = process.env.GATEWAY_USER || 'admin';
const GATEWAY_PASS = process.env.GATEWAY_PASS || '';
const DB_URL = process.env.DB_URL || 'http://localhost:3000';
const HOSTNAME = process.env.HOSTNAME || `${GATEWAY_IP}-gateway-client`;
const POLL_INTERVAL = 15000;

const log = {
  info: (msg) => console.log(`[${new Date().toLocaleTimeString()}] ℹ️  ${msg}`),
  report: (msg) => console.log(`[${new Date().toLocaleTimeString()}] 📤 ${msg}`),
  error: (msg) => console.log(`[${new Date().toLocaleTimeString()}] ❌ ${msg}`)
};

log.info(`Starting Gateway Client v5.0.1 for ${GATEWAY_IP}`);

const device = new tr064.TR064();

async function getFritzBoxData() {
  return new Promise((resolve, reject) => {
    device.initDevice(GATEWAY_IP, 49000, (err, dev) => {
      if (err) return reject(new Error(`Initalization failed: ${err.message}`));
      
      dev.login(GATEWAY_USER, GATEWAY_PASS);
      
      const stats = {
        uptime: 0,
        model: "Fritz!Box",
        dsl_sync: "Unknown",
        rx_sec: 0,
        tx_sec: 0,
        vpn_active: false
      };

      // 1. Device Info
      const devInfo = dev.services['urn:dslforum-org:service:DeviceInfo:1'];
      devInfo.actions.GetInfo((err, result) => {
        if (!err && result) {
          stats.uptime = parseInt(result.NewUpTime || 0);
          stats.model = result.NewModelName || "Fritz!Box";
        }

        // 2. DSL & Network Stats
        const commonLink = dev.services['urn:dslforum-org:service:WANCommonInterfaceConfig:1'];
        commonLink.actions.GetCommonLinkProperties((err, linkResult) => {
          if (!err && linkResult) {
            stats.dsl_sync = linkResult.NewPhysicalLinkStatus || "Unknown";
          }

          commonLink.actions.GetAddonInfos((err, addonResult) => {
            if (!err && addonResult) {
              stats.rx_sec = parseInt(addonResult.NewByteReceiveRate || 0) / 1024;
              stats.tx_sec = parseInt(addonResult.NewByteSendRate || 0) / 1024;
            }

            // 3. VPN Status (Try X_AVM-DE_VPN)
            const vpnService = dev.services['urn:dslforum-org:service:X_AVM-DE_VPN:1'];
            if (vpnService) {
              vpnService.actions.GetVPNInfo((err, vpnResult) => {
                // VPN info is often a long XML string in NewVPNInfo
                if (!err && vpnResult) {
                  const info = JSON.stringify(vpnResult);
                  stats.vpn_active = info.includes('Connected') || info.includes('1');
                }
                resolve(stats);
              });
            } else {
              resolve(stats);
            }
          });
        });
      });
    });
  });
}

async function report() {
  try {
    const fbData = await getFritzBoxData();
    
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
          model: fbData.model
        }
      },
      reported_at: new Date().toISOString(),
      system_info: {
        model: fbData.model,
        platform: 'fritzbox',
        version: '5.0.1'
      }
    };

    const response = await fetch(`${DB_URL}/rpc/report_client_metrics`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Prefer': 'params=single-object'
      },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      log.report(`Status: ${response.status} | Sync: ${fbData.dsl_sync} | VPN: ${fbData.vpn_active}`);
    } else {
      log.error(`Reporting failed: ${response.status}`);
    }
  } catch (err) {
    log.error(`Collection failed: ${err.message}`);
  }
}

// Initial delay to let PM2 settle
setTimeout(() => {
  setInterval(report, POLL_INTERVAL);
  report();
}, 2000);
