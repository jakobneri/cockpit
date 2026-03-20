import fs from 'fs';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/** 
 * PI COCKPIT AGENT v2.2.0
 * Multi-platform support with system-specific data collection.
 */

/** 
 * PI COCKPIT CLIENT v3.0.0
 * Multi-platform support reporting to PostgREST.
 */

const DB_URL = process.env.DB_URL || 'http://localhost:3000'; // Default to PostgREST on port 3000
const POLL_INTERVAL = 5000;
const HOSTNAME = os.hostname();

// Logging Utility
const log = {
  info: (msg) => console.log(`[${new Date().toLocaleTimeString()}] ℹ️  ${msg}`),
  success: (msg) => console.log(`[${new Date().toLocaleTimeString()}] ✅ ${msg}`),
  warn: (msg) => console.log(`[${new Date().toLocaleTimeString()}] ⚠️  ${msg}`),
  error: (msg) => console.log(`[${new Date().toLocaleTimeString()}] ❌ ${msg}`),
  report: (msg) => console.log(`[${new Date().toLocaleTimeString()}] 📤 ${msg}`),
  update: (msg) => console.log(`[${new Date().toLocaleTimeString()}] 🔄 ${msg}`)
};

// ── System Detection ──
const system = {
  platform: os.platform(),
  isLinux: os.platform() === 'linux',
  isWindows: os.platform() === 'win32',
  isPi: false,
  cpuCount: os.cpus().length,
  model: 'Unknown'
};

if (system.isLinux) {
  try {
    const modelData = fs.readFileSync('/proc/device-tree/model', 'utf8').replace(/\u0000/g, '');
    system.model = modelData || 'Linux System';
    if (modelData.includes('Raspberry Pi')) system.isPi = true;
  } catch {
    system.model = 'Linux System';
  }
} else if (system.isWindows) {
  system.model = 'Windows PC';
}

log.info(`Cockpit Client v5.0.0 starting on ${HOSTNAME}`);
log.info(`System: ${system.model} (${system.platform})`);
log.info(`PostgREST endpoint: ${DB_URL}`);

let lastCpuTicks = { idle: 0, total: 0 };
let lastNetBytes = { tx: 0, rx: 0, time: 0 };

// ── Metrics Helpers ──

function getCpuLoad() {
  try {
    if (system.isLinux) {
      const data = fs.readFileSync('/proc/stat', 'utf8');
      const cpuLine = data.split('\n').find(l => l.startsWith('cpu '));
      const parts = cpuLine.split(/\s+/).slice(1).map(Number);
      const idle = parts[3] + parts[4];
      const total = parts.reduce((a, b) => a + b, 1); // Avoid div by zero
      const diffIdle = idle - lastCpuTicks.idle;
      const diffTotal = total - lastCpuTicks.total;
      const load = diffTotal > 0 ? Math.round(100 * (1 - diffIdle / diffTotal)) : 0;
      lastCpuTicks = { idle, total };
      return Math.max(0, Math.min(100, load));
    } else {
      const cpus = os.cpus();
      let totalIdle = 0, totalTick = 0;
      cpus.forEach(cpu => {
        for (let type in cpu.times) totalTick += cpu.times[type];
        totalIdle += cpu.times.idle;
      });
      const diffIdle = totalIdle - lastCpuTicks.idle;
      const diffTotal = totalTick - lastCpuTicks.total;
      const load = diffTotal > 0 ? Math.round(100 * (1 - diffIdle / diffTotal)) : 0;
      lastCpuTicks = { idle: totalIdle, total: totalTick };
      return Math.max(0, Math.min(100, load));
    }
  } catch { return 0; }
}

function getMemory() {
  try {
    if (system.isLinux) {
      const data = fs.readFileSync('/proc/meminfo', 'utf8');
      const getVal = (key) => {
        const match = data.match(new RegExp(`${key}:\\s+(\\d+)`));
        return match ? parseInt(match[1]) * 1024 : 0;
      };
      const total = getVal('MemTotal');
      const avail = getVal('MemAvailable') || (getVal('MemFree') + getVal('Buffers') + getVal('Cached'));
      const used = total - avail;
      return { total, used, percent: Math.round((used / total) * 100) };
    } else {
      const total = os.totalmem();
      const free = os.freemem();
      const used = total - free;
      return { total, used, percent: Math.round((used / total) * 100) };
    }
  } catch { return { total: 0, used: 0, percent: 0 }; }
}

function getTemperature() {
  if (!system.isLinux) return 0;
  const paths = [
    '/sys/class/thermal/thermal_zone0/temp',
    '/sys/class/hwmon/hwmon0/temp1_input'
  ];
  for (const p of paths) {
    try {
      const temp = fs.readFileSync(p, 'utf8');
      return Math.round(parseInt(temp) / 1000);
    } catch {}
  }
  return 0;
}

async function getNetwork() {
  try {
    if (system.isLinux) {
      const data = fs.readFileSync('/proc/net/dev', 'utf8');
      const lines = data.split('\n');
      let totalRx = 0, totalTx = 0;
      for (const line of lines) {
        if (line.includes(':')) {
          const parts = line.trim().split(/\s+/);
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
    } else if (system.isWindows) {
      try {
        const { stdout } = await execAsync('netstat -e');
        const lines = stdout.split('\n');
        const bytesLine = lines.find(l => l.includes('Bytes'));
        if (!bytesLine) return { tx_sec: 0, rx_sec: 0 };
        
        const parts = bytesLine.trim().split(/\s+/);
        const totalRx = parseInt(parts[1]);
        const totalTx = parseInt(parts[2]);

        const now = Date.now();
        const diffSec = (now - lastNetBytes.time) / 1000;
        const rx_sec = diffSec > 0 ? (totalRx - lastNetBytes.rx) / diffSec : 0;
        const tx_sec = diffSec > 0 ? (totalTx - lastNetBytes.tx) / diffSec : 0;
        lastNetBytes = { tx: totalTx, rx: totalRx, time: now };
        return { tx_sec, rx_sec };
      } catch { return { tx_sec: 0, rx_sec: 0 }; }
    } else {
      return { tx_sec: 0, rx_sec: 0 };
    }
  } catch { return { tx_sec: 0, rx_sec: 0 }; }
}

async function getStorage() {
  try {
    if (system.isLinux) {
      const { stdout } = await execAsync('df -BK --output=source,size,used,pcent,target,fstype');
      const lines = stdout.split('\n').slice(1).filter(l => l.trim() !== '');
      const parsed = lines.map(l => {
        const p = l.trim().split(/\s+/);
        return { 
          total: parseInt(p[1]) * 1024, 
          used: parseInt(p[2]) * 1024, 
          percent: parseInt(p[3]), 
          path: p[4], 
          type: p[5] 
        };
      });
      return {
        root: parsed.find(d => d.path === '/'),
        smb: parsed.find(d => ['cifs', 'nfs', 'smbfs'].includes(d.type) || d.path.includes('nas'))
      };
    } else if (system.isWindows) {
      try {
        const { stdout } = await execAsync('powershell -NoProfile -Command "Get-Volume | Where-Object {$_.DriveLetter -ne $null} | Select-Object DriveLetter, Size, SizeRemaining, FileSystem | ConvertTo-Json"');
        const volumes = JSON.parse(stdout);
        const data = Array.isArray(volumes) ? volumes : [volumes];
        const parsed = data.map(v => ({
          total: v.Size,
          used: v.Size - v.SizeRemaining,
          percent: Math.round(((v.Size - v.SizeRemaining) / v.Size) * 100),
          path: v.DriveLetter + ':',
          type: v.FileSystem
        }));
        return {
          root: parsed.find(d => d.path === 'C:'),
          smb: parsed.find(d => d.type === 'CSVFS' || d.path.startsWith('\\')) 
        };
      } catch { return { root: null, smb: null }; }
    }
  } catch { return { root: null, smb: null }; }
}

// Removed getProcesses() to save RAM and CPU (was unused in v3.3.x)

let reportCount = 0;
async function report() {
  try {
    const stats = {
      cpu: { load: getCpuLoad(), temp: getTemperature() },
      memory: getMemory(),
      network: await getNetwork(),
      storage: await getStorage(),
      uptime: os.uptime()
    };

    const payload = {
      hostname: HOSTNAME,
      stats,
      reported_at: new Date().toISOString(),
      system_info: {} // Always include for database compatibility
    };

    // Only send full heavy system info & static metadata on first report or every 120 reports (~10 mins)
    if (reportCount % 120 === 0) {
      payload.system_info = system;
      payload.stats.os = system.platform;
      payload.stats.model = system.model;
    }
    reportCount++;

    const jsonPayload = JSON.stringify(payload);
    const bytesSent = Buffer.byteLength(jsonPayload);

    // V3: Report to PostgREST RPC function
    const response = await fetch(`${DB_URL}/rpc/report_client_metrics`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Prefer': 'params=single-object'
      },
      body: jsonPayload
    });

    if (response.ok) {
      log.report(`Status: ${response.status} | Bytes Sent: ${bytesSent}B`);
    } else {
      log.error(`Database reporting failed: ${response.status}`);
      const errText = await response.text();
      console.error(errText);
    }
  } catch (err) {
    log.error(`Database unreachable: ${err.message}`);
  }
}

const CLIENT_VERSION = '5.0.0';

setInterval(report, POLL_INTERVAL);
report();
