'use strict';

// PM2: pm2 start ecosystem.config.js (first time), pm2 restart axora-subscriptions
// Settings come from .env in this folder (loaded by src/server.js); PORT
// defaults to 3060.
module.exports = {
  apps: [
    {
      name: 'axora-subscriptions',
      script: 'src/server.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      // Don't loop forever on a configuration error; see `pm2 logs`.
      max_restarts: 10,
      min_uptime: '10s',
      env: { NODE_ENV: 'production' },
    },
  ],
};
