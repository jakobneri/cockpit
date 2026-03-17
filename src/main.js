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

// Get color class based on percentage
function getColorClass(percent, type = 'usage') {
  if (type === 'temp') {
    if (percent < 60) return '';
    if (percent < 80) return 'warning';
    return 'danger';
  } else {
    if (percent < 70) return '';
    if (percent < 90) return 'warning';
    return 'danger';
  }
}

// Update DOM element
function updateElement(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

// Update Progress bar
function updateProgress(id, percent, type = 'usage') {
  const el = document.getElementById(id);
  if (el) {
    el.style.width = `${percent}%`;
    el.className = `progress-fill ${getColorClass(percent, type)}`;
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
    updateProgress('cpu-bar', data.cpu.load);
    updateElement('cpu-temp', data.cpu.temp);
    updateProgress('temp-bar', data.cpu.temp, 'temp'); // treating absolute temp as roughly % mapping up to 100 for color

    // RAM
    updateElement('ram-usage', data.memory.percent);
    updateProgress('ram-bar', data.memory.percent);
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
fetchStats();
fetchServicesStatus();
setInterval(fetchStats, REFRESH_INTERVAL_STATS);
setInterval(fetchServicesStatus, REFRESH_INTERVAL_SERVICES);
