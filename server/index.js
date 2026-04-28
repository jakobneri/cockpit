/**
 * =============================================================================
 * Cockpit Hub — Express Server
 * =============================================================================
 * Central API gateway for the Cockpit monitoring dashboard.
 *
 * Responsibilities:
 *  - Authenticates requests via Bearer token or trusted-IP allowlist.
 *  - Proxies fleet and per-node stats queries to PostgREST.
 *  - Exposes Pi/systemd service management endpoints.
 *  - Serves the compiled Vite frontend and handles SPA routing.
 *  - Runs a background auto-update loop (git pull → build → pm2 restart).
 *
 * Environment variables:
 *   PORT              — HTTP listen port          (default: 3000)
 *   HUB_PASSWORD      — Bearer token for API auth (default: test123)
 *   HUB_TRUSTED_IPS   — Comma-separated IPs that bypass auth
 *   DB_URL            — PostgREST base URL        (default: http://localhost:3001)
 * =============================================================================
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Configuration ─────────────────────────────────────────────────────────────

const PORT            = process.env.PORT         || 3000;
const HUB_PASSWORD    = process.env.HUB_PASSWORD || 'test123';
const DB_URL          = process.env.DB_URL        || 'http://localhost:3001';
const TRUSTED_IPS_ENV = process.env.HUB_TRUSTED_IPS || '127.0.0.1,192.168.188.23';
const PROXY_IPS       = TRUSTED_IPS_ENV.split(',').map(ip => ip.trim());

// ── Logging ───────────────────────────────────────────────────────────────────

const colors = {
  reset:   '\x1b[0m',
  cyan:    '\x1b[36m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  red:     '\x1b[31m',
  magenta: '\x1b[35m',
  gray:    '\x1b[90m'
};

const log = {
  info:    (msg) => console.log(`${colors.gray}[${new Date().toLocaleTimeString()}]${colors.reset} ${colors.cyan}ℹ️  ${msg}${colors.reset}`),
  success: (msg) => console.log(`${colors.gray}[${new Date().toLocaleTimeString()}]${colors.reset} ${colors.green}✅ ${msg}${colors.reset}`),
  warn:    (msg) => console.log(`${colors.gray}[${new Date().toLocaleTimeString()}]${colors.reset} ${colors.yellow}⚠️  ${msg}${colors.reset}`),
  error:   (msg) => console.log(`${colors.gray}[${new Date().toLocaleTimeString()}]${colors.reset} ${colors.red}❌ ${msg}${colors.reset}`),
  report:  (msg) => console.log(`${colors.gray}[${new Date().toLocaleTimeString()}]${colors.reset} ${colors.magenta}📡 ${msg}${colors.reset}`),
  update:  (msg) => console.log(`${colors.gray}[${new Date().toLocaleTimeString()}]${colors.reset} ${colors.yellow}🔄 ${msg}${colors.reset}`)
};

// ── Middleware ─────────────────────────────────────────────────────────────────

const app = express();
app.set('trust proxy', true); // Honour X-Forwarded-For from reverse proxies.
app.use(cors());
app.use(express.json());

/**
 * Authentication middleware applied to all /api routes.
 * Requests are allowed through if the client IP is in PROXY_IPS, is in the
 * 172.x.x.x Docker bridge range, or supplies a valid Bearer token / query token.
 */
const authMiddleware = (req, res, next) => {
  const clientIp   = req.ip.replace('::ffff:', '');
  const authHeader = req.headers['authorization'];
  const queryToken = req.query.token;

  if (PROXY_IPS.includes(clientIp) || clientIp.startsWith('172.')) return next();
  if (authHeader === `Bearer ${HUB_PASSWORD}` || queryToken === HUB_PASSWORD) return next();

  log.warn(`Unauthorized access attempt from [${clientIp}]`);
  res.status(401).send('Unauthorized');
};

// Request logger — skips the high-frequency heartbeat endpoint.
app.use((req, res, next) => {
  if (req.originalUrl === '/api/active') return next();

  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const clientIp = req.ip.replace('::ffff:', '');
    const status   = res.statusCode;
    const color    = status >= 400 ? colors.red : (status >= 300 ? colors.yellow : colors.green);
    console.log(
      `${colors.gray}[${new Date().toLocaleTimeString()}]${colors.reset}` +
      ` ${color}${req.method}${colors.reset} ${req.originalUrl}` +
      ` ${color}${status}${colors.reset}` +
      ` ${colors.gray}(${duration}ms)${colors.reset}` +
      ` ${colors.magenta}ip:[${clientIp}]${colors.reset}`
    );
  });
  next();
});

app.use('/api', authMiddleware);

// Serve the compiled frontend before API routes so the static middleware
// doesn't intercept API paths.
app.use(express.static(path.join(__dirname, '../dist')));

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Resolves the PostgREST table name for a given hostname.
 * First tries a direct sanitized lookup (`metrics_<hostname>`), then falls
 * back to a fuzzy search against the `fleet_tables` view.
 *
 * @param {string} hostname - Raw client hostname as reported by the agent.
 * @returns {Promise<string|null>} Table name, or null if no match found.
 */
async function resolveTableName(hostname) {
  const sanitized = hostname.toLowerCase().replace(/[^a-z0-9]/g, '_');
  const directName = `metrics_${sanitized}`;

  const checkRes = await fetch(`${DB_URL}/${directName}?limit=1`);
  if (checkRes.ok) return directName;

  // Fuzzy fallback — search the fleet_tables view for a partial match.
  try {
    const fleetRes = await fetch(`${DB_URL}/fleet_tables`);
    if (fleetRes.ok) {
      const allTables = await fleetRes.json();
      const bestMatch = allTables.find(t =>
        t.table_name.toLowerCase().includes(sanitized) ||
        sanitized.includes(t.table_name.replace('metrics_', ''))
      );
      if (bestMatch) {
        log.success(`Fuzzy table match for ${hostname}: ${bestMatch.table_name}`);
        return bestMatch.table_name;
      }
    }
  } catch (e) {
    log.error(`Fuzzy table search failed: ${e.message}`);
  }

  return null;
}

/**
 * Recursively flattens a nested metrics object into a single-level map with
 * UPPER_SNAKE_CASE keys (e.g. `cpu.load` → `CPU_LOAD`).
 * Used to expose raw metric keys to the frontend history table.
 *
 * @param {object} obj    - Nested metrics object.
 * @param {string} prefix - Key prefix accumulated through recursion.
 * @returns {object} Flat key → value map.
 */
function flattenMetrics(obj, prefix = '') {
  let result = {};
  for (const [key, val] of Object.entries(obj)) {
    const propName = prefix ? `${prefix}_${key}` : key;
    if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
      Object.assign(result, flattenMetrics(val, propName));
    } else {
      result[propName.toUpperCase()] = val;
    }
  }
  return result;
}

// ── API Routes ────────────────────────────────────────────────────────────────

/** Manual update trigger — runs the same logic as the background auto-updater. */
app.post('/api/admin/update', async (req, res) => {
  log.info(`Manual update triggered by ${req.ip}`);
  try {
    const updated = await runAutoUpdate(true);
    res.json({ success: true, message: updated ? 'Update started.' : 'Up to date.' });
  } catch (err) {
    log.error(`Update failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Fleet overview — returns all registered clients with their last-seen time,
 * system info, and latest metrics snapshot, plus metadata about the Hub itself.
 */
app.get('/api/fleet', async (req, res) => {
  try {
    const hubHostname = os.hostname();
    const hubSystem = {
      model:  os.platform() === 'win32' ? 'Windows Hub' : 'Linux Hub',
      os:     os.platform(),
      uptime: os.uptime()
    };

    let serverMap = {};
    try {
      const response = await fetch(`${DB_URL}/clients?select=hostname,last_seen,system_info,latest_metrics&order=id.asc`);
      if (response.ok) {
        const clients = await response.json();
        clients.forEach(c => {
          serverMap[c.hostname] = {
            lastReport: new Date(c.last_seen).getTime(),
            ...c.system_info,
            ...(c.latest_metrics || {})
          };
        });
      }
    } catch (_) {}

    res.json({ hubHostname, hubSystem, servers: serverMap });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Per-node detail — returns the latest metrics snapshot plus up to 200
 * historical data points for charting.  Falls back to the registry
 * `latest_metrics` column when no time-series table exists yet.
 */
app.get('/api/stats/:hostname', async (req, res) => {
  try {
    const { hostname } = req.params;
    const foundTable = await resolveTableName(hostname);

    // Fetch registry entry (system_info + latest snapshot fallback).
    const metaRes = await fetch(`${DB_URL}/clients?hostname=eq.${hostname}&select=system_info,latest_metrics`);
    let registryData = null;
    if (metaRes.ok) {
      const [meta] = await metaRes.json();
      registryData = meta;
    }

    // Fetch the most recent row from the time-series table.
    let latest = null;
    if (foundTable) {
      const response = await fetch(`${DB_URL}/${foundTable}?limit=1&order=recorded_at.desc`);
      if (response.ok) {
        const data = await response.json();
        if (data.length > 0) latest = data[0];
      }
    }

    // Fall back to registry snapshot when no time-series row is available.
    if (!latest && registryData?.latest_metrics) {
      log.warn(`Using registry fallback for ${hostname}`);
      latest = { data: registryData.latest_metrics };
    }

    if (!latest) {
      log.warn(`Stats not found for ${hostname}`);
      return res.status(404).json({ error: 'Not found' });
    }

    log.success(`Resolved ${foundTable || 'registry'} for ${hostname}`);

    // Fetch up to 200 history points for charting.
    let historyData = [];
    if (foundTable) {
      try {
        const hRes = await fetch(`${DB_URL}/${foundTable}?limit=200&order=recorded_at.desc`);
        if (hRes.ok) {
          const arr = await hRes.json();
          if (Array.isArray(arr)) {
            historyData = arr;
            log.info(`Fetched ${arr.length} history points for ${hostname}`);
          }
        }
      } catch (hErr) {
        log.error(`History fetch failed: ${hErr.message}`);
      }
    }

    const history = [...historyData].reverse().map(h => ({
      ...flattenMetrics(h.data || {}),
      cpu:  h.data?.cpu?.load        || 0,
      ram:  h.data?.memory?.percent  || 0,
      tx:   h.data?.network?.tx_sec  || 0,
      rx:   h.data?.network?.rx_sec  || 0,
      time: h.recorded_at
    }));

    // Ensure at least one point exists so the frontend table isn't empty.
    if (history.length === 0 && latest) {
      history.push({
        ...flattenMetrics(latest.data || {}),
        cpu:  latest.data?.cpu?.load        || 0,
        ram:  latest.data?.memory?.percent  || 0,
        tx:   latest.data?.network?.tx_sec  || 0,
        rx:   latest.data?.network?.rx_sec  || 0,
        time: latest.recorded_at || new Date().toISOString()
      });
    }

    res.json({
      hostname,
      model:   registryData?.system_info?.model    || 'Unknown',
      os:      registryData?.system_info?.platform || 'Linux',
      uptime:  latest.data?.uptime  || 0,
      cpu:     latest.data?.cpu     || { load: 0, temp: 0 },
      memory:  latest.data?.memory  || { total: 0, used: 0, percent: 0 },
      network: latest.data?.network || { tx_sec: 0, rx_sec: 0 },
      storage: latest.data?.storage || { root: { total: 0, used: 0, percent: 0 } },
      gateway: latest.data?.gateway,
      history
    });
  } catch (error) {
    log.error(`Stats error for ${req.params.hostname}: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * CSV/XML export — streams historical metrics for a node as an XML file.
 * Optional `timeframe` query param: hour | day | week | year (default: all).
 */
app.get('/api/export/:hostname', async (req, res) => {
  try {
    const { hostname } = req.params;
    const { timeframe } = req.query;
    const tableName = await resolveTableName(hostname);

    if (!tableName) return res.status(404).json({ error: 'No table found for this host' });

    let timeFilter = '';
    const now = Date.now();
    if      (timeframe === 'hour') timeFilter = `&recorded_at=gte.${new Date(now - 3_600_000).toISOString()}`;
    else if (timeframe === 'day')  timeFilter = `&recorded_at=gte.${new Date(now - 86_400_000).toISOString()}`;
    else if (timeframe === 'week') timeFilter = `&recorded_at=gte.${new Date(now - 7 * 86_400_000).toISOString()}`;
    else if (timeframe === 'year') timeFilter = `&recorded_at=gte.${new Date(now - 365 * 86_400_000).toISOString()}`;

    const response = await fetch(`${DB_URL}/${tableName}?order=recorded_at.desc${timeFilter}`);
    if (!response.ok) return res.status(404).json({ error: 'Data not found' });

    const data = await response.json();

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<cockpit_export>\n';
    xml += `  <metadata>\n    <hostname>${hostname}</hostname>\n    <timeframe>${timeframe || 'all'}</timeframe>\n    <timestamp>${new Date().toISOString()}</timestamp>\n    <count>${data.length}</count>\n  </metadata>\n`;
    xml += '  <history>\n';

    data.forEach(row => {
      xml += '    <entry>\n';
      xml += `      <recorded_at>${row.recorded_at}</recorded_at>\n`;
      if (row.data) {
        if (row.data.cpu) {
          xml += `      <cpu>\n        <load>${row.data.cpu.load}</load>\n        <temp>${row.data.cpu.temp || 0}</temp>\n      </cpu>\n`;
        }
        if (row.data.memory) {
          xml += `      <memory>\n        <percent>${row.data.memory.percent}</percent>\n        <total_bytes>${row.data.memory.total || 0}</total_bytes>\n        <used_bytes>${row.data.memory.used || 0}</used_bytes>\n      </memory>\n`;
        }
        if (row.data.network) {
          xml += `      <network>\n        <tx_kb_sec>${row.data.network.tx_sec}</tx_kb_sec>\n        <rx_kb_sec>${row.data.network.rx_sec}</rx_kb_sec>\n      </network>\n`;
        }
        if (row.data.storage) {
          xml += '      <storage>\n';
          for (const [drive, info] of Object.entries(row.data.storage)) {
            xml += `        <disk name="${drive}">\n          <total_bytes>${info.total}</total_bytes>\n          <used_bytes>${info.used}</used_bytes>\n          <percent>${info.percent}</percent>\n        </disk>\n`;
          }
          xml += '      </storage>\n';
        }
        if (row.data.uptime !== undefined) {
          xml += `      <uptime_seconds>${row.data.uptime}</uptime_seconds>\n`;
        }
        if (row.data.gateway) {
          xml += `      <gateway>\n        <model>${row.data.gateway.model}</model>\n        <dsl_sync>${row.data.gateway.dsl_sync}</dsl_sync>\n        <vpn_active>${row.data.gateway.vpn_active}</vpn_active>\n`;
          if (row.data.gateway.logs) {
            xml += `        <logs>${row.data.gateway.logs.replace(/[<&]/g, c => ({ '<': '&lt;', '&': '&amp;' }[c]))}</logs>\n`;
          }
          xml += '      </gateway>\n';
        }
      }
      xml += '    </entry>\n';
    });
    xml += '  </history>\n</cockpit_export>';

    res.header('Content-Type', 'application/xml');
    res.attachment(`cockpit_export_${hostname}_${timeframe || 'all'}.xml`);
    res.send(xml);
  } catch (err) {
    res.status(500).send('<error>' + err.message + '</error>');
  }
});

/** Heartbeat endpoint — frontend pings this to confirm the hub is reachable. */
app.post('/api/active', (req, res) => res.sendStatus(200));

/**
 * Pi/systemd service list — returns relevant running services.
 * On Windows returns a simulated response so the UI still renders.
 */
app.get('/api/pi/services', async (req, res) => {
  if (process.platform === 'win32') {
    return res.json([
      { name: 'cockpit-hub', status: 'running', description: 'Cockpit Hub Management' },
      { name: 'postgrest',   status: 'running', description: 'Data API Service' }
    ]);
  }

  try {
    const filter = ['cockpit', 'docker', 'ssh', 'nginx', 'pihole', 'pgrst', 'db'];
    const { stdout } = await execAsync('systemctl list-units --type=service --all --no-legend');
    const services = stdout.split('\n')
      .map(line => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 4) return null;
        const name   = parts[0].replace('.service', '');
        const active = parts[2];
        const sub    = parts[3];
        const desc   = parts.slice(4).join(' ');
        return { name, status: active === 'active' ? 'running' : 'stopped', sub, description: desc };
      })
      .filter(s => s && filter.some(f => s.name.toLowerCase().includes(f)));

    res.json(services);
  } catch (err) {
    log.error(`Failed to list services: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/** Systemd service control — start / stop / restart a named service. */
app.post('/api/pi/services/:name/:action', async (req, res) => {
  const { name, action } = req.params;
  const allowedActions = ['start', 'stop', 'restart'];

  if (!allowedActions.includes(action)) return res.status(400).json({ error: 'Invalid action' });
  if (process.platform === 'win32') return res.json({ success: true, message: `Simulated ${action} on ${name}` });

  try {
    log.info(`Service action: ${action} ${name} by ${req.ip}`);
    await execAsync(`sudo systemctl ${action} ${name}.service`);
    res.json({ success: true });
  } catch (err) {
    log.error(`Service action failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Legacy compatibility shim — redirects bare /rpc calls to PostgREST on
 * port 3001. Clients should POST directly to PostgREST, but this keeps
 * old deployments working without reconfiguration.
 */
app.use('/rpc', (req, res) => {
  log.warn(`Legacy /rpc request from ${req.ip} — redirecting to port 3001`);
  res.redirect(307, `http://${req.hostname}:3001${req.originalUrl}`);
});

// SPA fallback — all unmatched GET requests serve index.html for client-side routing.
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

// ── Background Tasks ──────────────────────────────────────────────────────────

/**
 * Checks for upstream commits and, if found, runs:
 *   git pull → npm install → npm run build → pm2 restart all
 *
 * Skipped entirely on Windows (no pm2 assumption there).
 *
 * @param {boolean} force - When true, applies the update even if already up to date.
 * @returns {Promise<boolean>} True if an update was applied.
 */
const runAutoUpdate = async (force = false) => {
  if (process.platform === 'win32') return false;
  try {
    log.info('Checking for repository updates…');

    // Prevent git safe-directory errors in restricted environments.
    try { await execAsync('git config --global --add safe.directory /home/archimedes/cockpit'); } catch (_) {}

    await execAsync('git fetch origin main');
    const { stdout: localCommit }  = await execAsync('git rev-parse HEAD');
    const { stdout: remoteCommit } = await execAsync('git rev-parse origin/main');

    if (localCommit.trim() === remoteCommit.trim() && !force) {
      log.info(`Up to date (${localCommit.trim().substring(0, 7)})`);
      return false;
    }

    const { stdout: behindCount } = await execAsync('git rev-list HEAD..origin/main --count');
    const count = parseInt(behindCount.trim()) || 0;
    log.update(`${count} new commit(s). Local: ${localCommit.trim().substring(0, 7)} → Remote: ${remoteCommit.trim().substring(0, 7)}`);

    await execAsync('git pull origin main');
    log.success('Git pull successful.');

    await execAsync('npm install');
    log.info('Dependencies installed. Building frontend…');

    await execAsync('npm run build');
    log.success('Build successful. Restarting via PM2…');

    setTimeout(async () => {
      try {
        await execAsync('pm2 restart all');
      } catch (e) {
        log.error(`PM2 restart failed: ${e.message}. Exiting for manual restart.`);
        process.exit(0);
      }
    }, 2000);

    return true;
  } catch (error) {
    log.error(`Auto-update failed: ${error.message}`);
    return false;
  }
};

// Check for updates every 5 minutes.
setInterval(() => runAutoUpdate(), 5 * 60 * 1000);

// ── Startup ───────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  try {
    await runAutoUpdate();
    let nodeCount = 0;
    try {
      const res  = await fetch(`${DB_URL}/clients?select=hostname`);
      const data = await res.json();
      nodeCount  = data.length || 0;
    } catch (_) {}
    console.log(
      `\n${colors.cyan}🚀 Cockpit Hub${colors.reset}` +
      ` | ${colors.green}🌐 http://localhost:${PORT}${colors.reset}` +
      ` | ${colors.magenta}📊 PostgREST: ${nodeCount} node(s) registered${colors.reset}\n`
    );
  } catch (_) {}
});
