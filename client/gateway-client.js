/**
 * COCKPIT GATEWAY CLIENT v5.0.0
 * Fetches metrics from Fritz!Box via TR-064 SOAP API.
 */

import os from 'os';

const GATEWAY_IP = process.env.GATEWAY_IP || '192.168.178.1';
const GATEWAY_USER = process.env.GATEWAY_USER || 'admin';
const GATEWAY_PASS = process.env.GATEWAY_PASS || '';
const DB_URL = process.env.DB_URL || 'http://localhost:3000';
const HOSTNAME = process.env.HOSTNAME || `${GATEWAY_IP}-gateway-client`;
const POLL_INTERVAL = 10000;

const log = {
  info: (msg) => console.log(`[${new Date().toLocaleTimeString()}] ℹ️  ${msg}`),
  report: (msg) => console.log(`[${new Date().toLocaleTimeString()}] 📤 ${msg}`),
  error: (msg) => console.log(`[${new Date().toLocaleTimeString()}] ❌ ${msg}`)
};

log.info(`Starting Gateway Client for ${GATEWAY_IP} as ${HOSTNAME}`);

/** ── SOAP Helper ── **/
async function soapRequest(service, action, params = '') {
  const url = `http://${GATEWAY_IP}:49000/upnp/control/${service}`;
  const soapAction = `urn:dslforum-org:service:${service}:1#${action}`;
  
  const body = `<?xml version="1.0" encoding="utf-8"?>
    <s:Envelope s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
      <s:Body>
        <u:${action} xmlns:u="urn:dslforum-org:service:${service}:1">
          ${params}
        </u:${action}>
      </s:Body>
    </s:Envelope>`;

  // Base64 Auth
  const auth = Buffer.from(`${GATEWAY_USER}:${GATEWAY_PASS}`).toString('base64');

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'SOAPACTION': `"${soapAction}"`,
        'Authorization': `Basic ${auth}`
      },
      body
    });

    if (!res.ok) {
      if (res.status === 401) throw new Error('Auth failed (Check user/pass)');
      throw new Error(`HTTP ${res.status}`);
    }

    return await res.text();
  } catch (err) {
    throw err;
  }
}

function parseXmlTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>(.*?)</${tag}>`));
  return match ? match[1] : null;
}

/** ── Metrics Collection ── **/
async function getMetrics() {
  const stats = {
    cpu: { load: 0, temp: 0 },
    memory: { total: 0, used: 0, percent: 0 },
    network: { tx_sec: 0, rx_sec: 0 },
    storage: { root: { total: 0, used: 0, percent: 0 } },
    uptime: 0,
    gateway: {
      dsl_sync: "Unknown",
      dsl_crashes: 0,
      vpn_active: false,
      model: "Fritz!Box"
    }
  };

  try {
    // 1. Device Info (Uptime & Model)
    try {
      const devInfo = await soapRequest('DeviceInfo', 'GetInfo');
      stats.uptime = parseInt(parseXmlTag(devInfo, 'NewUpTime') || 0);
      stats.gateway.model = parseXmlTag(devInfo, 'NewModelName') || "Fritz!Box";
    } catch (e) { log.error(`DeviceInfo failed: ${e.message}`); }

    // 2. DSL Sync & Stats
    try {
      const dslInfo = await soapRequest('WANCommonInterfaceConfig', 'GetCommonLinkProperties');
      stats.gateway.dsl_sync = parseXmlTag(dslInfo, 'NewPhysicalLinkStatus') || "Disconnected";
      
      const addonInfo = await soapRequest('WANCommonInterfaceConfig', 'GetAddonInfos');
      // We interpret 'NewX_AVM_DE_DSLConectionStats' or similar if available
      // For now, let's just get throughput
      stats.network.rx_sec = parseInt(parseXmlTag(addonInfo, 'NewByteReceiveRate') || 0) / 1024; // KB/s
      stats.network.tx_sec = parseInt(parseXmlTag(addonInfo, 'NewByteSendRate') || 0) / 1024; // KB/s
    } catch (e) { log.error(`DSL Info failed: ${e.message}`); }

    // 3. VPN Status
    try {
      // Use X_AVM-DE_VPN service if possible, or check active connections
      const vpnInfo = await soapRequest('X_AVM-DE_VPN', 'GetVPNInfo');
      // This returns a list of VPN connections in XML format
      stats.gateway.vpn_active = vpnInfo.includes('Connected') || vpnInfo.includes('true');
    } catch (e) { 
      // Fallback: Check if any host has X_AVM-DE_IsVPN
      stats.gateway.vpn_active = false;
    }

  } catch (err) {
    log.error(`Collection cycle failed: ${err.message}`);
  }

  return stats;
}

async function report() {
  try {
    const stats = await getMetrics();
    const payload = {
      hostname: HOSTNAME,
      stats,
      reported_at: new Date().toISOString(),
      system_info: {
        model: stats.gateway.model,
        platform: 'fritzbox',
        version: '5.0.0'
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
      log.report(`Status: ${response.status} | Uptime: ${stats.uptime}s | VPN: ${stats.gateway.vpn_active}`);
    } else {
      log.error(`Reporting failed: ${response.status}`);
    }
  } catch (err) {
    log.error(`Database unreachable: ${err.message}`);
  }
}

setInterval(report, POLL_INTERVAL);
report();
