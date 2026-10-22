// PM2: the whole site, its admin API and the Lead Getter licence API run in
// this one process. (.cjs because the project uses ES modules, which PM2
// can't load as its config.)
//   npm run build && pm2 start ecosystem.config.cjs    (first time)
//   npm run build && pm2 restart axora-subscriptions   (updates)
// Settings come from .env in this folder (read by Next.js).

module.exports = {
  apps: [
    {
      name: 'axora-subscriptions',
      cwd: __dirname,
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3060',
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
