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
      script: 'client/client.js',
      env: {
        NODE_ENV: 'production',
        DB_URL: 'http://localhost:3001'
      }
    }
  ]
};
