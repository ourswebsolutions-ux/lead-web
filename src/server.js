'use strict';

const { PrismaClient } = require('@prisma/client');
const { loadEnvFile } = require('./env');
const { loadConfig } = require('./config');
const { Users } = require('./users');
const { createApp } = require('./app');
const { migrate, redact } = require('../scripts/migrate');

async function main() {
  loadEnvFile();
  const config = loadConfig();
  if (config.migrateOnStart) await migrate({ databaseUrl: config.databaseUrl });
  const prisma = new PrismaClient({ datasourceUrl: config.databaseUrl });
  await prisma.$connect();
  const app = createApp({ config, users: new Users(prisma) });
  const server = app.listen(config.port, config.host, () => {
    console.log(`Axora subscriptions on http://${config.host}:${config.port} (public ${config.publicOrigin})`);
  });
  const stop = () => server.close(() => prisma.$disconnect().finally(() => process.exit(0)));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err) => {
  const code = err.code || err.errorCode;
  console.error(`Startup failed: ${code ? `${code} ` : ''}${redact(String(err.message).trim(), process.env.DATABASE_URL)}`);
  process.exit(1);
});
