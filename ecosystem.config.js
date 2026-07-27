module.exports = {
  apps: [
    {
      name: 'shortnews-cms',
      script: './server.js',
      instances: 'max',
      exec_mode: 'cluster',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      listen_timeout: 10000, // wait 10s for app to listen
      kill_timeout: 5000,    // wait 5s for active connections to close
      merge_logs: true,
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm Z',
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000
      }
    }
  ]
};
