'use strict';

// npm run migrate — applies pending Prisma migrations (prisma migrate deploy).
// Safe to run repeatedly; never drops or resets data.
//
// Databases created by the earlier version of this app (tables made by
// migrations/001_create_users_and_subscriptions.sql, tracked in
// schema_migrations) already have exactly the init migration's tables. They
// are baselined first: the init migration is marked as applied without
// running it, so existing users and subscriptions are kept as they are.

const { execFileSync } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');
const { loadEnvFile } = require('../src/env');

const PRISMA_CLI = require.resolve('prisma/build/index.js');
const INIT_MIGRATION = '20261021000000_init';
const LEGACY_MIGRATION = '001_create_users_and_subscriptions.sql';

// Removes the database password from text before it is logged: as written
// in DATABASE_URL (percent-encoded), decoded, and in canonical encoding.
function redact(text, databaseUrl) {
  const secrets = new Set();
  try {
    const raw = new URL(databaseUrl).password;
    secrets.add(raw);
    secrets.add(decodeURIComponent(raw));
    secrets.add(encodeURIComponent(decodeURIComponent(raw)));
  } catch {}
  let out = String(text);
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(secret).join('***');
  return out;
}

function prismaCli(args, databaseUrl) {
  try {
    return execFileSync(process.execPath, [PRISMA_CLI, ...args], {
      env: { ...process.env, DATABASE_URL: databaseUrl, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw new Error(redact(`prisma ${args.slice(0, 2).join(' ')} failed: ${(err.stderr || err.stdout || err.message).trim()}`, databaseUrl));
  }
}

async function tables(databaseUrl) {
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const rows = await prisma.$queryRaw`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()`;
    const names = new Set(rows.map((r) => r.name));
    const legacy = names.has('schema_migrations') ? (await prisma.$queryRaw`SELECT version FROM schema_migrations`).map((r) => r.version) : [];
    return { names, legacy };
  } finally {
    await prisma.$disconnect();
  }
}

async function migrate({ databaseUrl = process.env.DATABASE_URL, log = console.log } = {}) {
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  const { names, legacy } = await tables(databaseUrl);
  if (!names.has('_prisma_migrations') && names.has('users')) {
    const isLegacy = names.has('subscriptions') && legacy.length === 1 && legacy[0] === LEGACY_MIGRATION;
    if (!isLegacy) throw new Error('The database already has a users table that was not created by this app. Nothing was changed; check the database before migrating.');
    prismaCli(['migrate', 'resolve', '--applied', INIT_MIGRATION], databaseUrl);
    log(`[migrate] existing tables baselined as ${INIT_MIGRATION} (no data changed)`);
  }
  const out = prismaCli(['migrate', 'deploy'], databaseUrl);
  const applied = [...out.matchAll(/^Applying migration `([^`]+)`/gm)].map((m) => m[1]);
  for (const name of applied) log(`[migrate] applied ${name}`);
  return applied;
}

module.exports = { migrate, redact };

if (require.main === module) {
  loadEnvFile();
  migrate()
    .then((applied) => console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database is up to date.'))
    .catch((err) => {
      console.error(`Migration failed: ${redact(String(err.message), process.env.DATABASE_URL)}`);
      process.exit(1);
    });
}
