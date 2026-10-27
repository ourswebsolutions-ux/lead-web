// Database setup (prisma/setup.js) and the licence signing key
// (lib/licence/keys.js): existing data and the installed apps' key are
// never lost or replaced.

import { DB_URL, skip, TEST_PUBLIC_KEY, TEST_PRIVATE_KEY_B64, dropAll } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { prisma } from '../lib/prisma.js';
import { setup } from '../prisma/setup.js';
import { loadSigningKey, SigningKeyUnavailable, INSTALLED_APP_PUBLIC_KEY } from '../lib/licence/keys.js';
import { licenceSettings } from '../lib/licence/settings.js';

const require = createRequire(import.meta.url);
const ROOT = path.join(import.meta.dirname, '..');
const collations = async () => Object.fromEntries((await prisma.$queryRaw`SELECT CONCAT(table_name, '.', column_name) AS c, collation_name AS coll FROM information_schema.columns WHERE table_schema = DATABASE() AND CONCAT(table_name, '.', column_name) IN ('users.id', 'subscriptions.user_id', 'licence_devices.id', 'licence_applications.device_id')`).map((r) => [r.c, r.coll]));

test('setup on a database like production: adds only, keeps every row', { skip }, async (t) => {
  t.after(async () => {
    await dropAll(prisma);
    await prisma.$disconnect();
  });
  await dropAll(prisma);
  // Production today: users/subscriptions created by `prisma db push` from
  // the previous schema (case-insensitive IDs), with data.
  const oldSchema = path.join(os.tmpdir(), `old-schema-${process.pid}.prisma`);
  const current = fs.readFileSync(path.join(ROOT, 'prisma', 'schema.prisma'), 'utf8');
  fs.writeFileSync(oldSchema, current.slice(0, current.indexOf('// --- Lead Getter licence system')));
  execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', oldSchema], { env: { ...process.env, DATABASE_URL: DB_URL, PRISMA_HIDE_UPDATE_MESSAGE: '1' }, stdio: 'ignore' });
  fs.rmSync(oldSchema);
  await prisma.$executeRawUnsafe("INSERT INTO users (id, email, created_at, updated_at) VALUES ('Prod_User-1', 'prod@example.com', NOW(3), NOW(3))");
  await prisma.$executeRawUnsafe("INSERT INTO subscriptions (user_id, status, expires_at, activated_at, updated_at) VALUES ('Prod_User-1', 'active', '2027-01-01 00:00:00', NOW(3), NOW(3))");
  assert.equal((await collations())['users.id'], 'utf8mb4_unicode_ci');

  const logs = [];
  process.env.LICENSE_PRIVATE_KEY = TEST_PRIVATE_KEY_B64;
  await setup({ log: (m) => logs.push(m) });
  // The licence tables, plus activation requests, the daily allowance and
  // the audit log; and subscriptions.plan.
  assert.match(logs.join('\n'), /created 11 table\(s\)/);
  assert.match(logs.join('\n'), /users\.id and subscriptions\.user_id are now case-sensitive/);
  assert.match(logs.join('\n'), /signing key ready/);
  assert.deepEqual(Object.values(await collations()), ['ascii_bin', 'ascii_bin', 'ascii_bin', 'ascii_bin']);
  const user = await prisma.user.findUnique({ where: { id: 'Prod_User-1' }, include: { subscription: true } });
  assert.deepEqual([user.email, user.subscription.status, user.subscription.expiresAt.toISOString(), user.subscription.plan], ['prod@example.com', 'active', '2027-01-01T00:00:00.000Z', null]);
  assert.equal(await prisma.user.count({ where: { id: 'prod_user-1' } }), 0, 'IDs now case-sensitive');
  await assert.rejects(prisma.subscription.create({ data: { userId: 'missing', status: 'active' } }), 'foreign key restored');

  // Running again changes nothing.
  logs.length = 0;
  await setup({ log: (m) => logs.push(m) });
  delete process.env.LICENSE_PRIVATE_KEY;
  assert.match(logs.join('\n'), /tables are up to date/);
  assert.doesNotMatch(logs.join('\n'), /case-sensitive/);
  assert.match(logs.join('\n'), /stored in the database/, 'key reused from the database without LICENSE_PRIVATE_KEY');
  assert.equal(await prisma.user.count(), 1);

  // A change that isn't purely additive is refused and nothing is changed.
  await prisma.$executeRawUnsafe('ALTER TABLE users ADD COLUMN legacy_note VARCHAR(20) NULL');
  await prisma.$executeRawUnsafe("UPDATE users SET legacy_note = 'keep me'");
  await assert.rejects(setup({ log: () => {} }), /not just additions, so nothing was changed[\s\S]*DROP COLUMN `legacy_note`/);
  assert.deepEqual(await prisma.$queryRaw`SELECT legacy_note FROM users`, [{ legacy_note: 'keep me' }]);
});

test('signing key: reused, verified against the installed apps, never generated or replaced', { skip }, async (t) => {
  t.after(async () => {
    await dropAll(prisma);
    await prisma.$disconnect();
  });
  await dropAll(prisma);
  process.env.LICENSE_PRIVATE_KEY = TEST_PRIVATE_KEY_B64;
  await setup({ log: () => {} });
  delete process.env.LICENSE_PRIVATE_KEY;
  await prisma.licenceSigningKey.deleteMany();
  const other = Buffer.from(crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' })).toString('base64');
  const logs = [];
  const log = (m) => logs.push(m);

  await assert.rejects(loadSigningKey({ prisma, settings: { privateKey: null }, log }), (e) => e instanceof SigningKeyUnavailable && /never generated/.test(e.message));
  assert.equal(await prisma.licenceSigningKey.count(), 0, 'nothing generated');
  await assert.rejects(loadSigningKey({ prisma, settings: { privateKey: { base64: other, from: 'environment' } }, log }), /does not match the public key installed apps trust/);
  await assert.rejects(loadSigningKey({ prisma, settings: { privateKey: { base64: 'bm90IGEga2V5', from: 'environment' } }, log }), /not a valid Ed25519 key/);
  assert.equal(await prisma.licenceSigningKey.count(), 0);

  const k = await loadSigningKey({ prisma, settings: { privateKey: { base64: TEST_PRIVATE_KEY_B64, from: '/opt/lead-getter/server/.env' } }, log });
  assert.equal(k.publicKey, TEST_PUBLIC_KEY);
  const row = await prisma.licenceSigningKey.findUnique({ where: { id: 'status' } });
  assert.deepEqual([row.publicKey, row.source], [TEST_PUBLIC_KEY, '/opt/lead-getter/server/.env']);
  // A different key offered later never replaces the stored one.
  const again = await loadSigningKey({ prisma, settings: { privateKey: { base64: other, from: 'environment' } }, log });
  assert.deepEqual([again.publicKey, again.source], [TEST_PUBLIC_KEY, 'database']);
  // A stored key that doesn't match what installed apps trust is refused, and left alone.
  await assert.rejects(loadSigningKey({ prisma, settings: { privateKey: null }, expected: INSTALLED_APP_PUBLIC_KEY, log }), /does not match .* left unchanged/);
  assert.equal((await prisma.licenceSigningKey.findUnique({ where: { id: 'status' } })).publicKey, TEST_PUBLIC_KEY);
  assert.ok(!logs.join().includes(TEST_PRIVATE_KEY_B64), 'the key is never logged');
});

test('settings: an earlier licence server .env is reused, the environment wins', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'LICENSE_PRIVATE_KEY=abc\nSMTP_HOST=smtp.example\nSMTP_PORT=465\nSMTP_USER=u\nSMTP_PASS="p w"\nSMTP_FROM=Lead Finder <x@example.com>\nSUBSCRIPTION_ADMIN_EMAIL=admin@example.com\n');
  try {
    const s = licenceSettings({ LEAD_GETTER_ENV_FILE: file }, dir);
    assert.deepEqual(s.privateKey, { base64: 'abc', from: file });
    assert.deepEqual(s.smtp, { host: 'smtp.example', port: 465, user: 'u', pass: 'p w', from: 'Lead Finder <x@example.com>' });
    assert.equal(s.adminEmail, 'admin@example.com');
    assert.deepEqual(licenceSettings({ LEAD_GETTER_ENV_FILE: file, LICENSE_PRIVATE_KEY: 'env' }, dir).privateKey, { base64: 'env', from: 'environment' });
    assert.equal(licenceSettings({ LEAD_GETTER_ENV_FILE: 'none' }, dir).privateKey, null);
    assert.deepEqual(licenceSettings({ LEAD_GETTER_ENV_FILE: 'none' }, dir).smtpMissing, ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SUBSCRIPTION_ADMIN_EMAIL']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
