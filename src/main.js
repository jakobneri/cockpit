// Configuration
const REFRESH_INTERVAL_FLEET = 5000;
const REFRESH_INTERVAL_STATS = 5000;

// State
let currentView = 'overview'; // 'overview' or 'details'
let detailViewMode = 'chart'; // 'chart' or 'table'
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
const maxDataPoints = 120; // 10 minutes of history @ 5s interval
const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  scales: {
    x: { display: false },
    y: {
      min: 0, display: true,
      ticks: { display: true, color: 'rgba(148,163,184,0.4)', font: { size: 9 }, maxTicksLimit: 3, callback: v => v + '%' },
      grid: { color: 'rgba(255,255,255,0.03)' },
      border: { display: false }
    }
  },
  plugins: { legend: { display: false }, tooltip: { enabled: true } },
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

let cpuChart, ramChart, netChart;

function createCharts() {
  if (cpuChart) cpuChart.destroy();
  if (ramChart) ramChart.destroy();
  if (netChart) netChart.destroy();

  const createGradient = (ctx, color) => {
    const grd = ctx.createLinearGradient(0, 0, 0, 150);
    grd.addColorStop(0, color + '70'); // Stronger fill at the top
    grd.addColorStop(0.3, color + '20'); // Quick fade
    grd.addColorStop(1, color + '00'); // Complete transparency
    return grd;
  };

  const createLine = (id, color, opts) => {
    const canvas = document.getElementById(id);
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    
    return new Chart(ctx, {
      type: 'line',
      data: {
        labels: Array(maxDataPoints).fill(''),
        datasets: [{
          data: Array(maxDataPoints).fill(null),
          borderColor: color,
          backgroundColor: createGradient(ctx, color),
          fill: true,
          spanGaps: true
        }]
      },
      options: opts || chartOptions
    });
  };

  cpuChart = createLine('cpuChart', '#3b82f6');
  ramChart = createLine('ramChart', '#818cf8');

  // Network Multi-line Chart
  const netCanvas = document.getElementById('netChart');
  if (netCanvas) {
    const ctx = netCanvas.getContext('2d');
    netChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: Array(maxDataPoints).fill(''),
        datasets: [
          {
            label: 'Download (Rx)',
            data: Array(maxDataPoints).fill(null),
            borderColor: '#f59e0b',
            backgroundColor: createGradient(ctx, '#f59e0b'),
            fill: true,
            tension: 0.4,
            borderWidth: 2
          },
          {
            label: 'Upload (Tx)',
            data: Array(maxDataPoints).fill(null),
            borderColor: '#10b981',
            backgroundColor: createGradient(ctx, '#10b981'),
            fill: true,
            tension: 0.4,
            borderWidth: 2
          }
        ]
      },
      options: netChartOptions
    });
  }
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
    
    // Update Hub branding in Header if not in details view
    if (currentView === 'overview') {
      document.getElementById('header-hostname').textContent = 'nerifeige.de hub';
      document.title = 'nerifeige.de Cockpit';
      
      const osInfo = document.getElementById('os-info');
      if (osInfo && data.hubSystem) {
        osInfo.style.display = 'block';
        const model = data.hubSystem.model || 'Hub System';
        osInfo.textContent = `${model} | Running ${data.hubSystem.os || 'Linux'} | Uptime: ${formatUptime(data.hubSystem.uptime)}`;
      }
    }

    renderFleet(data.servers || {});
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
        <div class="node-header" style="align-items: flex-start;">
          <div style="display: flex; flex-direction: column; gap: 2px;">
            <span class="node-hostname">${hostname}</span>
            <span style="font-size: 0.75rem; color: var(--text-secondary); font-weight: 500;">${data.model || 'Linux Node'}</span>
          </div>
          <div class="heartbeat ${isOnline ? 'active' : 'error'}" style="margin-top: 6px;"></div>
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
    document.getElementById('header-hostname').innerHTML = `<span style="cursor: pointer;" onclick="showOverview()">${selectedHostname}</span>`;
    document.title = `${selectedHostname} | Cockpit`;
    const osInfo = document.getElementById('os-info');
    if (osInfo) {
      osInfo.style.display = 'block';
      const model = data.model || 'Unknown System';
      osInfo.textContent = `${model} | Running ${data.os || 'Linux'} | Uptime: ${formatUptime(data.uptime)}`;
    }

    // Populate initial history if charts are fresh
    if (data.history && cpuChart?.data.datasets[0].data.every(v => v === null)) {
      const hist = data.history.slice(-maxDataPoints);
      const padding = maxDataPoints - hist.length;
      
      cpuChart.data.datasets[0].data = [...Array(padding).fill(null), ...hist.map(h => h.cpu)];
      ramChart.data.datasets[0].data = [...Array(padding).fill(null), ...hist.map(h => h.ram)];
      if (netChart) {
        netChart.data.datasets[0].data = [...Array(padding).fill(null), ...hist.map(h => parseFloat((h.rx / 1024).toFixed(1)))];
        netChart.data.datasets[1].data = [...Array(padding).fill(null), ...hist.map(h => parseFloat((h.tx / 1024).toFixed(1)))];
      }
      cpuChart.update('none');
      ramChart.update('none');
      netChart?.update('none');
    }

    // Update History Table if in table mode
    if (data.history && detailViewMode === 'table') {
      renderHistoryTable(data.history);
    }

    // Metrics
    updateElement('cpu-load', data.cpu.load);
    updateChart(cpuChart, data.cpu.load);

    updateElement('ram-usage', data.memory.percent);
    updateChart(ramChart, data.memory.percent);
    updateElement('ram-detail', `${formatBytes(data.memory.used)} / ${formatBytes(data.memory.total)}`);

    if (data.network && netChart) {
      const txKB = (data.network.tx_sec / 1024).toFixed(1);
      const rxKB = (data.network.rx_sec / 1024).toFixed(1);
      updateElement('net-tx', txKB);
      updateElement('net-rx', rxKB);
      
      // Update dual dataset chart (Rx is set 0, Tx is set 1)
      const rxData = netChart.data.datasets[0].data;
      const txData = netChart.data.datasets[1].data;
      rxData.push(parseFloat(rxKB));
      txData.push(parseFloat(txKB));
      rxData.shift();
      txData.shift();
      netChart.update();
    }

    // Storage
    if (data.storage.root) {
      updateElement('root-percent', `${data.storage.root.percent}%`);
      updateProgress('root-bar', data.storage.root.percent);
      updateElement('root-detail', `${formatBytes(data.storage.root.used)} / ${formatBytes(data.storage.root.total)}`);
    }

    // Removed SMB section for v4.0.0

  } catch (error) {
    console.error('Error fetching node stats:', error);
  }
}

// Navigation
window.setDetailMode = (mode) => {
  detailViewMode = mode;
  const chartSect = document.getElementById('details-charts');
  const rawSect = document.getElementById('details-raw');
  const btnChart = document.getElementById('btn-chart-view');
  const btnRaw = document.getElementById('btn-raw-view');

  if (mode === 'chart') {
    chartSect.style.display = 'block';
    rawSect.style.display = 'none';
    btnChart.classList.add('active');
    btnRaw.classList.remove('active');
  } else {
    chartSect.style.display = 'none';
    rawSect.style.display = 'block';
    btnChart.classList.remove('active');
    btnRaw.classList.add('active');
    fetchNodeStats(); // Trigger immediate refresh for table
  }
};

function renderHistoryTable(history) {
  const tbody = document.getElementById('history-table-body');
  if (!tbody) return;
  
  // Clone history and reverse it to show newest first for the table
  const tableData = [...history].reverse();
  
  tbody.innerHTML = tableData.map(h => `
    <tr>
      <td style="color: var(--text-secondary); font-family: monospace;">${new Date(h.time).toLocaleString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
      <td style="font-weight: 600;">${h.cpu}%</td>
      <td style="color: var(--accent-purple); font-weight: 600;">${h.ram}%</td>
      <td style="color: var(--accent-orange);">${(h.rx / 1024).toFixed(1)} KB/s</td>
      <td style="color: var(--accent-green);">${(h.tx / 1024).toFixed(1)} KB/s</td>
    </tr>
  `).join('');
}

window.openDetails = (hostname) => {
  selectedHostname = hostname;
  currentView = 'details';
  document.getElementById('view-overview').style.display = 'none';
  document.getElementById('view-details').style.display = 'grid';
  
  // Reset to chart view when opening new node
  setDetailMode('chart');
  
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
  
  // os-info is handled inside fetchFleet for overview
  
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

// Heartbeat to Hub to suppress noisy logs when watching
async function sendActiveHeartbeat() {
  try { await fetch('/api/active', { method: 'POST' }); }
  catch (e) {}
}

// Start
document.addEventListener('DOMContentLoaded', () => {
  showOverview();
  setInterval(sendActiveHeartbeat, 10000); 
  sendActiveHeartbeat();
});
