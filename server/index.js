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

// Logging Utility
const log = {
  info: (msg) => console.log(`[${new Date().toLocaleTimeString()}] ℹ️  ${msg}`),
  success: (msg) => console.log(`[${new Date().toLocaleTimeString()}] ✅ ${msg}`),
  warn: (msg) => console.log(`[${new Date().toLocaleTimeString()}] ⚠️  ${msg}`),
  error: (msg) => console.log(`[${new Date().toLocaleTimeString()}] ❌ ${msg}`),
  report: (msg) => console.log(`[${new Date().toLocaleTimeString()}] 📡 ${msg}`),
  update: (msg) => console.log(`[${new Date().toLocaleTimeString()}] 🔄 ${msg}`)
};

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../dist')));

// ============================================================
// V2.1 HUB SERVER
// ============================================================

const DATA_DIR = path.join(__dirname, '../data');
const DATA_FILE = path.join(DATA_DIR, 'servers.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const loadServers = () => {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) { log.error('Could not load servers.json'); }
  return {};
};

const saveServers = () => {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(servers, null, 2));
  } catch (e) { log.error('Could not save servers.json'); }
};

const servers = loadServers();
const commandQueues = {};
let activeClients = 0;
let activeTimeout = null;
let reportCounters = {};

setInterval(saveServers, 30000);

app.post('/api/report', (req, res) => {
  const { hostname, stats, services, timestamp } = req.body;
  if (!hostname) return res.status(400).json({ error: 'Missing hostname' });

  // Update server data and maintain history
  if (!servers[hostname]) servers[hostname] = {};
  if (!servers[hostname].history) servers[hostname].history = [];

  const newEntry = {
    ...stats,
    services: services || {},
    lastReport: timestamp || Date.now()
  };

  servers[hostname] = { ...servers[hostname], ...newEntry };
  
  // Store history (last 60 reports ~5 minutes)
  servers[hostname].history.push({
    cpu: stats.cpu?.load || 0,
    ram: stats.memory?.percent || 0,
    tx: stats.network?.tx_sec || 0,
    rx: stats.network?.rx_sec || 0,
    time: timestamp || Date.now()
  });

  if (servers[hostname].history.length > 60) {
    servers[hostname].history.shift();
  }

  const commands = commandQueues[hostname] || [];
  commandQueues[hostname] = [];

  const bytesReceived = Buffer.byteLength(JSON.stringify(req.body));
  
  if (!reportCounters[hostname]) reportCounters[hostname] = 0;
  reportCounters[hostname]++;

  const threshold = activeClients > 0 ? 10 : 2;
  if (reportCounters[hostname] % threshold === 0) {
    const s = stats || {};
    const cpu = s.cpu ? `${s.cpu.load}%` : '--';
    const ram = s.memory ? `${s.memory.percent}%` : '--';
    log.report(`[${hostname}] CPU: ${cpu} | RAM: ${ram} | In: ${bytesReceived}B`);
  }

  res.json({ success: true, commands });
});

app.post('/api/active', (req, res) => {
  activeClients = 1;
  if (activeTimeout) clearTimeout(activeTimeout);
  activeTimeout = setTimeout(() => { activeClients = 0; }, 15000);
  res.json({ success: true });
});

app.get('/api/fleet', (req, res) => {
  res.json({ hubHostname: os.hostname(), servers });
});

app.get('/api/stats/:hostname', (req, res) => {
  const server = servers[req.params.hostname];
  if (!server) return res.status(404).json({ error: 'Node not found' });
  res.json({ hostname: req.params.hostname, ...server });
});

app.post('/api/services/:hostname/:service/:action', (req, res) => {
  const { hostname, service, action } = req.params;
  if (!commandQueues[hostname]) commandQueues[hostname] = [];
  commandQueues[hostname].push({ type: 'SERVICE_CONTROL', service, action });
  res.json({ success: true, message: `Command queued for ${hostname}` });
});

app.get('/api/services/:hostname/:service/logs', (req, res) => {
  const { hostname, service } = req.params;
  if (!commandQueues[hostname]) commandQueues[hostname] = [];
  commandQueues[hostname].push({ type: 'REQUEST_LOGS', service });
  res.json({ success: true, message: 'Log request queued.' });
});

const isWindows = process.platform === 'win32';
const runAutoUpdate = async (force = false) => {
  if (isWindows) return;
  try {
    process.stdout.write(`[${new Date().toLocaleTimeString()}] 🔄 Checking for Hub updates... `);
    
    await execAsync('git fetch origin main');
    const { stdout: behindCount } = await execAsync('git rev-list HEAD..origin/main --count');
    const count = parseInt(behindCount.trim());

    if (count === 0 && !force) {
      console.log('✅ Up to date.');
      return;
    }

    console.log(`🚀 Update found: ${count} commits.`);
    const start = Date.now();

    log.update(`Found ${count} new commits. Pulling...`);
    const { stdout: pullOut } = await execAsync('git pull origin main');
    log.info(`Pull result: ${pullOut.split('\n')[0]}`);

    log.update('Installing dependencies (npm install)...');
    await execAsync('npm install --include=dev');
    
    log.update('Building frontend (vite build)...');
    await execAsync('npx vite build');
    
    log.success(`Update complete in ${((Date.now() - start) / 1000).toFixed(1)}s. Restarting Hub...`);
    setTimeout(() => process.exit(0), 1000);
  } catch (error) { 
    log.error(`Auto-update failed: ${error.message}`);
  }
};

setInterval(() => runAutoUpdate(), 1 * 60 * 1000);
runAutoUpdate();

app.listen(PORT, () => {
  console.log(`\n🚀 nerifeige.de hub v2.1.5 running on http://192.168.188.22:${PORT}`);
  log.info(`Ready to receive reports at /api/report\n`);
});
