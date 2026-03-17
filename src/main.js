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
    y: { min: 0, max: 100, display: false }
  },
  plugins: { legend: { display: false }, tooltip: { enabled: false } },
  animation: { duration: 400 },
  elements: {
    line: { tension: 0.4, borderWidth: 2 },
    point: { radius: 0 }
  },
  layout: { padding: 0 }
};

const createChart = (ctxId, color) => {
  const ctx = document.getElementById(ctxId).getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 80);
  gradient.addColorStop(0, color + '80'); 
  gradient.addColorStop(1, color + '00'); 
  
  return new Chart(ctx, {
    type: 'line',
    data: {
      labels: Array(maxDataPoints).fill(''),
      datasets: [{
        data: Array(maxDataPoints).fill(0),
        borderColor: color,
        backgroundColor: gradient,
        fill: true
      }]
    },
    options: chartOptions
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

// Fetch and update stats
async function fetchStats() {
  try {
    const res = await fetch('/api/stats');
    if (!res.ok) throw new Error('Network response was not ok');
    const data = await res.json();

    // OS info
    updateElement('os-info', `Running ${data.os || 'Linux'} | Dashboard Active`);

    // CPU
    updateElement('cpu-load', data.cpu.load);
    updateChart(cpuChart, data.cpu.load);
    
    updateElement('cpu-temp', data.cpu.temp);
    updateChart(tempChart, data.cpu.temp); // Temp visually mapped 0-100 on graph

    // RAM
    updateElement('ram-usage', data.memory.percent);
    updateChart(ramChart, data.memory.percent);
    updateElement('ram-detail', `${formatBytes(data.memory.used)} / ${formatBytes(data.memory.total)}`);

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
        const badge = document.getElementById(`${service}-status`);
        if (badge) {
          badge.textContent = data.status;
          badge.className = `status-badge ${data.status}`;
        }
      }
    } catch (error) {
      console.error(`Error fetching status for ${service}:`, error);
    }
  }
}

// Manage Service action
window.manageService = async (service, action) => {
  const badge = document.getElementById(`${service}-status`);
  if (badge) {
    badge.textContent = `${action.toUpperCase()}ING...`;
    badge.className = `status-badge`;
  }
  
  try {
    const res = await fetch(`/api/services/${service}/${action}`, { method: 'POST' });
    if (res.ok) {
      // Immediately refresh stats to reflect new status
      setTimeout(fetchServicesStatus, 1500); 
    } else {
      alert(`Failed to ${action} ${service}. Check console for details.`);
    }
  } catch (error) {
    console.error(`Error performing ${action} on ${service}:`, error);
    alert(`Error: ${error.message}`);
  }
};

// Initialization
document.addEventListener('DOMContentLoaded', () => {
  cpuChart = createChart('cpuChart', '#3b82f6'); // blue
  ramChart = createChart('ramChart', '#8b5cf6'); // purple
  tempChart = createChart('tempChart', '#ef4444'); // red
  
  fetchStats();
  fetchServicesStatus();
  setInterval(fetchStats, REFRESH_INTERVAL_STATS);
  setInterval(fetchServicesStatus, REFRESH_INTERVAL_SERVICES);
});
