// Configuration
const REFRESH_INTERVAL_FLEET = 5000;
const REFRESH_INTERVAL_STATS = 5000;

// State
let currentView = 'overview'; // 'overview' or 'details'
let detailViewMode = 'chart'; // 'chart' or 'table'
let selectedHostname = null;
let statsTimer = null;
let fleetTimer = null;

/** ── Auth State Management ── **/
let hubToken = localStorage.getItem('hub_token') || '';

// Handle ?token= in URL for pre-auth
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.has('token')) {
  hubToken = urlParams.get('token');
  localStorage.setItem('hub_token', hubToken);
  // Clean URL to keep it pretty
  const newUrl = window.location.pathname;
  window.history.replaceState({}, '', newUrl);
}

async function apiFetch(url, options = {}) {
  const headers = { ...options.headers };
  if (hubToken) {
    headers['Authorization'] = `Bearer ${hubToken}`;
  }
  
  const res = await fetch(url, { ...options, headers });
  
  if (res.status === 401) {
    showAuthModal();
    const err = new Error('Unauthorized');
    err.status = 401;
    throw err;
  }
  
  return res;
}

function showAuthModal() {
  const modal = document.getElementById('auth-modal');
  if (modal) {
    modal.style.display = 'flex';
    const input = document.getElementById('hub-password-input');
    if (input) input.focus();
  }
}

window.submitPassword = async () => {
  const input = document.getElementById('hub-password-input');
  const pwd = input ? input.value : '';
  if (!pwd) return;
  
  hubToken = pwd;
  localStorage.setItem('hub_token', hubToken);
  document.getElementById('auth-modal').style.display = 'none';
  
  // Clear input
  if (input) input.value = '';

  // Immediate retry to unlock data
  if (currentView === 'overview') await fetchFleet();
  else if (selectedHostname) await fetchNodeStats();
};

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

function updateElement(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function getTempClass(temp) {
  if (temp < 45) return 'cool';
  if (temp < 65) return 'warm';
  return 'hot';
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
  plugins: { 
    legend: { display: false }, 
    tooltip: { 
      enabled: true,
      mode: 'index',
      intersect: false,
      backgroundColor: 'rgba(15, 23, 42, 0.9)',
      titleColor: '#94a3b8',
      bodyColor: '#fff',
      borderColor: 'rgba(255,255,255,0.1)',
      borderWidth: 1,
      padding: 10,
      displayColors: true,
      callbacks: {
        label: (ctx) => ` ${ctx.dataset.label || 'Value'}: ${ctx.parsed.y}${ctx.dataset.label?.includes('Network') ? ' KB/s' : '%'}`
      }
    } 
  },
  animation: { duration: 400 },
  elements: {
    line: { tension: 0.4, borderWidth: 2.5 },
    point: { radius: 0, hoverRadius: 4 }
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

  const createGradient = (ctx, color, alphaTop, alphaBottom) => {
    const grd = ctx.createLinearGradient(0, 0, 0, 150);
    grd.addColorStop(0, color.replace(')', `, ${alphaTop})`).replace('rgb', 'rgba'));
    grd.addColorStop(1, color.replace(')', `, ${alphaBottom})`).replace('rgb', 'rgba'));
    return grd;
  };

  const createLine = (id, color, opts) => {
    const canvas = document.getElementById(id);
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    
    // Convert hex to rgb for gradient helper
    const hexToRgb = (hex) => {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return `rgb(${r}, ${g}, ${b})`;
    };
    const rgbColor = hexToRgb(color);

    return new Chart(ctx, {
      type: 'line',
      data: {
        labels: Array(maxDataPoints).fill(''),
        datasets: [{
          data: Array(maxDataPoints).fill(null),
          borderColor: color,
          backgroundColor: createGradient(ctx, rgbColor, 0.4, 0),
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
            backgroundColor: createGradient(ctx, 'rgb(245, 158, 11)', 0.4, 0),
            fill: true,
            tension: 0.4,
            borderWidth: 2
          },
          {
            label: 'Upload (Tx)',
            data: Array(maxDataPoints).fill(null),
            borderColor: '#10b981',
            backgroundColor: createGradient(ctx, 'rgb(16, 185, 129)', 0.4, 0),
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

function updateChart(chart, newValue, label = '') {
  if (!chart) return;
  const data = chart.data.datasets[0].data;
  const labels = chart.data.labels;
  data.push(newValue);
  data.shift();
  labels.push(label);
  labels.shift();
  chart.update('none');
}

/** ── Fleet Overview Logic ── **/

async function fetchFleet() {
  try {
    const res = await apiFetch('/api/fleet');
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
    
    // Build dynamic metrics
    let metricsHtml = '';
    
    // 1. Gateway Metrics
    if (data.gateway) {
      if (data.gateway.dsl_sync) {
        metricsHtml += `
          <div class="mini-metric">
            <span class="label">DSL Sync</span>
            <span class="status-badge ${data.gateway.dsl_sync === 'Up' ? 'online' : 'offline'}">${data.gateway.dsl_sync}</span>
          </div>`;
      }
      if (data.gateway.vpn_active !== undefined) {
        metricsHtml += `
          <div class="mini-metric">
            <span class="label">VPN Bridge</span>
            <span class="status-badge ${data.gateway.vpn_active ? 'online' : 'offline'}">${data.gateway.vpn_active ? 'Active' : 'Down'}</span>
          </div>`;
      }
    }

    // 2. Client Metrics (CPU/RAM)
    if (data.cpu && data.cpu.load !== undefined && data.cpu.load > 0) {
      const tempHtml = data.cpu.temp ? `<span class="temp-badge ${getTempClass(data.cpu.temp)}">${data.cpu.temp}°C</span>` : '';
      metricsHtml += `
        <div class="mini-metric">
          <span class="label">CPU</span>
          <span class="val">${data.cpu.load}% ${tempHtml}</span>
        </div>
        <div class="progress-bar" style="height: 4px;"><div class="progress-fill" style="width: ${data.cpu.load}%;"></div></div>`;
    }

    if (data.memory && data.memory.percent !== undefined && data.memory.percent > 0) {
      metricsHtml += `
        <div class="mini-metric">
          <span class="label">RAM</span>
          <span class="val">${data.memory.percent}%</span>
        </div>
        <div class="progress-bar" style="height: 4px;"><div class="progress-fill" style="width: ${data.memory.percent}%; background-color: var(--accent-purple);"></div></div>`;
    }

    // 3. Uptime (Always have space for it if present)
    if (data.uptime) {
      metricsHtml += `
        <div class="mini-metric" style="margin-top: 0.5rem;">
          <span class="label">Uptime</span>
          <span class="val" style="color: var(--text-secondary); font-size: 0.8rem;">${formatUptime(data.uptime)}</span>
        </div>`;
    }

    return `
      <div class="card glass node-card" onclick="openDetails('${hostname}')">
        <div class="node-header" style="align-items: flex-start;">
          <div style="display: flex; flex-direction: column; gap: 2px;">
            <span class="node-hostname">${hostname}</span>
            <span style="font-size: 0.75rem; color: var(--text-secondary); font-weight: 500;">${data.model || 'Node'}</span>
          </div>
          <div class="heartbeat ${isOnline ? 'active' : 'error'}" style="margin-top: 6px;"></div>
        </div>
        <div class="node-metrics">
          ${metricsHtml || '<span style="color: var(--text-secondary); font-size: 0.8rem;">No metrics reported</span>'}
        </div>
      </div>
    `;
  }).join('');
}

/** ── Detailed View Logic ── **/

async function fetchNodeStats() {
  if (!selectedHostname) return;
  try {
    const res = await apiFetch(`/api/stats/${selectedHostname}`);
    const data = await res.json();
    console.log('[Cockpit] Received node stats:', data);

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
    
    // Gateway vs Server UI Toggle (v5.3.10)
    const isGateway = data.os === 'fritzbox' || 
                      (data.model && data.model.toLowerCase().includes('fritz')) ||
                      data.hostname.toLowerCase().includes('gateway');
                      
    console.log(`[Cockpit] isGateway: ${isGateway} | model: ${data.model} | os: ${data.os}`);
    document.getElementById('gateway-info').style.display = isGateway ? 'block' : 'none';
    
    // Hide standard server bars for gateways (v5.3.10)
    const cpuCard = [...document.querySelectorAll('#details-charts .card')].find(c => c.innerHTML.toUpperCase().includes('CPU USAGE'));
    const ramCard = [...document.querySelectorAll('#details-charts .card')].find(c => c.innerHTML.toUpperCase().includes('MEMORY USAGE'));
    const storageCard = document.getElementById('details-storage');

    if (cpuCard) cpuCard.style.display = isGateway ? 'none' : 'block';
    if (ramCard) ramCard.style.display = isGateway ? 'none' : 'block';
    if (storageCard) storageCard.style.display = isGateway ? 'none' : 'block';

    if (isGateway && data.gateway) {
      updateElement('gw-dsl-sync', data.gateway.dsl_sync || 'Up');
      const vpnEl = document.getElementById('gw-vpn-status');
      if (vpnEl) {
        vpnEl.textContent = data.gateway.vpn_active ? 'CONNECTED' : 'DISCONNECTED';
        vpnEl.className = `temp-badge ${data.gateway.vpn_active ? 'cool' : 'hot'}`;
      }
      updateElement('gw-ext-ip', data.network?.ext_ip || 'Managed');
    }

    // Header Info
    updateElement('header-hostname', data.hostname);
    updateElement('os-info', `${data.model || 'Unknown'} | Running ${data.os || 'Linux'} | Uptime: ${formatUptime(data.uptime)}`);
    
    // Populate initial history if charts are fresh
    if (data.history && cpuChart?.data.datasets[0].data.every(v => v === null)) {
      const hist = data.history.slice(-maxDataPoints);
      console.log(`[Cockpit] Injecting ${hist.length} history points into charts`);
      hist.forEach(h => {
        const time = new Date(h.recorded_at).toLocaleTimeString();
        cpuChart.data.labels.push(time);
        cpuChart.data.datasets[0].data.push(h.cpu || 0);
        ramChart.data.labels.push(time);
        ramChart.data.datasets[0].data.push(h.ram || 0);
        if (netChart) {
          netChart.data.labels.push(time);
          netChart.data.datasets[0].data.push(h.rx || 0);
          netChart.data.datasets[1].data.push(h.tx || 0);
        }
      });
      cpuChart.update('none');
      ramChart.update('none');
      netChart?.update('none');
    }

    // Update History Table if in raw mode
    if (data.history && detailViewMode === 'raw') {
      renderHistoryTable(data.history);
    }

    const timeLabel = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    // Metrics (v5.3.10)
    const hasCpu = data.cpu && data.cpu.load !== undefined;
    const hasRam = data.memory && data.memory.percent !== undefined;
    
    console.log(`[Cockpit] Metrics Load Checked: hasCpu=${hasCpu}, hasRam=${hasRam}`);

    const cpuBox = document.getElementById('cpu-metric-box');
    const ramBox = document.getElementById('ram-metric-box');
    
    if (cpuBox) cpuBox.style.display = (hasCpu && !isGateway) ? 'block' : 'none';
    if (ramBox) ramBox.style.display = (hasRam && !isGateway) ? 'block' : 'none';

    if (hasCpu) {
      console.log(`[Cockpit] Updating CPU Load: ${data.cpu.load}%`);
      updateElement('cpu-load', data.cpu.load);
      updateChart(cpuChart, data.cpu.load, timeLabel);
      
      const tempEl = document.getElementById('cpu-temp-details');
      if (tempEl) {
        if (data.cpu.temp) {
          tempEl.textContent = `${data.cpu.temp}°C`;
          tempEl.className = `temp-badge ${getTempClass(data.cpu.temp)}`;
          tempEl.style.display = 'inline-flex';
        } else {
          tempEl.style.display = 'none';
        }
      }
    }

    if (hasRam) {
      console.log(`[Cockpit] Updating RAM Usage: ${data.memory.percent}%`);
      updateElement('ram-usage', data.memory.percent);
      updateChart(ramChart, data.memory.percent, timeLabel);
      updateElement('ram-detail', `${formatBytes(data.memory.used)} / ${formatBytes(data.memory.total)}`);
    }

    if (data.network && netChart) {
      const txKB = (data.network.tx_sec / 1024).toFixed(1);
      const rxKB = (data.network.rx_sec / 1024).toFixed(1);
      updateElement('net-tx', txKB);
      updateElement('net-rx', rxKB);
      
      // Update dual dataset chart (Rx is set 0, Tx is set 1)
      const rxData = netChart.data.datasets[0].data;
      const txData = netChart.data.datasets[1].data;
      const netLabels = netChart.data.labels;
      
      rxData.push(parseFloat(rxKB));
      txData.push(parseFloat(txKB));
      netLabels.push(timeLabel);
      
      rxData.shift();
      txData.shift();
      netLabels.shift();
      
      netChart.update('none');
    }

    // Storage
    if (data.storage.root) {
      updateElement('root-percent', `${data.storage.root.percent}%`);
      updateProgress('root-bar', data.storage.root.percent);
      updateElement('root-detail', `${formatBytes(data.storage.root.used)} / ${formatBytes(data.storage.root.total)}`);
    }

    // Gateway Section
    const gwSection = document.getElementById('gateway-stats-section');
    if (data.gateway && gwSection) {
      gwSection.style.display = 'block';
      updateElement('gw-dsl-sync', data.gateway.dsl_sync);
      updateElement('gw-vpn-status', data.gateway.vpn_active ? 'Active' : 'Down');
      const vpnBadge = document.getElementById('gw-vpn-badge');
      if (vpnBadge) vpnBadge.className = `status-badge ${data.gateway.vpn_active ? 'online' : 'offline'}`;
    } else if (gwSection) {
      gwSection.style.display = 'none';
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
  
  tbody.innerHTML = tableData.map(h => {
    const date = h.time ? new Date(h.time) : null;
    const timeStr = (date && !isNaN(date)) ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '---';
    
    return `
      <tr>
        <td style="color: var(--text-secondary); font-family: monospace;">${timeStr}</td>
        <td style="font-weight: 600;">${h.cpu}%</td>
        <td style="color: var(--accent-purple); font-weight: 600;">${h.ram}%</td>
        <td style="color: var(--accent-orange);">${(h.rx / 1024).toFixed(1)} KB/s</td>
        <td style="color: var(--accent-green);">${(h.tx / 1024).toFixed(1)} KB/s</td>
      </tr>
    `;
  }).join('');
}

window.openDetails = (hostname, push = true) => {
  selectedHostname = hostname;
  currentView = 'details';
  document.getElementById('view-overview').style.display = 'none';
  document.getElementById('view-details').style.display = 'grid';
  
  if (push) {
    window.history.pushState({ hostname }, '', `/${hostname}`);
  }

  // Reset to chart view when opening new node
  setDetailMode('chart');
  
  createCharts(); // Re-init charts for this node
  fetchNodeStats();
  
  if (fleetTimer) clearInterval(fleetTimer);
  statsTimer = setInterval(fetchNodeStats, REFRESH_INTERVAL_STATS);
};

window.showOverview = (push = true) => {
  selectedHostname = null;
  currentView = 'overview';
  document.getElementById('view-overview').style.display = 'block';
  document.getElementById('view-details').style.display = 'none';
  
  if (push) {
    window.history.pushState({}, '', '/');
  }

  // os-info is handled inside fetchFleet for overview
  
  if (statsTimer) clearInterval(statsTimer);
  fetchFleet();
  fleetTimer = setInterval(fetchFleet, REFRESH_INTERVAL_FLEET);
};

window.exportData = async () => {
  if (!selectedHostname) return;
  const timeframe = document.getElementById('export-timeframe').value;
  const url = `/api/export/${selectedHostname}?timeframe=${timeframe}`;
  
  // Create a temporary link to trigger download
  const link = document.createElement('a');
  link.href = `${url}&token=${hubToken}`; // Pass token for auth in download
  link.setAttribute('download', '');
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

function handleRouting() {
  const path = window.location.pathname.replace(/^\/|\/$/g, '');
  if (!path) {
    showOverview(false);
  } else {
    openDetails(path, false);
  }
}

window.onpopstate = (event) => {
  handleRouting();
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
  try { await apiFetch('/api/active', { method: 'POST' }); }
  catch (e) {}
}

// Start
document.addEventListener('DOMContentLoaded', () => {
  handleRouting();
  setInterval(sendActiveHeartbeat, 10000); 
  sendActiveHeartbeat();
});
