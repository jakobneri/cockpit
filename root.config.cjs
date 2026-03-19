const os = require('os');
const isWindows = os.platform() === 'win32';

module.exports = {
  apps: [
    {
      name: 'cockpit-hub',
      script: 'server/index.js',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        DB_URL: 'http://localhost:3001' // Assuming PostgREST runs on 3001
      }
    },
    {
      name: 'cockpit-client',
      // Dynamically select the native script based on OS
      script: isWindows ? 'client/client.ps1' : 'client/client.sh',
      interpreter: isWindows ? 'powershell' : 'bash',
      env: {
        NODE_ENV: 'production',
        DB_URL: 'http://localhost:3001'
      },
      // Restart on failure
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000
    }
  ]
};
