// Configuration
const REFRESH_INTERVAL_FLEET = 5000;
const REFRESH_INTERVAL_STATS = 5000;

// State
let currentView = 'overview'; // 'overview' or 'details'
let selectedHostname = null;
let statsTimer = null;
let fleetTimer = null;

// Helper to format bytes
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Format uptime
function formatUptime(seconds) {
  if (!seconds) return '--';
  const d = Math.floor(seconds / (3600*24));
  const h = Math.floor(seconds % (3600*24) / 3600);
  const m = Math.floor(seconds % 3600 / 60);
  let str = [];
  if (d > 0) str.push(`${d}d`);
  if (h > 0) str.push(`${h}h`);
  str.push(`${m}m`);
  return str.join(' ');
}

// Update DOM element
function updateElement(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

// Chart.js Setup
const maxDataPoints = 12;
const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  scales: {
    x: { display: false },
    y: {
      min: 0, max: 100, display: true,
      ticks: { display: true, color: 'rgba(148,163,184,0.4)', font: { size: 9 }, maxTicksLimit: 3, callback: v => v + '%' },
      grid: { color: 'rgba(255,255,255,0.03)' },
      border: { display: false }
    }
  },
  plugins: { legend: { display: false }, tooltip: { enabled: false } },
  animation: { duration: 400 },
  elements: {
    line: { tension: 0.4, borderWidth: 2.5 },
    point: { radius: 0, hoverRadius: 3 }
  },
  layout: { padding: { left: 0, right: 4, top: 4, bottom: 0 } }
};

const netChartOptions = {
  ...chartOptions,
  scales: {
    x: { display: false },
    y: {
      min: 0, display: true, beginAtZero: true,
      ticks: { display: true, color: 'rgba(148,163,184,0.4)', font: { size: 9 }, maxTicksLimit: 3, callback: v => v.toFixed(1) },
      grid: { color: 'rgba(255,255,255,0.03)' },
      border: { display: false }
    }
  }
};

let cpuChart, ramChart, tempChart, txChart, rxChart;

function createCharts() {
  // Clear any existing instances
  if (cpuChart) cpuChart.destroy();
  if (ramChart) ramChart.destroy();
  if (tempChart) tempChart.destroy();
  if (txChart) txChart.destroy();
  if (rxChart) rxChart.destroy();

  const createLine = (id, color, opts) => {
    const canvas = document.getElementById(id);
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, 120);
    gradient.addColorStop(0, color + '60'); 
    gradient.addColorStop(1, color + '00'); 
    
    return new Chart(ctx, {
      type: 'line',
      data: {
        labels: Array(maxDataPoints).fill(''),
        datasets: [{
          data: Array(maxDataPoints).fill(null),
          borderColor: color,
          backgroundColor: gradient,
          fill: true,
          spanGaps: false
        }]
      },
      options: opts || chartOptions
    });
  };

  cpuChart = createLine('cpuChart', '#3b82f6');
  ramChart = createLine('ramChart', '#8b5cf6');
  tempChart = createLine('tempChart', '#ef4444');
  txChart = createLine('txChart', '#10b981', netChartOptions);
  rxChart = createLine('rxChart', '#f59e0b', netChartOptions);
}

function updateChart(chart, newValue) {
  if (!chart) return;
  const data = chart.data.datasets[0].data;
  data.push(newValue);
  data.shift();
  chart.update();
}

/** ── Fleet Overview Logic ── **/

async function fetchFleet() {
  try {
    const res = await fetch('/api/fleet');
    const data = await res.json();
    
    // Update Hub Hostname in Header if not in details view
    if (currentView === 'overview') {
      document.getElementById('header-hostname').textContent = `${data.hubHostname || 'Fleet'} Hub`;
      document.title = `${data.hubHostname || 'Fleet'} Cockpit`;
    }

    renderFleet(data.servers);
  } catch (err) {
    console.error('Error fetching fleet:', err);
  }
}

function renderFleet(servers) {
  const container = document.getElementById('nodes-container');
  if (!container) return;

  if (Object.keys(servers).length === 0) {
    container.innerHTML = '<div class="glass" style="grid-column: 1/-1; text-align: center; padding: 4rem;"><h3>Waiting for first reports...</h3><p>Ensure your agents are running and pointing to this Hub IP.</p></div>';
    return;
  }

  container.innerHTML = Object.entries(servers).map(([hostname, data]) => {
    const isOnline = (Date.now() - data.lastReport) < 15000;
    return `
      <div class="card glass node-card" onclick="openDetails('${hostname}')">
        <div class="node-header">
          <span class="node-hostname">${hostname}</span>
          <div class="heartbeat ${isOnline ? 'active' : 'error'}"></div>
        </div>
        <div class="node-metrics">
          <div class="mini-metric">
            <span class="label">CPU</span>
            <span class="val">${data.cpu.load}%</span>
          </div>
          <div class="progress-bar" style="height: 4px;"><div class="progress-fill" style="width: ${data.cpu.load}%;"></div></div>
          
          <div class="mini-metric">
            <span class="label">RAM</span>
            <span class="val">${data.memory.percent}%</span>
          </div>
          <div class="progress-bar" style="height: 4px;"><div class="progress-fill" style="width: ${data.memory.percent}%; background-color: var(--accent-purple);"></div></div>
          
          <div class="mini-metric" style="margin-top: 0.5rem;">
            <span class="label">Uptime</span>
            <span class="val" style="color: var(--text-secondary); font-size: 0.8rem;">${formatUptime(data.uptime)}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

/** ── Detailed View Logic ── **/

async function fetchNodeStats() {
  if (!selectedHostname) return;
  try {
    const res = await fetch(`/api/stats/${selectedHostname}`);
    const data = await res.json();

    // Heartbeat
    const heartbeat = document.getElementById('heartbeat-dot');
    if (heartbeat) {
      heartbeat.className = 'heartbeat active';
      setTimeout(() => heartbeat.className = 'heartbeat', 500);
    }

    // Header 
    document.getElementById('header-hostname').innerHTML = `← <span style="cursor: pointer;" onclick="showOverview()">${selectedHostname}</span>`;
    document.title = `${selectedHostname} | Cockpit`;
    const osInfo = document.getElementById('os-info');
    if (osInfo) {
      osInfo.style.display = 'block';
      osInfo.textContent = `Running ${data.os || 'Linux'} | Uptime: ${formatUptime(data.uptime)}`;
    }

    // Metrics
    updateElement('cpu-load', data.cpu.load);
    updateChart(cpuChart, data.cpu.load);
    updateElement('cpu-temp', data.cpu.temp);
    updateChart(tempChart, data.cpu.temp);

    updateElement('ram-usage', data.memory.percent);
    updateChart(ramChart, data.memory.percent);
    updateElement('ram-detail', `${formatBytes(data.memory.used)} / ${formatBytes(data.memory.total)}`);

    if (data.network) {
      const txKB = (data.network.tx_sec / 1024).toFixed(1);
      const rxKB = (data.network.rx_sec / 1024).toFixed(1);
      updateElement('net-tx', txKB);
      updateChart(txChart, parseFloat(txKB));
      updateElement('net-rx', rxKB);
      updateChart(rxChart, parseFloat(rxKB));
    }

    // Storage
    if (data.storage.root) {
      updateElement('root-percent', `${data.storage.root.percent}%`);
      updateProgress('root-bar', data.storage.root.percent);
      updateElement('root-detail', `${formatBytes(data.storage.root.used)} / ${formatBytes(data.storage.root.total)}`);
    }

    if (data.storage.smb) {
      updateElement('smb-name', `SMB (${data.storage.smb.path})`);
      updateElement('smb-percent', `${data.storage.smb.percent}%`);
      updateProgress('smb-bar', data.storage.smb.percent);
      updateElement('smb-detail', `${formatBytes(data.storage.smb.used)} / ${formatBytes(data.storage.smb.total)}`);
    } else {
      updateElement('smb-detail', 'Not Mounted');
      updateProgress('smb-bar', 0);
    }

    // Processes
    if (data.processes) {
      renderProcesses('process-cpu-list', data.processes.cpu, 'cpu');
      renderProcesses('process-mem-list', data.processes.mem, 'mem');
    }

    // Services
    if (data.services) {
      Object.entries(data.services).forEach(([service, status]) => {
        const card = document.querySelector(`.service-card[data-service="${service}"]`);
        if (card) {
          const badge = card.querySelector('.status-badge');
          if (badge) {
            badge.textContent = status.toUpperCase();
            badge.className = `status-badge ${status}`;
          }
        }
      });
    }

  } catch (error) {
    console.error('Error fetching node stats:', error);
  }
}

// Navigation
window.openDetails = (hostname) => {
  selectedHostname = hostname;
  currentView = 'details';
  document.getElementById('view-overview').style.display = 'none';
  document.getElementById('view-details').style.display = 'grid';
  
  createCharts(); // Re-init charts for this node
  fetchNodeStats();
  
  if (fleetTimer) clearInterval(fleetTimer);
  statsTimer = setInterval(fetchNodeStats, REFRESH_INTERVAL_STATS);
};

window.showOverview = () => {
  selectedHostname = null;
  currentView = 'overview';
  document.getElementById('view-overview').style.display = 'block';
  document.getElementById('view-details').style.display = 'none';
  
  const osInfo = document.getElementById('os-info');
  if (osInfo) osInfo.style.display = 'none';
  
  if (statsTimer) clearInterval(statsTimer);
  fetchFleet();
  fleetTimer = setInterval(fetchFleet, REFRESH_INTERVAL_FLEET);
};

// Utilities
function updateProgress(id, percent) {
  const el = document.getElementById(id);
  if (el) {
    el.style.width = `${percent}%`;
    el.className = `progress-fill ${percent >= 90 ? 'danger' : (percent >= 70 ? 'warning' : '')}`;
  }
}

function renderProcesses(listId, data, type) {
  const listEl = document.getElementById(listId);
  if (!listEl) return;
  listEl.innerHTML = data.map(p => `
    <tr class="process-item">
      <td class="col-pid">${p.pid}</td>
      <td class="col-user">${p.user}</td>
      <td class="col-name" title="${p.name}">${p.name}</td>
      <td class="col-val" style="padding-right: 1rem;">
        <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 4px;">
          <span>${type === 'cpu' ? p.cpu : p.mem}%</span>
        </div>
      </td>
    </tr>
  `).join('');
}

window.serviceAction = async (service, action) => {
  if (!selectedHostname) return;
  try {
    const res = await fetch(`/api/services/${selectedHostname}/${service}/${action}`, { method: 'POST' });
    if (res.ok) fetchNodeStats();
  } catch (err) { alert(err.message); }
};

window.openLogs = async (service) => {
  // Log implementation simplified for v2 (queued via agent)
  alert('Log request queued. In v2.0, logs will be visible in the next dashboard refresh.');
  const res = await fetch(`/api/services/${selectedHostname}/${service}/logs`);
};

// Start
document.addEventListener('DOMContentLoaded', showOverview);
