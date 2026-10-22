// One-time import of an earlier standalone licence server's SQLite data.

import { skip, TEST_PRIVATE_KEY_B64, dropAll, png } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '../lib/prisma.js';
import { Users } from '../lib/users.js';
import { importLicenceSqlite } from '../lib/licence/import-sqlite.js';
import { setup } from '../prisma/setup.js';

// The licence server's SQLite schema (lead-getter server/src/store.js).
const ORIGINAL_SCHEMA = `
CREATE TABLE devices (id TEXT PRIMARY KEY, public_key TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
CREATE TABLE applications (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, device_id TEXT NOT NULL REFERENCES devices(id), plan TEXT NOT NULL, message TEXT NOT NULL DEFAULT '', email TEXT, email_verified INTEGER NOT NULL DEFAULT 0, screenshot_path TEXT, screenshot_type TEXT NOT NULL, screenshot_size INTEGER NOT NULL, screenshot_sha256 TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'cancelled')), created_at TEXT NOT NULL, decided_at TEXT);
CREATE TABLE action_tokens (hash TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE, action TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);
CREATE TABLE licenses (device_id TEXT PRIMARY KEY REFERENCES devices(id), plan TEXT NOT NULL, application_id TEXT NOT NULL REFERENCES applications(id), activated_at TEXT NOT NULL, expires_at TEXT);
CREATE TABLE trials (machine_id TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
CREATE TABLE seen_requests (sig_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);`;

test('import of an earlier licence server: once, adding only', { skip }, async (t) => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-data-'));
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-up-'));
  t.after(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(uploadDir, { recursive: true, force: true });
    await dropAll(prisma);
    await prisma.$disconnect();
  });
  await dropAll(prisma);
  process.env.LICENSE_PRIVATE_KEY = TEST_PRIVATE_KEY_B64;
  await setup({ log: () => {} });
  delete process.env.LICENSE_PRIVATE_KEY;

  const future = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const db = new DatabaseSync(path.join(dir, 'subscriptions.db'));
  db.exec(ORIGINAL_SCHEMA);
  const now = '2026-10-21T10:10:03.076Z';
  db.prepare('INSERT INTO devices VALUES (?, ?, ?, ?)').run('Dev_Paid-000000000000000000000001', 'PK1', now, now);
  db.prepare('INSERT INTO devices VALUES (?, ?, ?, ?)').run('Dev_Pending-0000000000000000000002', 'PK2', now, now);
  const app = db.prepare("INSERT INTO applications (id, device_id, plan, message, email, screenshot_path, screenshot_type, screenshot_size, screenshot_sha256, status, created_at, decided_at) VALUES (?, ?, 'monthly', 'Paid', ?, ?, 'image/png', 72, ?, ?, ?, ?)");
  app.run('LF-AAAAAAAAAA', 'Dev_Paid-000000000000000000000001', null, 'applications/LF-AAAAAAAAAA/0123456789abcdef.png', 'a'.repeat(64), 'approved', now, now);
  app.run('LF-BBBBBBBBBB', 'Dev_Paid-000000000000000000000001', 'paid@example.com', null, 'b'.repeat(64), 'pending', '2026-10-21T12:00:00.000Z', null);
  app.run('LF-CCCCCCCCCC', 'Dev_Pending-0000000000000000000002', 'pending@example.com', 'applications/LF-CCCCCCCCCC/fedcba9876543210.png', 'c'.repeat(64), 'pending', now, null);
  db.prepare("INSERT INTO action_tokens VALUES (?, 'LF-CCCCCCCCCC', 'approve', ?, ?, NULL)").run('d'.repeat(64), now, future);
  db.prepare("INSERT INTO licenses VALUES ('Dev_Paid-000000000000000000000001', 'monthly', 'LF-AAAAAAAAAA', ?, ?)").run(now, future);
  db.prepare('INSERT INTO trials VALUES (?, 3, ?)').run('e'.repeat(64), now);
  db.close();
  for (const p of ['applications/LF-AAAAAAAAAA/0123456789abcdef.png', 'applications/LF-CCCCCCCCCC/fedcba9876543210.png']) {
    fs.mkdirSync(path.dirname(path.join(dir, 'uploads', p)), { recursive: true });
    fs.writeFileSync(path.join(dir, 'uploads', p), png);
  }

  const users = new Users(prisma);
  const logs = [];
  const run = () => importLicenceSqlite({ prisma, users, uploadDir, env: { LEAD_GETTER_DATA_DIR: dir }, log: (m) => logs.push(m) });
  const r = await run();
  assert.deepEqual(r.counts, { devices: 2, applications: 3, tokens: 1, trials: 1, screenshots: 2, subscriptions: 1 });
  const paid = await users.get('Dev_Paid-000000000000000000000001');
  assert.deepEqual([paid.email, paid.subscription.effectiveStatus, paid.subscription.expiresAt], ['paid@example.com', 'active', future], 'the paid licence is kept, with its expiry');
  assert.equal(await users.get('Dev_Pending-0000000000000000000002'), null, 'pending applicants stay unregistered until they check in');
  assert.equal((await prisma.licenceApplication.findUnique({ where: { id: 'LF-CCCCCCCCCC' } })).status, 'pending');
  assert.equal((await prisma.licenceTrial.findUnique({ where: { machineId: 'e'.repeat(64) } })).used, 3);
  assert.ok(fs.readFileSync(path.join(uploadDir, 'applications/LF-CCCCCCCCCC/fedcba9876543210.png')).equals(png));

  // Once only: a user deleted afterwards is not brought back.
  await users.remove('Dev_Paid-000000000000000000000001');
  assert.deepEqual(await run(), { skipped: 'already imported', file: path.join(dir, 'subscriptions.db') });
  assert.equal(await users.get('Dev_Paid-000000000000000000000001'), null);
  assert.equal(await prisma.licenceApplication.count(), 3);
});
