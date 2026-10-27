// npm run setup — prepares the database. Run by `npm run dev` and
// `npm run build`; safe to run any number of times.
//
//   1. Creates missing tables/indexes from prisma/schema.prisma. Only
//      additive changes are applied: if Prisma's plan would drop, rename or
//      change anything that exists, nothing is changed and setup stops.
//   2. Makes the user/device ID columns case-sensitive (ascii_bin), which
//      Prisma can't express: a collation change only, no rows touched.
//   3. Verifies the licence signing key (lib/licence/keys.js) and stores it
//      in the database on first run. A missing key is reported, not fatal.
//   4. Imports an earlier standalone licence server's data once, if found
//      (lib/licence/import-sqlite.js).
//
// Never resets, drops or deletes data.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { PrismaClient } from '@prisma/client';
import { redact, checkDatabaseUrl } from '../lib/config.js';
import { licenceSettings } from '../lib/licence/settings.js';
import { loadSigningKey, SigningKeyUnavailable } from '../lib/licence/keys.js';
import { importLicenceSqlite } from '../lib/licence/import-sqlite.js';
import { Users } from '../lib/users.js';

const require = createRequire(import.meta.url);
const PRISMA_CLI = require.resolve('prisma/build/index.js');

// Statements that only add (table, column, index, foreign key).
const ADDITIVE = [/^CREATE TABLE `[^`]+` \(/i, /^CREATE (UNIQUE )?INDEX `[^`]+` ON `[^`]+`/i, /^ALTER TABLE `[^`]+` ADD (CONSTRAINT|COLUMN|INDEX|UNIQUE INDEX|PRIMARY KEY|FOREIGN KEY|`)/i];

// [table, column, referencing table, column, foreign key, ON DELETE]
const ID_COLUMNS = [
  ['users', 'id', 'subscriptions', 'user_id', 'subscriptions_user_fk', 'CASCADE'],
  ['licence_devices', 'id', 'licence_applications', 'device_id', 'licence_applications_device_fk', 'RESTRICT'],
];

// Device-ID columns without a foreign key: [table, column, definition].
const PLAIN_ID_COLUMNS = [
  ['licence_activations', 'device_id', 'VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL'],
  ['licence_activations', 'open_for', 'VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL'],
  ['licence_credit_usage', 'account', 'VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL'],
  ['licence_credit_leads', 'account', 'VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL'],
  ['licence_credit_leads', 'device_id', 'VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL'],
];

function prisma(args, input) {
  try {
    return execFileSync(process.execPath, [PRISMA_CLI, ...args], { env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' }, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    throw new Error(redact(`prisma ${args.slice(0, 2).join(' ')} failed: ${(err.stderr || err.stdout || err.message).trim()}`));
  }
}

function statements(sql) {
  return sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}

async function createMissingTables(log) {
  const sql = prisma(['migrate', 'diff', '--from-url', process.env.DATABASE_URL, '--to-schema-datamodel', 'prisma/schema.prisma', '--script']);
  const todo = statements(sql);
  if (!todo.length) return log('[setup] database tables are up to date');
  const unsafe = todo.filter((s) => !ADDITIVE.some((re) => re.test(s)));
  if (unsafe.length) {
    throw new Error(`The database differs from prisma/schema.prisma in a way that is not just additions, so nothing was changed:\n  ${unsafe.join(';\n  ')}\nReview it, then apply it yourself (npx prisma db push) if it is intended.`);
  }
  prisma(['db', 'execute', '--stdin', '--url', process.env.DATABASE_URL], `${todo.join(';\n')};\n`);
  log(`[setup] created ${todo.filter((s) => /^CREATE TABLE/i.test(s)).length} table(s) and ${todo.filter((s) => !/^CREATE TABLE/i.test(s)).length} index/key change(s)`);
}

async function caseSensitiveIds(db, log) {
  for (const [table, col, refTable, refCol, fk, onDelete] of ID_COLUMNS) {
    const cols = await db.$queryRaw`SELECT table_name AS t, column_name AS c, collation_name AS coll FROM information_schema.columns WHERE table_schema = DATABASE() AND ((table_name = ${table} AND column_name = ${col}) OR (table_name = ${refTable} AND column_name = ${refCol}))`;
    if (cols.length !== 2 || cols.every((r) => r.coll === 'ascii_bin')) continue;
    const fks = await db.$queryRaw`SELECT constraint_name AS n FROM information_schema.referential_constraints WHERE constraint_schema = DATABASE() AND table_name = ${refTable} AND constraint_name = ${fk}`;
    // MySQL/MariaDB won't change a column used by a foreign key, so the key
    // is dropped and recreated identically around the change.
    if (fks.length) await db.$executeRawUnsafe(`ALTER TABLE \`${refTable}\` DROP FOREIGN KEY \`${fk}\``);
    await db.$executeRawUnsafe(`ALTER TABLE \`${table}\` MODIFY \`${col}\` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL`);
    await db.$executeRawUnsafe(`ALTER TABLE \`${refTable}\` MODIFY \`${refCol}\` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL`);
    await db.$executeRawUnsafe(`ALTER TABLE \`${refTable}\` ADD CONSTRAINT \`${fk}\` FOREIGN KEY (\`${refCol}\`) REFERENCES \`${table}\` (\`${col}\`) ON DELETE ${onDelete} ON UPDATE RESTRICT`);
    log(`[setup] ${table}.${col} and ${refTable}.${refCol} are now case-sensitive (no rows changed)`);
  }
  for (const [table, col, definition] of PLAIN_ID_COLUMNS) {
    const [row] = await db.$queryRaw`SELECT collation_name AS coll FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ${table} AND column_name = ${col}`;
    if (!row || row.coll === 'ascii_bin') continue;
    await db.$executeRawUnsafe(`ALTER TABLE \`${table}\` MODIFY \`${col}\` ${definition}`);
    log(`[setup] ${table}.${col} is now case-sensitive (no rows changed)`);
  }
}

async function signingKey(db, log) {
  try {
    const k = await loadSigningKey({ prisma: db, settings: licenceSettings(), log });
    log(`[setup] licence signing key ready (${k.source === 'database' ? 'stored in the database' : k.source}; matches installed Lead Finder apps)`);
  } catch (err) {
    if (!(err instanceof SigningKeyUnavailable)) throw err;
    log(`[setup] WARNING: ${err.message} Desktop status checks will answer 503 until LICENSE_PRIVATE_KEY (the existing key) is available once.`);
  }
}

export async function setup({ log = console.log } = {}) {
  checkDatabaseUrl(process.env.DATABASE_URL);
  await createMissingTables(log);
  const db = new PrismaClient();
  try {
    await caseSensitiveIds(db, log);
    await signingKey(db, log);
    await importLicenceSqlite({ prisma: db, users: new Users(db), uploadDir: path.resolve(process.env.UPLOAD_DIR || 'data/uploads'), log });
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (fs.existsSync('.env')) process.loadEnvFile('.env');
  setup().catch((err) => {
    console.error(`[setup] failed: ${redact(String(err.message))}`);
    process.exit(1);
  });
}
