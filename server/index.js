import express from 'express';
import cors from 'cors';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../dist')));

const isWindows = process.platform === 'win32';

// ============================================================
// LITE POLLING ENGINE (Direct /proc and /sys reads)
// Drops systeminformation dependency for zero-overhead monitoring
// ============================================================

const FAST_INTERVAL = 5000;
const SLOW_INTERVAL = 30000;
const IDLE_TIMEOUT = 30000;

let lastClientRequest = 0;
let pollTimer = null;
let currentInterval = SLOW_INTERVAL;
let pollCount = 0;

// Cached data
let cachedStats = {};          
let cachedProcesses = { cpu: [], mem: [] };
let cachedStorage = { root: null, smb: null };
let cachedServices = {};         

// Refresh tracking
let lastProcessRefresh = 0;
let lastStorageRefresh = 0;
let lastServiceRefresh = 0;

const PROCESS_CACHE_TTL = 10000;
const STORAGE_CACHE_TTL = 30000;
const SERVICE_CACHE_TTL = 15000;

// CPU Delta tracking
let lastCpuTicks = { idle: 0, total: 0 };

function isClientActive() {
  return (Date.now() - lastClientRequest) < IDLE_TIMEOUT;
}

function markActive() {
  lastClientRequest = Date.now();
  if (currentInterval !== FAST_INTERVAL) {
    currentInterval = FAST_INTERVAL;
    restartPolling();
    console.log('⚡ Client connected — switching to fast polling (5s)');
  }
}

function restartPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollCycle, currentInterval);
}

// ── LITE: CPU Load from /proc/stat ──
function getCpuLoad() {
  if (isWindows) return 5;
  try {
    const data = fs.readFileSync('/proc/stat', 'utf8');
    const lines = data.split('\n');
    const cpuLine = lines.find(l => l.startsWith('cpu '));
    if (!cpuLine) return 0;
    
    // user nice system idle iowait irq softirq steal guest guest_nice
    const parts = cpuLine.split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + parts[4]; // idle + iowait
    const total = parts.reduce((a, b) => a + b, 0);
    
    const diffIdle = idle - lastCpuTicks.idle;
    const diffTotal = total - lastCpuTicks.total;
    const load = diffTotal > 0 ? Math.round(100 * (1 - diffIdle / diffTotal)) : 0;
    
    lastCpuTicks = { idle, total };
    return load;
  } catch { return 0; }
}

// ── LITE: Memory from /proc/meminfo ──
function getMemory() {
  if (isWindows) return { total: os.totalmem(), used: os.totalmem() - os.freemem(), percent: 50 };
  try {
    const data = fs.readFileSync('/proc/meminfo', 'utf8');
    const getVal = (key) => {
      const match = data.match(new RegExp(`${key}:\\s+(\\d+)`));
      return match ? parseInt(match[1]) * 1024 : 0; // Convert kB to Bytes
    };
    
    const total = getVal('MemTotal');
    const avail = getVal('MemAvailable');
    const used = total - avail;
    const percent = Math.round((used / total) * 100);
    
    return { total, used, free: avail, percent };
  } catch { return { total: 0, used: 0, free: 0, percent: 0 }; }
}

// ── LITE: Temperature from /sys ──
function getTemperature() {
  if (isWindows) return 45;
  try {
    const temp = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8');
    return Math.round(parseInt(temp) / 1000);
  } catch { return 0; }
}

// ── LITE: Network from /proc/net/dev ──
let lastNetBytes = { tx: 0, rx: 0, time: 0 };
function getNetwork() {
  if (isWindows) return { tx_sec: 0, rx_sec: 0 };
  try {
    const data = fs.readFileSync('/proc/net/dev', 'utf8');
    const lines = data.split('\n');
    let totalRx = 0;
    let totalTx = 0;
    
    // Skip headers, find eth0 or wlan0 or similar
    // Interface | Receive | Transmit
    // face | bytes packets ... | bytes packets ...
    for (const line of lines) {
      if (line.includes(':')) {
        const parts = line.trim().split(/\s+/);
        // parts[0] is face:
        // parts[1] is rx_bytes
        // parts[9] is tx_bytes
        totalRx += parseInt(parts[1]);
        totalTx += parseInt(parts[9]);
      }
    }
    
    const now = Date.now();
    const diffSec = (now - lastNetBytes.time) / 1000;
    const rx_sec = diffSec > 0 ? (totalRx - lastNetBytes.rx) / diffSec : 0;
    const tx_sec = diffSec > 0 ? (totalTx - lastNetBytes.tx) / diffSec : 0;
    
    lastNetBytes = { tx: totalTx, rx: totalRx, time: now };
    return { tx_sec, rx_sec };
  } catch { return { tx_sec: 0, rx_sec: 0 }; }
}

async function refreshFastStats() {
  cachedStats = {
    os: isWindows ? 'win32' : 'linux',
    hostname: os.hostname(),
    uptime: os.uptime(),
    cpu: {
      load: getCpuLoad(),
      temp: getTemperature()
    },
    memory: getMemory(),
    network: getNetwork()
  };
}

async function refreshProcesses() {
  if (Date.now() - lastProcessRefresh < PROCESS_CACHE_TTL) return;
  try {
    // Single efficient call to 'ps' for both lists
    const { stdout } = await execAsync('ps aux --sort=-%cpu | head -11');
    const lines = stdout.split('\n').slice(1).filter(l => l.trim() !== '');
    
    const parseLine = (l) => {
      const p = l.trim().split(/\s+/);
      return { pid: p[1], user: p[0], name: p[10].split('/').pop(), cpu: parseFloat(p[2]).toFixed(1), mem: parseFloat(p[3]).toFixed(1) };
    };

    const cpuProcs = lines.slice(0, 5).map(parseLine);
    
    const { stdout: memStdout } = await execAsync('ps aux --sort=-%mem | head -6');
    const memLines = memStdout.split('\n').slice(1).filter(l => l.trim() !== '');
    const memProcs = memLines.map(parseLine);

    cachedProcesses = { cpu: cpuProcs, mem: memProcs };
    lastProcessRefresh = Date.now();
  } catch (err) {
    console.error('Error refreshing processes:', err.message);
  }
}

async function refreshStorage() {
  if (Date.now() - lastStorageRefresh < STORAGE_CACHE_TTL) return;
  try {
    // df -BK for bytes in blocks of 1K
    const { stdout } = await execAsync('df -BK --output=source,size,used,pcent,target,fstype');
    const lines = stdout.split('\n').slice(1).filter(l => l.trim() !== '');
    
    const parseDf = (l) => {
      const p = l.trim().split(/\s+/);
      // source, size, used, pcent, target, fstype
      const sizeBytes = parseInt(p[1].replace('K', '')) * 1024;
      const usedBytes = parseInt(p[2].replace('K', '')) * 1024;
      const percent = parseInt(p[3].replace('%', ''));
      return { total: sizeBytes, used: usedBytes, percent, path: p[4], type: p[5] };
    };

    const parsed = lines.map(parseDf);
    const rootDrive = parsed.find(d => d.path === '/');
    const smbDrive = parsed.find(d => ['cifs', 'nfs', 'smbfs'].includes(d.type) || d.path.includes('nas') || d.path.includes('mnt'));

    cachedStorage = {
      root: rootDrive ? { total: rootDrive.total, used: rootDrive.used, percent: rootDrive.percent } : null,
      smb: smbDrive ? { total: smbDrive.total, used: smbDrive.used, path: smbDrive.path, percent: smbDrive.percent } : null
    };
    lastStorageRefresh = Date.now();
  } catch (err) {
    console.error('Error refreshing storage:', err.message);
  }
}

async function refreshServices() {
  if (Date.now() - lastServiceRefresh < SERVICE_CACHE_TTL) return;
  const services = ['nextcloud', 'unifi', 'pihole-FTL'];
  for (const service of services) {
    let isActive = false;
    try {
      if (isWindows) {
        isActive = true;
      } else {
        // Use pgrep as primary lightweight check
        if (service === 'unifi') {
          await execAsync('pgrep -f unifi');
          isActive = true;
        } else if (service === 'nextcloud') {
          await execAsync('pgrep -f "apache2|mariadbd"');
          isActive = true;
        } else if (service === 'pihole-FTL') {
          await execAsync('pgrep -f pihole-FTL');
          isActive = true;
        }
      }
    } catch { isActive = false; }
    cachedServices[service] = isActive ? 'running' : 'stopped';
  }
  lastServiceRefresh = Date.now();
}

async function pollCycle() {
  pollCount++;
  if (!isClientActive() && currentInterval === FAST_INTERVAL) {
    currentInterval = SLOW_INTERVAL;
    restartPolling();
    console.log('💤 No active clients — switching to slow polling (30s)');
  }

  await refreshFastStats();

  const active = isClientActive();
  if (active) {
    await refreshProcesses();
    await refreshStorage();
    await refreshServices();
  }

  // Logging logic
  if (!active && pollCount % 2 === 0) {
    const cpu = cachedStats?.cpu?.load ?? '?';
    const mem = cachedStats?.memory?.percent ?? '?';
    const temp = cachedStats?.cpu?.temp ?? '?';
    console.log(`📡 [IDLE] Poll #${pollCount} | CPU: ${cpu}% | RAM: ${mem}% | Temp: ${temp}°C`);
  }
}

// ============================================================
// API ENDPOINTS
// ============================================================

app.get('/api/stats', (req, res) => {
  markActive();
  res.json({
    ...cachedStats,
    storage: cachedStorage || { root: null, smb: null },
    processes: cachedProcesses || { cpu: [], mem: [] }
  });
});

app.get('/api/services/:service', (req, res) => {
  markActive();
  const { service } = req.params;
  res.json({ service, status: cachedServices[service] || 'stopped' });
});

app.get('/api/services/:service/logs', async (req, res) => {
  const { service } = req.params;
  try {
    let cmd = '';
    if (service === 'unifi') {
      cmd = 'sudo -n journalctl -u unifi-core.service -n 50 --no-pager 2>/dev/null || journalctl -u unifi-core.service -n 50 --no-pager';
    } else if (service === 'nextcloud') {
      cmd = 'cd /home/archimedes/nextcloud && sudo docker compose logs --tail 50 2>/dev/null || sudo -n journalctl -u apache2.service -n 50 --no-pager';
    } else if (service === 'pihole-FTL') {
      cmd = 'tail -n 50 /var/log/pihole.log 2>/dev/null || tail -n 50 /var/log/pihole/pihole-FTL.log 2>/dev/null || tail -n 50 /var/log/pihole/FTL.log 2>/dev/null || sudo -n journalctl -u pihole-FTL -n 50 --no-pager 2>/dev/null || pihole -t 2>/dev/null | head -50';
    } else return res.status(400).json({ error: 'Invalid service' });

    if (isWindows) return res.json({ logs: '[Simulated Logs Windows]' });
    const { stdout, stderr } = await execAsync(cmd);
    res.json({ logs: stdout || stderr || 'No logs found.' });
  } catch (err) {
    res.json({ logs: `Error:\n${err.message}` });
  }
});

app.post('/api/services/:service/:action', async (req, res) => {
  const { service, action } = req.params;
  try {
    let cmd = '';
    if (service === 'nextcloud') {
      cmd = `cd /home/archimedes/nextcloud && sudo docker compose ${action === 'stop' ? 'stop' : (action === 'restart' ? 'restart' : 'up -d')}`;
    } else {
      let target = service === 'unifi' ? 'unifi-core.service' : service;
      cmd = `sudo systemctl ${action} ${target}`;
    }
    const { stdout } = await execAsync(cmd);
    lastServiceRefresh = 0;
    setTimeout(refreshServices, 2000);
    res.json({ success: true, output: stdout });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const runAutoUpdate = async (force = false) => {
  if (isWindows) return;
  try {
    if (!force) {
      await execAsync('git fetch');
      const { stdout: status } = await execAsync('git status -uno');
      if (!status.includes('Your branch is behind')) return;
    }
    console.log('🔄 [UPDATE] New version detected. Starting update...');
    
    console.log('📥 [UPDATE] Pulling latest changes...');
    const { stdout: pullOut } = await execAsync('git pull');
    console.log(pullOut);

    console.log('📦 [UPDATE] Installing dependencies...');
    const { stdout: instOut } = await execAsync('npm install --include=dev');
    console.log(instOut);

    console.log('🏗️ [UPDATE] Building frontend assets...');
    const { stdout: buildOut } = await execAsync('npx vite build');
    console.log(buildOut);

    console.log('🚀 [UPDATE] Build successful. Restarting in 1s...');
    setTimeout(() => {
      console.log('👋 Goodbye! (PM2 will restart me)');
      process.exit(0);
    }, 1000);
  } catch (error) { 
    console.error('❌ [UPDATE] FAILED:');
    console.error(error.message);
    if (error.stdout) console.error('STDOUT:', error.stdout);
    if (error.stderr) console.error('STDERR:', error.stderr);
  }
};

setInterval(() => runAutoUpdate(), 60 * 1000);
app.post('/api/webhook/update', (req, res) => { res.json({ message: 'OK' }); runAutoUpdate(true); });

(async () => {
  console.log('🚀 LITE load...');
  await refreshFastStats();
  await refreshProcesses();
  await refreshStorage();
  await refreshServices();
  pollTimer = setInterval(pollCycle, currentInterval);
})();

app.listen(PORT, () => { console.log(`Lite Backend on http://localhost:${PORT}`); });
