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

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../dist')));

// ============================================================
// V2.0 HUB SERVER
// Central repository for monitoring data from all agents
// ============================================================

const DATA_DIR = path.join(__dirname, '../data');
const DATA_FILE = path.join(DATA_DIR, 'servers.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const loadServers = () => {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) { console.error('⚠️ Could not load servers.json'); }
  return {};
};

const saveServers = () => {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(servers, null, 2));
  } catch (e) { console.error('⚠️ Could not save servers.json'); }
};

const servers = loadServers();  // Map of hostname -> latest reported stats
const commandQueues = {};  // Map of hostname -> array of pending commands
let activeClients = 0;     // Number of browsers watching the dashboard
let activeTimeout = null;
let reportCounters = {};   // hostname -> count (for periodic logging)

// Periodic flush to disk
setInterval(saveServers, 30000);

// API: Agent Report (POSTed by agents every few seconds)
app.post('/api/report', (req, res) => {
  const { hostname, stats, services, timestamp } = req.body;
  if (!hostname) return res.status(400).json({ error: 'Missing hostname' });

  // Update server data
  servers[hostname] = {
    ...stats,
    services: services || {},
    lastReport: timestamp || Date.now()
  };

  // Return any pending commands for this agent
  const commands = commandQueues[hostname] || [];
  commandQueues[hostname] = []; // Clear queue after sending

  const bytesReceived = Buffer.byteLength(JSON.stringify(req.body));
  
  // Adaptive Logging:
  // If browsers are watching, we stay quiet (log every 10th report)
  // If no one is watching, we log every 2nd report
  if (!reportCounters[hostname]) reportCounters[hostname] = 0;
  reportCounters[hostname]++;

  const threshold = activeClients > 0 ? 10 : 2;
  if (reportCounters[hostname] % threshold === 0) {
    const s = stats || {};
    const cpu = s.cpu ? `${s.cpu.load}%` : '--';
    const ram = s.memory ? `${s.memory.percent}%` : '--';
    const temp = s.cpu ? `${s.cpu.temp}°C` : '--';
    console.log(`📡 [${hostname}] CPU:${cpu} | RAM:${ram} | Temp:${temp} (${bytesReceived}B)`);
  }

  res.json({ success: true, commands });
});

// API: Heartbeat from Browser
app.post('/api/active', (req, res) => {
  activeClients = 1; // Mark as active
  if (activeTimeout) clearTimeout(activeTimeout);
  activeTimeout = setTimeout(() => { activeClients = 0; }, 15000); // Quiet after 15s inactivity
  res.json({ success: true });
});

// API: Get Fleet Overview (for the Dashboard)
app.get('/api/fleet', (req, res) => {
  // Return all current server states
  res.json({ 
    hubHostname: os.hostname(),
    servers 
  });
});

// API: Get Detailed Stats for a single server
app.get('/api/stats/:hostname', (req, res) => {
  const server = servers[req.params.hostname];
  if (!server) return res.status(404).json({ error: 'Node not found' });
  res.json({ hostname: req.params.hostname, ...server });
});

// API: Service Control (Adds a command to the queue for the agent)
app.post('/api/services/:hostname/:service/:action', (req, res) => {
  const { hostname, service, action } = req.params;
  
  if (!commandQueues[hostname]) commandQueues[hostname] = [];
  
  commandQueues[hostname].push({
    type: 'SERVICE_CONTROL',
    service,
    action
  });

  res.json({ success: true, message: `Command queued for ${hostname}` });
});

// API: Get Logs (Poll-and-response is tricky for logs, so we'll request it)
app.get('/api/services/:hostname/:service/logs', (req, res) => {
  const { hostname, service } = req.params;
  
  if (!commandQueues[hostname]) commandQueues[hostname] = [];
  commandQueues[hostname].push({
    type: 'REQUEST_LOGS',
    service
  });

  res.json({ 
    success: true, 
    message: 'Log request queued. Result will appear in next heartbeat.' 
  });
});

const isWindows = process.platform === 'win32';
const runAutoUpdate = async (force = false) => {
  if (isWindows) return;
  try {
    const start = Date.now();
    await execAsync('git fetch origin main');
    const { stdout: behindCount } = await execAsync('git rev-list HEAD..origin/main --count');
    
    const count = parseInt(behindCount.trim());
    if (count === 0 && !force) return;

    console.log(`🔄 [HUB UPDATE] Found ${count} new commits. Starting update...`);
    await execAsync('git pull origin main');
    await execAsync('npm install --include=dev');
    await execAsync('npx vite build');
    
    console.log(`✅ [HUB UPDATE] Finished in ${((Date.now() - start) / 1000).toFixed(1)}s. Restarting...`);
    setTimeout(() => process.exit(0), 1000);
  } catch (error) { 
    console.error('❌ [HUB UPDATE] Update failed:', error.message);
  }
};

setInterval(() => runAutoUpdate(), 2 * 60 * 1000); // Check every 2 mins instead of 5
runAutoUpdate(); // Check immediately on boot just in case it was missed during sleep/restart

app.listen(PORT, () => {
  console.log(`\n🚀 Pi Cockpit v2.0 HUB running on http://localhost:${PORT}`);
  console.log(`📡 Ready to receive reports at /api/report\n`);
});
