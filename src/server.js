'use strict';

// The database schema is managed with `npx prisma db push`; startup only
// connects to the database and never changes its schema.

const { PrismaClient } = require('@prisma/client');
const { loadEnvFile } = require('./env');
const { loadConfig, redact } = require('./config');
const { Users } = require('./users');
const { createApp } = require('./app');

async function main() {
  loadEnvFile();
  const config = loadConfig();
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
  console.error(`Startup failed: ${code ? `${code} ` : ''}${redact(String(err.message).trim())}`);
  process.exit(1);
});
