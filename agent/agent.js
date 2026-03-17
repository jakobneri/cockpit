import fs from 'fs';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/** 
 * PI COCKPIT AGENT v2.1.1
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

log.info(`Cockpit Agent v2.1.1 starting on ${HOSTNAME}`);
log.info(`Reporting to: ${HUB_URL}`);

let lastCpuTicks = { idle: 0, total: 0 };
let lastNetBytes = { tx: 0, rx: 0, time: 0 };

// ── Metrics Helpers ──

function getCpuLoad() {
  try {
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
  } catch { return 0; }
}

function getMemory() {
  try {
    const data = fs.readFileSync('/proc/meminfo', 'utf8');
    const getVal = (key) => {
      const match = data.match(new RegExp(`${key}:\\s+(\\d+)`));
      return match ? parseInt(match[1]) * 1024 : 0;
    };
    const total = getVal('MemTotal');
    const avail = getVal('MemAvailable');
    const used = total - avail;
    return { total, used, percent: Math.round((used / total) * 100) };
  } catch { return { total: 0, used: 0, percent: 0 }; }
}

function getTemperature() {
  try {
    const temp = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8');
    return Math.round(parseInt(temp) / 1000);
  } catch { return 0; }
}

function getNetwork() {
  try {
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
  } catch { return { tx_sec: 0, rx_sec: 0 }; }
}

async function getStorage() {
  try {
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
  } catch { return { root: null, smb: null }; }
}

async function getProcesses() {
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
    if (cmd.type === 'SERVICE_CONTROL') {
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
    const stats = {
      cpu: { load: getCpuLoad(), temp: getTemperature() },
      memory: getMemory(),
      network: getNetwork(),
      storage: await getStorage(),
      processes: await getProcesses(),
      uptime: os.uptime(),
      os: os.platform()
    };

    const payload = {
      hostname: HOSTNAME,
      stats,
      services: {},
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
      log.report(`Out: ${bytesSent}B | In: ${bytesReceived}B | Status: ${response.status}`);
      
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

const AGENT_VERSION = '2.1.4';

async function runAutoUpdate() {
  if (os.platform() === 'win32') return;
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

setInterval(runAutoUpdate, 1 * 60 * 1000); 
runAutoUpdate();

setInterval(report, POLL_INTERVAL);
report();
