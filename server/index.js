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

const app = express();
const PORT = process.env.PORT || 3000;
const HUB_PASSWORD = process.env.HUB_PASSWORD || 'change-me'; // SET THIS IN YOUR ENVIRONMENT

// Logging Utility
const log = {
  info: (msg) => console.log(`[${new Date().toLocaleTimeString()}] ℹ️  ${msg}`),
  success: (msg) => console.log(`[${new Date().toLocaleTimeString()}] ✅ ${msg}`),
  warn: (msg) => console.log(`[${new Date().toLocaleTimeString()}] ⚠️  ${msg}`),
  error: (msg) => console.log(`[${new Date().toLocaleTimeString()}] ❌ ${msg}`),
  report: (msg) => console.log(`[${new Date().toLocaleTimeString()}] 📡 ${msg}`),
  update: (msg) => console.log(`[${new Date().toLocaleTimeString()}] 🔄 ${msg}`)
};

// Security Middleware: Simple Password Check
const authMiddleware = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const queryToken = req.query.token;
  
  // Accept if header matches or query param matches
  if (authHeader === `Bearer ${HUB_PASSWORD}` || queryToken === HUB_PASSWORD) {
    return next();
  }
  
  log.warn(`Blocked unauthorized access attempt from ${req.ip}`);
  res.status(401).send('<h1>401 Unauthorized</h1><p>Please provide a valid token.</p>');
};

app.use(cors());
app.use(express.json());

// Protect all /api endpoints EXCEPT the ones we decide to leave public (none for now)
app.use('/api', authMiddleware);

app.use(express.static(path.join(__dirname, '../dist')));

// ============================================================
// V3.0 HUB SERVER (PostgREST Consumer)
// ============================================================

const DB_URL = process.env.DB_URL || 'http://localhost:3000';

app.get('/api/fleet', async (req, res) => {
  try {
    const hubHostname = os.hostname();
    const isPi = process.platform === 'linux' && fs.existsSync('/proc/device-tree/model');
    let hubModel = os.platform() === 'win32' ? 'Windows Hub' : 'Linux Hub';
    if (isPi) {
      try { hubModel = fs.readFileSync('/proc/device-tree/model', 'utf8').replace(/\u0000/g, '') || 'Raspberry Pi Hub'; }
      catch { hubModel = 'Raspberry Pi Hub'; }
    }

    // Fetch clients from PostgREST
    const response = await fetch(`${DB_URL}/clients?select=*&order=last_seen.desc`);
    if (!response.ok) throw new Error(`DB fetch failed: ${response.status}`);
    const clients = await response.json();

    // Transform into the format expected by the frontend
    const serverMap = {};
    clients.forEach(c => {
      serverMap[c.hostname] = {
        lastReport: new Date(c.last_seen).getTime(),
        model: c.system_info?.model || 'Unknown',
        os: c.system_info?.platform || 'Unknown',
        // Note: For full fleet view, we might want to fetch latest stats for each, 
        // but for now we send the registry info.
        ...c.system_info 
      };
    });

    res.json({ 
      hubHostname, 
      hubSystem: {
        model: hubModel,
        os: os.platform(),
        uptime: os.uptime()
      },
      servers: serverMap 
    });
  } catch (err) {
    log.error(`Fleet fetch failed: ${err.message}`);
    res.status(500).json({ error: 'Database unreachable' });
  }
});

app.get('/api/stats/:hostname', async (req, res) => {
  try {
    const hostname = req.params.hostname;
    const tableName = 'metrics_' + hostname.toLowerCase().replace(/[^a-z0-9]/g, '_');
    
    // Fetch latest entry from the specific metrics table
    const response = await fetch(`${DB_URL}/${tableName}?limit=1&order=timestamp.desc`);
    if (!response.ok) return res.status(404).json({ error: 'Node data not found' });
    
    const [latest] = await response.json();
    if (!latest) return res.status(404).json({ error: 'No stats yet' });

    // Fetch history (last 60)
    const histRes = await fetch(`${DB_URL}/${tableName}?limit=60&order=timestamp.desc`);
    const historyData = await histRes.json();
    
    const history = historyData.reverse().map(h => ({
      cpu: h.data?.cpu?.load || 0,
      ram: h.data?.memory?.percent || 0,
      tx: h.data?.network?.tx_sec || 0,
      rx: h.data?.network?.rx_sec || 0,
      time: new Date(h.timestamp).getTime()
    }));

    res.json({ 
      hostname, 
      ...latest.data, 
      history,
      lastReport: new Date(latest.timestamp).getTime()
    });
  } catch (err) {
    log.error(`Stats fetch failed: ${err.message}`);
    res.status(500).json({ error: 'Database unreachable' });
  }
});

// Service control endpoints remain similar but might need database-driven command queuing later
// For now, they return 501 until implemented via DB
app.post('/api/services/:hostname/:service/:action', (req, res) => {
  res.status(501).json({ error: 'Service control not yet implemented in V3 DB mode' });
});

const runAutoUpdate = async (force = false) => {
  if (process.platform === 'win32') return;
  try {
    process.stdout.write(`[${new Date().toLocaleTimeString()}] 🔄 Checking for Hub updates... `);
    await execAsync('git fetch origin main');
    const { stdout: behindCount } = await execAsync('git rev-list HEAD..origin/main --count');
    const count = parseInt(behindCount.trim());
    if (count === 0 && !force) {
      console.log('✅ Up to date.');
      return;
    }
    log.update(`Found ${count} new commits. Pulling...`);
    await execAsync('git pull origin main');
    await execAsync('npm install --include=dev');
    await execAsync('npx vite build');
    log.success(`Update complete. Restarting Hub...`);
    setTimeout(() => process.exit(0), 1000);
  } catch (error) { 
    log.error(`Auto-update failed: ${error.message}`);
  }
};

setInterval(() => runAutoUpdate(), 10 * 60 * 1000); // 10 minutes frequency
runAutoUpdate();

app.listen(PORT, () => {
  console.log(`\n🚀 cockpit hub v3.2.2 running on http://localhost:${PORT}`);
  log.info(`Reading data from PostgREST at ${DB_URL}\n`);
});
