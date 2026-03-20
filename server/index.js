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

const app = express();
app.set('trust proxy', true); // Support X-Forwarded-For headers
const PORT = process.env.PORT || 3000;
const HUB_PASSWORD = process.env.HUB_PASSWORD || 'test123';
const TRUSTED_IPS_ENV = process.env.HUB_TRUSTED_IPS || '192.168.178.187,95.117.170.17,127.0.0.1,46.31.216.50,95.117.210.49';
const PROXY_IPS = TRUSTED_IPS_ENV.split(',').map(ip => ip.trim());

// Security Middleware: Trust Proxy + Password Fallback
const authMiddleware = (req, res, next) => {
  const clientIp = req.ip.replace('::ffff:', ''); // Clean IPv6 prefix
  const authHeader = req.headers['authorization'];
  const queryToken = req.query.token;
  
  // 1. Check if it's a trusted reverse proxy or local access
  if (PROXY_IPS.includes(clientIp) || clientIp.startsWith('172.')) {
    return next();
  }

  // 2. Otherwise, require the password/token
  if (authHeader === `Bearer ${HUB_PASSWORD}` || queryToken === HUB_PASSWORD) {
    return next();
  }
  
  hubLog.warn(`Blocked unauthorized access attempt from IP: [${clientIp}]`);
  res.status(401).send('<h1>401 Unauthorized</h1><p>Please provide a valid token.</p>');
};

app.use(cors());
app.use(express.json());

// Request logging middleware
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

// Protect all /api endpoints EXCEPT the ones we decide to leave public (none for now)
app.use('/api', authMiddleware);

// Admin Update Endpoint (Manually trigger update)
app.post('/api/admin/update', async (req, res) => {
  hubLog.info(`Manual update triggered by ${req.ip}`);
  try {
    const updated = await runAutoUpdate(true);
    res.json({ success: true, message: updated ? 'Update started. Hub will restart.' : 'Hub is already up to date.' });
  } catch (err) {
    hubLog.error(`Manual update failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, '../dist')));

// ============================================================
// V3.0 HUB SERVER (PostgREST Consumer)
// ============================================================

const DB_URL = process.env.DB_URL || 'http://localhost:3000';

app.get('/api/fleet', async (req, res) => {
  try {
    // Fetch hub info first so we can return it even if DB fails
    const hubHostname = os.hostname();
    const isPi = process.platform === 'linux' && fs.existsSync('/proc/device-tree/model');
    let hubModel = os.platform() === 'win32' ? 'Windows Hub' : 'Linux Hub';
    if (isPi) {
      try { hubModel = fs.readFileSync('/proc/device-tree/model', 'utf8').replace(/\u0000/g, '') || 'Raspberry Pi Hub'; }
      catch { hubModel = 'Raspberry Pi Hub'; }
    }

    const hubSystem = {
      model: hubModel,
      os: os.platform(),
      uptime: os.uptime()
    };

    let serverMap = {};
    try {
      // Explicitly select columns to avoid "column does not exist" breaking the whole list
      const response = await fetch(`${DB_URL}/clients?select=hostname,last_seen,system_info,latest_metrics&order=last_seen.desc`);
      if (response.ok) {
        const clients = await response.json();
        clients.forEach(c => {
          serverMap[c.hostname] = {
            lastReport: new Date(c.last_seen).getTime(),
            model: c.system_info?.model || 'Unknown',
            os: c.system_info?.platform || 'Unknown',
            ...c.system_info,
            ...(c.latest_metrics || {}) 
          };
        });
      }
    } catch (dbErr) {
      hubLog.warn(`DB partial failure in fleet: ${dbErr.message}`);
    }

    res.json({ 
      hubHostname, 
      hubSystem,
      servers: serverMap 
    });
  } catch (err) {
    hubLog.error(`Top-level fleet fetch failed: ${err.message}`);
    res.status(500).json({ error: 'Hub internal error' });
  }
});

app.get('/api/stats/:hostname', async (req, res) => {
  try {
    const hostname = req.params.hostname;
    const tableName = 'metrics_' + hostname.toLowerCase().replace(/[^a-z0-9]/g, '_');
    
    // Fetch latest entry from the specific metrics table
    const response = await fetch(`${DB_URL}/${tableName}?limit=1&order=recorded_at.desc`);
    if (!response.ok) return res.status(404).json({ error: 'Node data not found' });
    
    const [latest] = await response.json();
    if (!latest) return res.status(404).json({ error: 'No stats yet' });

    // Fetch history (last 200)
    const histRes = await fetch(`${DB_URL}/${tableName}?limit=200&order=recorded_at.desc`);
    const historyData = await histRes.json();
    
    // Fetch client metadata
    let model = 'Unknown System';
    let osPlatform = 'Linux';
    try {
      const metaRes = await fetch(`${DB_URL}/clients?hostname=eq.${hostname}&select=system_info`);
      if (metaRes.ok) {
        const [meta] = await metaRes.json();
        if (meta?.system_info) {
          model = meta.system_info.model || model;
          osPlatform = meta.system_info.platform || osPlatform;
        }
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
      hostname, 
      model,
      os: osPlatform,
      ...latest.data, 
      history,
      lastReport: new Date(latest.recorded_at).getTime()
    });
  } catch (err) {
    hubLog.error(`Stats fetch failed: ${err.message}`);
    res.status(500).json({ error: 'Database unreachable' });
  }
});

// Heartbeat to Hub to suppress noisy logs when watching
app.post('/api/active', (req, res) => res.sendStatus(200));

// Service control endpoints remain similar but might need database-driven command queuing later
// For now, they return 501 until implemented via DB
app.post('/api/services/:hostname/:service/:action', (req, res) => {
  res.status(501).json({ error: 'Service control not yet implemented in V3 DB mode' });
});

const runAutoUpdate = async (force = false) => {
  if (process.platform === 'win32') return false;
  try {
    hubLog.info('Checking for updates...');
    await execAsync('git fetch origin main');
    const { stdout: behindCount } = await execAsync('git rev-list HEAD..origin/main --count');
    const count = parseInt(behindCount.trim());
    
    if (count === 0 && !force) {
      hubLog.info('Hub is up to date.');
      return false;
    }

    hubLog.update(`Found ${count} new commits. Deploying v${count > 0 ? 'next' : 'current (forced)'}...`);
    
    // Attempt clean pull
    try {
      await execAsync('git pull origin main');
    } catch (pullErr) {
      hubLog.warn('Git pull failed, attempting hard reset...');
      await execAsync('git reset --hard origin/main');
    }

    hubLog.info('Installing dependencies...');
    await execAsync('npm install --include=dev');
    
    hubLog.info('Building frontend...');
    await execAsync('npx vite build');
    
    hubLog.success(`Update successful. Restarting process...`);
    setTimeout(() => process.exit(0), 1500);
    return true;
  } catch (error) { 
    hubLog.error(`Deployment failed: ${error.message}`);
    return false;
  }
};

// Check every 2 minutes for faster updates
setInterval(() => runAutoUpdate(), 2 * 60 * 1000);

app.listen(PORT, async () => {
  try {
    const isUpdated = await runAutoUpdate();
    if (isUpdated) return; // Exit if auto-update is restarting the process

    // Fetch node count for verification
    let nodeCount = 0;
    try {
      const res = await fetch(`${DB_URL}/clients?select=hostname`);
      const data = await res.json();
      nodeCount = data.length || 0;
    } catch (e) {}

    console.log(`\n${colors.cyan}🚀 cockpit hub v5.1.0${colors.reset} | ${colors.green}🌐 http://localhost:${PORT}${colors.reset} | ${colors.magenta}📊 PostgREST: ${nodeCount} nodes online${colors.reset}\n`);
  } catch (e) {
    console.error(`Startup sequence failed: ${e.message}`);
  }
});
