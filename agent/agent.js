import fs from 'fs';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/** 
 * PI COCKPIT AGENT v2.2.0
 * Multi-platform support with system-specific data collection.
 */

const HUB_URL = process.env.HUB_URL || 'http://localhost:3000';
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

log.info(`Cockpit Agent v2.2.0 starting on ${HOSTNAME}`);
log.info(`System: ${system.model} (${system.platform})`);
log.info(`Reporting to: ${HUB_URL}`);

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
      const total = parts.reduce((a, b) => a + b, 0);
      const diffIdle = idle - lastCpuTicks.idle;
      const diffTotal = total - lastCpuTicks.total;
      const load = diffTotal > 0 ? Math.round(100 * (1 - diffIdle / diffTotal)) : 0;
      lastCpuTicks = { idle, total };
      return load;
    } else {
      // Portable Fallback
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
      return load;
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
        const { stdout } = await execAsync('powershell "Get-NetAdapterStatistics | Select-Object ReceivedBytes, SentBytes | ConvertTo-Json"');
        const stats = JSON.parse(stdout);
        const data = Array.isArray(stats) ? stats : [stats];
        let totalRx = 0, totalTx = 0;
        data.forEach(s => {
          totalRx += s.ReceivedBytes || 0;
          totalTx += s.SentBytes || 0;
        });
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
        const { stdout } = await execAsync('powershell "Get-Volume | Where-Object {$_.DriveLetter -ne $null} | Select-Object DriveLetter, Size, SizeRemaining, FileSystem | ConvertTo-Json"');
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
          smb: parsed.find(d => d.type === 'CSVFS' || d.path.startsWith('\\')) // Rough SMB detection
        };
      } catch { return { root: null, smb: null }; }
    }
  } catch { return { root: null, smb: null }; }
}

async function getProcesses() {
  if (system.isWindows) {
    try {
      const { stdout } = await execAsync('powershell "Get-Process | Sort-Object CPU -Descending | Select-Object -First 5 Name, Id, CPU, WorkingSet | ConvertTo-Json"');
      const procs = JSON.parse(stdout);
      const data = Array.isArray(procs) ? procs : [procs];
      const cpuProcs = data.map(p => ({
        pid: p.Id,
        user: 'N/A',
        cpu: (p.CPU || 0).toFixed(1),
        mem: (p.WorkingSet / 1024 / 1024).toFixed(1),
        name: p.Name
      }));
      // Memory sorted
      const { stdout: mOut } = await execAsync('powershell "Get-Process | Sort-Object WorkingSet -Descending | Select-Object -First 5 Name, Id, CPU, WorkingSet | ConvertTo-Json"');
      const mData = JSON.parse(mOut);
      const memProcs = (Array.isArray(mData) ? mData : [mData]).map(p => ({
        pid: p.Id,
        user: 'N/A',
        name: p.Name,
        mem: (p.WorkingSet / 1024 / 1024).toFixed(1)
      }));
      return { cpu: cpuProcs, mem: memProcs };
    } catch (err) {
      log.error(`Process detection failed: ${err.message}`);
      return { cpu: [], mem: [] };
    }
  }
  if (!system.isLinux) return { cpu: [], mem: [] };
  try {
    const { stdout } = await execAsync('top -bn1 -o %CPU | head -n 12');
    const lines = stdout.split('\n');
    const headerIndex = lines.findIndex(l => l.includes('PID') && l.includes('COMMAND'));
    if (headerIndex === -1) return { cpu: [], mem: [] };
    const processLines = lines.slice(headerIndex + 1).filter(l => l.trim().length > 0).slice(0, 5);
    const cpuProcs = processLines.map(l => {
      const p = l.trim().split(/\s+/);
      return { pid: p[0], user: p[1], cpu: p[8], mem: p[9], name: p[11] };
    });
    const { stdout: mOut } = await execAsync('ps aux --sort=-%mem | head -6');
    const mem = mOut.split('\n').slice(1).filter(l => l.trim()).map(l => {
      const p = l.trim().split(/\s+/);
      return { pid: p[1], user: p[0], name: p[10].split('/').pop(), mem: p[3] };
    });
    return { cpu: cpuProcs, mem };
  } catch (err) {
    return { cpu: [], mem: [] };
  }
}

async function handleCommand(cmd) {
  log.info(`🛠️ Executing command: ${cmd.type} - ${cmd.action} ${cmd.service}`);
  try {
    if (system.isLinux && cmd.type === 'SERVICE_CONTROL') {
      let target = cmd.service;
      if (cmd.service === 'unifi') target = 'unifi-core.service';
      await execAsync(`sudo systemctl ${cmd.action} ${target}`);
      log.success(`Command execution finished.`);
    }
  } catch (err) {
    log.error(`Command failed: ${err.message}`);
  }
}

// ── Main Loop ──

async function report() {
  try {
    // Conditional collection flow
    const stats = {
      cpu: { load: getCpuLoad(), temp: getTemperature() },
      memory: getMemory(),
      network: await getNetwork(),
      storage: await getStorage(),
      processes: await getProcesses(),
      uptime: os.uptime(),
      os: system.platform,
      model: system.model
    };

    const payload = {
      hostname: HOSTNAME,
      stats,
      services: {}, // Generic agent doesn't check services unless configured
      systemInfo: system,
      timestamp: Date.now()
    };

    const jsonPayload = JSON.stringify(payload);
    const bytesSent = Buffer.byteLength(jsonPayload);

    const response = await fetch(`${HUB_URL}/api/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: jsonPayload
    });

    if (response.ok) {
      const data = await response.json();
      const bytesReceived = Buffer.byteLength(JSON.stringify(data));
      log.report(`In: ${bytesReceived}B | Out: ${bytesSent}B | Status: ${response.status}`);
      
      if (data.commands && data.commands.length > 0) {
        for (const cmd of data.commands) await handleCommand(cmd);
      }
    } else {
      log.error(`Report failed with status: ${response.status}`);
    }
  } catch (err) {
    log.error(`Hub unreachable: ${err.message}`);
  }
}

const AGENT_VERSION = '2.2.0';

async function runAutoUpdate() {
  if (system.isWindows) return;
  try {
    const isGit = fs.existsSync('.git') || fs.existsSync('../.git');
    process.stdout.write(`[${new Date().toLocaleTimeString()}] 🔄 Checking for Agent updates... `);
    
    if (isGit) {
      await execAsync('git fetch origin main');
      const { stdout } = await execAsync('git rev-list HEAD..origin/main --count');
      const count = parseInt(stdout.trim());
      if (count > 0) {
        console.log(`🚀 Found ${count} commits.`);
        log.update(`Pulling...`);
        await execAsync('git pull origin main');
        log.success('Restarting Agent...');
        process.exit(0);
      } else {
        console.log('✅ Up to date.');
      }
    } else {
      const res = await fetch('https://raw.githubusercontent.com/jakobneri/cockpit/main/agent/agent.js');
      if (!res.ok) { console.log('❌ Failed.'); return; }
      const text = await res.text();
      const match = text.match(/const AGENT_VERSION = '(.+?)'/);
      if (match && match[1] !== AGENT_VERSION) {
        console.log(`🚀 New version ${match[1]} found.`);
        fs.writeFileSync('agent.js', text);
        log.success('Restarting Agent...');
        process.exit(0);
      } else {
        console.log('✅ Up to date.');
      }
    }
  } catch (err) { console.log('❌ Error.'); }
}

setInterval(runAutoUpdate, 5 * 60 * 1000);
runAutoUpdate();

setInterval(report, POLL_INTERVAL);
report();
