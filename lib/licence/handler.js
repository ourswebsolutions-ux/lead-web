// The Lead Getter licence API, served by this site at /lead-getter. A port of
// the former standalone licence server (lead-getter server/src/app.js) with
// the same routes, statuses, messages, headers and signed payloads; only the
// I/O differs (Web Request/Response) and this site's users/subscriptions are
// used in process. Subscriptions are always decided by this site.
//
//   GET  /api/plans                     public plan list
//   POST /api/applications              (device-signed) apply with payment screenshot
//   GET  /api/license?nonce=…           (device-signed) signed subscription status
//   POST /api/trial/consume             (device-signed) one free search
//   GET  /admin/applications/:id/:action?token=…   confirmation page (approve|cancel)
//   POST /admin/applications/:id/:action           performs it (single use)
//   GET  /admin/applications/:id/screenshot?token=…
//   GET  /verify-email?token=…
//   GET  /health
//
// Paths are relative to /lead-getter. Device requests are authenticated by
// the device's own Ed25519 signature (not by the admin login).

import crypto from 'node:crypto';
import { PLANS, PAYMENT_METHODS, TRIAL_SEARCHES, addMonths } from './plans.js';
import * as c from './crypto.js';
import * as pages from './pages.js';

const MAX_BODY = 8 * 1024 * 1024;
const MAX_SCREENSHOT = 5 * 1024 * 1024;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const ACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const REISSUE_GAP_MS = 10 * 60 * 1000;
// New applications are always allowed (even with one pending); this only
// stops a flood of emails to the administrator.
const MAX_APPLICATIONS_PER_DAY = 10;
// Same rule as the admin API's POST /users, so an email accepted here is
// never rejected there.
const EMAIL_RE = /^[^\s@<>()",;:]{1,64}@[^\s@<>()",;:]{1,189}\.[a-z]{2,24}$/i;

const IMAGE_TYPES = [
  { type: 'image/png', ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/webp', ext: 'webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (status, data) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
const html = (status, body) => new Response(body, { status, headers: HTML_HEADERS });

// The website's effectiveStatus, as this API's subscription states.
const WEBSITE_STATE = { active: 'active', expired: 'expired', suspended: 'suspended', inactive: 'inactive' };

// A renewal before expiry continues from the current end date; a lifetime
// subscription stays lifetime.
function licenceFor(plan, cur, decidedAt) {
  const start = cur && cur.expiresAt && cur.expiresAt > decidedAt.toISOString() ? new Date(cur.expiresAt) : decidedAt;
  const keepLifetime = cur && !cur.expiresAt;
  return { plan: keepLifetime ? cur.plan : plan.id, expiresAt: keepLifetime || plan.months === null ? null : addMonths(start, plan.months).toISOString() };
}

function createLicenceHandler({ publicBaseUrl, paymentInstructions = '', adminEmail, getSigningKey, store, storage, mailer, website, now = () => new Date(), logger = console }) {
  const nowIso = () => now().toISOString();
  const link = (p) => `${publicBaseUrl.replace(/\/$/, '')}${p}`;
  // Requests arrive under the public path (/lead-getter); routes and device
  // signatures use the path below it, as with the standalone server.
  const base = new URL(publicBaseUrl).pathname.replace(/\/+$/, '');
  const localPath = (u) => (base && (u === base || u.startsWith(`${base}/`) || u.startsWith(`${base}?`)) ? u.slice(base.length) || '/' : u);

  // --- helpers --------------------------------------------------------------

  async function readBody(request) {
    if (!request.body) return Buffer.alloc(0);
    const chunks = [];
    let size = 0;
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BODY) {
        await reader.cancel().catch(() => {});
        throw new HttpError(413, 'Request too large');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  // Verifies a device-signed request; returns { deviceId, machineId }.
  async function authenticate(request, url, body) {
    const h = request.headers;
    const key = h.get('x-lf-key');
    const ts = Number(h.get('x-lf-ts'));
    const sig = h.get('x-lf-sig');
    const nonce = h.get('x-lf-nonce');
    const machine = String(h.get('x-lf-machine') || '');
    if (machine && !/^[0-9a-f]{64}$/.test(machine)) throw new HttpError(401, 'Invalid machine id');
    if (!key || !ts || !sig || !/^[A-Za-z0-9_-]{16,64}$/.test(String(nonce || ''))) throw new HttpError(401, 'Unsigned request');
    if (Math.abs(now().getTime() - ts) > CLOCK_SKEW_MS) throw new HttpError(401, 'Request time is out of range. Check the computer clock.');
    let publicKey;
    try {
      publicKey = c.publicKeyFromB64(key);
    } catch {
      throw new HttpError(401, 'Invalid device key');
    }
    const ok = crypto.verify(null, c.requestDigest(request.method, url.pathname + url.search, ts, nonce, body, machine), publicKey, Buffer.from(String(sig), 'base64'));
    if (!ok) throw new HttpError(401, 'Bad signature');
    if (!(await store.rememberRequest(c.hashToken(sig), now().getTime(), CLOCK_SKEW_MS * 2))) throw new HttpError(401, 'Replayed request');
    const deviceId = c.deviceIdFromKey(key);
    try {
      await store.upsertDevice(deviceId, key, nowIso());
    } catch {
      throw new HttpError(401, 'Device key mismatch');
    }
    return { deviceId, machineId: machine || `device:${deviceId}` };
  }

  // Free searches are counted per computer (machine id), so reinstalling or
  // clearing the app's data does not start a new trial.
  async function trialFor(machineId) {
    const used = await store.trialUsed(machineId);
    return { limit: TRIAL_SEARCHES, used: Math.min(used, TRIAL_SEARCHES), remaining: Math.max(0, TRIAL_SEARCHES - used) };
  }

  // A new random token; only its hash is stored.
  function makeToken(action, ttl) {
    const token = c.randomToken();
    return { token, hash: c.hashToken(token), action, expiresAt: new Date(now().getTime() + ttl).toISOString() };
  }

  // A valid, unused, unexpired token for this application and action.
  async function checkToken(token, applicationId, action) {
    if (!token || typeof token !== 'string' || token.length > 100) return { error: 'This link is invalid.' };
    const row = await store.token(c.hashToken(token));
    if (!row || row.application_id !== applicationId || row.action !== action) return { error: 'This link is invalid.' };
    if (row.used_at) return { error: 'This link has already been used.', used: true };
    if (row.expires_at < nowIso()) return { error: 'This link has expired.', expired: true };
    return { row };
  }

  // The device's account on this site, as { subscription, registration }.
  // With register, a Device ID this site doesn't know is added (as an
  // inactive user) under the customer's email from their latest application.
  // Existing users, and an email that belongs to another device, are never
  // changed. If the database can't be used, nothing happens and the next
  // check retries.
  const logged = new Map(); // deviceId -> last logged registration state
  const note = (deviceId, state, text) => {
    if (logged.get(deviceId) === state) return;
    logged.set(deviceId, state);
    if (logged.size > 10_000) logged.clear();
    logger.error(`[subscription website] ${text}`);
  };

  async function websiteAccount(deviceId, { register = false } = {}) {
    const fromSite = (s) => ({ state: WEBSITE_STATE[s.effectiveStatus] || 'inactive', expiresAt: s.expiresAt });
    try {
      const found = await website.subscription(deviceId);
      if (found) return { subscription: fromSite(found), registration: { state: 'registered' } };
      const email = await store.latestEmail(deviceId);
      if (!register || !email) return { subscription: { state: 'none' }, registration: { state: email ? 'not_registered' : 'no_email' } };
      const r = await website.register(deviceId, email);
      if (r.state === 'registered') {
        note(deviceId, 'registered', `registered Device ID ${deviceId} (${email}) as an inactive user`);
        return { subscription: fromSite(r.user.subscription), registration: { state: 'registered' } };
      }
      if (r.state === 'exists') {
        const again = await website.subscription(deviceId);
        return { subscription: again ? fromSite(again) : { state: 'none' }, registration: { state: 'registered' } };
      }
      note(deviceId, r.state, `could not register Device ID ${deviceId}: ${r.state === 'email_in_use' ? `${email} already belongs to another Device ID (left unchanged)` : r.message}`);
      return { subscription: { state: 'none' }, registration: { state: r.state } };
    } catch (err) {
      note(deviceId, 'unavailable', err.message);
      return { subscription: { state: 'unavailable' }, registration: { state: 'unavailable' } };
    }
  }

  const subscriptionFor = async (deviceId) => (await websiteAccount(deviceId)).subscription;

  async function sendAdminEmail(app, approve, cancel, attachment) {
    const approveUrl = link(`/admin/applications/${app.id}/approve?token=${approve}`);
    const cancelUrl = link(`/admin/applications/${app.id}/cancel?token=${cancel}`);
    await mailer.send({
      to: adminEmail,
      subject: `Subscription request ${app.id}: ${app.plan.name} (${app.plan.priceLabel})`,
      html: pages.adminEmail(app, approveUrl, cancelUrl),
      text: pages.adminEmailText(app, approveUrl, cancelUrl),
      attachments: attachment ? [attachment] : [],
    });
  }

  // --- API ---------------------------------------------------------------------

  async function apply(request, url) {
    const body = await readBody(request);
    const { deviceId } = await authenticate(request, url, body);
    let data;
    try {
      data = JSON.parse(body.toString('utf8'));
    } catch {
      throw new HttpError(400, 'Invalid JSON');
    }
    const plan = PLANS[data?.plan];
    if (!plan) throw new HttpError(400, 'Choose a subscription plan.');
    const message = typeof data.message === 'string' ? data.message.trim() : '';
    if (message.length > 1000) throw new HttpError(400, 'The message is too long (1000 characters maximum).');
    // The email identifies the customer on this site.
    const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
    if (!email) throw new HttpError(400, 'Enter your email address.');
    if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, 'The email address is not valid.');
    const shot = Buffer.from(typeof data.screenshot?.data === 'string' ? data.screenshot.data : '', 'base64');
    if (!shot.length) throw new HttpError(400, 'Attach the payment screenshot.');
    if (shot.length > MAX_SCREENSHOT) throw new HttpError(400, 'The screenshot is larger than 5 MB.');
    const kind = IMAGE_TYPES.find((t) => t.test(shot));
    if (!kind) throw new HttpError(400, 'The screenshot must be a PNG, JPEG or WebP image.');

    const since = new Date(now().getTime() - 24 * 60 * 60 * 1000).toISOString();
    if ((await store.countApplicationsSince(deviceId, since)) >= MAX_APPLICATIONS_PER_DAY) {
      throw new HttpError(429, 'Too many applications today. Please try again tomorrow.');
    }

    const id = `LF-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    const objectPath = `applications/${id}/${crypto.randomBytes(8).toString('hex')}.${kind.ext}`;
    await storage.upload(objectPath, shot, kind.type);
    const approve = makeToken('approve', ACTION_TTL_MS);
    const cancel = makeToken('cancel', ACTION_TTL_MS);
    const verify = email ? makeToken('verify_email', EMAIL_TTL_MS) : null;
    try {
      await store.createApplication(
        { id, deviceId, plan: plan.id, message, email, screenshotPath: objectPath, screenshotType: kind.type, screenshotSize: shot.length, screenshotSha256: c.sha256(shot).toString('hex'), createdAt: nowIso() },
        [approve, cancel, ...(verify ? [verify] : [])],
      );
    } catch (err) {
      await storage.remove([objectPath]).catch(() => {});
      throw err;
    }

    // Registers a new device here (inactive) now, so the administrator can
    // find it; retried on later checks if needed.
    const account = await websiteAccount(deviceId, { register: true });
    const app = { id, plan, message, email, deviceId, createdAt: nowIso(), current: account.subscription, website: account.registration.state };
    try {
      await sendAdminEmail(app, approve.token, cancel.token, { filename: `payment-${id}.${kind.ext}`, content: shot, contentType: kind.type });
    } catch (err) {
      // Without the email nobody is told about it: remove the application
      // (it was never seen by anyone) and its upload, so the user retries.
      await store.discardUnsentApplication(id);
      await storage.remove([objectPath]).catch(() => {});
      logger.error(`[mail] admin email for ${id} failed: ${err.code || ''} ${String(err.message).split('\n')[0]}`);
      throw new HttpError(502, 'The application could not be sent for approval (email failed). Please try again later.');
    }
    if (verify) {
      const v = link(`/verify-email?token=${verify.token}`);
      mailer
        .send({ to: email, subject: 'Confirm your email for Lead Finder', html: pages.verifyEmail(v), text: `Confirm your email for Lead Finder: ${v}` })
        .catch((err) => logger.error(`[mail] verification email for ${id} failed: ${err.code || ''}`));
    }
    return json(201, { applicationId: id, status: 'pending', plan: plan.id, emailVerificationSent: Boolean(verify) });
  }

  async function license(request, url) {
    const body = await readBody(request);
    const { deviceId, machineId } = await authenticate(request, url, body);
    const nonce = url.searchParams.get('nonce') || '';
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) throw new HttpError(400, 'Missing nonce');
    const key = await getSigningKey();
    const [account, application, pendingApplications, trial] = await Promise.all([websiteAccount(deviceId, { register: true }), store.latestApplication(deviceId), store.pendingCount(deviceId), trialFor(machineId)]);
    const payload = { v: 1, deviceId, nonce, serverTime: nowIso(), subscription: account.subscription, registration: account.registration, application, pendingApplications, trial };
    return json(200, { token: c.signToken(payload, key) });
  }

  // Uses one free search, atomically; refused once all are used.
  async function consumeTrial(request, url) {
    const body = await readBody(request);
    const { deviceId, machineId } = await authenticate(request, url, body);
    if ((await subscriptionFor(deviceId)).state === 'active') return json(200, { consumed: false, subscribed: true, trial: await trialFor(machineId) });
    if (!(await store.consumeTrial(machineId, TRIAL_SEARCHES, nowIso()))) {
      throw new HttpError(402, `Your ${TRIAL_SEARCHES} free searches have been used. Choose a plan to keep searching.`);
    }
    return json(200, { consumed: true, trial: await trialFor(machineId) });
  }

  // --- decisions (emailed links and the admin dashboard) ------------------------

  const appRow = async (id) => (/^LF-[0-9A-F]{10}$/.test(id) ? store.application(id) : null);

  // Approves or cancels a pending application. Approval is recorded on this
  // site first (registering the device if needed); if that fails nothing
  // changes and the decision can be retried. tokenHash: an emailed link's,
  // or null for a signed-in administrator.
  async function decide(app, action, tokenHash) {
    const decidedAt = now();
    let website_ = null;
    if (action === 'approve' && app.status === 'pending') {
      if (!app.email) return { fail: [409, 'Email address needed', `Application ${app.id} has no email address, which the subscription website requires. Add Device ID ${app.device_id} on the subscription website and activate it there, then cancel this application.`] };
      try {
        const cur = await website.subscription(app.device_id);
        website_ = licenceFor(PLANS[app.plan], cur?.effectiveStatus === 'active' ? { plan: app.plan, expiresAt: cur.expiresAt } : null, decidedAt);
        const out = await website.activate(app.device_id, app.email, website_.expiresAt);
        if (out?.error) return { fail: [409, 'Not activated', `The subscription website refused it (${out.error.code}: ${out.error.message}). Nothing was changed; fix it on the website, then use this link again.`] };
      } catch (err) {
        logger.error(`[subscription website] ${err.message}`);
        return { fail: [503, 'Subscription website unavailable', 'The subscription website could not be reached, so nothing was changed. Use this link again later.'] };
      }
    }
    const r = await store.decide({ id: app.id, tokenHash, action, now: decidedAt.toISOString(), licenceFor: () => website_ });
    if (r.error) return { error: r.error, status: r.status };
    const plan = PLANS[app.plan];
    if (app.email && app.email_verified) {
      const subject = action === 'approve' ? 'Your Lead Finder subscription is active' : 'Your Lead Finder subscription application was not approved';
      const text =
        action === 'approve'
          ? `Your ${plan.name} subscription (application ${app.id}) is now active.${r.licence.expiresAt ? ` It is valid until ${new Date(r.licence.expiresAt).toUTCString()}.` : ' It never expires.'}`
          : `Your application ${app.id} was cancelled and no subscription was activated. You can submit a new application in Lead Finder.`;
      mailer.send({ to: app.email, subject, text, html: pages.userNotice(subject, text) }).catch((err) => logger.error(`[mail] user notice for ${app.id} failed: ${err.code || ''}`));
    }
    return { ok: true, licence: r.licence, plan };
  }

  async function adminPage(request, url, id, action) {
    const app = await appRow(id);
    const t = app ? await checkToken(url.searchParams.get('token'), id, action) : { error: 'This link is invalid.' };
    // An expired link of a still-pending application: email fresh links
    // (to the administrator only, at most every 10 minutes).
    if (t.expired && app.status === 'pending') {
      const last = await store.lastTokenIssued(id);
      if (!last || now().getTime() - Date.parse(last) > REISSUE_GAP_MS) {
        const approve = makeToken('approve', ACTION_TTL_MS);
        const cancel = makeToken('cancel', ACTION_TTL_MS);
        await store.addTokens(id, [approve, cancel], nowIso());
        const plan = PLANS[app.plan];
        await sendAdminEmail({ id, plan, message: app.message, email: app.email, deviceId: app.device_id, createdAt: app.created_at, current: await subscriptionFor(app.device_id) }, approve.token, cancel.token);
      }
      return html(410, pages.result('Link expired', `This link has expired, but application ${id} is still pending. Fresh Approve and Cancel links have been emailed to you.`));
    }
    if (t.error) return html(t.used ? 409 : 400, pages.result('Link not usable', `${t.error}${app && app.status !== 'pending' ? ` The application is ${app.status}.` : ''}`));
    if (app.status !== 'pending') return html(409, pages.result('Already processed', `Application ${id} is already ${app.status}.`));
    return html(200, pages.confirm({ ...app, planInfo: PLANS[app.plan], current: await subscriptionFor(app.device_id) }, action, url.searchParams.get('token')));
  }

  async function adminAction(request, id, action) {
    const body = (await readBody(request)).toString('utf8');
    const token = new URLSearchParams(body).get('token');
    const app = await appRow(id);
    if (!app) return html(404, pages.result('Not found', 'This application does not exist.'));
    if (!token || token.length > 100) return html(400, pages.result('Link not usable', 'This link is invalid.'));
    // Approval is only attempted on this site with a usable link.
    const usable = !(await checkToken(token, id, action)).error;
    const r = usable || action !== 'approve' ? await decide(app, action, c.hashToken(token)) : await store.decide({ id, tokenHash: c.hashToken(token), action, now: nowIso(), licenceFor: () => null });
    if (r.fail) return html(r.fail[0], pages.result(r.fail[1], r.fail[2]));
    if (r.error) {
      const text = { invalid: 'This link is invalid.', used: 'This link has already been used.', expired: 'This link has expired.', processed: `Application ${id} was already ${r.status}.` }[r.error];
      return html(r.error === 'used' || r.error === 'processed' ? 409 : 400, pages.result(r.error === 'processed' ? 'Already processed' : 'Link not usable', text));
    }
    const plan = PLANS[app.plan];
    const outcome =
      action === 'approve'
        ? { title: 'Subscription approved', text: `${plan.name} activated for application ${id}. ${r.licence.expiresAt ? `It expires on ${new Date(r.licence.expiresAt).toUTCString()}.` : 'It never expires.'}` }
        : { title: 'Application cancelled', text: `Application ${id} was cancelled. The subscription was not activated.` };
    return html(200, pages.result(outcome.title, outcome.text));
  }

  async function screenshot(request, url, id) {
    const app = await appRow(id);
    const token = url.searchParams.get('token');
    let ok = false;
    if (app) for (const a of ['approve', 'cancel']) if (!(await checkToken(token, id, a)).error) ok = true;
    if (!ok) return html(403, pages.result('Not available', 'This link is invalid or has been used.'));
    if (!app.screenshot_path) return html(410, pages.result('Screenshot removed', 'The screenshot is no longer available.'));
    const data = await storage.download(app.screenshot_path);
    return new Response(data, { status: 200, headers: { 'content-type': app.screenshot_type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  }

  async function verifyEmail(url) {
    const token = url.searchParams.get('token');
    const ok = token && token.length <= 100 ? await store.verifyEmail(c.hashToken(token), nowIso()) : false;
    if (!ok) return html(400, pages.result('Link not usable', 'This confirmation link is invalid, expired or already used.'));
    return html(200, pages.result('Email confirmed', 'Thank you. You will be notified by email when your subscription is approved or cancelled.'));
  }

  // --- router -------------------------------------------------------------------------

  async function route(request, raw) {
    const url = new URL(localPath(raw), 'http://local');
    const m = url.pathname.match(/^\/admin\/applications\/([^/]+)\/(approve|cancel|screenshot)$/);
    const method = request.method;
    if (method === 'GET' && url.pathname === '/api/plans') {
      return json(200, { plans: Object.values(PLANS), paymentMethods: PAYMENT_METHODS, paymentInstructions: paymentInstructions || '', trialSearches: TRIAL_SEARCHES });
    }
    if (method === 'POST' && url.pathname === '/api/applications') return apply(request, url);
    if (method === 'GET' && url.pathname === '/api/license') return license(request, url);
    if (method === 'POST' && url.pathname === '/api/trial/consume') return consumeTrial(request, url);
    if (m && m[2] === 'screenshot' && method === 'GET') return screenshot(request, url, m[1]);
    if (m && method === 'GET') return adminPage(request, url, m[1], m[2]);
    if (m && method === 'POST') return adminAction(request, m[1], m[2]);
    if (method === 'GET' && url.pathname === '/verify-email') return verifyEmail(url);
    if (method === 'GET' && url.pathname === '/health') return json(200, { ok: true });
    throw new HttpError(404, 'Not found');
  }

  async function handle(request) {
    const u = new URL(request.url);
    const raw = u.pathname + u.search;
    try {
      return await route(request, raw);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) logger.error(`[error] ${request.method} ${u.pathname}: ${String(err.message).split('\n')[0]}`);
      if (localPath(raw).startsWith('/api/')) return json(status, { error: status === 500 ? 'Server error' : err.message });
      return html(status, pages.result('Error', status === 500 ? 'Something went wrong.' : err.message));
    }
  }

  return { handle, decide, appRow };
}

export { createLicenceHandler, HttpError, licenceFor };
