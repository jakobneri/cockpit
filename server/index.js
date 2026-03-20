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
  
  if (PROXY_IPS.includes(clientIp) || clientIp.startsWith('172.')) {
    return next();
  }

  if (authHeader === `Bearer ${HUB_PASSWORD}`) {
    return next();
  }
  
  hubLog.warn(`Unauthorized access attempt from IP: [${clientIp}]`);
  res.status(401).send('Unauthorized');
};

app.use(cors());
app.use(express.json());

// Request logging
app.use((req, res, next) => {
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
    const tableName = 'metrics_' + hostname.toLowerCase().replace(/[^a-z0-9]/g, '_');
    
    const response = await fetch(`${DB_URL}/${tableName}?limit=1&order=recorded_at.desc`);
    if (!response.ok) return res.status(404).json({ error: 'Not found' });
    
    const [latest] = await response.json();
    const histRes = await fetch(`${DB_URL}/${tableName}?limit=200&order=recorded_at.desc`);
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
    console.log(`\n${colors.cyan}🚀 cockpit hub v5.2.1${colors.reset} | ${colors.green}🌐 http://localhost:${PORT}${colors.reset} | ${colors.magenta}📊 PostgREST: ${nodeCount} nodes online${colors.reset}\n`);
  } catch (e) {}
});
