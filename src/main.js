// Configuration
const REFRESH_INTERVAL_FLEET = 15000;
const REFRESH_INTERVAL_STATS = 15000;

// State
let currentView = 'main';
let detailViewMode = 'chart';
let selectedHostname = null;
let statsTimer = null;
let fleetTimer = null;
let piTimer = null;

function clearAllTimers() {
  if (fleetTimer) { clearInterval(fleetTimer); fleetTimer = null; }
  if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
  if (piTimer)    { clearInterval(piTimer);    piTimer = null; }
}

/** ── Auth ── **/
let hubToken = localStorage.getItem('hub_token') || '';

const urlParams = new URLSearchParams(window.location.search);
if (urlParams.has('token')) {
  hubToken = urlParams.get('token');
  localStorage.setItem('hub_token', hubToken);
  window.history.replaceState({}, '', window.location.pathname);
}

async function apiFetch(url, options = {}) {
  const headers = { ...options.headers };
  if (hubToken) headers['Authorization'] = `Bearer ${hubToken}`;
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
  if (input) input.value = '';
  if (selectedHostname) await fetchNodeStats();
  else await fetchFleet();
};

/** ── Utilities ── **/
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatUptime(seconds) {
  if (!seconds) return '--';
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor(seconds % (3600 * 24) / 3600);
  const m = Math.floor(seconds % 3600 / 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
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

/** ── Drawer ── **/

function openDrawer() {
  const drawer  = document.getElementById('detail-drawer');
  const overlay = document.getElementById('drawer-overlay');
  if (drawer)  drawer.classList.add('open');
  if (overlay) overlay.classList.add('visible');
}

window.closeDrawer = () => {
  selectedHostname = null;
  currentView = 'main';
  const drawer  = document.getElementById('detail-drawer');
  const overlay = document.getElementById('drawer-overlay');
  if (drawer)  drawer.classList.remove('open');
  if (overlay) overlay.classList.remove('visible');
  document.title = 'nerifeige.de · cockpit';
  window.history.pushState({}, '', '/');
  // Stop stats timer, keep fleet + services running
  if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
};

window.triggerHubUpdate = async () => {
  if (!confirm('Hub aktualisieren? Git pull + Rebuild werden ausgeführt.')) return;
  try {
    await apiFetch('/api/admin/update', { method: 'POST' });
    alert('Update-Befehl gesendet!');
  } catch (err) {
    alert('Fehler: ' + err.message);
  }
};

/** ── Charts ── **/
const maxDataPoints = 120;

const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  scales: {
    x: { display: false },
    y: {
      min: 0, display: true,
      ticks: { display: true, color: 'rgba(148,163,184,0.35)', font: { size: 9 }, maxTicksLimit: 3, callback: v => v + '%' },
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
      backgroundColor: 'rgba(10,10,20,0.95)',
      titleColor: '#6b7280',
      bodyColor: '#e2e2ee',
      borderColor: 'rgba(255,255,255,0.1)',
      borderWidth: 1,
      padding: 10,
      displayColors: true,
      callbacks: {
        label: (ctx) => ` ${ctx.dataset.label || 'Value'}: ${ctx.parsed.y}${ctx.dataset.label?.includes('Network') ? ' KB/s' : '%'}`
      }
    }
  },
  animation: { duration: 350 },
  elements: {
    line: { tension: 0.4, borderWidth: 2 },
    point: { radius: 0, hoverRadius: 5 }
  },
  layout: { padding: { left: 0, right: 8, top: 8, bottom: 0 } }
};

const netChartOptions = {
  ...chartOptions,
  scales: {
    x: { display: false },
    y: {
      min: 0, display: true, beginAtZero: true,
      ticks: { display: true, color: 'rgba(148,163,184,0.35)', font: { size: 9 }, maxTicksLimit: 3, callback: v => v.toFixed(1) },
      grid: { color: 'rgba(255,255,255,0.03)' },
      border: { display: false }
    }
  }
};

let cpuChart, ramChart, netChart;
let hubComputeChart, hubNetChart, hubStorageChart;

function createGradient(ctx, color, alphaTop, alphaBottom) {
  const grd = ctx.createLinearGradient(0, 0, 0, 150);
  let base = color;
  if (color.startsWith('#')) {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    base = `rgba(${r}, ${g}, ${b}`;
  } else {
    base = color.replace('rgb', 'rgba').replace(')', '');
  }
  grd.addColorStop(0, `${base}, ${alphaTop})`);
  grd.addColorStop(1, `${base}, ${alphaBottom})`);
  return grd;
}

function createLine(id, color, opts) {
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
        backgroundColor: createGradient(ctx, color, 0.18, 0),
        fill: true,
        spanGaps: true
      }]
    },
    options: opts || chartOptions
  });
}

function createNodeCharts() {
  if (cpuChart) cpuChart.destroy();
  if (ramChart) ramChart.destroy();
  if (netChart) netChart.destroy();

  cpuChart = createLine('cpuChart', '#ff9f0a');
  ramChart = createLine('ramChart', '#8b5cf6');

  const netCanvas = document.getElementById('netChart');
  if (netCanvas) {
    const ctx = netCanvas.getContext('2d');
    netChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          { label: 'Download (Rx)', data: [], borderColor: '#4d7cfe', backgroundColor: createGradient(ctx, '#4d7cfe', 0.15, 0), fill: true, tension: 0.5, borderWidth: 2 },
          { label: 'Upload (Tx)',   data: [], borderColor: '#ff8c00', backgroundColor: createGradient(ctx, '#ff8c00', 0.15, 0), fill: true, tension: 0.5, borderWidth: 2 }
        ]
      },
      options: netChartOptions
    });
  }
}

function createHubCharts() {
  if (hubComputeChart) hubComputeChart.destroy();
  if (hubNetChart)     hubNetChart.destroy();
  if (hubStorageChart) hubStorageChart.destroy();

  const hubCanvas = document.getElementById('hubComputeChart');
  if (hubCanvas) {
    const ctx = hubCanvas.getContext('2d');
    hubComputeChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          { label: 'Avg Fleet CPU', data: [], borderColor: '#ff9f0a', backgroundColor: createGradient(ctx, '#ff9f0a', 0.1, 0), fill: true, borderWidth: 2 },
          { label: 'Avg Fleet RAM', data: [], borderColor: '#8b5cf6', backgroundColor: createGradient(ctx, '#8b5cf6', 0.1, 0), fill: true, borderWidth: 2 }
        ]
      },
      options: {
        ...chartOptions,
        plugins: {
          ...chartOptions.plugins,
          legend: { display: true, position: 'top', labels: { color: 'rgba(255,255,255,0.6)', font: { size: 10 }, usePointStyle: true, boxWidth: 6, boxHeight: 6 } }
        },
        scales: {
          x: { display: false },
          y: { min: 0, max: 100, display: true, ticks: { display: true, color: 'rgba(148,163,184,0.35)', font: { size: 9 }, maxTicksLimit: 3 }, grid: { color: 'rgba(255,255,255,0.03)' }, border: { display: false } }
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
          { label: 'Avg RX (KB/s)', data: [], borderColor: '#4d7cfe', backgroundColor: createGradient(ctx, '#4d7cfe', 0.1, 0), fill: true, borderWidth: 2 },
          { label: 'Avg TX (KB/s)', data: [], borderColor: '#ff8c00', backgroundColor: createGradient(ctx, '#ff8c00', 0.1, 0), fill: true, borderWidth: 2 }
        ]
      },
      options: {
        ...netChartOptions,
        plugins: {
          ...netChartOptions.plugins,
          legend: { display: true, position: 'top', labels: { color: 'rgba(255,255,255,0.6)', font: { size: 10 }, usePointStyle: true, boxWidth: 6, boxHeight: 6 } }
        }
      }
    });
  }

  const storageCanvas = document.getElementById('hubStorageChart');
  if (storageCanvas) {
    const ctx = storageCanvas.getContext('2d');
    hubStorageChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: [],
        datasets: [{
          data: [],
          backgroundColor: ['#ff9f0a', '#8b5cf6', '#4d7cfe', '#f5c518', '#12d07a', '#ff2d55'],
          borderColor: 'rgba(0,0,0,0.4)',
          borderWidth: 2,
          hoverOffset: 12
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '65%',
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const node = ctx.chart.data.nodeDetails?.[ctx.dataIndex];
                if (!node) return '';
                return [` Host: ${node.hostname}`, ` Used: ${node.used} / ${node.total}`, ` Usage: ${node.percent}%`];
              }
            }
          }
        }
      },
      plugins: [{
        id: 'centerText',
        beforeDraw: (chart) => {
          const { width, height, ctx } = chart;
          ctx.restore();
          const fontSize = (height / 250).toFixed(2);
          ctx.font = `bold ${fontSize}em sans-serif`;
          ctx.textBaseline = 'middle';
          ctx.fillStyle = '#e2e2ee';
          const text = chart.data.centerText || '0 GB';
          const textX = Math.round((width - ctx.measureText(text).width) / 2);
          const textY = height / 2 + 10;
          ctx.fillText(text, textX, textY);
          ctx.font = `500 ${(fontSize * 0.4).toFixed(2)}em sans-serif`;
          ctx.fillStyle = '#44445e';
          const sub = 'TOTAL FLEET';
          ctx.fillText(sub, Math.round((width - ctx.measureText(sub).width) / 2), textY - 24);
          ctx.save();
        }
      }]
    });
  }
}

function updateChart(chart, newValue, label = '') {
  if (!chart) return;
  chart.data.datasets[0].data.push(newValue);
  chart.data.labels.push(label);
  if (chart.data.datasets[0].data.length > maxDataPoints) {
    chart.data.datasets[0].data.shift();
    chart.data.labels.shift();
  }
  chart.update('none');
}

/** ── Fleet ── **/

async function fetchFleet() {
  try {
    const res = await apiFetch('/api/fleet');
    const data = await res.json();

    if (data.hubSystem) {
      updateElement('info-uptime', formatUptime(data.hubSystem.uptime));
      updateElement('info-model',  `Model: ${data.hubSystem.model || 'Unknown'}`);
      updateElement('info-os',     `OS: ${data.hubSystem.os || 'Linux'}`);
    }

    renderFleetSummary(data.servers || {});
    renderFleet(data.servers || {});

    // Always update compute charts
    if (hubComputeChart && hubNetChart) {
      const entries = Object.entries(data.servers || {});
      let cpuSum = 0, cpuCount = 0, ramSum = 0, ramCount = 0;
      let rxSum = 0, txSum = 0, netCount = 0;

      entries.forEach(([, d]) => {
        if (d.gateway) return;
        if (d.cpu?.load > 0)           { cpuSum += d.cpu.load;       cpuCount++; }
        if (d.memory?.percent > 0)     { ramSum += d.memory.percent; ramCount++; }
        if (d.network?.rx_sec !== undefined) {
          rxSum += d.network.rx_sec / 1024;
          txSum += d.network.tx_sec / 1024;
          netCount++;
        }
      });

      const avgCpu = cpuCount > 0 ? cpuSum / cpuCount : 0;
      const avgRam = ramCount > 0 ? ramSum / ramCount : 0;
      const avgRx  = netCount > 0 ? rxSum / netCount  : 0;
      const avgTx  = netCount > 0 ? txSum / netCount  : 0;
      const time   = new Date().toLocaleTimeString();

      hubComputeChart.data.labels.push(time);
      hubComputeChart.data.datasets[0].data.push(avgCpu);
      hubComputeChart.data.datasets[1].data.push(avgRam);
      if (hubComputeChart.data.labels.length > maxDataPoints) {
        hubComputeChart.data.labels.shift();
        hubComputeChart.data.datasets[0].data.shift();
        hubComputeChart.data.datasets[1].data.shift();
      }
      hubComputeChart.update('none');

      hubNetChart.data.labels.push(time);
      hubNetChart.data.datasets[0].data.push(parseFloat(avgRx));
      hubNetChart.data.datasets[1].data.push(parseFloat(avgTx));
      if (hubNetChart.data.labels.length > maxDataPoints) {
        hubNetChart.data.labels.shift();
        hubNetChart.data.datasets[0].data.shift();
        hubNetChart.data.datasets[1].data.shift();
      }
      hubNetChart.update('none');

      if (hubStorageChart) {
        const labels = [], chartData = [], bgColors = [], nodeDetails = [];
        const baseColors = ['#ff9f0a', '#8b5cf6', '#4d7cfe', '#f5c518', '#12d07a', '#ff2d55'];
        let total = 0;
        let colorIdx = 0;
        const hexToRgba = (hex, a) => {
          const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
          return `rgba(${r},${g},${b},${a})`;
        };
        entries.forEach(([hostname, node]) => {
          if (!node.storage?.root) return;
          const { used, total: t } = node.storage.root;
          const free  = Math.max(t - used, 0);
          const color = baseColors[colorIdx % baseColors.length];
          labels.push(`${hostname} (Used)`);    chartData.push(used);  bgColors.push(color);        nodeDetails.push({ hostname, used: formatBytes(used), total: formatBytes(t), percent: node.storage.root.percent });
          labels.push(`${hostname} (Free)`);    chartData.push(free);  bgColors.push(hexToRgba(color, 0.15)); nodeDetails.push({ hostname, used: formatBytes(used), total: formatBytes(t), percent: node.storage.root.percent });
          total += t;
          colorIdx++;
        });
        hubStorageChart.data.labels = labels;
        hubStorageChart.data.datasets[0].data = chartData;
        hubStorageChart.data.datasets[0].backgroundColor = bgColors;
        hubStorageChart.data.nodeDetails = nodeDetails;
        hubStorageChart.data.centerText  = formatBytes(total);
        hubStorageChart.update('none');
      }
    }
  } catch (err) {
    console.error('fetchFleet:', err);
  }
}

// Hub aggregate sparklines (legacy, kept for compat)
let hubCpuChart = null, hubRamChart = null;
const hubCpuHistory = Array(30).fill(null);
const hubRamHistory = Array(30).fill(null);

function createHubSparkline(canvasId, color) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  const r = parseInt(color.slice(1,3),16), g = parseInt(color.slice(3,5),16), b = parseInt(color.slice(5,7),16);
  const grd = ctx.createLinearGradient(0, 0, 0, 80);
  grd.addColorStop(0, `rgba(${r},${g},${b},0.3)`);
  grd.addColorStop(1, `rgba(${r},${g},${b},0)`);
  return new Chart(ctx, {
    type: 'line',
    data: {
      labels: Array(30).fill(''),
      datasets: [{ data: Array(30).fill(null), borderColor: color, backgroundColor: grd, fill: true, tension: 0.5, borderWidth: 2, pointRadius: 0, spanGaps: true }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { x: { display: false }, y: { display: false, min: 0, max: 100 } },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      animation: { duration: 300 }, layout: { padding: 0 }
    }
  });
}

function renderFleetSummary(servers) {
  const entries = Object.entries(servers);
  if (entries.length === 0) return;

  let totalNodes = 0, onlineNodes = 0, gateways = 0;
  let cpuSum = 0, cpuCount = 0, ramSum = 0, ramCount = 0, maxTemp = 0;
  let rxSum = 0, txSum = 0, netCount = 0;

  entries.forEach(([hostname, data]) => {
    const isGateway = data.gateway || data.model?.toLowerCase().includes('fritz') || hostname.toLowerCase().includes('gateway');
    const isOnline  = (Date.now() - data.lastReport) < 45000;
    if (isGateway) { gateways++; return; }
    totalNodes++;
    if (isOnline) onlineNodes++;
    if (data.cpu?.load > 0)       { cpuSum += data.cpu.load;       cpuCount++; if (data.cpu.temp > maxTemp) maxTemp = data.cpu.temp; }
    if (data.memory?.percent > 0) { ramSum += data.memory.percent; ramCount++; }
    if (data.network?.rx_sec !== undefined) { rxSum += data.network.rx_sec / 1024; txSum += data.network.tx_sec / 1024; netCount++; }
  });

  const avgCpu = cpuCount > 0 ? (cpuSum / cpuCount).toFixed(1) : null;
  const avgRam = ramCount > 0 ? (ramSum / ramCount).toFixed(1) : null;
  const avgRx  = netCount > 0 ? rxSum / netCount : null;
  const avgTx  = netCount > 0 ? txSum / netCount : null;

  // ── Stat tiles ──
  function setTile(valId, barId, value, maxVal, unit) {
    const valEl = document.getElementById(valId);
    const barEl = document.getElementById(barId);
    if (valEl) valEl.textContent = value !== null ? value : '--';
    if (barEl) barEl.style.width = value !== null ? `${Math.min((parseFloat(value) / maxVal) * 100, 100)}%` : '0%';
    if (unit) { const u = document.getElementById(unit.id); if (u) u.textContent = unit.text; }
  }

  setTile('stat-avg-cpu', 'stat-avg-cpu-bar', avgCpu, 100);
  setTile('stat-avg-ram', 'stat-avg-ram-bar', avgRam, 100);

  const formatNet = (val) => val === null ? null : val >= 1024 ? (val / 1024).toFixed(1) : val.toFixed(1);
  const rxFmt = formatNet(avgRx);
  const txFmt = formatNet(avgTx);
  const rxUnit = avgRx !== null && avgRx >= 1024 ? 'MB/s inbound' : 'KB/s inbound';
  const txUnit = avgTx !== null && avgTx >= 1024 ? 'MB/s outbound' : 'KB/s outbound';
  setTile('stat-avg-rx', 'stat-avg-rx-bar', rxFmt, avgRx !== null && avgRx >= 1024 ? 100 : 1000, { id: 'stat-rx-unit', text: rxUnit });
  setTile('stat-avg-tx', 'stat-avg-tx-bar', txFmt, avgTx !== null && avgTx >= 1024 ? 100 : 1000, { id: 'stat-tx-unit', text: txUnit });

  const tempEl = document.getElementById('stat-peak-temp');
  const tempBar = document.getElementById('stat-temp-bar');
  if (tempEl) tempEl.textContent = maxTemp > 0 ? `${maxTemp}°C` : '--';
  if (tempBar) { tempBar.style.width = maxTemp > 0 ? `${Math.min((maxTemp / 90) * 100, 100)}%` : '0%'; tempBar.className = `stat-tile-fill temp ${maxTemp > 0 ? getTempClass(maxTemp) : ''}`; }

  const nodesEl  = document.getElementById('stat-nodes-online');
  const nodesBar = document.getElementById('stat-nodes-bar');
  const nodesSub = document.getElementById('stat-nodes-sub');
  if (nodesEl)  nodesEl.textContent  = totalNodes > 0 ? `${onlineNodes}/${totalNodes}` : '--';
  if (nodesBar) nodesBar.style.width = totalNodes > 0 ? `${(onlineNodes / totalNodes) * 100}%` : '0%';
  if (nodesSub) nodesSub.textContent = `of fleet online${gateways ? ` · ${gateways} gw` : ''}`;

  // ── Top-bar KPIs ──
  const topKpis = document.getElementById('top-kpis');
  if (topKpis) {
    topKpis.innerHTML = `
      <div class="kpi-chip">
        <span class="kpi-label">Nodes</span>
        <span class="kpi-val ${onlineNodes < totalNodes ? 'orange' : 'green'}">${onlineNodes}<span style="font-size:11px;color:var(--text-secondary)">/${totalNodes}</span></span>
      </div>
      ${gateways > 0 ? `<div class="kpi-chip"><span class="kpi-label">Gateway</span><span class="kpi-val green">${gateways}</span></div>` : ''}
      ${avgCpu !== null ? `<div class="kpi-chip"><span class="kpi-label">Avg CPU</span><span class="kpi-val">${avgCpu}%</span></div>` : ''}
      ${avgRam !== null ? `<div class="kpi-chip"><span class="kpi-label">Avg RAM</span><span class="kpi-val">${avgRam}%</span></div>` : ''}
      ${maxTemp > 0 ? `<div class="kpi-chip"><span class="kpi-label">Peak Temp</span><span class="kpi-val ${getTempClass(maxTemp)}">${maxTemp}°C</span></div>` : ''}
    `;
  }

  // ── Fleet-count sub-label ──
  const countEl = document.getElementById('fleet-count');
  if (countEl) countEl.textContent = `${onlineNodes}/${totalNodes} online${gateways ? ` · ${gateways} gateways` : ''}`;

  if (avgCpu !== null) { hubCpuHistory.push(parseFloat(avgCpu)); hubCpuHistory.shift(); }
  if (avgRam !== null) { hubRamHistory.push(parseFloat(avgRam)); hubRamHistory.shift(); }
  if (!hubCpuChart) hubCpuChart = createHubSparkline('hubCpuChart', '#ff9f0a');
  if (!hubRamChart) hubRamChart = createHubSparkline('hubRamChart', '#8b5cf6');
  if (hubCpuChart) { hubCpuChart.data.datasets[0].data = [...hubCpuHistory]; hubCpuChart.update('none'); }
  if (hubRamChart) { hubRamChart.data.datasets[0].data = [...hubRamHistory]; hubRamChart.update('none'); }
}

function renderFleet(servers) {
  const container = document.getElementById('nodes-container');
  if (!container) return;

  if (Object.keys(servers).length === 0) {
    container.innerHTML = '<div class="card" style="grid-column:1/-1;text-align:center;padding:3rem;"><p style="color:var(--text-secondary)">Waiting for first reports… Ensure agents are running and pointing to this Hub IP.</p></div>';
    return;
  }

  container.innerHTML = Object.entries(servers).map(([hostname, data]) => {
    const isOnline = (Date.now() - data.lastReport) < 45000;
    const uptime   = data.uptime ? formatUptime(data.uptime) : '';
    const onlineCls = isOnline ? 'online' : 'offline';

    // ── Gateway ──
    if (data.gateway) {
      const dsl = data.gateway.dsl_sync;
      const vpn = data.gateway.vpn_active;
      const extIp = data.network?.ext_ip || '';
      return `
        <div class="node-card" onclick="openDetails('${hostname}')">
          <div class="nc-head">
            <span class="nc-dot ${onlineCls}"></span>
            <span class="nc-hostname">${hostname}</span>
            <span class="nc-tag">${data.model || 'Gateway'}</span>
          </div>
          <div class="nc-vitals" style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px;">
            ${dsl ? `<div style="display:flex;align-items:center;justify-content:space-between;">
              <span style="font-size:9px;font-weight:800;letter-spacing:.12em;color:var(--text-secondary);text-transform:uppercase;">DSL SYNC</span>
              <span class="nc-status-badge ${dsl === 'Up' ? 'ok' : 'bad'}">${dsl}</span>
            </div>` : ''}
            ${vpn !== undefined ? `<div style="display:flex;align-items:center;justify-content:space-between;">
              <span style="font-size:9px;font-weight:800;letter-spacing:.12em;color:var(--text-secondary);text-transform:uppercase;">VPN</span>
              <span class="nc-status-badge ${vpn ? 'ok' : 'bad'}">${vpn ? 'Active' : 'Down'}</span>
            </div>` : ''}
            ${extIp ? `<div style="display:flex;align-items:center;justify-content:space-between;">
              <span style="font-size:9px;font-weight:800;letter-spacing:.12em;color:var(--text-secondary);text-transform:uppercase;">EXT IP</span>
              <span style="font-size:12px;font-family:monospace;color:var(--accent);">${extIp}</span>
            </div>` : ''}
          </div>
          <div class="nc-foot">
            ${uptime ? `<span class="nc-uptime">${uptime}</span>` : '<span></span>'}
            <button class="nc-logs-btn" onclick="event.stopPropagation();window.openGatewayLogs('${hostname}')">Logs</button>
          </div>
        </div>`;
    }

    // ── Compute node ──
    const cpu    = data.cpu     || {};
    const mem    = data.memory  || {};
    const net    = data.network || {};
    const cpuPct = cpu.load    !== undefined ? cpu.load    : 0;
    const memPct = mem.percent !== undefined ? mem.percent : 0;
    const temp   = cpu.temp;
    const rx     = net.rx_sec !== undefined ? (net.rx_sec / 1024).toFixed(1) : '0.0';
    const tx     = net.tx_sec !== undefined ? (net.tx_sec / 1024).toFixed(1) : '0.0';
    const cpuCls  = cpuPct > 85 ? 'hot' : cpuPct > 65 ? 'warm' : 'cpu';
    const tempCls = temp ? getTempClass(temp) : '';

    return `
      <div class="node-card" onclick="openDetails('${hostname}')">
        <div class="nc-head">
          <span class="nc-dot ${onlineCls}"></span>
          <span class="nc-hostname">${hostname}</span>
          <span class="nc-tag">${data.model || 'Node'}</span>
          ${uptime ? `<span class="nc-uptime">${uptime}</span>` : ''}
        </div>
        <div class="nc-vitals">
          <div class="nc-vital">
            <span class="nc-vval">${cpuPct}<span class="nc-vunit">%</span></span>
            <span class="nc-vlabel">CPU</span>
            <div class="nc-vbar"><div class="nc-vbar-fill ${cpuCls}" style="width:${cpuPct}%"></div></div>
          </div>
          <div class="nc-vdivider"></div>
          <div class="nc-vital">
            <span class="nc-vval">${memPct}<span class="nc-vunit">%</span></span>
            <span class="nc-vlabel">RAM</span>
            <div class="nc-vbar"><div class="nc-vbar-fill ram" style="width:${memPct}%"></div></div>
          </div>
        </div>
        <div class="nc-foot">
          <span class="nc-net">↓ ${rx} &nbsp;↑ ${tx} <small style="opacity:.45">KB/s</small></span>
          ${temp
            ? `<span class="nc-tpill ${tempCls}">${temp}°C</span>`
            : `<span class="nc-tpill ${onlineCls}">${isOnline ? 'ONLINE' : 'OFFLINE'}</span>`
          }
        </div>
      </div>`;
  }).join('');
}

/** ── Node Detail Stats ── **/

async function fetchNodeStats() {
  if (!selectedHostname) return;
  try {
    const res = await apiFetch(`/api/stats/${selectedHostname}`);
    const data = await res.json();

    // Heartbeat
    const hb = document.getElementById('heartbeat-dot');
    if (hb) { hb.className = 'heartbeat active'; setTimeout(() => hb.className = 'heartbeat', 500); }

    // Drawer header
    updateElement('drawer-hostname', data.hostname || selectedHostname);
    document.title = `${selectedHostname} | cockpit`;

    const isGateway = data.os === 'fritzbox' ||
                      data.model?.toLowerCase().includes('fritz') ||
                      data.hostname?.toLowerCase().includes('gateway');

    updateElement('os-info', `${data.model || 'Unknown'} · ${data.os || 'Linux'} · Up ${formatUptime(data.uptime)}`);

    // Show/hide gateway vs. compute cards
    document.getElementById('gateway-info').style.display = isGateway ? 'block' : 'none';
    const cpuBox     = document.getElementById('cpu-metric-box');
    const ramBox     = document.getElementById('ram-metric-box');
    const storageCard = document.getElementById('details-storage');
    if (cpuBox)      cpuBox.style.display     = (!isGateway) ? 'block' : 'none';
    if (ramBox)      ramBox.style.display     = (!isGateway) ? 'block' : 'none';
    if (storageCard) storageCard.style.display = (!isGateway) ? 'block' : 'none';

    if (isGateway && data.gateway) {
      updateElement('gw-dsl-sync', data.gateway.dsl_sync || 'Up');
      const vpnEl = document.getElementById('gw-vpn-status');
      if (vpnEl) {
        vpnEl.textContent = data.gateway.vpn_active ? 'CONNECTED' : 'DISCONNECTED';
        vpnEl.className = `temp-badge ${data.gateway.vpn_active ? 'cool' : 'hot'}`;
      }
      updateElement('gw-ext-ip', data.network?.ext_ip || 'Managed');
    }

    // Populate chart history on first load
    if (data.history && cpuChart?.data.datasets[0].data.length === 0) {
      const hist = data.history.slice(-maxDataPoints);
      [cpuChart, ramChart, netChart].forEach(c => { if (!c) return; c.data.labels = []; c.data.datasets.forEach(ds => ds.data = []); });
      hist.forEach(h => {
        const t = h.time ? new Date(h.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
        cpuChart?.data.labels.push(t); cpuChart?.data.datasets[0].data.push(h.cpu || 0);
        ramChart?.data.labels.push(t); ramChart?.data.datasets[0].data.push(h.ram || 0);
        if (netChart) { netChart.data.labels.push(t); netChart.data.datasets[0].data.push(h.rx || 0); netChart.data.datasets[1].data.push(h.tx || 0); }
      });
      cpuChart?.update('none');
      ramChart?.update('none');
      netChart?.update('none');
    }

    if (data.history && detailViewMode === 'raw') renderHistoryTable(data.history);

    const timeLabel = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const hasCpu = data.cpu?.load !== undefined;
    const hasRam = data.memory?.percent !== undefined;

    if (hasCpu) {
      updateElement('cpu-load', data.cpu.load);
      updateChart(cpuChart, data.cpu.load, timeLabel);
      const tempEl   = document.getElementById('cpu-temp-details');
      const stripTemp = document.getElementById('strip-temp');
      if (data.cpu.temp) {
        if (tempEl)   { tempEl.textContent = `${data.cpu.temp}°C`; tempEl.className = `temp-badge ${getTempClass(data.cpu.temp)}`; tempEl.style.display = 'inline-flex'; }
        if (stripTemp) { stripTemp.textContent = `${data.cpu.temp}°C`; stripTemp.className = `stat-value temp-badge ${getTempClass(data.cpu.temp)}`; }
      } else {
        if (tempEl)   tempEl.style.display = 'none';
        if (stripTemp) stripTemp.textContent = '--';
      }
    }

    if (hasRam) {
      updateElement('ram-usage', data.memory.percent);
      updateChart(ramChart, data.memory.percent, timeLabel);
      updateElement('ram-detail', `${formatBytes(data.memory.used)} / ${formatBytes(data.memory.total)}`);
    }

    if (data.uptime) updateElement('strip-uptime', formatUptime(data.uptime));

    if (data.network && netChart) {
      const txKB = (data.network.tx_sec / 1024).toFixed(1);
      const rxKB = (data.network.rx_sec / 1024).toFixed(1);
      updateElement('net-tx', txKB);
      updateElement('net-rx', rxKB);
      netChart.data.datasets[0].data.push(parseFloat(rxKB));
      netChart.data.datasets[1].data.push(parseFloat(txKB));
      netChart.data.labels.push(timeLabel);
      if (netChart.data.labels.length > maxDataPoints) {
        netChart.data.labels.shift();
        netChart.data.datasets[0].data.shift();
        netChart.data.datasets[1].data.shift();
      }
      netChart.update('none');
    }

    if (data.storage?.root) {
      updateElement('root-percent', `${data.storage.root.percent}%`);
      updateProgress('root-bar', data.storage.root.percent);
      updateElement('root-detail', `${formatBytes(data.storage.root.used)} / ${formatBytes(data.storage.root.total)}`);
    }

    renderDriveHealth(data);
    renderActiveJobs(data);
    renderActiveDrives(data);

  } catch (err) {
    console.error('fetchNodeStats:', err);
  }
}

function renderDriveHealth(data) {
  const container = document.getElementById('drives-container');
  if (!container) return;
  const drives = data.storage?.drives || [];
  if (drives.length === 0) { container.innerHTML = ''; return; }
  container.innerHTML = drives.map(d => `
    <div class="job-card" style="border:1px solid rgba(77,124,254,0.2);">
      <i data-lucide="hard-drive" class="job-icon"></i>
      <h4 style="font-size:0.9rem;margin-top:4px;">${d.device}</h4>
      <p style="font-size:0.8rem;margin-top:2px;">Status: <span class="status-badge ${d.status === 'Healthy' ? 'online' : 'offline'}">${d.status}</span></p>
    </div>
  `).join('');
  if (window.lucide) lucide.createIcons();
}

function renderActiveJobs(data) {
  const detailSect = document.getElementById('details-charts');
  if (!detailSect) return;
  let jobsSect = document.getElementById('details-jobs');
  if (!jobsSect) {
    const tpl = document.getElementById('jobs-template');
    if (tpl) { detailSect.appendChild(tpl.content.cloneNode(true)); jobsSect = document.getElementById('details-jobs'); if (window.lucide) lucide.createIcons(); }
  }
  const container = document.getElementById('jobs-container');
  if (!container) return;
  const jobs = data.stats?.jobs || data.jobs || [];
  if (jobs.length === 0) {
    container.innerHTML = '<p style="color:var(--text-secondary);font-size:13px;padding:0.5rem;">No active jobs detected.</p>';
    return;
  }
  container.innerHTML = jobs.map(j => `
    <div class="job-card">
      <i data-lucide="play-circle" class="job-icon"></i>
      <div style="margin-top:4px;"><h4 style="font-size:0.9rem;">${j.name}</h4><p style="font-size:0.8rem;color:var(--text-secondary);">${j.status} · ${j.started || '—'}</p></div>
    </div>
  `).join('');
  if (window.lucide) lucide.createIcons();
}

function renderActiveDrives(data) {
  const detailSect = document.getElementById('details-charts');
  if (!detailSect) return;
  let drivesSect = document.getElementById('details-drives');
  if (!drivesSect) {
    const tpl = document.getElementById('drives-template');
    if (tpl) { detailSect.appendChild(tpl.content.cloneNode(true)); drivesSect = document.getElementById('details-drives'); if (window.lucide) lucide.createIcons(); }
  }
  const container = document.getElementById('drives-container');
  const summary   = document.getElementById('drives-status-summary');
  if (!container) return;
  const drives = data.stats?.drives || data.drives || [];
  if (drives.length === 0) { if (drivesSect) drivesSect.style.display = 'none'; return; }
  if (drivesSect) drivesSect.style.display = 'block';

  let failing = 0;
  container.innerHTML = drives.map(d => {
    if (d.status === 'Failing') failing++;
    const ok     = d.status === 'Healthy';
    const bg     = ok ? 'rgba(18,208,122,0.05)'  : 'rgba(255,45,85,0.08)';
    const border = ok ? 'rgba(18,208,122,0.2)'   : 'rgba(255,45,85,0.35)';
    return `
      <div style="display:flex;flex-direction:column;gap:8px;border:1px solid ${border};background:${bg};padding:12px;border-radius:5px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-weight:600;font-size:0.95rem;display:flex;align-items:center;gap:6px;"><i data-lucide="hard-drive" style="width:15px;height:15px;"></i> ${d.name.toUpperCase()}</span>
          <span class="status-badge ${ok ? 'online' : 'offline'}">${d.status}</span>
        </div>
        <div style="color:var(--text-secondary);font-size:0.82rem;display:flex;flex-direction:column;gap:3px;">
          <div style="display:flex;justify-content:space-between;"><span>Model:</span><span style="color:var(--text-primary);">${d.model}</span></div>
          <div style="display:flex;justify-content:space-between;"><span>Size:</span><span style="color:var(--text-primary);">${formatBytes(d.size)}</span></div>
          <div style="display:flex;justify-content:space-between;"><span>State:</span><span style="color:var(--text-primary);">${d.state}</span></div>
        </div>
      </div>`;
  }).join('');

  if (summary) {
    summary.innerHTML = failing > 0
      ? `<span style="color:var(--accent-red);padding:3px 8px;background:rgba(255,45,85,0.1);border-radius:4px;">${failing} Drive(s) Failing!</span>`
      : `<span style="color:var(--accent-green);padding:3px 8px;background:rgba(18,208,122,0.08);border-radius:4px;">All ${drives.length} Healthy</span>`;
  }
  if (window.lucide) lucide.createIcons();
}

/** ── Detail mode (Charts / Raw) ── **/
window.setDetailMode = (mode) => {
  detailViewMode = mode;
  const chartSect = document.getElementById('details-charts');
  const rawSect   = document.getElementById('details-raw');
  const btnChart  = document.getElementById('btn-chart-view');
  const btnRaw    = document.getElementById('btn-raw-view');

  if (mode === 'chart') {
    if (chartSect) chartSect.style.display = 'block';
    if (rawSect)   rawSect.style.display   = 'none';
    if (btnChart)  btnChart.classList.add('active');
    if (btnRaw)    btnRaw.classList.remove('active');
  } else {
    if (chartSect) chartSect.style.display = 'none';
    if (rawSect)   rawSect.style.display   = 'block';
    if (btnChart)  btnChart.classList.remove('active');
    if (btnRaw)    btnRaw.classList.add('active');
    fetchNodeStats();
  }
};

function renderHistoryTable(history) {
  const tbody  = document.getElementById('history-table-body');
  const thead  = document.querySelector('.history-table thead tr');
  if (!tbody || !thead || !history.length) return;

  const allKeys = new Set();
  history.forEach(h => Object.keys(h).forEach(k => {
    if (!['time', 'recorded_at', 'data', 'GATEWAY_LOGS', 'cpu', 'ram', 'rx', 'tx'].includes(k)) allKeys.add(k);
  }));
  const sortedKeys = Array.from(allKeys).sort();

  thead.innerHTML = `<th>Timestamp</th>${sortedKeys.map(k => `<th>${k.toUpperCase()}</th>`).join('')}`;

  tbody.innerHTML = [...history].reverse().map(h => {
    const date    = h.time ? new Date(h.time) : null;
    const timeStr = (date && !isNaN(date)) ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '---';
    return `<tr>
      <td style="font-family:monospace;white-space:nowrap;">${timeStr}</td>
      ${sortedKeys.map(k => {
        let val = h[k];
        const ku = k.toUpperCase();
        if (ku.includes('PERCENT') || ku === 'CPU' || ku === 'RAM') val = typeof val === 'number' ? `${val.toFixed(1)}%` : val;
        else if (ku.includes('RX_SEC') || ku.includes('TX_SEC') || ku === 'TX' || ku === 'RX') val = typeof val === 'number' ? `${val.toFixed(1)} KB/s` : val;
        else if (ku.includes('BYTES')) val = typeof val === 'number' ? formatBytes(val) : val;
        return `<td style="font-family:monospace;font-size:0.82rem;">${val !== undefined ? (typeof val === 'object' ? `<pre style="margin:0;font-size:0.75rem;">${JSON.stringify(val, null, 2)}</pre>` : val) : '—'}</td>`;
      }).join('')}
    </tr>`;
  }).join('');
}

/** ── Node detail open / close ── **/
window.openDetails = (hostname, push = true) => {
  selectedHostname = hostname;
  currentView = 'details';

  updateElement('drawer-hostname', hostname);
  updateElement('os-info', '—');
  openDrawer();

  if (push) window.history.pushState({ hostname }, '', `/${hostname}`);

  setDetailMode('chart');
  createNodeCharts();
  fetchNodeStats();

  if (statsTimer) clearInterval(statsTimer);
  statsTimer = setInterval(fetchNodeStats, REFRESH_INTERVAL_STATS);
};

// Keep showOverview as alias for closeDrawer (router may call it)
window.showOverview = () => window.closeDrawer();

/** ── Services ── **/
async function fetchPiServices() {
  try {
    const res = await apiFetch('/api/pi/services');
    renderPiServices(await res.json());
  } catch (err) {
    console.error('fetchPiServices:', err);
  }
}

function renderPiServices(services) {
  const container = document.getElementById('pi-services-container');
  if (!container) return;
  if (services.length === 0) {
    container.innerHTML = '<p style="text-align:center;color:var(--text-secondary);padding:2rem;grid-column:1/-1;">No manageable services found.</p>';
    return;
  }
  container.innerHTML = services.map(s => {
    const running = s.status === 'running';
    return `
    <div class="node-card" style="cursor:default;">
      <div class="nc-head">
        <span class="nc-dot ${running ? 'online' : 'offline'}"></span>
        <span class="nc-hostname">${s.name}</span>
        <span class="nc-tag" style="${running ? 'color:var(--accent-green);border-color:rgba(13,204,110,0.3);' : 'color:var(--accent-red);border-color:rgba(255,51,82,0.3);'}">${running ? 'Running' : 'Stopped'}</span>
      </div>
      <p class="svc-desc">${s.description}</p>
      <div class="svc-actions">
        ${running
          ? `<button class="btn-ghost" style="flex:1;" onclick="piServiceAction('${s.name}','restart')">Restart</button>
             <button class="btn-ghost danger" style="flex:1;" onclick="piServiceAction('${s.name}','stop')">Stop</button>`
          : `<button class="btn-primary" style="flex:1;" onclick="piServiceAction('${s.name}','start')">Start</button>`
        }
      </div>
    </div>`;
  }).join('');
  if (window.lucide) lucide.createIcons();
}

window.piServiceAction = async (name, action) => {
  if (!confirm(`${action} ${name}?`)) return;
  try {
    await apiFetch(`/api/pi/services/${name}/${action}`, { method: 'POST' });
    await fetchPiServices();
  } catch (err) {
    alert('Fehler: ' + err.message);
  }
};

/** ── Gateway logs ── **/
window.openGatewayLogs = (hostname) => {
  const modal = document.getElementById('logs-modal');
  const title = document.getElementById('modalTitle');
  const text  = document.getElementById('modalLogsText');
  if (!modal || !text) return;
  title.textContent = `${hostname} — Gateway Logs`;
  text.textContent  = 'Fetching…';
  modal.style.display = 'flex';
  apiFetch(`/api/stats/${hostname}`).then(r => r.json()).then(d => {
    text.textContent = d.gateway?.logs || 'No logs available.';
  }).catch(err => { text.textContent = 'Error: ' + err.message; });
};

window.closeLogs = () => {
  const modal = document.getElementById('logs-modal');
  if (modal) modal.style.display = 'none';
};

/** ── Export ── **/
window.exportData = async () => {
  if (!selectedHostname) return;
  const timeframe = document.getElementById('export-timeframe').value;
  const link = document.createElement('a');
  link.href = `/api/export/${selectedHostname}?timeframe=${timeframe}&token=${hubToken}`;
  link.setAttribute('download', '');
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

/** ── Routing ── **/
function handleRouting() {
  const path = window.location.pathname.replace(/^\/|\/$/g, '');
  if (path && path !== 'hub' && path !== 'info') {
    openDetails(path, false);
  }
}

window.onpopstate = () => handleRouting();

/** ── Misc utils ── **/
function updateProgress(id, percent) {
  const el = document.getElementById(id);
  if (el) {
    el.style.width = `${percent}%`;
    el.className = `progress-fill ${percent >= 90 ? 'danger' : percent >= 70 ? 'warning' : ''}`;
  }
}

async function sendActiveHeartbeat() {
  try { await apiFetch('/api/active', { method: 'POST' }); } catch (_) {}
}

/** ── Boot ── **/
document.addEventListener('DOMContentLoaded', () => {
  createHubCharts();
  handleRouting();

  fetchFleet();
  fleetTimer = setInterval(fetchFleet, REFRESH_INTERVAL_FLEET);

  fetchPiServices();
  piTimer = setInterval(fetchPiServices, 30000);

  setInterval(sendActiveHeartbeat, 30000);
  sendActiveHeartbeat();
});
