// Configuration
const REFRESH_INTERVAL_STATS = 5000;
const REFRESH_INTERVAL_SERVICES = 10000;

// Helper to format bytes
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
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
const maxDataPoints = 12; // 1 minute at 5s intervals
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

// Network charts need a dynamic y-axis since values are typically < 5 MB/s
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

const createChart = (ctxId, color, opts) => {
  const ctx = document.getElementById(ctxId).getContext('2d');
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

let cpuChart, ramChart, tempChart;

function updateChart(chart, newValue) {
  if (!chart) return;
  const data = chart.data.datasets[0].data;
  data.push(newValue);
  data.shift();
  chart.update();
}

// Update Progress bar (used only for storage UI now)
function updateProgress(id, percent) {
  const el = document.getElementById(id);
  if (el) {
    el.style.width = `${percent}%`;
    let colorClass = '';
    if (percent >= 90) colorClass = 'danger';
    else if (percent >= 70) colorClass = 'warning';
    
    el.className = `progress-fill ${colorClass}`;
  }
}

let txChart, rxChart; // Network charts

// Fetch and update stats
async function fetchStats() {
  try {
    const res = await fetch('/api/stats');
    if (!res.ok) throw new Error('Network response was not ok');
    const data = await res.json();

    // Heartbeat Pulse
    const heartbeat = document.getElementById('heartbeat-dot');
    if (heartbeat) {
      heartbeat.className = 'heartbeat active';
      setTimeout(() => heartbeat.className = 'heartbeat', 500);
    }

    // OS info / Uptime
    updateElement('os-info', `Running ${data.os || 'Linux'} | Uptime: ${formatUptime(data.uptime)}`);

    // CPU
    updateElement('cpu-load', data.cpu.load);
    updateChart(cpuChart, data.cpu.load);
    
    updateElement('cpu-temp', data.cpu.temp);
    updateChart(tempChart, data.cpu.temp); // Temp visually mapped 0-100 on graph

    // RAM
    updateElement('ram-usage', data.memory.percent);
    updateChart(ramChart, data.memory.percent);
    updateElement('ram-detail', `${formatBytes(data.memory.used)} / ${formatBytes(data.memory.total)}`);

    // Network
    if (data.network) {
      const txMB = (data.network.tx_sec / 1e6).toFixed(1);
      const rxMB = (data.network.rx_sec / 1e6).toFixed(1);
      updateElement('net-tx', txMB);
      updateChart(txChart, txMB);
      updateElement('net-rx', rxMB);
      updateChart(rxChart, rxMB);
    }

    // Storage: Root
    if (data.storage.root) {
      updateElement('root-percent', `${data.storage.root.percent}%`);
      updateProgress('root-bar', data.storage.root.percent);
      updateElement('root-detail', `${formatBytes(data.storage.root.used)} / ${formatBytes(data.storage.root.total)}`);
    }

    // Storage: SMB
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

  } catch (error) {
    console.error('Error fetching stats:', error);
    const heartbeat = document.getElementById('heartbeat-dot');
    if (heartbeat) heartbeat.className = 'heartbeat error';
  }
}

// Render processes helper
function renderProcesses(listId, data, type) {
  const listEl = document.getElementById(listId);
  if (!listEl) return;
  
  if (!data || data.length === 0) {
    listEl.innerHTML = '<tr><td colspan="4">No data retrieving...</td></tr>';
    return;
  }
  
  listEl.innerHTML = data.map(p => {
    const val = type === 'cpu' ? p.cpu : p.mem;
    const isCpu = type === 'cpu';
    const percent = Math.min(val, 100); // cap at 100% for bar display
    const barColor = isCpu ? 'var(--accent-blue)' : 'var(--accent-purple)';
    
    return `
    <tr class="process-item">
      <td class="col-pid">${p.pid}</td>
      <td class="col-user">${p.user}</td>
      <td class="col-name" title="${p.name}">${p.name}</td>
      <td class="col-val" style="padding-right: 1rem;">
        <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 4px;">
          <span>${val}%</span>
          <div class="progress-bar" style="height: 4px; background: var(--glass-border); max-width: 60px;">
            <div class="progress-fill" style="width: ${percent}%; background-color: ${barColor};"></div>
          </div>
        </div>
      </td>
    </tr>
    `;
  }).join('');
}

// Fetch and update service status
async function fetchServicesStatus() {
  const services = ['nextcloud', 'unifi', 'pihole-FTL'];
  for (const service of services) {
    try {
      const res = await fetch(`/api/services/${service}`);
      if (res.ok) {
        const data = await res.json();
        const card = document.querySelector(`.service-card[data-service="${service}"]`);
        if (card) {
          const badge = card.querySelector('.status-badge');
          if (badge) {
            badge.textContent = data.status.toUpperCase();
            badge.className = `status-badge ${data.status}`;
          }
        }
      }
    } catch (error) {
      console.error(`Error fetching status for ${service}:`, error);
    }
  }
}

// Manage Service action
window.serviceAction = async (service, action) => {
  const badge = document.querySelector(`.service-card[data-service="${service}"] .status-badge`);
  if (badge) {
    badge.textContent = `${action.toUpperCase()}ING...`;
    badge.className = `status-badge`;
  }
  
  try {
    const res = await fetch(`/api/services/${service}/${action}`, { method: 'POST' });
    if (res.ok) {
      setTimeout(fetchServicesStatus, 1500); 
    } else {
      alert(`Failed to ${action} ${service}. Check console for details.`);
    }
  } catch (error) {
    console.error(`Error performing ${action} on ${service}:`, error);
    alert(`Error: ${error.message}`);
  }
};

// Logs Modal functions
window.openLogs = async (service) => {
  const modal = document.getElementById('logsModal');
  const modalTitle = document.getElementById('modalTitle');
  const modalText = document.getElementById('modalLogsText');
  
  modal.style.display = 'flex';
  modalTitle.textContent = `${service.toUpperCase()} Logs`;
  modalText.textContent = 'Fetching logs from server...';

  try {
    const res = await fetch(`/api/services/${service}/logs`);
    const data = await res.json();
    modalText.textContent = data.logs || 'No logs available.';
    // scroll to bottom
    modalText.scrollTop = modalText.scrollHeight;
  } catch (err) {
    modalText.textContent = `Error fetching logs: ${err.message}`;
  }
};

window.closeLogs = () => {
  document.getElementById('logsModal').style.display = 'none';
};

// Close modal when clicking outside
window.onclick = (event) => {
  const modal = document.getElementById('logsModal');
  if (event.target == modal) {
    modal.style.display = 'none';
  }
};

// Initialization
document.addEventListener('DOMContentLoaded', () => {
  cpuChart = createChart('cpuChart', '#3b82f6');       // blue
  ramChart = createChart('ramChart', '#8b5cf6');       // purple
  tempChart = createChart('tempChart', '#ef4444');     // red
  txChart = createChart('txChart', '#10b981', netChartOptions);  // emerald, auto y-axis
  rxChart = createChart('rxChart', '#f59e0b', netChartOptions);  // amber, auto y-axis
  
  fetchStats();
  fetchServicesStatus();
  setInterval(fetchStats, REFRESH_INTERVAL_STATS);
  setInterval(fetchServicesStatus, REFRESH_INTERVAL_SERVICES);
});
