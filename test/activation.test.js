// Activation (an Activation ID and a 4-digit code emailed to the
// administrator only; entering the code activates the plan) and the daily
// qualified-lead allowance, as Lead Finder 1.6+ uses /lead-getter. Real
// MySQL; email is captured, never sent; the clock is controlled.

import { skip, TEST_PRIVATE_KEY_B64, device, verifyToken, dropAll } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '../lib/prisma.js';
import { Users } from '../lib/users.js';
import { Store } from '../lib/licence/store.js';
import { Uploads } from '../lib/licence/uploads.js';
import { Website } from '../lib/licence/website.js';
import { createLicenceHandler } from '../lib/licence/handler.js';
import { loadSigningKey } from '../lib/licence/keys.js';
import { setup } from '../prisma/setup.js';

const DAY = 86_400_000;
const ADMIN = 'admin@example.com';
const BASE = 'https://subscription.example/lead-getter';
const BASIC = `Basic ${Buffer.from('admin:correct-horse-battery').toString('base64')}`;

const codeIn = (mail) => (mail.text.match(/Activation code: (\d{4})/) || [])[1];

test('activation and daily allowance', { skip }, async (t) => {
  await dropAll(prisma);
  process.env.LICENSE_PRIVATE_KEY = TEST_PRIVATE_KEY_B64;
  await setup({ log: () => {} });
  delete process.env.LICENSE_PRIVATE_KEY;

  let clock = Date.parse('2026-10-27T05:00:00.000Z');
  const now = () => new Date(clock);
  const mails = [];
  let mailFails = false;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axora-uploads-'));
  const signingKey = loadSigningKey({ prisma, settings: { privateKey: null } }).then((k) => k.privateKey);
  const build = () =>
    createLicenceHandler({
      publicBaseUrl: BASE,
      adminEmail: ADMIN,
      timezone: 'Asia/Karachi',
      getSigningKey: () => signingKey,
      store: new Store(prisma),
      storage: new Uploads(dir),
      mailer: { send: async (m) => (mailFails ? Promise.reject(Object.assign(new Error('smtp down'), { code: 'ECONNECTION' })) : (mails.push(m), {})) },
      website: new Website(new Users(prisma, { now })),
      now,
      logger: { error() {} },
    });
  let h = build();
  const store = () => h.store;
  t.after(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    await dropAll(prisma);
    await prisma.$disconnect();
  });

  // A desktop installation; signs with the test clock.
  function app(opts) {
    const d = device({ ...opts, clock: () => clock });
    const call = async (method, pq, body) => {
      const r = d.signed(method, pq, body);
      const res = await h.handle(new Request(BASE + pq, { method, headers: r.headers, body: r.body }));
      return { status: res.status, body: await res.json() };
    };
    return {
      ...d,
      call,
      async status() {
        const nonce = crypto.randomBytes(18).toString('base64url');
        const r = await call('GET', `/api/license?nonce=${nonce}`);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        const p = verifyToken(r.body.token);
        assert.ok(p && p.nonce === nonce && p.deviceId === d.deviceId);
        return p;
      },
      request: (plan) => call('POST', '/api/activation', { plan }),
      verify: (code) => call('POST', '/api/activation/verify', { code }),
      resend: () => call('POST', '/api/activation/resend', {}),
      reserve: (source, lead) => call('POST', '/api/credits/reserve', { source, key: crypto.createHash('sha256').update(String(lead)).digest('hex') }),
    };
  }
  // The app asks for `plan`; the administrator's email carries the code.
  async function requested(d, plan) {
    const r = await d.request(plan);
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.body));
    return { id: r.body.activation.id, code: codeIn(mails.findLast((m) => m.subject.includes(r.body.activation.id))) };
  }

  await t.test('schema: device-ID columns of the new tables are case-sensitive', async () => {
    const rows = await prisma.$queryRaw`SELECT table_name AS t, column_name AS c, collation_name AS coll FROM information_schema.columns
      WHERE table_schema = DATABASE() AND ((table_name = 'licence_activations' AND column_name IN ('device_id', 'open_for')) OR (table_name IN ('licence_credit_usage', 'licence_credit_leads') AND column_name = 'account'))`;
    assert.equal(rows.length, 4);
    assert.ok(rows.every((r) => r.coll === 'ascii_bin'), JSON.stringify(rows));
  });

  await t.test('plans: Free plus the paid plans; earlier app versions still get theirs', async () => {
    const res = await h.handle(new Request(`${BASE}/api/plans`));
    const plans = await res.json();
    assert.deepEqual(
      plans.plans.map((p) => [p.id, p.name, p.price, p.months, p.daily]),
      [
        ['monthly', 'Monthly', 3000, 1, { total: 100 }],
        ['six_months', 'Six Months', 10000, 6, { total: 250 }],
        ['lifetime', 'One-Time', 20000, null, null],
      ],
    );
    assert.deepEqual([plans.freePlan.id, plans.freePlan.daily, plans.timezone, plans.trialSearches], ['free', { maps: 5, facebook: 5 }, 'Asia/Karachi', 3]);
  });

  await t.test('a new installation is on Free (5 Google Maps + 5 Facebook a day)', async () => {
    const d = app();
    const st = await d.status();
    assert.deepEqual(st.plan, { id: 'free', name: 'Free', state: 'free', expiresAt: null, activatedAt: null, expiredPlan: null });
    assert.deepEqual([st.credits.scope, st.credits.maps, st.credits.facebook, st.credits.resetsAt], ['per_source', { used: 0, limit: 5, remaining: 5 }, { used: 0, limit: 5, remaining: 5 }, '2026-10-27T19:00:00.000Z']);
    // Version 1 fields are still there for earlier app versions.
    assert.deepEqual([st.v, st.subscription.state, st.trial.limit], [2, 'none', 3]);
  });

  await t.test('activation: the code goes to the administrator only; entering it activates the plan', async () => {
    const d = app();
    assert.equal((await d.request('free')).status, 400);
    let r = await d.request('monthly');
    assert.equal(r.status, 201);
    const id = r.body.activation.id;
    assert.match(id, /^ACT-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    assert.deepEqual([r.body.activation.status, r.body.activation.plan], ['pending', 'monthly']);
    const mail = mails.at(-1);
    assert.equal(mail.to, ADMIN, 'only the administrator gets the code');
    assert.ok(mails.every((m) => m.to === ADMIN));
    assert.match(mail.subject, new RegExp(`Lead Finder activation ${id}: Monthly`));
    assert.match(mail.text, /Plan: Monthly: PKR 3,000, 100 leads a day/);
    const code = codeIn(mail);
    assert.match(code, /^\d{4}$/);
    const stored = await prisma.licenceActivation.findUnique({ where: { id } });
    assert.ok(!JSON.stringify(stored).includes(`"${code}"`) && stored.otpHash.length === 64, 'only an HMAC of the code is stored');
    r = await d.request('monthly');
    assert.deepEqual([r.status, r.body.activation.id], [200, id], 'the same request is reused');
    let st = await d.status();
    assert.deepEqual([st.plan.id, st.activation.id, st.activation.code.attemptsLeft], ['free', id, 5]);
    assert.ok(!JSON.stringify(st).includes(code));

    const wrong = code === '0000' ? '1111' : '0000';
    r = await d.verify(wrong);
    assert.deepEqual([r.status, r.body.reason, r.body.attemptsLeft], [400, 'invalid', 4]);
    assert.equal((await d.status()).plan.id, 'free', 'a wrong code activates nothing');
    r = await d.verify(code);
    assert.deepEqual([r.status, r.body.plan, r.body.expiresAt], [200, 'monthly', '2026-11-27T05:00:00.000Z']);
    st = await d.status();
    assert.deepEqual([st.plan.id, st.plan.state, st.activation, st.credits.total], ['monthly', 'active', null, { used: 0, limit: 100, remaining: 100 }]);
    const user = await new Users(prisma, { now }).get(d.deviceId);
    assert.deepEqual([user.subscription.status, user.subscription.plan], ['active', 'monthly']);
    assert.match(user.email, /@device\.leadfinder\.invalid$/, 'no email is asked for');
    assert.equal((await d.verify(code)).body.reason, 'used');
    const audit = await store().auditLog();
    assert.deepEqual(audit.filter((e) => e.target === id).map((e) => e.action).reverse(), ['activation.requested', 'activation.code_incorrect', 'activation.activated']);
    assert.equal((await app().verify(code)).body.reason, 'not_open', "another device can't use it");

    // The dashboard's user list: plan and today's usage; revoke and suspend.
    const api = await import('../lib/admin-api.js');
    const call = async (fn, method, url, body, params) => {
      const res = await fn(new Request(`http://x${url}`, { method, headers: { authorization: BASIC, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), { params: Promise.resolve(params || {}) });
      return { status: res.status, data: await res.json() };
    };
    await d.reserve('maps', 'lead-1');
    const list = await call(api.listUsers, 'GET', '/api/v1/users');
    const u = list.data.users.find((x) => x.id === d.deviceId);
    assert.deepEqual([u.plan.id, u.plan.daily, u.usageToday], ['monthly', { total: 100 }, { maps: 1, facebook: 0 }]);
    const patch = (body) => call(api.patchSubscription, 'PATCH', `/api/v1/users/${d.deviceId}/subscription`, body, { id: d.deviceId });
    assert.equal((await patch({ status: 'active', expiresAt: null, plan: 'gold' })).data.error.code, 'invalid_plan');
    assert.equal((await patch({ status: 'suspended' })).status, 200);
    assert.equal((await d.reserve('maps', 'lead-2')).body.reason, 'suspended');
    assert.equal((await patch({ status: 'inactive' })).data.user.subscription.status, 'inactive');
    assert.equal((await d.status()).plan.id, 'free', 'revoked: back to Free');
    assert.equal((await patch({ status: 'active', expiresAt: null, plan: 'lifetime' })).data.user.subscription.plan, 'lifetime');
    assert.equal((await d.status()).credits.scope, 'unlimited');
  });

  await t.test('codes: lockout after 5 wrong tries even all at once, new codes, expiry after a day, another plan', async () => {
    const d = app();
    let { id, code } = await requested(d, 'lifetime');
    const wrong = code === '9999' ? '9998' : '9999';
    const answers = await Promise.all(Array.from({ length: 20 }, () => d.verify(wrong)));
    assert.equal(answers.filter((a) => a.status === 400).length, 5, 'only 5 guesses are ever compared');
    assert.equal(answers.filter((a) => a.status === 429).length, 15);
    assert.equal((await d.verify(code)).body.reason, 'locked');
    assert.equal((await d.resend()).status, 429, 'cooldown');
    clock += 61_000;
    let r = await d.resend();
    assert.deepEqual([r.status, r.body.activation.id], [200, id]);
    assert.equal(mails.at(-1).to, ADMIN);
    for (let i = 0; i < 3; i++) {
      clock += 61_000;
      assert.equal((await d.resend()).status, 200);
    }
    clock += 61_000;
    assert.equal((await d.resend()).body.error, 'Too many codes today. Please try again tomorrow.');
    code = codeIn(mails.at(-1));
    clock += 25 * 3_600_000;
    assert.equal((await d.verify(code)).body.reason, 'expired', 'a code lasts a day');
    ({ id, code } = await requested(d, 'monthly'));
    const second = await requested(d, 'six_months');
    assert.notEqual(second.id, id);
    assert.equal((await d.verify(code)).body.reason, 'invalid', "the replaced request's code is gone");
    assert.equal((await d.verify(second.code)).status, 200);
    assert.equal((await d.status()).plan.id, 'six_months');
  });

  await t.test('requests: limited per day; a failed email leaves nothing half-done', async () => {
    const e = app();
    for (const p of ['monthly', 'six_months', 'lifetime', 'monthly', 'six_months']) assert.equal((await e.request(p)).status, 201);
    assert.equal((await e.request('lifetime')).status, 429);
    mailFails = true;
    const f = app();
    assert.equal((await f.request('monthly')).status, 502);
    mailFails = false;
    assert.equal((await f.status()).activation, null);
    assert.equal((await f.request('monthly')).status, 201);
  });

  await t.test('Free allowance: per source, per computer, never charged twice, survives restarts, resets at midnight', async () => {
    const d = app();
    for (let i = 0; i < 5; i++) assert.equal((await d.reserve('maps', `f-${i}`)).body.granted, true);
    let r = await d.reserve('maps', 'f-5');
    assert.deepEqual([r.body.granted, r.body.reason, r.body.credits.maps.remaining], [false, 'exhausted', 0]);
    r = await d.reserve('facebook', 'f-1');
    assert.deepEqual([r.body.granted, r.body.duplicate, r.body.credits.facebook.used], [true, true, 0]);
    // Ten at once on Facebook: exactly five go through.
    const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => d.reserve('facebook', `fb-${i}`)));
    assert.equal(burst.filter((x) => x.body.granted).length, 5);
    // Reinstalled on the same computer: same allowance.
    const again = app({ machine: d.machine });
    assert.equal((await again.reserve('maps', 'f-new')).body.granted, false);
    // Restart (a new handler and store over the same database).
    h = build();
    assert.equal((await d.reserve('maps', 'f-new')).body.granted, false);
    // Midnight in Karachi.
    const st0 = await d.status();
    clock = Date.parse(st0.credits.resetsAt) + 1;
    const st = await d.status();
    assert.deepEqual([st.credits.maps.used, st.credits.facebook.used], [0, 0]);
    assert.equal((await d.reserve('maps', 'f-new')).body.granted, true);
    assert.equal((await d.reserve('maps', 'f-1')).body.duplicate, true, 'charged yesterday: still not charged again');
    assert.equal((await d.reserve('nope', 'x')).status, 400);
    assert.equal((await d.call('POST', '/api/credits/reserve', { source: 'maps', key: 'short' })).status, 400);
  });

  await t.test('paid plans: shared daily total under concurrency, Six Months, One-Time unlimited, expiry, suspension', async () => {
    const m = app();
    await requested(m, 'monthly').then(({ code }) => m.verify(code));
    const results = await Promise.all(Array.from({ length: 130 }, (_, i) => m.reserve(i % 2 ? 'facebook' : 'maps', `m-${i}`)));
    assert.equal(results.filter((r) => r.body.granted).length, 100, 'never more than 100, both sources together');
    const st = await m.status();
    assert.deepEqual(st.credits.total, { used: 100, limit: 100, remaining: 0 });
    assert.equal(await prisma.licenceCreditLead.count({ where: { account: `device:${m.deviceId}` } }), 100);

    const s = app();
    await requested(s, 'six_months').then(({ code }) => s.verify(code));
    const six = await Promise.all(Array.from({ length: 260 }, (_, i) => s.reserve('maps', `s-${i}`)));
    assert.equal(six.filter((r) => r.body.granted).length, 250);

    const o = app();
    await requested(o, 'lifetime').then(({ code }) => o.verify(code));
    for (let i = 0; i < 120; i++) assert.equal((await o.reserve(i % 2 ? 'maps' : 'facebook', `o-${i}`)).body.granted, true);
    assert.deepEqual([(await o.status()).credits.scope, (await o.status()).credits.discovered], ['unlimited', 120]);

    clock += 190 * DAY;
    const after = await m.status();
    assert.deepEqual([after.plan.id, after.plan.state, after.plan.expiredPlan], ['free', 'expired', 'monthly'], 'one calendar month');
    assert.equal((await s.status()).plan.state, 'expired', 'six calendar months');
    assert.equal((await o.status()).plan.state, 'active', 'One-Time never expires');
    await new Users(prisma, { now }).suspend(o.deviceId);
    const r = await o.reserve('maps', 'o-new');
    assert.deepEqual([r.body.granted, r.body.reason], [false, 'suspended']);
    assert.deepEqual([(await o.status()).plan.state, (await o.status()).credits.scope], ['suspended', 'blocked']);
  });

  await t.test('subscriptions from before plans were recorded get their plan', async () => {
    const users = new Users(prisma, { now });
    const legacy = app();
    await users.create({ id: legacy.deviceId, email: 'legacy@example.com' });
    await users.activate(legacy.deviceId, null);
    assert.deepEqual([(await legacy.status()).plan.id, (await legacy.status()).credits.scope], ['lifetime', 'unlimited'], 'never expires: One-Time');
    const paid = app();
    await users.create({ id: paid.deviceId, email: 'paid6@example.com' });
    await users.activate(paid.deviceId, new Date(clock + 30 * DAY));
    assert.equal((await paid.status()).plan.id, 'monthly');
    await prisma.licenceDevice.upsert({ where: { id: paid.deviceId }, update: {}, create: { id: paid.deviceId, publicKey: paid.publicKey, createdAt: now(), lastSeenAt: now() } });
    await prisma.licenceApplication.create({ data: { id: 'LF-AAAAAAAAAA', deviceId: paid.deviceId, plan: 'six_months', message: '', email: 'paid6@example.com', screenshotType: 'image/png', screenshotSize: 1, screenshotSha256: 'a'.repeat(64), status: 'approved', createdAt: now(), decidedAt: now() } });
    assert.equal((await paid.status()).plan.id, 'six_months', 'from the approved payment application');
  });
});
