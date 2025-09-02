module.exports = {
  apps: [{
    name: 'ibc-monitor',
    script: 'server.js',
    cwd: '/opt/ibc-monitor',
    user: 'ibcmonitor',
    instances: 1,  // or 'max' for cluster mode
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 3000,
      LOG_LEVEL: 'info'
    },
    env_development: {
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'debug'
    },
    error_file: '/opt/ibc-monitor/logs/pm2-error.log',
    out_file: '/opt/ibc-monitor/logs/pm2-out.log',
    log_file: '/opt/ibc-monitor/logs/pm2-combined.log',
    time: true,
    max_memory_restart: '500M',
    restart_delay: 5000,
    max_restarts: 10,
    min_uptime: '10s',
    watch: false,
    ignore_watch: [
      'node_modules',
      'logs',
      'database'
    ],
    // Cron restart (daily at 2 AM)
    cron_restart: '0 2 * * *',
    // Graceful shutdown
    kill_timeout: 5000,
    // Auto restart on crash
    autorestart: true,
    // PM2 monitoring
    pmx: true,
    // Instance variables
    instance_var: 'INSTANCE_ID'
  }]
};