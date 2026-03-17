import express from 'express';
import si from 'systeminformation';
import cors from 'cors';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
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
// ADAPTIVE POLLING ENGINE
// Polls fast (5s) when clients are active, slow (30s) when idle
// All data is cached server-side; API endpoints just return cache
// ============================================================

const FAST_INTERVAL = 5000;   // 5s when someone is watching
const SLOW_INTERVAL = 30000;  // 30s when idle
const IDLE_TIMEOUT = 30000;   // Consider idle after 30s of no requests

let lastClientRequest = 0;       // Timestamp of last API request
let pollTimer = null;            // Reference to the current polling timer
let currentInterval = SLOW_INTERVAL;

// Cached data
let cachedStats = null;          // CPU, RAM, Temp, Network, Uptime
let cachedProcesses = null;      // Top 5 CPU/RAM processes
let cachedStorage = null;        // Root + SMB disk info
let cachedServices = {};         // { nextcloud: 'running', ... }

// Track when slow data was last refreshed
let lastProcessRefresh = 0;
let lastStorageRefresh = 0;
let lastServiceRefresh = 0;

const PROCESS_CACHE_TTL = 10000; // Refresh processes every 10s max
const STORAGE_CACHE_TTL = 30000; // Refresh storage every 30s max
const SERVICE_CACHE_TTL = 15000; // Refresh services every 15s max

function isClientActive() {
  return (Date.now() - lastClientRequest) < IDLE_TIMEOUT;
}

function markActive() {
  lastClientRequest = Date.now();
  // If we were in slow mode, switch to fast
  if (currentInterval !== FAST_INTERVAL) {
    currentInterval = FAST_INTERVAL;
    restartPolling();
    // Silencing log when active as requested
  }
}

function restartPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollCycle, currentInterval);
}

// ── Fast data: CPU, RAM, Temp, Network ──
async function refreshFastStats() {
  try {
    const [cpu, mem, temp, net] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.cpuTemperature(),
      si.networkStats()
    ]);

    cachedStats = {
      os: isWindows ? 'win32' : 'linux',
      hostname: os.hostname(),
      uptime: os.uptime(),
      network: {
        tx_sec: net && net[0] ? net[0].tx_sec : 0,
        rx_sec: net && net[0] ? net[0].rx_sec : 0
      },
      cpu: {
        load: Math.round(cpu.currentLoad || 0),
        temp: temp.main ? Math.round(temp.main) : (isWindows ? 45 : 0)
      },
      memory: {
        total: mem.total,
        used: mem.active,
        free: mem.available,
        percent: Math.round((mem.active / mem.total) * 100) || 0
      }
    };
  } catch (err) {
    console.error('Error refreshing fast stats:', err.message);
  }
}

// ── Slow data: Processes (expensive!) ──
async function refreshProcesses() {
  if (Date.now() - lastProcessRefresh < PROCESS_CACHE_TTL) return;
  try {
    const processes = await si.processes();
    cachedProcesses = {
      cpu: processes && processes.list
        ? [...processes.list].sort((a, b) => b.cpu - a.cpu).slice(0, 5).map(p => ({ pid: p.pid, user: p.user || 'N/A', name: p.name, cpu: p.cpu.toFixed(1) }))
        : [],
      mem: processes && processes.list
        ? [...processes.list].sort((a, b) => b.mem - a.mem).slice(0, 5).map(p => ({ pid: p.pid, user: p.user || 'N/A', name: p.name, mem: p.mem.toFixed(1) }))
        : []
    };
    lastProcessRefresh = Date.now();
  } catch (err) {
    console.error('Error refreshing processes:', err.message);
  }
}

// ── Slow data: Storage (can block on SMB) ──
async function refreshStorage() {
  if (Date.now() - lastStorageRefresh < STORAGE_CACHE_TTL) return;
  try {
    const fsSize = await si.fsSize();
    const rootDrive = fsSize.find(fs => fs.mount === '/' || (isWindows && fs.mount.startsWith('C:')));
    const smbDrive = fsSize.find(fs => fs.type === 'cifs' || fs.type === 'nfs' || fs.type === 'smbfs' || fs.mount === '/nas-nextcloud-db' || fs.mount.toLowerCase().includes('mnt') || fs.mount.toLowerCase().includes('smb') || (isWindows && !fs.mount.startsWith('C:')));

    cachedStorage = {
      root: rootDrive ? { total: rootDrive.size, used: rootDrive.used, percent: Math.round(rootDrive.use) } : null,
      smb: smbDrive ? { total: smbDrive.size, used: smbDrive.used, path: smbDrive.mount, percent: Math.round(smbDrive.use) } : null
    };
    lastStorageRefresh = Date.now();
  } catch (err) {
    console.error('Error refreshing storage:', err.message);
  }
}

// ── Service status (uses cached process list for fallback) ──
async function refreshServices() {
  if (Date.now() - lastServiceRefresh < SERVICE_CACHE_TTL) return;
  const services = ['nextcloud', 'unifi', 'pihole-FTL'];
  for (const service of services) {
    try {
      const { stdout } = await runServiceCmd(service, 'status');
      let isActive = false;

      if (isWindows) {
        isActive = true;
      } else if (service === 'nextcloud') {
        isActive = stdout.includes('Up') || stdout.includes('running') || stdout.trim() === 'active';
      } else {
        isActive = stdout.trim() === 'active';
      }

      // Fallback: use the already-cached process list instead of calling si.processes() again
      if (!isActive && !isWindows && cachedProcesses) {
        // We need the raw process list for fallback — but we can use a lightweight pgrep instead
        try {
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
        } catch { /* pgrep returns exit 1 if not found — that's fine */ }
      }

      cachedServices[service] = isActive ? 'running' : 'stopped';
    } catch {
      // If systemctl throws, try lightweight pgrep fallback
      try {
        if (service === 'unifi') {
          await execAsync('pgrep -f unifi');
          cachedServices[service] = 'running';
        } else if (service === 'nextcloud') {
          await execAsync('pgrep -f "apache2|mariadbd"');
          cachedServices[service] = 'running';
        } else if (service === 'pihole-FTL') {
          await execAsync('pgrep -f pihole-FTL');
          cachedServices[service] = 'running';
        } else {
          cachedServices[service] = 'stopped';
        }
      } catch {
        cachedServices[service] = 'stopped';
      }
    }
  }
  lastServiceRefresh = Date.now();
}

// ── Main poll cycle ──
let pollCount = 0;

async function pollCycle() {
  pollCount++;

  // Check if we should switch to slow mode
  if (!isClientActive() && currentInterval === FAST_INTERVAL) {
    currentInterval = SLOW_INTERVAL;
    restartPolling();
    console.log('💤 No active clients — switching to slow polling (30s)');
  }

  // Always refresh fast stats
  await refreshFastStats();

  // Only refresh expensive data when a client is active
  const active = isClientActive();
  if (active) {
    await refreshProcesses();
    await refreshStorage();
    await refreshServices();
  }

  // Status report
  if (!active && pollCount % 2 === 0) {
    const cpu = cachedStats?.cpu?.load ?? '?';
    const mem = cachedStats?.memory?.percent ?? '?';
    const temp = cachedStats?.cpu?.temp ?? '?';
    console.log(`📊 Idle Poll #${pollCount} | CPU: ${cpu}% | RAM: ${mem}% | Temp: ${temp}°C`);
  }
}

// ============================================================
// API ENDPOINTS — just return cached data, zero computation
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

// ============================================================
// SERVICE MANAGEMENT (start/stop/restart) — not cached, runs live
// ============================================================

const runServiceCmd = async (service, action) => {
  if (isWindows) {
    const isStatus = action === 'status';
    return { stdout: isStatus ? 'active' : `Mock executed: ${action} ${service}` };
  }

  if (service === 'nextcloud') {
    if (action === 'status') {
      try {
        return await execAsync('cd /home/archimedes/nextcloud && sudo docker compose ps');
      } catch (e) {
        return await execAsync('systemctl is-active apache2');
      }
    } else if (action === 'start') {
      try { return await execAsync('cd /home/archimedes/nextcloud && sudo docker compose up -d'); }
      catch (e) { return await execAsync('sudo systemctl start apache2'); }
    } else if (action === 'stop') {
      try { return await execAsync('cd /home/archimedes/nextcloud && sudo docker compose stop'); }
      catch (e) { return await execAsync('sudo systemctl stop apache2'); }
    } else if (action === 'restart') {
      try { return await execAsync('cd /home/archimedes/nextcloud && sudo docker compose restart'); }
      catch (e) { return await execAsync('sudo systemctl restart apache2'); }
    }
  } else {
    let targetService = service;
    if (service === 'unifi') {
      try {
        await execAsync('systemctl is-active unifi-core.service');
        targetService = 'unifi-core.service';
      } catch { targetService = 'unifi-core'; }
    }

    if (action === 'status') {
      return await execAsync(`systemctl is-active ${targetService}`);
    } else {
      return await execAsync(`sudo systemctl ${action} ${targetService}`);
    }
  }
};

app.post('/api/services/:service/:action', async (req, res) => {
  const { service, action } = req.params;
  const validServices = ['nextcloud', 'unifi', 'pihole-FTL'];
  const validActions = ['start', 'stop', 'restart'];

  if (!validServices.includes(service) || !validActions.includes(action)) {
    return res.status(400).json({ error: 'Invalid service or action' });
  }

  try {
    const { stdout } = await runServiceCmd(service, action);
    // Force-refresh service status after an action
    lastServiceRefresh = 0;
    setTimeout(refreshServices, 2000);
    res.json({ success: true, output: stdout });
  } catch (error) {
    console.error(`Error with service ${service} action ${action}:`, error);
    res.status(500).json({ error: 'Service command failed', details: error.message });
  }
});

// ============================================================
// LOGS ENDPOINT — runs live, not cached
// ============================================================

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
    } else {
      return res.status(400).json({ error: 'Invalid service for logs' });
    }

    if (isWindows) {
      return res.json({ logs: '[Simulated Logs on Windows]\nStarting service...\nService running OK.' });
    }

    const { stdout, stderr } = await execAsync(cmd);
    res.json({ logs: stdout || stderr || 'No logs found.' });
  } catch (err) {
    res.json({ logs: `Could not fetch logs:\n${err.message}\n\nTip: Make sure the node process has permission to read journalctl.\nYou can grant access with: sudo usermod -aG systemd-journal $(whoami)` });
  }
});

// ============================================================
// AUTO-UPDATE
// ============================================================

const runAutoUpdate = async (force = false) => {
  if (isWindows) return;
  try {
    if (!force) {
      await execAsync('git fetch');
      const { stdout: status } = await execAsync('git status -uno');
      if (!status.includes('Your branch is behind')) return;
    }
    console.log('Updates found! Pulling new code...');
    await execAsync('git pull');
    console.log('Installing dependencies...');
    await execAsync('npm install --include=dev');
    console.log('Building project...');
    await execAsync('npx vite build');
    console.log('Update complete. Process exiting to trigger a restart...');
    setTimeout(() => process.exit(0), 1000);
  } catch (error) {
    console.error('Auto-update error:', error);
  }
};

setInterval(() => runAutoUpdate(), 60 * 1000);

app.post('/api/webhook/update', (req, res) => {
  res.json({ message: 'Auto-update webhook triggered.' });
  runAutoUpdate(true);
});

// ============================================================
// STARTUP
// ============================================================

// Do an initial data load, then start polling in slow mode
(async () => {
  console.log('🚀 Initial data load...');
  await refreshFastStats();
  await refreshProcesses();
  await refreshStorage();
  await refreshServices();
  console.log('✅ Cache primed, starting adaptive polling');
  pollTimer = setInterval(pollCycle, currentInterval);
})();

app.listen(PORT, () => {
  console.log(`Backend Server running on http://localhost:${PORT}`);
});
