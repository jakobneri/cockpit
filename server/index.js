import express from 'express';
import si from 'systeminformation';
import cors from 'cors';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../dist')));

// Helper to handle Windows fallback for testing locally
const isWindows = process.platform === 'win32';

// 1. Stats Endpoint
app.get('/api/stats', async (req, res) => {
  try {
    const [cpu, mem, temp, fsSize, osInfo, processes, net] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.cpuTemperature(),
      si.fsSize(),
      si.osInfo(),
      si.processes(),
      si.networkStats()
    ]);

    // Filter storage for Root
    const rootDrive = fsSize.find(fs => fs.mount === '/' || (isWindows && fs.mount.startsWith('C:')));
    // Rough guess for SMB: look for /nas-nextcloud-db, /mnt, smb, or any other drive on Windows
    const smbDrive = fsSize.find(fs => fs.type === 'cifs' || fs.type === 'nfs' || fs.type === 'smbfs' || fs.mount === '/nas-nextcloud-db' || fs.mount.toLowerCase().includes('mnt') || fs.mount.toLowerCase().includes('smb') || (isWindows && !fs.mount.startsWith('C:')));

    res.json({
      os: osInfo.platform,
      uptime: os.uptime(),
      network: {
        tx_sec: net && net[0] ? net[0].tx_sec : 0,
        rx_sec: net && net[0] ? net[0].rx_sec : 0
      },
      cpu: {
        load: Math.round(cpu.currentLoad || 0),
        temp: temp.main ? Math.round(temp.main) : (isWindows ? 45 : 0) // Windows temp fallback
      },
      memory: {
        total: mem.total,
        used: mem.active,
        free: mem.available,
        percent: Math.round((mem.active / mem.total) * 100) || 0
      },
      storage: {
        root: rootDrive ? {
          total: rootDrive.size,
          used: rootDrive.used,
          percent: Math.round(rootDrive.use)
        } : null,
        smb: smbDrive ? {
          total: smbDrive.size,
          used: smbDrive.used,
          path: smbDrive.mount,
          percent: Math.round(smbDrive.use)
        } : null
      },
      processes: {
        cpu: processes && processes.list ? [...processes.list].sort((a, b) => b.cpu - a.cpu).slice(0, 5).map(p => ({ pid: p.pid, user: p.user || 'N/A', name: p.name, cpu: p.cpu.toFixed(1) })) : [],
        mem: processes && processes.list ? [...processes.list].sort((a, b) => b.mem - a.mem).slice(0, 5).map(p => ({ pid: p.pid, user: p.user || 'N/A', name: p.name, mem: p.mem.toFixed(1) })) : []
      }
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch system stats' });
  }
});

// 2. Services Endpoint
const runServiceCmd = async (service, action) => {
  if (isWindows) {
    // Mock for local testing on Windows
    const isStatus = action === 'status';
    return { stdout: isStatus ? 'active' : `Mock executed: ${action} ${service}` };
  }
  
  // Custom logic for Nextcloud (Docker Compose or Native Apache)
  if (service === 'nextcloud') {
    if (action === 'status') {
      try {
        const result = await execAsync('cd /home/archimedes/nextcloud && sudo docker compose ps');
        return result;
      } catch (e) {
        return await execAsync('systemctl is-active apache2');
      }
    } else if (action === 'start') {
      try {
        return await execAsync('cd /home/archimedes/nextcloud && sudo docker compose up -d');
      } catch (e) {
        return await execAsync('sudo systemctl start apache2');
      }
    } else if (action === 'stop') {
      try {
        return await execAsync('cd /home/archimedes/nextcloud && sudo docker compose stop');
      } catch (e) {
        return await execAsync('sudo systemctl stop apache2');
      }
    } else if (action === 'restart') {
      try {
        return await execAsync('cd /home/archimedes/nextcloud && sudo docker compose restart');
      } catch (e) {
        return await execAsync('sudo systemctl restart apache2');
      }
    }
  } else {
    // Standard systemctl logic for Unifi and Pihole
    let targetService = service;
    if (service === 'unifi') {
        try {
            await execAsync(`systemctl is-active unifi-core.service`);
            targetService = 'unifi-core.service';
        } catch(e) { targetService = 'unifi-core'; }
    }
    
    if (action === 'status') {
      return await execAsync(`systemctl is-active ${targetService}`); // Removed sudo to prevent password prompt block
    } else {
      return await execAsync(`sudo systemctl ${action} ${targetService}`);
    }
  }
};

app.get('/api/services/:service', async (req, res) => {
  const { service } = req.params;
  try {
    const { stdout } = await runServiceCmd(service, 'status');
    let isActive = false;
    
    if (isWindows) {
      isActive = true;
    } else if (service === 'nextcloud') {
      isActive = stdout.includes('Up') || stdout.includes('running') || stdout.trim() === 'active';
    } else {
      isActive = stdout.trim() === 'active';
    }
    
    // Fallback: If systemctl check says it's not active, do a physical process check
    if (!isActive && !isWindows) {
      const procs = await si.processes();
      if (service === 'unifi') {
        isActive = procs.list.some(p => p.name.includes('unifi') || (p.user === 'uosserver' && p.name.includes('java')));
      } else if (service === 'nextcloud') {
        isActive = procs.list.some(p => p.name.includes('apache2') || p.name.includes('mariadbd'));
      } else if (service === 'pihole-FTL') {
        isActive = procs.list.some(p => p.name.includes('pihole-FTL'));
      }
    }
    
    res.json({ service, status: isActive ? 'running' : 'stopped' });
  } catch (err) {
    // If command throws, fall back to process check
    let isActive = false;
    try {
      const procs = await si.processes();
      if (service === 'unifi') {
        isActive = procs.list.some(p => p.name.includes('unifi') || (p.user === 'uosserver' && p.name.includes('java')));
      } else if (service === 'nextcloud') {
        isActive = procs.list.some(p => p.name.includes('apache2') || p.name.includes('mariadbd'));
      } else if (service === 'pihole-FTL') {
        isActive = procs.list.some(p => p.name.includes('pihole-FTL'));
      }
    } catch (e) { console.error('Fallback proc check failed:', e); }

    res.json({ service, status: isActive ? 'running' : 'stopped' });
  }
});

// Fetch Logs for a specific service
app.get('/api/services/:service/logs', async (req, res) => {
  const { service } = req.params;
  try {
    let cmd = '';
    if (service === 'unifi') {
      cmd = 'sudo -n journalctl -u unifi-core.service -n 50 --no-pager 2>/dev/null || journalctl -u unifi-core.service -n 50 --no-pager';
    } else if (service === 'nextcloud') {
      cmd = 'cd /home/archimedes/nextcloud && sudo docker compose logs --tail 50 2>/dev/null || sudo -n journalctl -u apache2.service -n 50 --no-pager';
    } else if (service === 'pihole-FTL') {
      // Try multiple pihole log locations, then journalctl with sudo
      cmd = 'tail -n 50 /var/log/pihole.log 2>/dev/null || tail -n 50 /var/log/pihole/pihole-FTL.log 2>/dev/null || tail -n 50 /var/log/pihole/FTL.log 2>/dev/null || sudo -n journalctl -u pihole-FTL -n 50 --no-pager 2>/dev/null || pihole -t 2>/dev/null | head -50';
    } else {
      return res.status(400).json({ error: 'Invalid service for logs' });
    }

    if (isWindows) {
      return res.json({ logs: '[Simulated Logs on Windows]\nStarting service...\nService running OK.' });
    }

    const { stdout, stderr } = await execAsync(cmd);
    res.json({ logs: stdout || stderr || 'No logs found.' });
  } catch (err) {
    // Return the error message as logs content so the modal shows something useful
    res.json({ logs: `Could not fetch logs:\n${err.message}\n\nTip: Make sure the node process has permission to read journalctl.\nYou can grant access with: sudo usermod -aG systemd-journal $(whoami)` });
  }
});

app.post('/api/services/:service/:action', async (req, res) => {
  const { service, action } = req.params;
  const validServices = ['nextcloud', 'unifi', 'pihole-FTL'];
  const validActions = ['start', 'stop', 'restart'];

  if (!validServices.includes(service) || !validActions.includes(action)) {
    return res.status(400).json({ error: 'Invalid service or action' });
  }

  try {
    const { stdout } = await runServiceCmd(service, action);
    res.json({ success: true, output: stdout });
  } catch (error) {
    console.error(`Error with service ${service} action ${action}:`, error);
    res.status(500).json({ error: 'Service command failed', details: error.message });
  }
});

// 3. Auto-update logic (Webhook endpoint & Polling fallback)
const runAutoUpdate = async (force = false) => {
  if (isWindows) return; // Skip on local Windows testing
  try {
    if (!force) {
      await execAsync('git fetch');
      const { stdout: status } = await execAsync('git status -uno');
      if (!status.includes('Your branch is behind')) return;
    }
    console.log('Updates found! Pulling new code...');
    await execAsync('git pull');
    console.log('Installing dependencies...');
    await execAsync('npm install');
    console.log('Building project...');
    await execAsync('npm run build');
    console.log('Update complete. Process exiting to trigger a restart...');
    setTimeout(() => process.exit(0), 1000); // Allow HTTP response to finish before exiting
  } catch (error) {
    console.error('Auto-update error:', error);
  }
};

// Check every 1 minute as a robust fallback to the webhook
setInterval(() => runAutoUpdate(), 60 * 1000);

// Endpoint for Github Webhooks (instant updates)
app.post('/api/webhook/update', (req, res) => {
  res.json({ message: 'Auto-update webhook triggered.' });
  runAutoUpdate(true);
});

app.listen(PORT, () => {
  console.log(`Backend Server running on http://localhost:${PORT}`);
});
