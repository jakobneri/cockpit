import express from 'express';
import si from 'systeminformation';
import cors from 'cors';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
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
    const [cpu, mem, temp, fsSize, osInfo, processes] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.cpuTemperature(),
      si.fsSize(),
      si.osInfo(),
      si.processes()
    ]);

    // Filter storage for Root
    const rootDrive = fsSize.find(fs => fs.mount === '/' || (isWindows && fs.mount.startsWith('C:')));
    // Rough guess for SMB: look for /nas-nextcloud-db, /mnt, smb, or any other drive on Windows
    const smbDrive = fsSize.find(fs => fs.mount === '/nas-nextcloud-db' || fs.mount.toLowerCase().includes('mnt') || fs.mount.toLowerCase().includes('smb') || (isWindows && !fs.mount.startsWith('C:')));

    res.json({
      os: osInfo.platform,
      cpu: {
        load: Math.round(cpu.currentLoad || 0),
        temp: temp.main ? Math.round(temp.main) : (isWindows ? 45 : 0) // Windows temp fallback
      },
      memory: {
        total: mem.total,
        used: mem.used,
        free: mem.free,
        percent: Math.round((mem.used / mem.total) * 100) || 0
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
        cpu: processes && processes.list ? [...processes.list].sort((a, b) => b.cpu - a.cpu).slice(0, 5).map(p => ({ name: p.name, cpu: p.cpu })) : [],
        mem: processes && processes.list ? [...processes.list].sort((a, b) => b.mem - a.mem).slice(0, 5).map(p => ({ name: p.name, mem: p.mem })) : []
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
  
  // Custom logic for Nextcloud (Docker Compose)
  if (service === 'nextcloud') {
    if (action === 'status') {
      return await execAsync('cd /nextcloud && sudo docker-compose ps');
    } else if (action === 'start') {
      return await execAsync('cd /nextcloud && sudo docker-compose up -d');
    } else if (action === 'stop') {
      return await execAsync('cd /nextcloud && sudo docker-compose stop');
    } else if (action === 'restart') {
      return await execAsync('cd /nextcloud && sudo docker-compose restart');
    }
  } else {
    // Standard systemctl logic for Unifi and Pihole
    if (action === 'status') {
      return await execAsync(`sudo systemctl is-active ${service}`);
    } else {
      return await execAsync(`sudo systemctl ${action} ${service}`);
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
      // Docker compose ps usually outputs 'Up' or 'running' for active containers
      isActive = stdout.includes('Up') || stdout.includes('running');
    } else {
      // systemctl is-active strictly outputs 'active' and cleanly errors if not
      isActive = stdout.trim() === 'active';
    }
    
    res.json({ service, status: isActive ? 'running' : 'stopped' });
  } catch (err) {
    // If systemctl is-active throws (returns non-zero), it is stopped
    res.json({ service, status: 'stopped' });
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
