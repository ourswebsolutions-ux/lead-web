// Admin API (/api/v1) handlers and the admin login. Same expectations as the
// earlier Express version's tests.

import { skip, TEST_PRIVATE_KEY_B64, device, dropAll, png } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../lib/prisma.js';
import { loadConfig, redact } from '../lib/config.js';
import { createAuth, clientIp } from '../lib/auth.js';
import * as api from '../lib/admin-api.js';
import { setup } from '../prisma/setup.js';

const ADMIN = { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'correct-horse-battery', DATABASE_URL: 'mysql://u:p@h/d' };
const BASIC = `Basic ${Buffer.from('admin:correct-horse-battery').toString('base64')}`;
const DEVICE_ID = 'Ab3_-xY9Ab3_-xY9Ab3_-xY9Ab3_-xY9'; // Lead Getter-style device ID

test('config: required settings and redaction', () => {
  assert.equal(loadConfig(ADMIN).databaseUrl, 'mysql://u:p@h/d');
  assert.throws(() => loadConfig({ ...ADMIN, DATABASE_URL: '' }), /Missing environment variable: DATABASE_URL/);
  assert.throws(() => loadConfig({ ...ADMIN, DATABASE_URL: 'postgres://u:p@h/d' }), /must start with mysql:\/\//);
  assert.throws(() => loadConfig({ ...ADMIN, DATABASE_URL: 'mysql://u:p@h:3306' }), /database name/);
  assert.throws(() => loadConfig({ ...ADMIN, DATABASE_URL: 'mysql://u:secret@h:99999999/d' }), (e) => /not a valid URL/.test(e.message) && !e.message.includes('secret'));
  assert.throws(() => loadConfig({ ...ADMIN, ADMIN_PASSWORD: 'short' }), /at least 12/);
  assert.throws(() => loadConfig({ DATABASE_URL: 'mysql://u:p@h/d' }), /ADMIN_USERNAME, ADMIN_PASSWORD/);
  assert.equal(redact('failed for p@ss!w0rd and p%40ss%21w0rd', 'mysql://u:p%40ss%21w0rd@h:3306/d'), 'failed for *** and ***');
});

test('admin login: Basic auth, CSRF, lockout', async () => {
  const config = { ...loadConfig(ADMIN), publicOrigin: 'https://subscription.axorawebsolutions.com', trustProxy: 1 };
  const auth = createAuth(config);
  const req = (path, init = {}) => new Request(`http://127.0.0.1:3060${path}`, { ...init, headers: { 'x-forwarded-for': '203.0.113.7', ...(init.headers || {}) } });

  let r = auth(req('/'));
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), /^Basic realm="Axora Subscriptions"/);
  r = auth(req('/api/v1/users'));
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('www-authenticate'), null, 'the API never triggers the browser prompt');
  assert.deepEqual(await r.json(), { error: { code: 'unauthorized', message: 'Missing or invalid admin credentials.' } });
  assert.equal(auth(req('/api/v1/users', { headers: { authorization: BASIC } })), null);
  assert.equal(auth(req('/api/v1/users', { headers: { authorization: `Bearer ${'t'.repeat(40)}` } })).status, 401, 'only the admin username and password');

  r = auth(req('/api/v1/users/x/subscription', { method: 'PATCH', headers: { authorization: BASIC, origin: 'https://evil.example' } }));
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error.code, 'forbidden_origin');
  assert.equal(auth(req('/api/v1/users/x', { method: 'DELETE', headers: { authorization: BASIC, 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal(auth(req('/api/v1/users/x', { method: 'DELETE', headers: { authorization: BASIC, origin: 'https://subscription.axorawebsolutions.com' } })), null);

  const bad = `Basic ${Buffer.from('admin:wrong').toString('base64')}`;
  for (let i = 0; i < 10; i++) auth(req('/api/v1/users', { headers: { authorization: bad } }));
  assert.equal(auth(req('/api/v1/users', { headers: { authorization: BASIC } })).status, 429, 'locked out for 15 minutes');
  assert.equal(auth(req('/api/v1/users', { headers: { authorization: BASIC, 'x-forwarded-for': '198.51.100.1' } })), null, 'per client address');
});

test('client address behind proxies', () => {
  const r = (xff) => new Request('http://x/', { headers: xff ? { 'x-forwarded-for': xff } : {} });
  assert.equal(clientIp(r('203.0.113.7'), 0), '203.0.113.7');
  assert.equal(clientIp(r('spoofed, 203.0.113.7'), 0), '203.0.113.7');
  assert.equal(clientIp(r('spoofed, 203.0.113.7, 127.0.0.1'), 1), '203.0.113.7');
  assert.equal(clientIp(r(''), 1), 'unknown');
});

test('admin API against MySQL', { skip }, async (t) => {
  await dropAll(prisma);
  process.env.LICENSE_PRIVATE_KEY = TEST_PRIVATE_KEY_B64;
  await setup({ log: () => {} });
  delete process.env.LICENSE_PRIVATE_KEY;
  t.after(async () => {
    await dropAll(prisma);
    await prisma.$disconnect();
  });

  async function call(handler, method, path, body, params = {}) {
    const res = await handler(new Request(`http://127.0.0.1:3060${path}`, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }), { params: Promise.resolve(params) });
    return { status: res.status, data: await res.json().catch(() => null), headers: res.headers };
  }
  const list = (q = '') => call(api.listUsers, 'GET', `/api/v1/users${q}`);
  const add = (body) => call(api.createUser, 'POST', '/api/v1/users', body);
  const patch = (id, body) => call(api.patchSubscription, 'PATCH', `/api/v1/users/${id}/subscription`, body, { id });
  const del = (id) => call(api.deleteUser, 'DELETE', `/api/v1/users/${id}`, undefined, { id });

  await t.test('add users', async () => {
    const r = await add({ id: DEVICE_ID, email: '  Alice@Example.com ' });
    assert.equal(r.status, 201);
    assert.deepEqual(Object.keys(r.data.user), ['id', 'email', 'createdAt', 'updatedAt', 'subscription']);
    assert.deepEqual(Object.keys(r.data.user.subscription), ['status', 'effectiveStatus', 'expiresAt', 'activatedAt', 'suspendedAt', 'updatedAt']);
    assert.equal(r.data.user.email, 'alice@example.com');
    assert.deepEqual([r.data.user.subscription.status, r.data.user.subscription.effectiveStatus, r.data.user.subscription.expiresAt], ['inactive', 'inactive', null]);
    assert.equal((await add({ id: 'user-2', email: 'bob@example.com' })).status, 201);
    assert.equal((await add({ id: DEVICE_ID.toLowerCase(), email: 'carol@example.com' })).status, 201, 'IDs are case-sensitive');
  });

  await t.test('validation and duplicates', async () => {
    assert.deepEqual((await add({ id: DEVICE_ID, email: 'other@example.com' })).data.error.code, 'user_exists');
    assert.deepEqual((await add({ id: 'new-id', email: 'ALICE@example.com' })).data.error.code, 'email_exists');
    let r = await add({ id: 'a b', email: 'x' });
    assert.equal(r.data.error.code, 'validation_failed');
    assert.ok(r.data.error.fields.id && r.data.error.fields.email);
    r = await add('{bad json');
    assert.deepEqual([r.status, r.data.error.code], [400, 'invalid_json']);
    assert.equal((await add('"string"')).data.error.code, 'invalid_json');
    assert.equal((await add([1])).data.error.code, 'invalid_body');
    assert.equal((await add('')).data.error.code, 'invalid_body');
    r = await add({ id: 'x'.repeat(10), email: `${'a'.repeat(20000)}@x.com` });
    assert.deepEqual([r.status, r.data.error.code], [413, 'body_too_large']);
  });

  await t.test('list and search', async () => {
    assert.equal((await list()).data.count, 3);
    assert.deepEqual((await list('?search=bob@')).data.users.map((u) => u.id), ['user-2']);
    assert.deepEqual((await list(`?search=${encodeURIComponent(DEVICE_ID)}`)).data.users.map((u) => u.id), [DEVICE_ID], 'exact, case-sensitive');
    assert.deepEqual((await list('?search=user-')).data.users.map((u) => u.id), ['user-2']);
    assert.equal((await list('?search=EXAMPLE.COM')).data.count, 3);
    assert.equal((await list('?search=%25')).data.count, 0, 'LIKE wildcards are escaped');
    assert.equal((await list('?search=user_2')).data.count, 0, '"_" is not a wildcard');
  });

  await t.test('activate, suspend, re-activate', async () => {
    let r = await patch(DEVICE_ID, { status: 'active', expiresAt: '2099-12-21T23:59:59Z' });
    assert.deepEqual([r.status, r.data.status, r.data.user.subscription.expiresAt], [200, 'active', '2099-12-21T23:59:59.000Z']);
    r = await patch(DEVICE_ID, { status: 'suspended' });
    assert.deepEqual([r.data.status, r.data.user.subscription.expiresAt], ['suspended', '2099-12-21T23:59:59.000Z']);
    const first = r.data.user.subscription.suspendedAt;
    assert.ok(first);
    assert.equal((await patch(DEVICE_ID, { status: 'suspended' })).data.user.subscription.suspendedAt, first, 'idempotent');
    r = await patch(DEVICE_ID, { status: 'active', expiresAt: null });
    assert.deepEqual([r.data.status, r.data.user.subscription.expiresAt, r.data.user.subscription.suspendedAt], ['active', null, null]);
    r = await patch('user-2', { status: 'active', expiresAt: '2099-10-22T00:00:00+05:00' });
    assert.equal(r.data.user.subscription.expiresAt, '2099-10-21T19:00:00.000Z');
  });

  await t.test('subscription validation', async () => {
    const cases = [
      [{ status: 'active' }, 'expiry_required'],
      [{ status: 'active', expiresAt: '2026-12-21' }, 'invalid_expiry'],
      [{ status: 'active', expiresAt: 1798070399000 }, 'invalid_expiry'],
      [{ status: 'active', expiresAt: '2020-01-01T00:00:00Z' }, 'expiry_in_past'],
      [{ status: 'suspended', expiresAt: '2099-01-01T00:00:00Z' }, 'unexpected_expiry'],
      [{ status: 'paused' }, 'invalid_status'],
      [{}, 'invalid_status'],
      [{ id: 'someone-else', status: 'suspended' }, 'user_id_mismatch'],
    ];
    for (const [body, code] of cases) assert.equal((await patch('user-2', body)).data.error.code, code, JSON.stringify(body));
    assert.deepEqual([(await patch('nobody', { status: 'suspended' })).status, (await patch('nobody', { status: 'suspended' })).data.error.code], [404, 'user_not_found']);
    assert.equal((await patch('a b', { status: 'suspended' })).data.error.code, 'invalid_user_id');
  });

  await t.test('delete removes the user and the subscription', async () => {
    assert.deepEqual((await del(DEVICE_ID)).data, { deleted: true, id: DEVICE_ID });
    assert.equal(await prisma.subscription.count({ where: { userId: DEVICE_ID } }), 0);
    assert.equal((await del(DEVICE_ID)).status, 404);
    assert.equal((await list()).data.count, 2);
  });

  await t.test('payment approvals in the dashboard: same decision as the emailed links', async () => {
    const { licence } = await import('../lib/licence/index.js');
    const d = device();
    // A pending application, stored like the desktop app's would be.
    const store = licence().store;
    await store.upsertDevice(d.deviceId, d.publicKey, new Date().toISOString());
    const id = 'LF-0123456789';
    await licence().storage.upload(`applications/${id}/0123456789abcdef.png`, png);
    await store.createApplication({ id, deviceId: d.deviceId, plan: 'six_months', message: 'Paid by NayaPay', email: 'dash@example.com', screenshotPath: `applications/${id}/0123456789abcdef.png`, screenshotType: 'image/png', screenshotSize: png.length, screenshotSha256: 'a'.repeat(64), createdAt: new Date().toISOString() }, []);

    let r = await call(api.listApplications, 'GET', '/api/v1/applications?status=pending');
    assert.equal(r.data.count, 1);
    assert.deepEqual([r.data.applications[0].id, r.data.applications[0].planName, r.data.applications[0].user], [id, 'Six Months', null]);
    assert.equal((await call(api.listApplications, 'GET', '/api/v1/applications?status=nope')).data.error.code, 'invalid_status');
    const shot = await api.applicationScreenshot(new Request(`http://x/api/v1/applications/${id}/screenshot`), { params: Promise.resolve({ id }) });
    assert.deepEqual([shot.status, shot.headers.get('content-type'), Buffer.from(await shot.arrayBuffer()).equals(png)], [200, 'image/png', true]);

    r = await call(api.decideApplication('approve'), 'POST', `/api/v1/applications/${id}/approve`, undefined, { id });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.application.status, 'approved');
    assert.equal(r.data.application.user.subscription.effectiveStatus, 'active');
    assert.equal(r.data.application.user.email, 'dash@example.com');
    r = await call(api.decideApplication('cancel'), 'POST', `/api/v1/applications/${id}/cancel`, undefined, { id });
    assert.deepEqual([r.status, r.data.error.code], [409, 'already_processed']);
    assert.equal((await call(api.decideApplication('approve'), 'POST', '/api/v1/applications/LF-FFFFFFFFFF/approve', undefined, { id: 'LF-FFFFFFFFFF' })).status, 404);
  });

  await t.test('unknown API routes answer the JSON 404', async () => {
    const r = api.notFound();
    assert.deepEqual([r.status, await r.json()], [404, { error: { code: 'not_found', message: 'No such API route.' } }]);
  });
});

test('database outage: 503 without leaking details', async () => {
  const { PrismaClient } = await import('@prisma/client');
  const down = new PrismaClient({ datasourceUrl: 'mysql://u:secretpw@127.0.0.1:1/db' });
  const logs = [];
  const h = api.handler(async () => {
    await down.user.findMany();
  }, { error: (m) => logs.push(m) });
  const res = await h(new Request('http://x/api/v1/users'));
  await down.$disconnect();
  const body = await res.json();
  assert.deepEqual([res.status, body.error.code], [503, 'database_unavailable']);
  assert.ok(!JSON.stringify(body).includes('secretpw') && !logs.join().includes('secretpw'));
});
