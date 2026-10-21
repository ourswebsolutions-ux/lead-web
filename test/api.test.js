'use strict';

// Runs against a real MySQL/MariaDB database. ALL TABLES IN IT ARE DROPPED,
// so never point it at the production database:
//   TEST_DATABASE_URL=mysql://user:pass@127.0.0.1:3306/axora_subs_test npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');
const { loadConfig, redact } = require('../src/config');
const { Users } = require('../src/users');
const { createApp } = require('../src/app');
const { seed } = require('../prisma/seed');

const DB_URL = process.env.TEST_DATABASE_URL;
const ADMIN = { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'correct-horse-battery', ADMIN_API_TOKEN: 't'.repeat(40) };
const BASIC = `Basic ${Buffer.from('admin:correct-horse-battery').toString('base64')}`;
const BEARER = `Bearer ${'t'.repeat(40)}`;
const DEVICE_ID = 'Ab3_-xY9Ab3_-xY9Ab3_-xY9Ab3_-xY9'; // Lead Getter-style device ID
const ROOT = path.join(__dirname, '..');

async function dropAll(prisma) {
  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
  await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS subscriptions, users, schema_migrations, _prisma_migrations');
  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
}

// The deployment flow: `prisma db push`, then prisma/case-sensitive-ids.sql.
async function createSchema(prisma) {
  await dropAll(prisma);
  execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: DB_URL, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    stdio: 'ignore',
  });
  const sql = fs.readFileSync(path.join(ROOT, 'prisma', 'case-sensitive-ids.sql'), 'utf8');
  const statements = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(/;\s*(?:\n|$)/).map((x) => x.trim()).filter(Boolean);
  for (const statement of statements) await prisma.$executeRawUnsafe(statement);
}

test('config: DATABASE_URL is required and checked, port defaults to 3060', () => {
  assert.equal(loadConfig({ ...ADMIN, DATABASE_URL: 'mysql://u:p@h/d' }).port, 3060);
  const a = loadConfig({ ...ADMIN, DATABASE_URL: 'mysql://u%40x:p%3Ass@db.example.com:3307/subs' });
  assert.equal(a.databaseUrl, 'mysql://u%40x:p%3Ass@db.example.com:3307/subs');
  assert.throws(() => loadConfig({ ...ADMIN }), /Missing environment variable: DATABASE_URL/);
  assert.throws(() => loadConfig({ ...ADMIN, DB_HOST: 'h', DB_USER: 'u', DB_NAME: 'n' }), /DATABASE_URL/, 'DB_* alone is no longer used');
  assert.throws(() => loadConfig({ ...ADMIN, DATABASE_URL: 'postgres://u:p@h/d' }), /must start with mysql:\/\//);
  assert.throws(() => loadConfig({ ...ADMIN, DATABASE_URL: 'mysql://u:p@h:3306' }), /database name/);
  assert.throws(() => loadConfig({ ...ADMIN, DATABASE_URL: 'mysql://u:secret@h:99999999/d' }), (e) => /not a valid URL/.test(e.message) && !e.message.includes('secret'));
  assert.throws(() => loadConfig({ ...ADMIN, ADMIN_PASSWORD: 'short', DATABASE_URL: 'mysql://u:p@h/d' }), /at least 12/);
  assert.throws(() => loadConfig({ DATABASE_URL: 'mysql://u:p@h/d' }), /ADMIN_USERNAME, ADMIN_PASSWORD/);
});

test('redact hides the database password, plain and URL-encoded', () => {
  const url = 'mysql://u:p%40ss%21w0rd@h:3306/d';
  assert.equal(redact('failed for p@ss!w0rd and p%40ss%21w0rd', url), 'failed for *** and ***');
});

test('seed creates the initial user once, never a duplicate', { skip: !DB_URL && 'set TEST_DATABASE_URL to run' }, async () => {
  const prisma = new PrismaClient({ datasourceUrl: DB_URL });
  const logs = [];
  const log = (m) => logs.push(m);
  try {
    await createSchema(prisma);
    assert.deepEqual(await seed({ prisma, id: '', email: '', log }), { created: false }, 'nothing configured: no-op');
    await assert.rejects(seed({ prisma, id: 'a b', email: 'x@example.com', log }), /SEED_USER_ID/);
    await assert.rejects(seed({ prisma, id: 'seed-user', email: 'nope', log }), /SEED_USER_EMAIL/);
    assert.deepEqual(await seed({ prisma, id: 'seed-user', email: ' Owner@Example.com ', log }), { created: true });
    const user = await prisma.user.findUnique({ where: { id: 'seed-user' }, include: { subscription: true } });
    assert.equal(user.email, 'owner@example.com');
    assert.equal(user.subscription.status, 'inactive');
    // Re-running, or the same email under another ID, creates nothing.
    assert.deepEqual(await seed({ prisma, id: 'seed-user', email: 'owner@example.com', log }), { created: false });
    assert.deepEqual(await seed({ prisma, id: 'other-id', email: 'OWNER@example.com', log }), { created: false });
    // Existing data is left untouched.
    await prisma.subscription.update({ where: { userId: 'seed-user' }, data: { status: 'active', expiresAt: null } });
    await seed({ prisma, id: 'seed-user', email: 'owner@example.com', log });
    assert.equal((await prisma.subscription.findUnique({ where: { userId: 'seed-user' } })).status, 'active');
    assert.equal(await prisma.user.count(), 1);
  } finally {
    await dropAll(prisma);
    await prisma.$disconnect();
  }
});

test('seed command runs through prisma db seed, without printing secrets', { skip: !DB_URL && 'set TEST_DATABASE_URL to run' }, async () => {
  const prisma = new PrismaClient({ datasourceUrl: DB_URL });
  try {
    await createSchema(prisma);
    const run = () =>
      execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'seed'], {
        cwd: ROOT,
        env: { ...process.env, DATABASE_URL: DB_URL, SEED_USER_ID: 'cli-seed', SEED_USER_EMAIL: 'cli@example.com', PRISMA_HIDE_UPDATE_MESSAGE: '1' },
        encoding: 'utf8',
      });
    assert.match(run(), /created user cli-seed/);
    assert.match(run(), /already exists; nothing created/);
    assert.equal(await prisma.user.count(), 1);
    const password = new URL(DB_URL).password;
    if (password) assert.ok(!run().includes(password));
  } finally {
    await dropAll(prisma);
    await prisma.$disconnect();
  }
});

test('API against MySQL', { skip: !DB_URL && 'set TEST_DATABASE_URL to run' }, async (t) => {
  const config = loadConfig({ ...ADMIN, DATABASE_URL: DB_URL, PUBLIC_ORIGIN: 'https://subscription.axorawebsolutions.com' });
  const prisma = new PrismaClient({ datasourceUrl: DB_URL });
  await createSchema(prisma);

  let clock = new Date('2026-10-21T12:00:00Z');
  const errors = [];
  const app = createApp({ config, users: new Users(prisma, { now: () => clock }), now: () => clock, logger: { error: (m) => errors.push(m) } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  async function call(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { authorization: BASIC, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: res.status, data, headers: res.headers };
  }

  await t.test('authorization is required for the page and every API', async () => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 401);
    assert.match(page.headers.get('www-authenticate'), /^Basic/);
    for (const [m, p] of [['GET', '/api/v1/users'], ['POST', '/api/v1/users'], ['DELETE', '/api/v1/users/abc'], ['PATCH', '/api/v1/users/abc/subscription']]) {
      const r = await fetch(base + p, { method: m });
      assert.equal(r.status, 401, `${m} ${p}`);
      assert.equal(r.headers.get('www-authenticate'), null, 'API does not trigger browser prompt');
      assert.equal((await r.json()).error.code, 'unauthorized');
    }
    const wrong = await call('GET', '/api/v1/users', undefined, { authorization: `Basic ${Buffer.from('admin:nope').toString('base64')}` });
    assert.equal(wrong.status, 401);
    const badToken = await call('GET', '/api/v1/users', undefined, { authorization: 'Bearer nope' });
    assert.equal(badToken.status, 401);
    assert.equal((await call('GET', '/api/v1/users', undefined, { authorization: BEARER })).status, 200);
  });

  await t.test('page is served with no secrets and a strict CSP', async () => {
    const r = await call('GET', '/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
    const js = await call('GET', '/app.js');
    assert.equal(js.status, 200);
    for (const secret of [ADMIN.ADMIN_PASSWORD, ADMIN.ADMIN_API_TOKEN, 'testpass']) {
      assert.ok(!r.data.includes(secret) && !js.data.includes(secret));
    }
  });

  await t.test('add users', async () => {
    const r = await call('POST', '/api/v1/users', { id: DEVICE_ID, email: '  Alice@Example.com ' });
    assert.equal(r.status, 201);
    assert.equal(r.data.user.id, DEVICE_ID);
    assert.equal(r.data.user.email, 'alice@example.com');
    assert.deepEqual(
      { status: r.data.user.subscription.status, effective: r.data.user.subscription.effectiveStatus, exp: r.data.user.subscription.expiresAt },
      { status: 'inactive', effective: 'inactive', exp: null },
    );
    assert.equal((await call('POST', '/api/v1/users', { id: 'user-2', email: 'bob@example.com' })).status, 201);
    // IDs are case-sensitive (device IDs are base64url).
    assert.equal((await call('POST', '/api/v1/users', { id: DEVICE_ID.toLowerCase(), email: 'carol@example.com' })).status, 201);
  });

  await t.test('add user validation and duplicates', async () => {
    let r = await call('POST', '/api/v1/users', { id: DEVICE_ID, email: 'other@example.com' });
    assert.equal(r.status, 409);
    assert.equal(r.data.error.code, 'user_exists');
    r = await call('POST', '/api/v1/users', { id: 'new-id', email: 'ALICE@example.com' });
    assert.equal(r.status, 409);
    assert.equal(r.data.error.code, 'email_exists');
    r = await call('POST', '/api/v1/users', { id: 'a b', email: 'x' });
    assert.equal(r.status, 400);
    assert.equal(r.data.error.code, 'validation_failed');
    assert.ok(r.data.error.fields.id && r.data.error.fields.email);
    r = await call('POST', '/api/v1/users', '{bad json');
    assert.equal(r.status, 400);
    assert.equal(r.data.error.code, 'invalid_json');
    r = await call('POST', '/api/v1/users', [1]);
    assert.equal(r.data.error.code, 'invalid_body');
    r = await call('POST', '/api/v1/users', { id: 'x'.repeat(10), email: `${'a'.repeat(20000)}@x.com` });
    assert.equal(r.status, 413);
  });

  await t.test('list and search', async () => {
    let r = await call('GET', '/api/v1/users');
    assert.equal(r.status, 200);
    assert.equal(r.data.count, 3);
    r = await call('GET', '/api/v1/users?search=bob@');
    assert.deepEqual(r.data.users.map((u) => u.id), ['user-2']);
    r = await call('GET', `/api/v1/users?search=${encodeURIComponent(DEVICE_ID)}`);
    assert.deepEqual(r.data.users.map((u) => u.id), [DEVICE_ID], 'exact ID, case-sensitive');
    r = await call('GET', '/api/v1/users?search=user-');
    assert.deepEqual(r.data.users.map((u) => u.id), ['user-2'], 'ID prefix');
    r = await call('GET', '/api/v1/users?search=EXAMPLE.COM');
    assert.equal(r.data.count, 3, 'email search is case-insensitive');
    r = await call('GET', '/api/v1/users?search=%25');
    assert.equal(r.data.count, 0, 'LIKE wildcards are escaped');
    r = await call('GET', '/api/v1/users?search=user_2');
    assert.equal(r.data.count, 0, '"_" is not a wildcard (device IDs contain it)');
  });

  await t.test('activate with expiry', async () => {
    const r = await call('PATCH', `/api/v1/users/${DEVICE_ID}/subscription`, { status: 'active', expiresAt: '2026-12-21T23:59:59Z' });
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 'active');
    assert.equal(r.data.user.id, DEVICE_ID);
    assert.equal(r.data.user.subscription.status, 'active');
    assert.equal(r.data.user.subscription.expiresAt, '2026-12-21T23:59:59.000Z');
    assert.ok(r.data.user.subscription.activatedAt);
    assert.equal(r.data.user.subscription.suspendedAt, null);
  });

  await t.test('suspend immediately, idempotently, keeping the expiry on record', async () => {
    let r = await call('PATCH', `/api/v1/users/${DEVICE_ID}/subscription`, { status: 'suspended' });
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 'suspended');
    assert.equal(r.data.user.subscription.status, 'suspended');
    assert.equal(r.data.user.subscription.expiresAt, '2026-12-21T23:59:59.000Z');
    const first = r.data.user.subscription.suspendedAt;
    assert.ok(first);
    const [row] = await prisma.$queryRaw`SELECT status FROM subscriptions WHERE user_id = ${DEVICE_ID}`;
    assert.equal(row.status, 'suspended', 'persisted in MySQL');
    r = await call('PATCH', `/api/v1/users/${DEVICE_ID}/subscription`, { status: 'suspended' });
    assert.equal(r.data.user.subscription.suspendedAt, first);
  });

  await t.test('re-activate (also with no expiry), and expiry is reported', async () => {
    let r = await call('PATCH', `/api/v1/users/${DEVICE_ID}/subscription`, { status: 'active', expiresAt: null });
    assert.equal(r.data.user.subscription.expiresAt, null);
    assert.equal(r.data.user.subscription.suspendedAt, null);
    assert.equal(r.data.status, 'active');
    r = await call('PATCH', '/api/v1/users/user-2/subscription', { status: 'active', expiresAt: '2026-10-22T00:00:00+05:00' });
    assert.equal(r.data.user.subscription.expiresAt, '2026-10-21T19:00:00.000Z', 'timezone offsets normalised to UTC');
    clock = new Date('2026-10-21T19:00:01Z');
    r = await call('GET', '/api/v1/users?search=user-2');
    assert.equal(r.data.users[0].subscription.status, 'active');
    assert.equal(r.data.users[0].subscription.effectiveStatus, 'expired');
    clock = new Date('2026-10-21T12:00:00Z');
  });

  await t.test('subscription validation', async () => {
    const cases = [
      [{ status: 'active' }, 400, 'expiry_required'],
      [{ status: 'active', expiresAt: '2026-12-21' }, 400, 'invalid_expiry'],
      [{ status: 'active', expiresAt: 'tomorrow' }, 400, 'invalid_expiry'],
      [{ status: 'active', expiresAt: 1798070399000 }, 400, 'invalid_expiry'],
      [{ status: 'active', expiresAt: '2020-01-01T00:00:00Z' }, 400, 'expiry_in_past'],
      [{ status: 'suspended', expiresAt: '2027-01-01T00:00:00Z' }, 400, 'unexpected_expiry'],
      [{ status: 'paused' }, 400, 'invalid_status'],
      [{}, 400, 'invalid_status'],
      [{ id: 'someone-else', status: 'suspended' }, 400, 'user_id_mismatch'],
    ];
    for (const [body, status, code] of cases) {
      const r = await call('PATCH', '/api/v1/users/user-2/subscription', body);
      assert.equal(r.status, status, JSON.stringify(body));
      assert.equal(r.data.error.code, code, JSON.stringify(body));
    }
    let r = await call('PATCH', '/api/v1/users/nobody/subscription', { status: 'suspended' });
    assert.equal(r.status, 404);
    assert.equal(r.data.error.code, 'user_not_found');
    r = await call('PATCH', '/api/v1/users/a%20b/subscription', { status: 'suspended' });
    assert.equal(r.data.error.code, 'invalid_user_id');
  });

  await t.test('cross-site browser requests are refused (CSRF)', async () => {
    let r = await call('PATCH', '/api/v1/users/user-2/subscription', { status: 'suspended' }, { origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    assert.equal(r.data.error.code, 'forbidden_origin');
    r = await call('DELETE', '/api/v1/users/user-2', undefined, { 'sec-fetch-site': 'cross-site' });
    assert.equal(r.status, 403);
    r = await call('PATCH', '/api/v1/users/user-2/subscription', { status: 'suspended' }, { origin: 'https://subscription.axorawebsolutions.com' });
    assert.equal(r.status, 200);
    // Bearer tokens are not sent automatically by browsers, so no origin check.
    r = await call('PATCH', '/api/v1/users/user-2/subscription', { status: 'suspended' }, { authorization: BEARER, origin: 'https://tool.example' });
    assert.equal(r.status, 200);
  });

  await t.test('delete removes the user and their subscription', async () => {
    let r = await call('DELETE', `/api/v1/users/${DEVICE_ID}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, { deleted: true, id: DEVICE_ID });
    assert.equal(await prisma.subscription.count({ where: { userId: DEVICE_ID } }), 0, 'subscription row cascaded');
    r = await call('DELETE', `/api/v1/users/${DEVICE_ID}`);
    assert.equal(r.status, 404);
    r = await call('GET', '/api/v1/users');
    assert.equal(r.data.count, 2);
  });

  await t.test('unknown routes', async () => {
    assert.equal((await call('GET', '/api/v1/nope')).data.error.code, 'not_found');
    assert.equal((await call('GET', '/api/license')).status, 404);
    assert.equal((await call('PUT', '/api/v1/users/user-2')).status, 404);
  });

  await t.test('failed sign-ins are rate limited per IP', async () => {
    const bad = `Basic ${Buffer.from('admin:wrong').toString('base64')}`;
    for (let i = 0; i < 10; i++) await call('GET', '/api/v1/users', undefined, { authorization: bad });
    const r = await call('GET', '/api/v1/users');
    assert.equal(r.status, 429);
  });

  assert.deepEqual(errors, []);
});

test('database outage returns 503 without leaking details', async () => {
  const config = loadConfig({ ...ADMIN, DATABASE_URL: 'mysql://u:secretpw@127.0.0.1:1/db' });
  const prisma = new PrismaClient({ datasourceUrl: config.databaseUrl });
  const logs = [];
  const server = createApp({ config, users: new Users(prisma), logger: { error: (m) => logs.push(m) } }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/users`, { headers: { authorization: BASIC } });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error.code, 'database_unavailable');
    assert.ok(!JSON.stringify(body).includes('secretpw') && !logs.join().includes('secretpw'));
  } finally {
    server.close();
    await prisma.$disconnect();
  }
});
