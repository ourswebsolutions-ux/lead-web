// The Lead Getter licence API (/lead-getter), as the installed desktop app
// uses it. Expected values are the former standalone licence server's.

import { DB_URL, skip, TEST_PRIVATE_KEY_B64, device, verifyToken, dropAll, png } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { Users } from '../lib/users.js';
import { Store } from '../lib/licence/store.js';
import { Uploads } from '../lib/licence/uploads.js';
import { Website } from '../lib/licence/website.js';
import { createLicenceHandler, HttpError } from '../lib/licence/handler.js';
import { loadSigningKey } from '../lib/licence/keys.js';
import { addMonths } from '../lib/licence/plans.js';
import { setup } from '../prisma/setup.js';

// GET /api/plans of the original licence server, verbatim.
const ORIGINAL_PLANS = {
  plans: [
    { id: 'monthly', name: 'Monthly', priceLabel: 'PKR 3,000', price: 3000, currency: 'PKR', months: 1, duration: '1 month' },
    { id: 'six_months', name: 'Six Months', priceLabel: 'PKR 10,000', price: 10000, currency: 'PKR', months: 6, duration: '6 months' },
    { id: 'lifetime', name: 'Lifetime', priceLabel: 'PKR 20,000', price: 20000, currency: 'PKR', months: null, duration: 'One-time payment, never expires' },
  ],
  paymentMethods: [
    { id: 'nayapay', name: 'NayaPay', account: '03245237429' },
    { id: 'jazzcash', name: 'JazzCash', account: '03245237429' },
    { id: 'easypaisa', name: 'Easypaisa', account: '03245237429' },
  ],
  paymentInstructions: '',
  trialSearches: 3,
};

test('licence API', { skip }, async (t) => {
  await dropAll(prisma);
  process.env.LICENSE_PRIVATE_KEY = TEST_PRIVATE_KEY_B64;
  await setup({ log: () => {} });
  delete process.env.LICENSE_PRIVATE_KEY;

  let clock = new Date();
  const mails = [];
  let mailFails = false;
  const errors = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axora-uploads-'));
  const users = new Users(prisma, { now: () => clock });
  const store = new Store(prisma);
  let signingKey = loadSigningKey({ prisma, settings: { privateKey: null } }).then((k) => k.privateKey);
  const h = createLicenceHandler({
    publicBaseUrl: 'https://subscription.example/lead-getter',
    adminEmail: 'admin@example.com',
    getSigningKey: () => signingKey,
    store,
    storage: new Uploads(dir),
    mailer: { send: async (m) => (mailFails ? Promise.reject(Object.assign(new Error('smtp down'), { code: 'ECONNECTION' })) : (mails.push(m), {})) },
    website: new Website(users),
    now: () => clock,
    logger: { error: (m) => errors.push(m) },
  });
  t.after(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    await dropAll(prisma);
    await prisma.$disconnect();
  });

  const base = 'https://subscription.example/lead-getter';
  async function send({ method, pathQuery, headers = {}, body }) {
    const res = await h.handle(new Request(base + pathQuery, { method, headers, body }));
    const text = Buffer.from(await res.arrayBuffer());
    let data = null;
    try {
      data = JSON.parse(text.toString('utf8'));
    } catch {}
    return { status: res.status, headers: res.headers, data, text: text.toString('utf8') };
  }
  const get = (pathQuery, headers) => send({ method: 'GET', pathQuery, headers });
  const status = async (d) => {
    const nonce = crypto.randomBytes(18).toString('base64url');
    const r = await send(d.signed('GET', `/api/license?nonce=${nonce}`));
    assert.equal(r.status, 200, r.text);
    const p = verifyToken(r.data.token);
    assert.ok(p, 'token signed with the server key');
    assert.equal(p.nonce, nonce);
    assert.equal(p.deviceId, d.deviceId);
    return p;
  };
  const apply = (d, body) => send(d.signed('POST', '/api/applications', { plan: 'monthly', message: 'Paid', email: 'customer@example.com', screenshot: { type: 'image/png', data: png.toString('base64') }, ...body }));
  const approveLink = (mail, action = 'approve') => {
    const m = mail.text.match(new RegExp(`${base}(/admin/applications/LF-[0-9A-F]{10}/${action})\\?token=(\\S+)`));
    return { path: m[1], token: m[2] };
  };
  const decide = (link) => send({ method: 'POST', pathQuery: link.path, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(link.token)}` });

  await t.test('health and plans: exactly the original answers', async () => {
    let r = await get('/health');
    assert.equal(r.status, 200);
    assert.equal(r.text, '{"ok":true}');
    assert.equal(r.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    r = await get('/api/plans');
    assert.equal(r.status, 200);
    assert.equal(r.text, JSON.stringify(ORIGINAL_PLANS));
    assert.equal(r.headers.get('www-authenticate'), null);
  });

  await t.test('device authentication: unsigned, forged, out of time, replayed, bad machine id', async () => {
    const d = device();
    const nonce = 'n'.repeat(20);
    assert.deepEqual((await get(`/api/license?nonce=${nonce}`)).data, { error: 'Unsigned request' });
    let r = await send(d.signed('GET', `/api/license?nonce=${nonce}`, null, { tamper: (hd) => (hd['x-lf-sig'] = Buffer.alloc(64).toString('base64')) }));
    assert.deepEqual([r.status, r.data], [401, { error: 'Bad signature' }]);
    r = await send(d.signed('GET', `/api/license?nonce=${nonce}`, null, { tamper: (hd) => (hd['x-lf-key'] = 'AAAA') }));
    assert.deepEqual([r.status, r.data], [401, { error: 'Invalid device key' }]);
    r = await send(d.signed('GET', `/api/license?nonce=${nonce}`, null, { tamper: (hd) => (hd['x-lf-machine'] = 'xyz') }));
    assert.deepEqual([r.status, r.data], [401, { error: 'Invalid machine id' }]);
    const late = device({ clock: () => Date.now() - 6 * 60 * 1000 });
    r = await send(late.signed('GET', `/api/license?nonce=${nonce}`));
    assert.deepEqual([r.status, r.data], [401, { error: 'Request time is out of range. Check the computer clock.' }]);
    // The signature covers the path below /lead-getter, exactly as signed.
    r = await send(d.signed('GET', `/api/license?nonce=${'m'.repeat(20)}`, null, { tamper: () => {} }));
    assert.equal(r.status, 200);
    const once = d.signed('GET', `/api/license?nonce=${'r'.repeat(20)}`);
    assert.equal((await send(once)).status, 200);
    assert.deepEqual((await send(once)).data, { error: 'Replayed request' });
    r = await send(d.signed('GET', '/api/license?nonce=short'));
    assert.deepEqual([r.status, r.data], [400, { error: 'Missing nonce' }]);
  });

  await t.test('signed status of a new device: same fields and values as the original', async () => {
    const d = device();
    const p = await status(d);
    assert.deepEqual(Object.keys(p), ['v', 'deviceId', 'nonce', 'serverTime', 'subscription', 'registration', 'application', 'pendingApplications', 'trial']);
    assert.equal(p.v, 1);
    assert.equal(p.serverTime, clock.toISOString());
    assert.deepEqual(p.subscription, { state: 'none' });
    assert.deepEqual(p.registration, { state: 'no_email' });
    assert.equal(p.application, null);
    assert.equal(p.pendingApplications, 0);
    assert.deepEqual(p.trial, { limit: 3, used: 0, remaining: 3 });
  });

  await t.test('free trial: 3 searches per computer, then 402', async () => {
    const machine = crypto.randomBytes(32).toString('hex');
    const a = device({ machine });
    for (let i = 1; i <= 3; i++) {
      const r = await send(a.signed('POST', '/api/trial/consume', {}));
      assert.deepEqual([r.status, r.data], [200, { consumed: true, trial: { limit: 3, used: i, remaining: 3 - i } }]);
    }
    const r = await send(a.signed('POST', '/api/trial/consume', {}));
    assert.deepEqual([r.status, r.data], [402, { error: 'Your 3 free searches have been used. Choose a plan to keep searching.' }]);
    // A reinstall (new device key) on the same computer gets no new trial.
    const again = device({ machine });
    assert.deepEqual((await status(again)).trial, { limit: 3, used: 3, remaining: 0 });
  });

  await t.test('application validation messages', async () => {
    const d = device();
    const cases = [
      [{ plan: 'weekly' }, 'Choose a subscription plan.'],
      [{ message: 'x'.repeat(1001) }, 'The message is too long (1000 characters maximum).'],
      [{ email: '' }, 'Enter your email address.'],
      [{ email: 'nope' }, 'The email address is not valid.'],
      [{ screenshot: { data: '' } }, 'Attach the payment screenshot.'],
      [{ screenshot: { data: Buffer.from('GIF89a').toString('base64') } }, 'The screenshot must be a PNG, JPEG or WebP image.'],
      [{ screenshot: { data: Buffer.alloc(5 * 1024 * 1024 + 1, 0x89).toString('base64') } }, 'The screenshot is larger than 5 MB.'],
    ];
    for (const [body, error] of cases) {
      const r = await apply(d, body);
      assert.deepEqual([r.status, r.data], [400, { error }], error);
    }
    const r = await send({ ...d.signed('POST', '/api/applications', { a: 1 }), body: '{bad' });
    assert.equal(r.status, 401, 'body is part of the signature');
    assert.equal(await prisma.licenceApplication.count({ where: { deviceId: d.deviceId } }), 0);
  });

  let approvedDevice;
  await t.test('apply → registered inactive → approve link → active until +1 month; links single use', async () => {
    const d = device();
    approvedDevice = d;
    const r = await apply(d, { email: ' Customer@Example.com ' });
    assert.equal(r.status, 201);
    assert.deepEqual(Object.keys(r.data), ['applicationId', 'status', 'plan', 'emailVerificationSent']);
    assert.match(r.data.applicationId, /^LF-[0-9A-F]{10}$/);
    assert.deepEqual([r.data.status, r.data.plan, r.data.emailVerificationSent], ['pending', 'monthly', true]);
    const adminMail = mails.find((m) => m.subject.startsWith(`Subscription request ${r.data.applicationId}`));
    assert.equal(adminMail.to, 'admin@example.com');
    assert.equal(adminMail.subject, `Subscription request ${r.data.applicationId}: Monthly (PKR 3,000)`);
    assert.equal(adminMail.attachments[0].filename, `payment-${r.data.applicationId}.png`);
    assert.match(adminMail.text, /Subscription website: Device ID registered/);
    const user = await users.get(d.deviceId);
    assert.deepEqual([user.email, user.subscription.status], ['customer@example.com', 'inactive']);

    let p = await status(d);
    assert.deepEqual(p.subscription, { state: 'inactive', expiresAt: null });
    assert.deepEqual(p.registration, { state: 'registered' });
    assert.deepEqual(p.application, { id: r.data.applicationId, plan: 'monthly', status: 'pending', createdAt: clock.toISOString(), decidedAt: null });
    assert.equal(p.pendingApplications, 1);

    const link = approveLink(adminMail);
    const page = await get(`${link.path}?token=${link.token}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Approve Subscription\?/);
    assert.equal(page.headers.get('content-security-policy'), "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    const shot = await get(`/admin/applications/${r.data.applicationId}/screenshot?token=${link.token}`);
    assert.deepEqual([shot.status, shot.headers.get('content-type')], [200, 'image/png']);

    const done = await decide(link);
    assert.equal(done.status, 200);
    assert.match(done.text, /Subscription approved/);
    p = await status(d);
    assert.deepEqual(p.subscription, { state: 'active', expiresAt: addMonths(clock, 1).toISOString() });
    assert.equal(p.application.status, 'approved');
    assert.equal((await users.get(d.deviceId)).subscription.effectiveStatus, 'active');

    assert.equal((await decide(link)).status, 409, 'used link');
    assert.equal((await decide(approveLink(adminMail, 'cancel'))).status, 409, 'the other link was spent too');
    assert.equal((await get(`/admin/applications/${r.data.applicationId}/screenshot?token=${link.token}`)).status, 403);
    const tampered = await decide({ ...link, token: link.token.slice(0, -2) + 'xx' });
    assert.equal(tampered.status, 400);
  });

  await t.test('renewal before expiry continues from the end date; lifetime stays lifetime', async () => {
    const d = approvedDevice;
    const end = (await users.get(d.deviceId)).subscription.expiresAt;
    mails.length = 0;
    await apply(d, { plan: 'six_months' });
    await decide(approveLink(mails[0]));
    assert.equal((await status(d)).subscription.expiresAt, addMonths(new Date(end), 6).toISOString());
    mails.length = 0;
    await apply(d, { plan: 'lifetime' });
    await decide(approveLink(mails[0]));
    assert.deepEqual((await status(d)).subscription, { state: 'active', expiresAt: null });
  });

  await t.test('suspension and expiry are reported in the signed status', async () => {
    const d = approvedDevice;
    await users.suspend(d.deviceId);
    assert.deepEqual((await status(d)).subscription, { state: 'suspended', expiresAt: null });
    const until = new Date(clock.getTime() + 60_000);
    await users.activate(d.deviceId, until);
    assert.equal((await status(d)).subscription.state, 'active');
    const r = await send(d.signed('POST', '/api/trial/consume', {}));
    assert.deepEqual(r.data, { consumed: false, subscribed: true, trial: { limit: 3, used: 0, remaining: 3 } });
    // One minute later (server clock): expired, measured by the server.
    clock = new Date(until.getTime() + 1);
    assert.deepEqual((await status(d)).subscription, { state: 'expired', expiresAt: until.toISOString() });
    clock = new Date();
  });

  await t.test('cancel link: application cancelled, nothing activated', async () => {
    const d = device();
    mails.length = 0;
    await apply(d, { email: 'cancel-me@example.com' });
    const r = await decide(approveLink(mails[0], 'cancel'));
    assert.equal(r.status, 200);
    assert.match(r.text, /Application cancelled/);
    const p = await status(d);
    assert.deepEqual([p.subscription.state, p.application.status], ['inactive', 'cancelled']);
  });

  await t.test('another device with an already used email is not registered; existing user untouched', async () => {
    const d = device();
    await apply(d, { email: 'customer@example.com' });
    const p = await status(d);
    assert.deepEqual([p.subscription, p.registration], [{ state: 'none' }, { state: 'email_in_use' }]);
    assert.equal(await users.get(d.deviceId), null);
    assert.equal((await users.get(approvedDevice.deviceId)).email, 'customer@example.com');
  });

  await t.test('approval email failure: 502 and the application is removed', async () => {
    const d = device();
    const shots = () => fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.png')).length;
    const before = shots();
    mailFails = true;
    const r = await apply(d, { email: 'mailfail@example.com' });
    mailFails = false;
    assert.deepEqual([r.status, r.data], [502, { error: 'The application could not be sent for approval (email failed). Please try again later.' }]);
    assert.equal(await prisma.licenceApplication.count({ where: { deviceId: d.deviceId } }), 0);
    assert.equal(shots(), before, 'its screenshot was removed');
  });

  await t.test('10 applications per device per day', async () => {
    const d = device();
    for (let i = 0; i < 10; i++) assert.equal((await apply(d, { email: 'many@example.com' })).status, 201);
    const r = await apply(d, { email: 'many@example.com' });
    assert.deepEqual([r.status, r.data], [429, { error: 'Too many applications today. Please try again tomorrow.' }]);
  });

  await t.test('verify-email link, single use', async () => {
    const mail = mails.find((m) => m.subject === 'Confirm your email for Lead Finder');
    const token = mail.text.match(/verify-email\?token=(\S+)/)[1];
    assert.equal((await get(`/verify-email?token=${token}`)).status, 200);
    assert.equal((await get(`/verify-email?token=${token}`)).status, 400);
  });

  await t.test('limits, unknown routes and a missing signing key', async () => {
    const big = Buffer.alloc(8 * 1024 * 1024 + 10, 0x61);
    let r = await send({ method: 'POST', pathQuery: '/api/applications', headers: { 'content-type': 'application/json' }, body: big });
    assert.deepEqual([r.status, r.data], [413, { error: 'Request too large' }]);
    r = await get('/api/nope');
    assert.deepEqual([r.status, r.data], [404, { error: 'Not found' }]);
    r = await get('/nope');
    assert.equal(r.status, 404);
    assert.match(r.headers.get('content-type'), /text\/html/);
    r = await send({ method: 'PUT', pathQuery: '/api/plans' });
    assert.equal(r.status, 404);
    signingKey = Promise.reject(new HttpError(503, 'Subscriptions are temporarily unavailable on the server. Please try again later.'));
    signingKey.catch(() => {});
    r = await send(device().signed('GET', `/api/license?nonce=${'k'.repeat(20)}`));
    assert.deepEqual([r.status, r.data], [503, { error: 'Subscriptions are temporarily unavailable on the server. Please try again later.' }]);
    assert.equal((await get('/api/plans')).status, 200, 'plans and health need no key');
  });

  assert.deepEqual(errors.filter((e) => !/^\[subscription website\]|^\[mail\]/.test(e)), [], 'no unexpected server errors');
  void DB_URL;
});
