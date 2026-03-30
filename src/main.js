// Configuration
const REFRESH_INTERVAL_FLEET = 5000;
const REFRESH_INTERVAL_STATS = 5000;

// State
let currentView = 'overview'; // 'overview', 'details', or 'pi'
let detailViewMode = 'chart'; // 'chart' or 'raw'
let selectedHostname = null;
let statsTimer = null;
let fleetTimer = null;
let piTimer = null;

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
    line: { tension: 0.6, borderWidth: 3 },
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

let cpuChart, ramChart, netChart, hubComputeChart, hubNetChart;

function createCharts() {
  if (cpuChart) cpuChart.destroy();
  if (ramChart) ramChart.destroy();
  if (netChart) netChart.destroy();
  if (hubComputeChart) hubComputeChart.destroy();
  if (hubNetChart) hubNetChart.destroy();

  const createGradient = (ctx, color, alphaTop, alphaBottom) => {
    const grd = ctx.createLinearGradient(0, 0, 0, 150);
    // Fix for the replacement helper: ensure color parsing works for both hex and rgb
    let baseColor = color;
    if (color.startsWith('#')) {
        const r = parseInt(color.slice(1, 3), 16);
        const g = parseInt(color.slice(3, 5), 16);
        const b = parseInt(color.slice(5, 7), 16);
        baseColor = `rgba(${r}, ${g}, ${b}`;
    } else {
        baseColor = color.replace('rgb', 'rgba').replace(')', '');
    }
    grd.addColorStop(0, `${baseColor}, ${alphaTop})`);
    grd.addColorStop(1, `${baseColor}, ${alphaBottom})`);
    return grd;
  };

  const createLine = (id, color, opts) => {
    const canvas = document.getElementById(id);
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');

    return new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          data: [],
          borderColor: color,
          backgroundColor: createGradient(ctx, color, 0.15, 0),
          fill: true,
          spanGaps: true
        }]
      },
      options: opts || chartOptions
    });
  };

  cpuChart = createLine('cpuChart', '#ff9f0a');
  ramChart = createLine('ramChart', '#bf5af2');

  // Network Multi-line Chart
  const netCanvas = document.getElementById('netChart');
  if (netCanvas) {
    const ctx = netCanvas.getContext('2d');
    netChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Download (Rx)',
            data: [],
            borderColor: '#ffd60a',
            backgroundColor: createGradient(ctx, '#ffd60a', 0.15, 0),
            fill: true,
            tension: 0.6,
            borderWidth: 3
          },
          {
            label: 'Upload (Tx)',
            data: [],
            borderColor: '#32ade6',
            backgroundColor: createGradient(ctx, '#32ade6', 0.15, 0),
            fill: true,
            tension: 0.6,
            borderWidth: 3
          }
        ]
      },
      options: netChartOptions
    });
  }

  // Hub Page Compute Chart
  const hubCanvas = document.getElementById('hubComputeChart');
  if (hubCanvas) {
    const ctx = hubCanvas.getContext('2d');
    hubComputeChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Avg Fleet CPU',
            data: [],
            borderColor: '#ff9f0a',
            backgroundColor: createGradient(ctx, '#ff9f0a', 0.1, 0),
            fill: true,
            borderWidth: 2
          },
          {
            label: 'Avg Fleet RAM',
            data: [],
            borderColor: '#bf5af2',
            backgroundColor: createGradient(ctx, '#bf5af2', 0.1, 0),
            fill: true,
            borderWidth: 2
          }
        ]
      },
      options: {
        ...chartOptions,
        scales: {
            x: { display: false },
            y: {
                min: 0, max: 100, display: true,
                ticks: { display: true, color: 'rgba(148,163,184,0.4)', font: { size: 9 }, maxTicksLimit: 3 },
                grid: { color: 'rgba(255,255,255,0.03)' },
                border: { display: false }
            }
        }
      }
    });
  }

  const hubNetCanvas = document.getElementById('hubNetChart');
  if (hubNetCanvas) {
    const ctx = hubNetCanvas.getContext('2d');
    hubNetChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Avg RX (KB/s)',
            data: [],
            borderColor: '#ffd60a',
            backgroundColor: createGradient(ctx, '#ffd60a', 0.1, 0),
            fill: true,
            borderWidth: 2
          },
          {
            label: 'Avg TX (KB/s)',
            data: [],
            borderColor: '#32ade6',
            backgroundColor: createGradient(ctx, '#32ade6', 0.1, 0),
            fill: true,
            borderWidth: 2
          }
        ]
      },
      options: {
        ...netChartOptions,
        scales: {
            x: { display: false },
            y: {
                min: 0, display: true, beginAtZero: true,
                ticks: { display: true, color: 'rgba(148,163,184,0.4)', font: { size: 9 }, maxTicksLimit: 3 },
                grid: { color: 'rgba(255,255,255,0.03)' },
                border: { display: false }
            }
        }
      }
    });
  }
}

function updateChart(chart, newValue, label = '') {
  if (!chart) return;
  const data = chart.data.datasets[0].data;
  const labels = chart.data.labels;
  data.push(newValue);
  labels.push(label);
  
  if (data.length > maxDataPoints) {
    data.shift();
    labels.shift();
  }
  chart.update('none');
}

/** ── Fleet Overview Logic ── **/

async function fetchFleet() {
  try {
    const res = await apiFetch('/api/fleet');
    const data = await res.json();
    
    // Update Hub branding in Header if not in details view
    if (currentView === 'overview') {
      document.getElementById('header-hostname').textContent = 'hub';
      document.title = 'nerifeige.de Cockpit';
      
      if (data.hubSystem) {
        const infoUptime = document.getElementById('info-uptime');
        if (infoUptime) infoUptime.textContent = formatUptime(data.hubSystem.uptime);
        
        const infoModel = document.getElementById('info-model');
        if (infoModel) infoModel.textContent = `Model: ${data.hubSystem.model || 'Unknown'}`;
        
        const infoOs = document.getElementById('info-os');
        if (infoOs) infoOs.textContent = `OS: ${data.hubSystem.os || 'Linux'}`;
      }
    }

    renderFleetSummary(data.servers || {});
    renderFleet(data.servers || {});
    
    // Update Compute Charts if on Hub View
    if (currentView === 'pi' && hubComputeChart && hubNetChart) {
        const servers = data.servers || {};
        const entries = Object.entries(servers);
        let cpuSum = 0, cpuCount = 0, ramSum = 0, ramCount = 0;
        let rxSum = 0, txSum = 0, netCount = 0;
        entries.forEach(([h, d]) => {
            if (d.gateway) return;
            if (d.cpu && d.cpu.load > 0) { cpuSum += d.cpu.load; cpuCount++; }
            if (d.memory && d.memory.percent > 0) { ramSum += d.memory.percent; ramCount++; }
            if (d.network && d.network.rx_sec !== undefined) {
                rxSum += (d.network.rx_sec / 1024);
                txSum += (d.network.tx_sec / 1024);
                netCount++;
            }
        });
        const avgCpu = cpuCount > 0 ? (cpuSum / cpuCount) : 0;
        const avgRam = ramCount > 0 ? (ramSum / ramCount) : 0;
        const avgRx = netCount > 0 ? (rxSum / netCount) : 0;
        const avgTx = netCount > 0 ? (txSum / netCount) : 0;
        
        const time = new Date().toLocaleTimeString();
        
        // Compute Chart
        hubComputeChart.data.labels.push(time);
        hubComputeChart.data.datasets[0].data.push(avgCpu);
        hubComputeChart.data.datasets[1].data.push(avgRam);
        
        if (hubComputeChart.data.labels.length > maxDataPoints) {
            hubComputeChart.data.labels.shift();
            hubComputeChart.data.datasets[0].data.shift();
            hubComputeChart.data.datasets[1].data.shift();
        }
        hubComputeChart.update('none');

        // Net Chart
        const rxData = hubNetChart.data.datasets[0].data;
        const txData = hubNetChart.data.datasets[1].data;
        const netLabels = hubNetChart.data.labels;
        
        rxData.push(parseFloat(avgRx));
        txData.push(parseFloat(avgTx));
        netLabels.push(time);
        
        if (rxData.length > maxDataPoints) {
            rxData.shift();
            txData.shift();
            netLabels.shift();
        }
        hubNetChart.update('none');
    }
  } catch (err) {
    console.error('Error fetching fleet:', err);
  }
}

function renderFleetSummary(servers) {
  const summary = document.getElementById('fleet-summary');
  if (!summary) return;

  const entries = Object.entries(servers);
  if (entries.length === 0) { summary.style.display = 'none'; return; }

  let totalNodes = 0, onlineNodes = 0, gateways = 0;
  let cpuSum = 0, cpuCount = 0;
  let ramSum = 0, ramCount = 0;
  let maxTemp = 0;

  entries.forEach(([hostname, data]) => {
    const isGateway = data.gateway || (data.model && data.model.toLowerCase().includes('fritz')) || hostname.toLowerCase().includes('gateway');
    const isOnline = (Date.now() - data.lastReport) < 45000;

    if (isGateway) { gateways++; return; }

    totalNodes++;
    if (isOnline) onlineNodes++;

    if (data.cpu && data.cpu.load > 0) {
      cpuSum += data.cpu.load;
      cpuCount++;
      if (data.cpu.temp && data.cpu.temp > maxTemp) maxTemp = data.cpu.temp;
    }
    if (data.memory && data.memory.percent > 0) {
      ramSum += data.memory.percent;
      ramCount++;
    }
  });

  const avgCpu = cpuCount > 0 ? (cpuSum / cpuCount).toFixed(1) : '--';
  const avgRam = ramCount > 0 ? (ramSum / ramCount).toFixed(1) : '--';

  summary.style.display = 'flex';
  summary.innerHTML = `
    <div class="fleet-stat">
      <span class="label">Nodes Online</span>
      <div class="value">${onlineNodes}<small> / ${totalNodes}</small></div>
    </div>
    <div class="fleet-stat">
      <span class="label">Avg. CPU Load</span>
      <div class="value">${avgCpu}<small>%</small></div>
    </div>
    <div class="fleet-stat">
      <span class="label">Avg. Memory</span>
      <div class="value">${avgRam}<small>%</small></div>
    </div>
    ${maxTemp > 0 ? `<div class="fleet-stat">
      <span class="label">Peak Temp</span>
      <div class="value">${maxTemp}<small>°C</small></div>
    </div>` : ''}
    ${gateways > 0 ? `<div class="fleet-stat">
      <span class="label">Gateways</span>
      <div class="value">${gateways}</div>
    </div>` : ''}
  `;
}

function renderFleet(servers) {
  const container = document.getElementById('nodes-container');
  if (!container) return;

  if (Object.keys(servers).length === 0) {
    container.innerHTML = '<div class="glass" style="grid-column: 1/-1; text-align: center; padding: 4rem;"><h3>Waiting for first reports...</h3><p>Ensure your agents are running and pointing to this Hub IP.</p></div>';
    return;
  }

  container.innerHTML = Object.entries(servers).map(([hostname, data]) => {
    const isOnline = (Date.now() - data.lastReport) < 45000;
    
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
          ${data.gateway ? `<button class="temp-badge cool" style="cursor: pointer; border: none; font-family: inherit; font-size: 0.7rem; margin-top: 4px;" onclick="event.stopPropagation(); window.openGatewayLogs('${hostname}')">Logs</button>` : ''}
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
    // Populate initial history
    if (data.history && (cpuChart?.data.datasets[0].data.length === 0)) {
      const hist = data.history.slice(-maxDataPoints);

      
      // Clear datasets
      [cpuChart, ramChart, netChart].forEach(c => {
        if (!c) return;
        c.data.labels = [];
        c.data.datasets.forEach(ds => ds.data = []);
      });

      hist.forEach(h => {
        const timeVal = h.time;
        const time = timeVal ? new Date(timeVal).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
        
        cpuChart?.data.labels.push(time);
        cpuChart?.data.datasets[0].data.push(h.cpu || 0);
        ramChart?.data.labels.push(time);
        ramChart?.data.datasets[0].data.push(h.ram || 0);
        if (netChart) {
          netChart.data.labels.push(time);
          netChart.data.datasets[0].data.push(h.rx || 0);
          netChart.data.datasets[1].data.push(h.tx || 0);
        }
      });
      cpuChart?.update('none');
      ramChart?.update('none');
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
    


    const cpuBox = document.getElementById('cpu-metric-box');
    const ramBox = document.getElementById('ram-metric-box');
    
    if (cpuBox) cpuBox.style.display = (hasCpu && !isGateway) ? 'block' : 'none';
    if (ramBox) ramBox.style.display = (hasRam && !isGateway) ? 'block' : 'none';

    if (hasCpu) {

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
      
      if (rxData.length > maxDataPoints) {
        rxData.shift();
        txData.shift();
        netLabels.shift();
      }
      
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

    // Active Jobs (v6.0.0)
    renderActiveJobs(data);

  } catch (error) {
    console.error('Error fetching node stats:', error);
  }
}

function renderActiveJobs(data) {
  const detailSect = document.getElementById('details-charts');
  if (!detailSect) return;

  let jobsSect = document.getElementById('details-jobs');
  if (!jobsSect) {
    const template = document.getElementById('jobs-template');
    if (template) {
      detailSect.appendChild(template.content.cloneNode(true));
      jobsSect = document.getElementById('details-jobs');
      if (window.lucide) lucide.createIcons();
    }
  }

  const container = document.getElementById('jobs-container');
  if (!container) return;

  const jobs = data.stats?.jobs || data.jobs || [];
  if (jobs.length === 0) {
    container.innerHTML = '<p style="color:var(--text-secondary); font-size: 0.9rem; padding: 1rem; text-align: center; background: rgba(0,0,0,0.02); border-radius: 12px;">No active jobs detected.</p>';
    return;
  }

  container.innerHTML = jobs.map(j => `
    <div class="job-card">
      <i data-lucide="play-circle" class="job-icon"></i>
      <div class="job-info">
        <h4>${j.name}</h4>
        <p>Status: ${j.status} | Since: ${j.started || 'Unknown'}</p>
      </div>
    </div>
  `).join('');
  if (window.lucide) lucide.createIcons();
}

// Navigation
window.setDetailMode = (mode) => {
  detailViewMode = mode;
  const chartSect = document.getElementById('details-charts');
  const rawSect = document.getElementById('details-raw');
  const btnChart = document.getElementById('btn-chart-view');
  const btnRaw = document.getElementById('btn-raw-view');

  // Handle Full Width Mode (v5.3.16)
  const container = document.querySelector('.app-container');
  if (container) {
    if (mode === 'raw') container.classList.add('full-width');
    else container.classList.remove('full-width');
  }

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
  const thead = document.querySelector('.history-table thead tr');
  if (!tbody || !thead || !history.length) return;
  
  // Identify all unique keys across the history (v5.3.14)
  const allKeys = new Set();
  history.forEach(h => {
    Object.keys(h).forEach(k => {
      if (!['time', 'recorded_at', 'data', 'GATEWAY_LOGS'].includes(k)) allKeys.add(k);
    });
  });
  const sortedKeys = Array.from(allKeys).sort();

  // Re-build Headers
  thead.innerHTML = `
    <th>Timestamp</th>
    ${sortedKeys.map(k => `<th>${k.toUpperCase()}</th>`).join('')}
  `;
  
  // Clone and reverse history
  const tableData = [...history].reverse();
  
  tbody.innerHTML = tableData.map(h => {
    const date = h.time ? new Date(h.time) : null;
    const timeStr = (date && !isNaN(date)) ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '---';
    
    return `
      <tr>
        <td style="font-family: monospace; white-space: nowrap; padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.05); min-width: 120px;">${timeStr}</td>
        ${sortedKeys.map(k => {
          let val = h[k];
          // Format based on key (v5.3.15)
          if (k.includes('PERCENT') || k === 'CPU' || k === 'RAM') val = typeof val === 'number' ? `${val.toFixed(1)}%` : val;
          else if (k.includes('BYTES') || k === 'TX' || k === 'RX') val = typeof val === 'number' ? formatBytes(val) : val;
          
          return `<td style="font-family: monospace; font-size: 0.85rem; min-width: 140px; padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.05); text-align: left; vertical-align: top;">
            ${val !== undefined ? val : '-'}
          </td>`;
        }).join('')}
      </tr>
    `;
  }).join('');
}

window.openDetails = (hostname, push = true) => {
  selectedHostname = hostname;
  currentView = 'details';
  document.getElementById('view-overview').style.display = 'none';
  document.getElementById('view-pi').style.display = 'none';
  document.getElementById('view-info').style.display = 'none';
  document.getElementById('view-details').style.display = 'grid';
  
  updateNavState();

  if (push) {
    window.history.pushState({ hostname }, '', `/${hostname}`);
  }

  // Reset to chart view when opening new node
  setDetailMode('chart');
  
  createCharts(); // Re-init charts for this node
  fetchNodeStats();
  
  if (fleetTimer) clearInterval(fleetTimer);
  if (piTimer) clearInterval(piTimer);
  statsTimer = setInterval(fetchNodeStats, REFRESH_INTERVAL_STATS);
};

window.showOverview = (push = true) => {
  selectedHostname = null;
  currentView = 'overview';
  document.getElementById('view-overview').style.display = 'block';
  document.getElementById('view-details').style.display = 'none';
  document.getElementById('view-pi').style.display = 'none';
  document.getElementById('view-info').style.display = 'none';
  
  updateNavState();

  if (push) {
    window.history.pushState({}, '', '/');
  }

  // os-info is handled inside fetchFleet for overview
  
  if (statsTimer) clearInterval(statsTimer);
  if (piTimer) clearInterval(piTimer);
  fetchFleet();
  fleetTimer = setInterval(fetchFleet, REFRESH_INTERVAL_FLEET);
};

/** ── Pi Hub Dashboard Logic (v6.0.0) ── **/

window.showPiDashboard = (push = true) => {
  selectedHostname = null;
  currentView = 'pi';
  document.getElementById('view-overview').style.display = 'none';
  document.getElementById('view-details').style.display = 'none';
  document.getElementById('view-pi').style.display = 'block';
  document.getElementById('view-info').style.display = 'none';

  updateNavState();

  if (push) {
    window.history.pushState({ view: 'pi' }, '', '/hub');
  }

  if (statsTimer) clearInterval(statsTimer);
  if (fleetTimer) clearInterval(fleetTimer);
  
  createCharts(); // Init compute chart
  fetchFleet();
  fetchPiServices();
  
  fleetTimer = setInterval(fetchFleet, REFRESH_INTERVAL_FLEET);
  piTimer = setInterval(fetchPiServices, 10000);
};

window.showInfoDashboard = (push = true) => {
  selectedHostname = null;
  currentView = 'info';
  document.getElementById('view-overview').style.display = 'none';
  document.getElementById('view-details').style.display = 'none';
  document.getElementById('view-pi').style.display = 'none';
  document.getElementById('view-info').style.display = 'block';

  updateNavState();

  if (push) {
    window.history.pushState({ view: 'info' }, '', '/info');
  }

  if (statsTimer) clearInterval(statsTimer);
  if (piTimer) clearInterval(piTimer);
  
  // Refresh Fleet to ensure uptime is updated, continue fleet timer so uptime ticks
  fetchFleet();
  if (fleetTimer) clearInterval(fleetTimer);
  fleetTimer = setInterval(fetchFleet, REFRESH_INTERVAL_FLEET);
};

function updateNavState() {
  const btnFleet = document.getElementById('nav-fleet');
  const btnInfo = document.getElementById('nav-info');
  
  if (btnFleet) btnFleet.className = currentView === 'overview' ? 'nav-link active' : 'nav-link';
  if (btnInfo) btnInfo.className = currentView === 'info' ? 'nav-link active' : 'nav-link';
}

async function fetchPiServices() {
  try {
    const res = await apiFetch('/api/pi/services');
    const services = await res.json();
    renderPiServices(services);
  } catch (err) {
    console.error('Error fetching pi services:', err);
  }
}

function renderPiServices(services) {
  const container = document.getElementById('pi-services-container');
  if (!container) return;

  if (services.length === 0) {
    container.innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding: 2rem; grid-column: 1 / -1;">No manageable services found.</p>';
    return;
  }

  container.innerHTML = services.map(s => `
    <div class="node-card card glass" style="cursor: default;">
      <div class="node-header" style="align-items: flex-start; margin-bottom: 0.5rem;">
        <div>
          <h3 class="node-name">${s.name}</h3>
          <p class="node-subtitle" style="font-size: 0.8rem; margin-top: 4px;">${s.description}</p>
        </div>
        <div class="status-indicator ${s.status === 'running' ? 'online' : 'offline'}"></div>
      </div>
      
      <div class="node-metrics" style="margin-top: auto; border-top: 1px solid var(--glass-border); padding-top: 1rem; flex-direction: column;">
        <div style="display: flex; gap: 0.5rem; justify-content: space-between; width: 100%;">
          ${s.status === 'running' 
            ? `<button class="btn-pill" style="flex:1; background: rgba(0,0,0,0.2); font-size: 0.85rem;" onclick="piServiceAction('${s.name}', 'restart')">🔄 Restart</button>
               <button class="btn-pill" style="flex:1; background: rgba(255,59,48,0.15); color: var(--accent-red); border: 1px solid rgba(255,59,48,0.2); font-size: 0.85rem;" onclick="piServiceAction('${s.name}', 'stop')">⏹ Stop</button>`
            : `<button class="btn-pill primary" style="flex:1; font-size: 0.85rem;" onclick="piServiceAction('${s.name}', 'start')">▶ Start</button>`
          }
        </div>
      </div>
    </div>
  `).join('');
  
  if (window.lucide) lucide.createIcons();
}

window.piServiceAction = async (name, action) => {
  if (!confirm(`Are you sure you want to ${action} ${name}?`)) return;
  try {
    await apiFetch(`/api/pi/services/${name}/${action}`, { method: 'POST' });
    await fetchPiServices();
  } catch (err) {
    alert('Action failed: ' + err.message);
  }
};

window.openGatewayLogs = (hostname) => {
  const modal = document.getElementById('logs-modal');
  const title = document.getElementById('modalTitle');
  const text = document.getElementById('modalLogsText');
  if (!modal || !text) return;

  title.textContent = `${hostname} Gateway Logs`;
  text.textContent = 'Fetching latest logs...';
  modal.style.display = 'flex';

  // We can just fetch the latest stats for this node which includes logs
  apiFetch(`/api/stats/${hostname}`).then(res => res.json()).then(data => {
    text.textContent = data.gateway?.logs || 'No logs available.';
  }).catch(err => {
    text.textContent = 'Error fetching logs: ' + err.message;
  });
};

window.closeLogs = () => {
  const modal = document.getElementById('logs-modal');
  if (modal) modal.style.display = 'none';
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
