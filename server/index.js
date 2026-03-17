import express from 'express';
import cors from 'cors';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../dist')));

// ============================================================
// V2.0 HUB SERVER
// Central repository for monitoring data from all agents
// ============================================================

const servers = {};        // Map of hostname -> latest reported stats
const commandQueues = {};  // Map of hostname -> array of pending commands

// API: Agent Report (POSTed by agents every few seconds)
app.post('/api/report', (req, res) => {
  const { hostname, stats, services, timestamp } = req.body;
  if (!hostname) return res.status(400).json({ error: 'Missing hostname' });

  // Update server data
  servers[hostname] = {
    ...stats,
    services: services || {},
    lastReport: timestamp || Date.now()
  };

  // Return any pending commands for this agent
  const commands = commandQueues[hostname] || [];
  commandQueues[hostname] = []; // Clear queue after sending

  res.json({ success: true, commands });
});

// API: Get Fleet Overview (for the Dashboard)
app.get('/api/fleet', (req, res) => {
  // Return all current server states
  res.json({ 
    hubHostname: os.hostname(),
    servers 
  });
});

// API: Get Detailed Stats for a single server
app.get('/api/stats/:hostname', (req, res) => {
  const server = servers[req.params.hostname];
  if (!server) return res.status(404).json({ error: 'Node not found' });
  res.json({ hostname: req.params.hostname, ...server });
});

// API: Service Control (Adds a command to the queue for the agent)
app.post('/api/services/:hostname/:service/:action', (req, res) => {
  const { hostname, service, action } = req.params;
  
  if (!commandQueues[hostname]) commandQueues[hostname] = [];
  
  commandQueues[hostname].push({
    type: 'SERVICE_CONTROL',
    service,
    action
  });

  res.json({ success: true, message: `Command queued for ${hostname}` });
});

// API: Get Logs (Poll-and-response is tricky for logs, so we'll request it)
app.get('/api/services/:hostname/:service/logs', (req, res) => {
  const { hostname, service } = req.params;
  
  if (!commandQueues[hostname]) commandQueues[hostname] = [];
  
  // For logs, since we want a "Live" feel, we might need a different approach 
  // but for V2 MVP we will just queue a log request
  commandQueues[hostname].push({
    type: 'REQUEST_LOGS',
    service
  });

  // Since logs are asynchronous in poll-and-response, 
  // we'll tell the UI to check back in a second for 'lastLogs' in the next report
  res.json({ 
    success: true, 
    message: 'Log request queued. Result will appear in next heartbeat.' 
  });
});

app.listen(PORT, () => {
  console.log(`\n🚀 Pi Cockpit v2.0 HUB running on http://localhost:${PORT}`);
  console.log(`📡 Ready to receive reports at /api/report\n`);
});
