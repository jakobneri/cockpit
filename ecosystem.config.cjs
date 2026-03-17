module.exports = {
  apps: [
    {
      name: 'cockpit-hub',
      script: 'server/index.js',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      }
    },
    {
      name: 'cockpit-agent',
      script: 'agent/agent.js',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: {
        NODE_ENV: 'production',
        HUB_URL: 'http://localhost:3000'
      }
    }
  ]
};
