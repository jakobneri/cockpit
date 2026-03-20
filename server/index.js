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
const __dirname = path.dirname(__filename);

// GLOBAL LOGGING UTILITY (ANSI Colors for PM2)
const colors = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m"
};

const hubLog = {
  info: (msg) => console.log(`${colors.gray}[${new Date().toLocaleTimeString()}]${colors.reset} ${colors.cyan}ℹ️  ${msg}${colors.reset}`),
  success: (msg) => console.log(`${colors.gray}[${new Date().toLocaleTimeString()}]${colors.reset} ${colors.green}✅ ${msg}${colors.reset}`),
  warn: (msg) => console.log(`${colors.gray}[${new Date().toLocaleTimeString()}]${colors.reset} ${colors.yellow}⚠️  ${msg}${colors.reset}`),
  error: (msg) => console.log(`${colors.gray}[${new Date().toLocaleTimeString()}]${colors.reset} ${colors.red}❌ ${msg}${colors.reset}`),
  report: (msg) => console.log(`${colors.gray}[${new Date().toLocaleTimeString()}]${colors.reset} ${colors.magenta}📡 ${msg}${colors.reset}`),
  update: (msg) => console.log(`${colors.gray}[${new Date().toLocaleTimeString()}]${colors.reset} ${colors.yellow}🔄 ${msg}${colors.reset}`)
};
const log = hubLog; // Alias for compatibility

const app = express();
app.set('trust proxy', true); // Support X-Forwarded-For headers
const PORT = process.env.PORT || 3000;
const HUB_PASSWORD = process.env.HUB_PASSWORD || 'test123';
const TRUSTED_IPS_ENV = process.env.HUB_TRUSTED_IPS || '127.0.0.1'; 
const PROXY_IPS = TRUSTED_IPS_ENV.split(',').map(ip => ip.trim());

// Security Middleware
const authMiddleware = (req, res, next) => {
  const clientIp = req.ip.replace('::ffff:', '');
  const authHeader = req.headers['authorization'];
  const queryToken = req.query.token;
  
  if (PROXY_IPS.includes(clientIp) || clientIp.startsWith('172.')) {
    return next();
  }

  if (authHeader === `Bearer ${HUB_PASSWORD}` || queryToken === HUB_PASSWORD) {
    return next();
  }
  
  hubLog.warn(`Unauthorized access attempt from IP: [${clientIp}]`);
  res.status(401).send('Unauthorized');
};

app.use(cors());
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  if (req.originalUrl === '/api/active') return next(); // Silence heartbeat logs
  
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const clientIp = req.ip.replace('::ffff:', '');
    const status = res.statusCode;
    const color = status >= 400 ? colors.red : (status >= 300 ? colors.yellow : colors.green);
    console.log(`${colors.gray}[${new Date().toLocaleTimeString()}]${colors.reset} ${color}${req.method}${colors.reset} ${req.originalUrl} ${color}${status}${colors.reset} ${colors.gray}(${duration}ms)${colors.reset} ${colors.magenta}ip:[${clientIp}]${colors.reset}`);
  });
  next();
});

app.use('/api', authMiddleware);

app.post('/api/admin/update', async (req, res) => {
  hubLog.info(`Manual update triggered by ${req.ip}`);
  try {
    const updated = await runAutoUpdate(true);
    res.json({ success: true, message: updated ? 'Update started.' : 'Up to date.' });
  } catch (err) {
    hubLog.error(`Update failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, '../dist')));

const DB_URL = process.env.DB_URL || 'http://localhost:3001';

app.get('/api/fleet', async (req, res) => {
  try {
    const hubHostname = os.hostname();
    const hubSystem = {
      model: os.platform() === 'win32' ? 'Windows Hub' : 'Linux Hub',
      os: os.platform(),
      uptime: os.uptime()
    };

    let serverMap = {};
    try {
      const response = await fetch(`${DB_URL}/clients?select=hostname,last_seen,system_info,latest_metrics&order=last_seen.desc`);
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
    } catch (e) {}

    res.json({ hubHostname, hubSystem, servers: serverMap });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Utility: Resolve Table (v5.3.17)
async function resolveTableName(hostname) {
    const sanitized = hostname.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const directName = `metrics_${sanitized}`;
    
    hubLog.info(`[v5.3.17] Resolving table for ${hostname} (Sanitized: ${sanitized})`);
    
    // Check direct
    const checkRes = await fetch(`${DB_URL}/${directName}?limit=1`);
    hubLog.info(`[v5.3.17] Direct check ${directName} status: ${checkRes.status}`);
    if (checkRes.ok) return directName;
    
    // Fuzzy Discovery
    try {
        const fleetRes = await fetch(`${DB_URL}/fleet_tables`);
        if (fleetRes.ok) {
            const allTables = await fleetRes.json();
            hubLog.info(`[v5.3.17] Fuzzy Discovery found ${allTables.length} tables: ${allTables.map(t => t.table_name).join(', ')}`);
            const bestMatch = allTables.find(t => 
                t.table_name.toLowerCase().includes(sanitized) || 
                sanitized.includes(t.table_name.replace('metrics_', ''))
            );
            if (bestMatch) hubLog.success(`[v5.3.17] Fuzzy match found: ${bestMatch.table_name}`);
            return bestMatch?.table_name || null;
        }
    } catch (e) { hubLog.error(`[v5.3.17] Fuzzy search error: ${e.message}`); }
    return null;
}

// Utility: Flatten Object (v5.3.15)
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

app.get('/api/stats/:hostname', async (req, res) => {
  try {
    const { hostname } = req.params;
    let foundTable = await resolveTableName(hostname);
    let latest = null;

    // Registry Fallback (v5.3.8)
    const metaRes = await fetch(`${DB_URL}/clients?hostname=eq.${hostname}&select=system_info,latest_metrics`);
    let registryData = null;
    if (metaRes.ok) {
        const [meta] = await metaRes.json();
        registryData = meta;
    }

    if (foundTable) {
        const response = await fetch(`${DB_URL}/${foundTable}?limit=1&order=recorded_at.desc`);
        if (response.ok) {
            const data = await response.json();
            if (data.length > 0) latest = data[0];
        }
    }

    if (!latest && registryData?.latest_metrics) {
        hubLog.warn(`Using registry fallback for ${hostname}`);
        latest = { data: registryData.latest_metrics };
    }

    if (!latest) {
      hubLog.warn(`Stats NOT FOUND for ${hostname}`);
      return res.status(404).json({ error: 'Not found' });
    }

    hubLog.success(`Resolved ${foundTable || 'Registry'} for ${hostname}`);
    
    let historyData = [];
    if (foundTable) {
        try {
          const hRes = await fetch(`${DB_URL}/${foundTable}?limit=200&order=recorded_at.desc`);
          if (hRes.ok) {
            const arr = await hRes.json();
            if (Array.isArray(arr)) {
              historyData = arr;
              hubLog.info(`[v5.3.19] Fetched ${arr.length} history points for ${hostname} from ${foundTable}`);
            }
          }
        } catch (hErr) { hubLog.error(`History fetch failed: ${hErr.message}`); }
    }
    
    // Map history with recursive flattening (v5.3.15)
    const history = [...historyData].reverse().map(h => ({
      ...flattenMetrics(h.data || {}),
      cpu: h.data?.cpu?.load || 0, // Legacy aliases
      ram: h.data?.memory?.percent || 0,
      tx: h.data?.network?.tx_sec || 0,
      rx: h.data?.network?.rx_sec || 0,
      time: h.recorded_at
    }));

    // If history is empty, inject latest as a single point for the table
    if (history.length === 0 && latest) {
      history.push({
        ...flattenMetrics(latest.data || {}),
        cpu: latest.data?.cpu?.load || 0,
        ram: latest.data?.memory?.percent || 0,
        tx: latest.data?.network?.tx_sec || 0,
        rx: latest.data?.network?.rx_sec || 0,
        time: latest.recorded_at || new Date().toISOString()
      });
    }

    const finalData = {
      hostname,
      model: registryData?.system_info?.model || 'Unknown',
      os: registryData?.system_info?.platform || 'Linux',
      uptime: latest.data?.uptime || 0,
      cpu: latest.data?.cpu || { load: 0, temp: 0 },
      memory: latest.data?.memory || { total: 0, used: 0, percent: 0 },
      network: latest.data?.network || { tx_sec: 0, rx_sec: 0 },
      storage: latest.data?.storage || { root: { total: 0, used: 0, percent: 0 } },
      gateway: latest.data?.gateway,
      history: history
    };

    hubLog.info(`Sending ${finalData.history.length} history points for ${hostname}`);
    res.json(finalData);

  } catch (error) {
    hubLog.error(`Stats Error for ${req.params.hostname}: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/export/:hostname', async (req, res) => {
  try {
    const { hostname } = req.params;
    const { timeframe } = req.query;
    const tableName = await resolveTableName(hostname);
    
    if (!tableName) return res.status(404).json({ error: 'No table found for this host' });

    let timeFilter = '';
    const now = Date.now();
    if (timeframe === 'hour') timeFilter = `&recorded_at=gte.${new Date(now - 3600000).toISOString()}`;
    else if (timeframe === 'day') timeFilter = `&recorded_at=gte.${new Date(now - 86400000).toISOString()}`;
    else if (timeframe === 'week') timeFilter = `&recorded_at=gte.${new Date(now - 7 * 86400000).toISOString()}`;
    else if (timeframe === 'year') timeFilter = `&recorded_at=gte.${new Date(now - 365 * 86400000).toISOString()}`;

    const response = await fetch(`${DB_URL}/${tableName}?order=recorded_at.desc${timeFilter}`);
    if (!response.ok) return res.status(404).json({ error: 'Data not found' });
    
    const data = await response.json();

    // Simple XML Builder (Fix v5.3.15)
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<cockpit_export>\n';
    xml += `  <metadata>\n    <hostname>${hostname}</hostname>\n    <timeframe>${timeframe || 'all'}</timeframe>\n    <timestamp>${new Date().toISOString()}</timestamp>\n    <count>${data.length}</count>\n    <hub_version>v5.3.15</hub_version>\n  </metadata>\n`;
    xml += '  <history>\n';
    
    data.forEach(row => {
      xml += '    <entry>\n';
      xml += `      <recorded_at>${row.recorded_at}</recorded_at>\n`;
      if (row.data) {
        // CPU
        if (row.data.cpu) {
          xml += `      <cpu>\n        <load>${row.data.cpu.load}</load>\n        <temp>${row.data.cpu.temp || 0}</temp>\n      </cpu>\n`;
        }
        // Memory
        if (row.data.memory) {
          xml += `      <memory>\n        <percent>${row.data.memory.percent}</percent>\n        <total_bytes>${row.data.memory.total || 0}</total_bytes>\n        <used_bytes>${row.data.memory.used || 0}</used_bytes>\n      </memory>\n`;
        }
        // Network
        if (row.data.network) {
          xml += `      <network>\n        <tx_kb_sec>${row.data.network.tx_sec}</tx_kb_sec>\n        <rx_kb_sec>${row.data.network.rx_sec}</rx_kb_sec>\n      </network>\n`;
        }
        // Storage
        if (row.data.storage) {
          xml += '      <storage>\n';
          for (const [drive, info] of Object.entries(row.data.storage)) {
            xml += `        <disk name="${drive}">\n          <total_bytes>${info.total}</total_bytes>\n          <used_bytes>${info.used}</used_bytes>\n          <percent>${info.percent}</percent>\n        </disk>\n`;
          }
          xml += '      </storage>\n';
        }
        // Gateway-specific
        if (row.data.gateway) {
          xml += `      <gateway>\n        <model>${row.data.gateway.model}</model>\n        <dsl_sync>${row.data.gateway.dsl_sync}</dsl_sync>\n        <vpn_active>${row.data.gateway.vpn_active}</vpn_active>\n      </gateway>\n`;
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

app.post('/api/active', (req, res) => res.sendStatus(200));

const runAutoUpdate = async (force = false) => {
  if (process.platform === 'win32') return false;
  try {
    hubLog.info('Checking for updates (v5.3.14)...');
    await execAsync('git fetch origin main');
    const { stdout: behindCount } = await execAsync('git rev-list HEAD..origin/main --count');
    
    if (parseInt(behindCount.trim()) === 0 && !force) return false;

    hubLog.update(`Update found (${behindCount.trim()} commits). Deploying...`);
    
    // Hard reset to ensure we are exactly match origin/main
    await execAsync('git reset --hard origin/main');
    hubLog.info('Git Reset Successful. Installing dependencies...');
    
    await execAsync('npm install');
    hubLog.info('NPM Install Successful. Building frontend...');
    
    await execAsync('npx vite build');
    hubLog.success('Build Successful. Restarting Hub...');
    
    setTimeout(() => {
        hubLog.info('PM2 Restarting...');
        process.exit(0); 
    }, 2000);
    return true;
  } catch (error) { 
    hubLog.error(`Update failed: ${error.message}`);
    // If we failed mid-update, try one last desperate reset
    try { await execAsync('git reset --hard origin/main'); } catch(e) {}
    return false;
  }
};

// SPA fallback for routing (v5.3.7)
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api')) {
    return next();
  }
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

setInterval(() => runAutoUpdate(), 5 * 60 * 1000);

app.listen(PORT, async () => {
  try {
    await runAutoUpdate();
    let nodeCount = 0;
    try {
      const res = await fetch(`${DB_URL}/clients?select=hostname`);
      const data = await res.json();
      nodeCount = data.length || 0;
    } catch (e) {}
    console.log(`\n${colors.cyan}🚀 cockpit hub v5.3.20${colors.reset} | ${colors.green}🌐 http://localhost:${PORT}${colors.reset} | ${colors.magenta}📊 PostgREST: ${nodeCount} nodes online${colors.reset}\n`);
  } catch (e) {}
});
