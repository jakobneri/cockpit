const os = require('os');
const fs = require('fs');
const path = require('path');
const isWindows = os.platform() === 'win32';
const hostname = os.hostname().toLowerCase();
const COCKPIT_DIR = path.resolve(__dirname);

let config = { gateways: [] };
try {
  const configPath = path.join(COCKPIT_DIR, 'config.json');
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.log(`[Config] Loaded config.json, found ${config.gateways?.length || 0} gateways.`);
  }
} catch (e) {
  console.error("Error reading config.json:", e.message);
}

const apps = [
  {
    name: 'cockpit-hub',
    script: path.join(COCKPIT_DIR, 'server/index.js'),
    cwd: COCKPIT_DIR,
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      DB_URL: 'http://127.0.0.1:3001',
      JWT_SECRET: '4b0ae67657e78e3e957d24da5da5abdf596ff0a9046513fd1600182c33562b29',
      INITIAL_ADMIN_PASSWORD: 'pw123'
    }
  },
  {
    name: `${hostname}-client`,
    script: path.join(COCKPIT_DIR, 'client/client.sh'),
    cwd: COCKPIT_DIR,
    interpreter: 'bash',
    env: {
      NODE_ENV: 'production',
      DB_URL: 'http://127.0.0.1:3001'
    },
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000
  }
];

// Add Fritz!Box Gateways — credentials aus config.json (gitignored)
config.gateways.forEach(gw => {
  const name = `${gw.ip}-gateway-client`;
  apps.push({
    name: name,
    script: path.join(COCKPIT_DIR, 'client/gateway-client.js'),
    cwd: COCKPIT_DIR,
    env: {
      GATEWAY_IP: gw.ip,
      GATEWAY_USER: gw.user,
      GATEWAY_PASS: gw.password,
      DB_URL: 'http://127.0.0.1:3001',
      HOSTNAME: name
    },
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000
  });
});

module.exports = { apps };
