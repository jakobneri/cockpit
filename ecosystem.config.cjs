module.exports = {
  apps: [{
    name: 'pi-cockpit',
    script: 'server/index.js',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    env: {
      NODE_ENV: 'production'
    }
  }]
};
