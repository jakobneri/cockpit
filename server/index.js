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

app.get('/api/stats/:hostname', async (req, res) => {
  try {
    const hostname = req.params.hostname;
    const sanitized = hostname.toLowerCase().replace(/[^a-z0-9]/g, '_');
    
    // 1. Try common variations
    const directTables = [`metrics_${sanitized}`, `metrics_${hostname.toLowerCase()}`, `metrics_${hostname}`];
    let foundTable = null;
    let latest = null;

    for (const tableName of directTables) {
      const response = await fetch(`${DB_URL}/${tableName}?limit=1&order=recorded_at.desc`);
      if (response.ok) {
        [latest] = await response.json();
        foundTable = tableName;
        break;
      }
    }

    // 2. Fuzzy Discovery if needed (v5.3.6)
    if (!foundTable) {
      try {
        const fleetRes = await fetch(`${DB_URL}/fleet_tables`);
        if (fleetRes.ok) {
          const allTables = await fleetRes.json();
          // Find closest match: table contains the sanitized hostname parts
          const bestMatch = allTables.find(t => 
            t.table_name.toLowerCase().includes(sanitized) || 
            sanitized.includes(t.table_name.replace('metrics_', ''))
          );
          if (bestMatch) {
            foundTable = bestMatch.table_name;
            const retryRes = await fetch(`${DB_URL}/${foundTable}?limit=1&order=recorded_at.desc`);
            if (retryRes.ok) [latest] = await retryRes.json();
          }
        }
      } catch (e) { hubLog.error(`Fuzzy discovery failed: ${e.message}`); }
    }

    if (!foundTable || !latest) {
      hubLog.warn(`Stats NOT FOUND for ${hostname} (Tried: ${directTables.join(', ')})`);
      return res.status(404).json({ error: 'Not found' });
    }

    hubLog.info(`Resolved table ${foundTable} for ${hostname}`);
    const histRes = await fetch(`${DB_URL}/${foundTable}?limit=200&order=recorded_at.desc`);
    const historyData = await histRes.json();
    
    let model = 'Unknown';
    let osPlatform = 'Linux';
    try {
      const metaRes = await fetch(`${DB_URL}/clients?hostname=eq.${hostname}&select=system_info`);
      if (metaRes.ok) {
        const [meta] = await metaRes.json();
        model = meta?.system_info?.model || model;
        osPlatform = meta?.system_info?.platform || osPlatform;
      }
    } catch (e) {}

    const history = historyData.reverse().map(h => ({
      cpu: h.data?.cpu?.load || 0,
      ram: h.data?.memory?.percent || 0,
      tx: h.data?.network?.tx_sec || 0,
      rx: h.data?.network?.rx_sec || 0,
      time: new Date(h.recorded_at).getTime()
    }));

    res.json({ 
      hostname, model, os: osPlatform,
      ...latest.data, history,
      lastReport: new Date(latest.recorded_at).getTime()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/export/:hostname', async (req, res) => {
  try {
    const { hostname } = req.params;
    const { timeframe } = req.query;
    const tableName = 'metrics_' + hostname.toLowerCase().replace(/[^a-z0-9]/g, '_');
    
    let timeFilter = '';
    const now = Date.now();
    if (timeframe === 'hour') timeFilter = `&recorded_at=gte.${new Date(now - 3600000).toISOString()}`;
    else if (timeframe === 'day') timeFilter = `&recorded_at=gte.${new Date(now - 86400000).toISOString()}`;
    else if (timeframe === 'week') timeFilter = `&recorded_at=gte.${new Date(now - 7 * 86400000).toISOString()}`;
    else if (timeframe === 'year') timeFilter = `&recorded_at=gte.${new Date(now - 365 * 86400000).toISOString()}`;

    const response = await fetch(`${DB_URL}/${tableName}?order=recorded_at.desc${timeFilter}`);
    if (!response.ok) return res.status(404).json({ error: 'Data not found' });
    
    const data = await response.json();

    // Simple XML Builder (Rich v5.3.4)
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<cockpit_export>\n';
    xml += `  <metadata>\n    <hostname>${hostname}</hostname>\n    <timeframe>${timeframe || 'all'}</timeframe>\n    <timestamp>${new Date().toISOString()}</timestamp>\n    <count>${data.length}</count>\n    <hub_version>v5.3.4</hub_version>\n  </metadata>\n`;
    xml += '  <history>\n';
    
    data.forEach(row => {
      xml += '    <entry>\n';
      xml += `      <recorded_at>${row.recorded_at}</recorded_at>\n`;
      if (row.data) {
        // CPU
        if (row.data.cpu) {
          xml += `      <cpu>\n        <load>${row.data.cpu.load}</cpu_load>\n        <temp>${row.data.cpu.temp || 0}</temp>\n      </cpu>\n`;
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
    hubLog.info('Checking for updates...');
    await execAsync('git fetch origin main');
    const { stdout: behindCount } = await execAsync('git rev-list HEAD..origin/main --count');
    if (parseInt(behindCount.trim()) === 0 && !force) return false;

    hubLog.update('Deploying updates...');
    try { await execAsync('git pull origin main'); }
    catch { await execAsync('git reset --hard origin/main'); }

    await execAsync('npm install');
    await execAsync('npx vite build');
    
    hubLog.success('Update successful. Restarting...');
    setTimeout(() => process.exit(0), 1000);
    return true;
  } catch (error) { 
    hubLog.error(`Update failed: ${error.message}`);
    return false;
  }
};

// SPA fallback for routing (v5.3.6)
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).send('API endpoint not found');
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
    console.log(`\n${colors.cyan}🚀 cockpit hub v5.3.6${colors.reset} | ${colors.green}🌐 http://localhost:${PORT}${colors.reset} | ${colors.magenta}📊 PostgREST: ${nodeCount} nodes online${colors.reset}\n`);
  } catch (e) {}
});
