/**
 * =============================================================================
 * Cockpit Gateway Client
 * =============================================================================
 * Monitoring agent for Fritz!Box routers via the TR-064 UPnP protocol.
 * Collects DSL sync status, WAN traffic, VPN state, uptime, and device logs,
 * then POSTs a JSON snapshot to the Cockpit PostgREST endpoint every
 * POLL_INTERVAL milliseconds.
 *
 * Configuration resolution order: ENV vars → config.json → built-in defaults.
 *
 * Environment variables:
 *   GATEWAY_IP    — Fritz!Box IP address      (default: 192.168.188.1)
 *   GATEWAY_USER  — TR-064 username           (default: admin)
 *   GATEWAY_PASS  — TR-064 password           (default: "")
 *   DB_URL        — PostgREST base URL        (default: http://127.0.0.1:3001)
 *   HOSTNAME      — Override reported hostname
 * =============================================================================
 */

import { createRequire } from 'module';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const tr064Lib = require('tr-064');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Configuration ─────────────────────────────────────────────────────────────

let GATEWAY_IP   = process.env.GATEWAY_IP;
let GATEWAY_USER = process.env.GATEWAY_USER;
let GATEWAY_PASS = process.env.GATEWAY_PASS;
let DB_URL       = process.env.DB_URL || 'http://127.0.0.1:3001';

// Merge config.json for any variables not set by the environment.
try {
  const configPath = path.join(__dirname, '../config.json');
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    if (!process.env.DB_URL && config.db_url) {
      DB_URL = config.db_url;
    }

    const gateways = config.gateways || [];
    const match = GATEWAY_IP
      ? gateways.find(g => g.ip === GATEWAY_IP)
      : gateways[0];

    if (match) {
      if (!GATEWAY_IP)   GATEWAY_IP   = match.ip;
      if (!GATEWAY_USER) GATEWAY_USER = match.user;
      if (!GATEWAY_PASS) GATEWAY_PASS = match.password;
    }
  }
} catch (_) {
  // Silent — fall through to built-in defaults below.
}

GATEWAY_IP   = GATEWAY_IP   || '192.168.188.1';
GATEWAY_USER = GATEWAY_USER || 'admin';
GATEWAY_PASS = GATEWAY_PASS || '';

const HOSTNAME      = process.env.HOSTNAME || `${GATEWAY_IP}-gateway-client`;
const POLL_INTERVAL = 30000; // ms — how often to query the Fritz!Box

// ── Logging ───────────────────────────────────────────────────────────────────

const log = {
  info:    (msg) => console.log(`[${new Date().toLocaleTimeString()}] ℹ️  ${msg}`),
  diag:    (msg) => console.log(`[${new Date().toLocaleTimeString()}] 🔍 ${msg}`),
  success: (msg) => console.log(`[${new Date().toLocaleTimeString()}] ✅ ${msg}`),
  warn:    (msg) => console.log(`[${new Date().toLocaleTimeString()}] ⚠️  ${msg}`),
  error:   (msg) => console.log(`[${new Date().toLocaleTimeString()}] ❌ ${msg}`),
  report:  (msg) => console.log(`[${new Date().toLocaleTimeString()}] 📤 ${msg}`)
};

log.info(`Gateway client starting — target: ${GATEWAY_IP}, host: ${HOSTNAME}`);

// ── State ─────────────────────────────────────────────────────────────────────

// Previous traffic counters for computing per-second deltas.
let prevStats = { rx: 0, tx: 0, time: Date.now() };

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Calls a TR-064 service action and returns the result, or null on failure.
 * Logs authentication errors distinctly so misconfigured credentials are obvious.
 *
 * @param {object} service    - TR-064 service object from tr-064 library.
 * @param {Function} action   - Bound action method on the service.
 * @param {string} actionName - Human-readable name used in log messages.
 * @returns {Promise<object|null>} Parsed response object, or null on any error.
 */
async function safeCall(service, action, actionName = 'Unknown') {
  if (!service || !action) {
    log.diag(`Skipping ${actionName} — service/action not available on this device`);
    return null;
  }

  log.diag(`Calling ${actionName}…`);
  try {
    const fn = promisify(action.bind(service));
    const res = await fn();
    log.success(`${actionName} OK`);
    return res;
  } catch (err) {
    if (err.message.includes('401')) {
      log.error(`${actionName} → 401 Unauthorized. Check GATEWAY_USER / GATEWAY_PASS.`);
    } else {
      log.error(`${actionName} failed: ${err.message}`);
    }
    return null;
  }
}

// ── Data Collection ───────────────────────────────────────────────────────────

/**
 * Connects to the Fritz!Box via TR-064 and collects all gateway metrics.
 * Individual failures are non-fatal — each section degrades gracefully and
 * leaves its field at the default value in the returned stats object.
 *
 * @returns {Promise<{
 *   uptime: number,
 *   model: string,
 *   dsl_sync: string,
 *   vpn_active: boolean,
 *   rx_sec: number,
 *   tx_sec: number,
 *   logs: string
 * }>}
 */
async function fetchStats() {
  const tr064      = new tr064Lib.TR064();
  const initDevice = promisify(tr064.initTR064Device.bind(tr064));

  const stats = {
    uptime:     0,
    model:      'Fritz!Box',
    dsl_sync:   'Unknown',
    vpn_active: false,
    rx_sec:     0,
    tx_sec:     0,
    logs:       ''
  };

  try {
    log.diag(`Connecting to ${GATEWAY_IP}…`);
    const dev = await initDevice(GATEWAY_IP, 49000);
    dev.login(GATEWAY_USER, GATEWAY_PASS);

    // Device info and uptime
    const deviceInfo = dev.services['urn:dslforum-org:service:DeviceInfo:1'];
    const infoRes = await safeCall(deviceInfo, deviceInfo?.actions?.GetInfo, 'GetInfo');
    if (infoRes) {
      stats.uptime = parseInt(infoRes.NewUpTime || 0);
      stats.model  = infoRes.NewModelName || 'Fritz!Box';
    } else {
      log.warn('GetInfo failed — credentials may be incorrect.');
    }

    // DSL sync status
    const commonLink = dev.services['urn:dslforum-org:service:WANCommonInterfaceConfig:1'];
    const syncRes = await safeCall(commonLink, commonLink?.actions?.GetCommonLinkProperties, 'GetCommonLinkProperties');
    if (syncRes) stats.dsl_sync = syncRes.NewPhysicalLinkStatus || 'Unknown';

    // WAN traffic counters — compute kB/s delta from previous sample
    const rxRes = await safeCall(commonLink, commonLink?.actions?.GetTotalBytesReceived, 'GetTotalBytesReceived');
    const txRes = await safeCall(commonLink, commonLink?.actions?.GetTotalBytesSent,     'GetTotalBytesSent');
    if (rxRes && txRes) {
      const now = Date.now();
      const rx  = parseInt(rxRes.NewTotalBytesReceived || 0);
      const tx  = parseInt(txRes.NewTotalBytesSent     || 0);
      if (prevStats.rx > 0) {
        const dt = (now - prevStats.time) / 1000;
        if (dt > 0) {
          stats.rx_sec = Math.max(0, (rx - prevStats.rx) / 1024 / dt);
          stats.tx_sec = Math.max(0, (tx - prevStats.tx) / 1024 / dt);
        }
      }
      prevStats = { rx, tx, time: now };
    }

    // VPN status — try X_AVM-DE_VPN service first
    const vpn = dev.services['urn:dslforum-org:service:X_AVM-DE_VPN:1'];
    if (vpn) {
      const vpnRes = await safeCall(vpn, vpn?.actions?.GetVPNInfo, 'GetVPNInfo');
      if (vpnRes) {
        const info = JSON.stringify(vpnRes);
        stats.vpn_active = info.includes('Connected') || info.includes('"1"') || info.includes('true');
      }
    } else {
      log.diag('X_AVM-DE_VPN service not present — will fall back to log scan.');
    }

    // Device logs — DeviceConfig primary, DeviceInfo fallback
    const deviceConfig = dev.services['urn:dslforum-org:service:DeviceConfig:1'];
    let logRes = await safeCall(deviceConfig, deviceConfig?.actions?.GetLogs,         'GetLogs');
    if (!logRes) {
      logRes   = await safeCall(deviceInfo,   deviceInfo?.actions?.GetDeviceLog,      'GetDeviceLog');
    }
    if (logRes) {
      stats.logs = logRes.NewLogData || logRes.NewDeviceLog || '';

      // Scan logs for WireGuard/VPN events when the TR-064 VPN service is absent
      // (e.g. WireGuard tunnels don't expose state via X_AVM-DE_VPN).
      if (!stats.vpn_active && stats.logs) {
        for (const line of stats.logs.split('\\n')) {
          const l = line.toLowerCase();
          if (l.includes('vpn') || l.includes('wireguard')) {
            if (l.includes('erfolgreich hergestellt') || l.includes('aufgebaut') ||
                l.includes('established')             || l.includes('connected')) {
              stats.vpn_active = true;
              break;
            }
            if (l.includes('getrennt') || l.includes('abgebaut') ||
                l.includes('disconnected') || l.includes('cleared')) {
              stats.vpn_active = false;
              break;
            }
          }
        }
      }
    }

    return stats;
  } catch (err) {
    throw new Error(`Device initialization failed: ${err.message}`);
  }
}

// ── Reporting ─────────────────────────────────────────────────────────────────

/**
 * Collects a fresh stats snapshot and POSTs it to the PostgREST endpoint.
 * Errors are caught and logged without crashing the poll loop.
 */
async function report() {
  try {
    const stats = await fetchStats();

    const payload = {
      hostname:    HOSTNAME,
      reported_at: new Date().toISOString(),
      system_info: { model: stats.model, platform: 'fritzbox', version: '6.0.0' },
      stats: {
        cpu:     { load: 0, temp: 0 },
        memory:  { total: 0, used: 0, percent: 0 },
        network: { tx_sec: stats.tx_sec, rx_sec: stats.rx_sec },
        storage: { root: { total: 0, used: 0, percent: 0 } },
        uptime:  stats.uptime,
        gateway: {
          dsl_sync:   stats.dsl_sync,
          vpn_active: stats.vpn_active,
          model:      stats.model,
          logs:       stats.logs
        }
      }
    };

    const res = await fetch(`${DB_URL}/rpc/report_client_metrics`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'params=single-object' },
      body:    JSON.stringify(payload)
    });

    if (res.ok) {
      log.report(`Reported successfully for ${HOSTNAME}`);
    } else {
      log.error(`DB error: ${res.statusText}`);
    }
  } catch (err) {
    log.error(`Reporting cycle failed: ${err.message}`);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
// Small initial delay lets the network stack settle before the first TR-064 call.
setTimeout(() => {
  report();
  setInterval(report, POLL_INTERVAL);
}, 2000);
