const os = require('os');
const fs = require('fs');
const path = require('path');
const isWindows = os.platform() === 'win32';
const hostname = os.hostname().toLowerCase();

let config = { gateways: [] };
try {
  const configPath = path.join(__dirname, 'cockpit.config.json');
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
} catch (e) {
  console.error("Error reading cockpit.config.json:", e.message);
}

const apps = [
  {
    name: 'cockpit-hub',
    script: 'server/index.js',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      DB_URL: 'http://localhost:3001',
      HUB_TRUSTED_IPS: '127.0.0.1,192.168.188.23'
    }
  },
  {
    name: `${hostname}-client`,
    script: isWindows ? 'client/client.ps1' : 'client/client.sh',
    interpreter: isWindows ? 'powershell' : 'bash',
    env: {
      NODE_ENV: 'production',
      DB_URL: 'http://localhost:3001'
    },
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000
  }
];

// Add Fritz!Box Gateways
config.gateways.forEach(gw => {
  const name = `${gw.ip}-gateway-client`;
  apps.push({
    name: name,
    script: 'client/gateway-client.js',
    env: {
      GATEWAY_IP: gw.ip,
      GATEWAY_USER: gw.user,
      GATEWAY_PASS: gw.password,
      DB_URL: 'http://localhost:3001',
      HOSTNAME: name 
    },
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000
  });
});

module.exports = { apps };
