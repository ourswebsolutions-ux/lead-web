// Licence data in MySQL (Prisma), replacing the licence server's SQLite
// store (server/src/store.js) method for method. Rows and values come back in
// the same shapes as before (snake_case rows, ISO time strings), so the
// request handling is unchanged. Operations that must happen once (replay
// protection, free searches, single-use links, decisions) use conditional
// writes, so concurrent requests can't both succeed.

import crypto from 'node:crypto';

const iso = (d) => (d ? new Date(d).toISOString() : null);
const date = (s) => (s ? new Date(s) : null);
const isDuplicate = (err) => err?.code === 'P2002';

function appRow(a) {
  return {
    seq: a.seq,
    id: a.id,
    device_id: a.deviceId,
    plan: a.plan,
    message: a.message,
    email: a.email,
    email_verified: a.emailVerified ? 1 : 0,
    screenshot_path: a.screenshotPath,
    screenshot_type: a.screenshotType,
    screenshot_size: a.screenshotSize,
    screenshot_sha256: a.screenshotSha256,
    status: a.status,
    created_at: iso(a.createdAt),
    decided_at: iso(a.decidedAt),
  };
}

function activationRow(a) {
  return {
    id: a.id,
    device_id: a.deviceId,
    machine_id: a.machineId,
    open_for: a.openFor,
    plan: a.plan,
    status: a.status,
    otp_hash: a.otpHash,
    otp_expires_at: iso(a.otpExpiresAt),
    otp_attempts: a.otpAttempts,
    otp_sent_at: iso(a.otpSentAt),
    otp_sends: a.otpSends,
    otp_window_start: iso(a.otpWindowStart),
    created_at: iso(a.createdAt),
    activated_at: iso(a.activatedAt),
  };
}

const MAX_OTP_ATTEMPTS = 5;
class Exhausted extends Error {}

// Users of this site have a unique email; a device activated in Lead Finder
// (which asks for none) gets one derived from its Device ID. The lowercased
// ID plus a hash of the exact ID keeps it unique.
function placeholderEmail(deviceId) {
  const h = crypto.createHash('sha256').update(deviceId).digest('hex').slice(0, 8);
  return `${deviceId.toLowerCase().replace(/[^a-z0-9_-]/g, '')}.${h}@device.leadfinder.invalid`;
}

// The subscription an activation gives. Free is set as it is; a lifetime
// subscription stays lifetime; renewing the same plan before it runs out
// continues from its current end.
function licenceForActivation(plan, cur, now, planExpiry) {
  if (plan.id === 'free') return { plan: 'free', expiresAt: null };
  if (cur?.state === 'active' && cur.plan === 'lifetime') return { plan: 'lifetime', expiresAt: null };
  const from = cur?.state === 'active' && cur.plan === plan.id && cur.expiresAt && cur.expiresAt > now ? new Date(cur.expiresAt) : new Date(now);
  return { plan: plan.id, expiresAt: planExpiry(plan, from) };
}

function tokenRow(t) {
  return { hash: t.hash, application_id: t.applicationId, action: t.action, created_at: iso(t.createdAt), expires_at: iso(t.expiresAt), used_at: iso(t.usedAt) };
}

class Store {
  constructor(prisma) {
    this.prisma = prisma;
  }

  // --- request authentication ------------------------------------------------

  // Replay protection: each signed request is accepted once.
  async rememberRequest(sigHash, nowMs, ttlMs) {
    await this.prisma.licenceSeenRequest.deleteMany({ where: { expiresAt: { lt: BigInt(nowMs) } } });
    try {
      await this.prisma.licenceSeenRequest.create({ data: { sigHash, expiresAt: BigInt(nowMs + ttlMs) } });
      return true;
    } catch (err) {
      if (isDuplicate(err)) return false;
      throw err;
    }
  }

  async upsertDevice(id, publicKey, now) {
    const row = await this.prisma.licenceDevice.findUnique({ where: { id } });
    if (row && row.publicKey !== publicKey) throw new Error('device key mismatch');
    if (row) {
      await this.prisma.licenceDevice.update({ where: { id }, data: { lastSeenAt: date(now) } });
      return;
    }
    try {
      await this.prisma.licenceDevice.create({ data: { id, publicKey, createdAt: date(now), lastSeenAt: date(now) } });
    } catch (err) {
      if (!isDuplicate(err)) throw err;
      // Registered concurrently: the key must still be the same.
      const again = await this.prisma.licenceDevice.findUnique({ where: { id } });
      if (again.publicKey !== publicKey) throw new Error('device key mismatch');
    }
  }

  // --- subscription state ------------------------------------------------------

  async latestApplication(deviceId) {
    const a = await this.prisma.licenceApplication.findFirst({ where: { deviceId }, orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }], select: { id: true, plan: true, status: true, createdAt: true, decidedAt: true } });
    return a ? { id: a.id, plan: a.plan, status: a.status, createdAt: iso(a.createdAt), decidedAt: iso(a.decidedAt) } : null;
  }

  // The customer's email from their latest application that has one.
  async latestEmail(deviceId) {
    const a = await this.prisma.licenceApplication.findFirst({ where: { deviceId, email: { not: null } }, orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }], select: { email: true } });
    return a?.email || null;
  }

  pendingCount(deviceId) {
    return this.prisma.licenceApplication.count({ where: { deviceId, status: 'pending' } });
  }

  async trialUsed(machineId) {
    return (await this.prisma.licenceTrial.findUnique({ where: { machineId } }))?.used || 0;
  }

  // Atomically uses one free search; false when none are left.
  async consumeTrial(machineId, limit, now) {
    await this.prisma.$executeRaw`INSERT IGNORE INTO licence_trials (machine_id, used, updated_at) VALUES (${machineId}, 0, ${date(now)})`;
    const { count } = await this.prisma.licenceTrial.updateMany({ where: { machineId, used: { lt: limit } }, data: { used: { increment: 1 }, updatedAt: date(now) } });
    return count === 1;
  }

  // --- applications ------------------------------------------------------------

  countApplicationsSince(deviceId, since) {
    return this.prisma.licenceApplication.count({ where: { deviceId, createdAt: { gte: date(since) } } });
  }

  async createApplication(app, tokens) {
    await this.prisma.$transaction([
      this.prisma.licenceApplication.create({
        data: {
          id: app.id,
          deviceId: app.deviceId,
          plan: app.plan,
          message: app.message,
          email: app.email,
          screenshotPath: app.screenshotPath,
          screenshotType: app.screenshotType,
          screenshotSize: app.screenshotSize,
          screenshotSha256: app.screenshotSha256,
          status: 'pending',
          createdAt: date(app.createdAt),
        },
      }),
      this.insertTokens(app.id, tokens, app.createdAt),
    ]);
  }

  insertTokens(applicationId, tokens, now) {
    return this.prisma.licenceActionToken.createMany({ data: tokens.map((t) => ({ hash: t.hash, applicationId, action: t.action, createdAt: date(now), expiresAt: date(t.expiresAt) })) });
  }

  // Only for an application whose approval email could not be sent (no one
  // has seen it). Explicit id; tokens go with it (ON DELETE CASCADE).
  async discardUnsentApplication(id) {
    await this.prisma.licenceApplication.deleteMany({ where: { id, status: 'pending', decidedAt: null } });
  }

  async application(id) {
    const a = await this.prisma.licenceApplication.findUnique({ where: { id } });
    return a ? appRow(a) : null;
  }

  async token(hash) {
    const t = await this.prisma.licenceActionToken.findUnique({ where: { hash } });
    return t ? tokenRow(t) : null;
  }

  async addTokens(applicationId, tokens, now) {
    await this.insertTokens(applicationId, tokens, now);
  }

  async lastTokenIssued(applicationId) {
    const r = await this.prisma.licenceActionToken.aggregate({ where: { applicationId, action: { in: ['approve', 'cancel'] } }, _max: { createdAt: true } });
    return iso(r._max.createdAt);
  }

  // Approve or cancel once, in one transaction, by an emailed link
  // (tokenHash) or by a signed-in administrator (tokenHash null).
  // licenceFor(appRow) supplies the new licence for approvals.
  async decide({ id, tokenHash, action, now, licenceFor }) {
    return this.prisma.$transaction(async (tx) => {
      if (tokenHash) {
        const t = await tx.licenceActionToken.findUnique({ where: { hash: tokenHash } });
        if (!t || t.applicationId !== id || t.action !== action) return { error: 'invalid' };
        if (t.usedAt) return { error: 'used' };
        if (iso(t.expiresAt) < now) return { error: 'expired' };
        // Only one request can spend the link.
        const spent = await tx.licenceActionToken.updateMany({ where: { hash: tokenHash, usedAt: null }, data: { usedAt: date(now) } });
        if (spent.count !== 1) return { error: 'used' };
      }
      const a = await tx.licenceApplication.findUnique({ where: { id } });
      if (!a) return { error: 'invalid' };
      await tx.licenceActionToken.updateMany({ where: { applicationId: id, action: { in: ['approve', 'cancel'] }, usedAt: null }, data: { usedAt: date(now) } });
      const decided = await tx.licenceApplication.updateMany({ where: { id, status: 'pending' }, data: { status: action === 'approve' ? 'approved' : 'cancelled', decidedAt: date(now) } });
      if (decided.count !== 1) return { error: 'processed', status: a.status };
      const app = appRow(a);
      if (action !== 'approve') return { ok: true, app };
      return { ok: true, app, licence: licenceFor(app) };
    });
  }

  async verifyEmail(tokenHash, now) {
    return this.prisma.$transaction(async (tx) => {
      const t = await tx.licenceActionToken.findUnique({ where: { hash: tokenHash } });
      if (!t || t.action !== 'verify_email' || t.usedAt || iso(t.expiresAt) < now) return false;
      const spent = await tx.licenceActionToken.updateMany({ where: { hash: tokenHash, usedAt: null }, data: { usedAt: date(now) } });
      if (spent.count !== 1) return false;
      await tx.licenceApplication.update({ where: { id: t.applicationId }, data: { emailVerified: true } });
      return true;
    });
  }

  // --- subscriptions (this site's users) ---------------------------------------------

  // { state: 'active'|'expired'|'suspended'|'inactive'|'none', plan, expiresAt, activatedAt }.
  // Subscriptions activated before plans were recorded have no plan: it is
  // the plan of the device's approved payment application, or else One-Time
  // when the subscription never expires and Monthly when it does.
  async subscription(deviceId, now, db = this.prisma) {
    const u = await db.user.findUnique({ where: { id: deviceId }, include: { subscription: true } });
    if (!u || u.id !== deviceId || !u.subscription) return { state: 'none' };
    const sub = u.subscription;
    const expiresAt = iso(sub.expiresAt);
    let plan = sub.plan;
    if (!plan && sub.status !== 'inactive') {
      const app = await db.licenceApplication.findFirst({ where: { deviceId, status: 'approved' }, orderBy: [{ decidedAt: 'desc' }, { seq: 'desc' }], select: { plan: true } });
      plan = app?.plan || (expiresAt ? 'monthly' : 'lifetime');
    }
    const expired = sub.status === 'active' && expiresAt && expiresAt <= now;
    return { state: expired ? 'expired' : sub.status, plan: plan || null, expiresAt, activatedAt: iso(sub.activatedAt), email: u.email };
  }

  // --- activation requests -------------------------------------------------------------

  async activation(id) {
    const a = await this.prisma.licenceActivation.findUnique({ where: { id } });
    return a ? activationRow(a) : null;
  }

  // The installation's open request. One whose code has expired is closed
  // first (the next request starts a new one).
  async openActivation(deviceId, now) {
    await this.prisma.licenceActivation.updateMany({ where: { openFor: deviceId, otpExpiresAt: { lte: date(now) } }, data: { status: 'expired', openFor: null, otpHash: null } });
    const a = await this.prisma.licenceActivation.findUnique({ where: { openFor: deviceId } });
    return a && a.deviceId === deviceId ? activationRow(a) : null;
  }

  async latestActivation(deviceId) {
    const a = await this.prisma.licenceActivation.findFirst({ where: { deviceId }, orderBy: { createdAt: 'desc' } });
    return a ? activationRow(a) : null;
  }

  countActivationsSince(deviceId, since) {
    return this.prisma.licenceActivation.count({ where: { deviceId, createdAt: { gte: date(since) } } });
  }

  // A new request with its first code. An open request for another plan is
  // replaced; one for the same plan is kept: { row, created }.
  async createActivation(r) {
    const open = await this.prisma.licenceActivation.findUnique({ where: { openFor: r.deviceId } });
    if (open?.plan === r.plan) return { row: activationRow(open), created: false };
    if (open) await this.prisma.licenceActivation.updateMany({ where: { id: open.id, openFor: r.deviceId }, data: { status: 'cancelled', openFor: null, otpHash: null } });
    try {
      const a = await this.prisma.licenceActivation.create({
        data: { id: r.id, deviceId: r.deviceId, machineId: r.machineId, openFor: r.deviceId, plan: r.plan, status: 'pending', otpHash: r.otpHash, otpExpiresAt: date(r.otpExpiresAt), otpSentAt: date(r.now), otpSends: 1, otpWindowStart: date(r.now), createdAt: date(r.now) },
      });
      return { row: activationRow(a), created: true };
    } catch (err) {
      if (!isDuplicate(err)) throw err;
      // Requested twice at once: the other request's row stands.
      const other = await this.prisma.licenceActivation.findUnique({ where: { openFor: r.deviceId } });
      if (!other) throw err;
      return { row: activationRow(other), created: false };
    }
  }

  // A replacement code, limited by a cooldown and a number per day.
  async replaceOtp({ id, otpHash, otpExpiresAt, now, cooldownMs, maxPerDay }) {
    const r = await this.activation(id);
    if (!r || r.status !== 'pending') return { error: 'not_open' };
    const next = r.otp_sent_at ? Date.parse(r.otp_sent_at) + cooldownMs : 0;
    if (next > Date.parse(now)) return { error: 'cooldown', retryAt: new Date(next).toISOString() };
    const windowFresh = r.otp_window_start && Date.parse(now) - Date.parse(r.otp_window_start) < 86_400_000;
    if (windowFresh && r.otp_sends >= maxPerDay) return { error: 'limit' };
    // Conditional on what was read, so two at once send one code.
    const { count } = await this.prisma.licenceActivation.updateMany({
      where: { id, status: 'pending', otpSends: r.otp_sends, otpSentAt: date(r.otp_sent_at) },
      data: { otpHash, otpExpiresAt: date(otpExpiresAt), otpAttempts: 0, otpSentAt: date(now), otpSends: windowFresh ? r.otp_sends + 1 : 1, otpWindowStart: windowFresh ? date(r.otp_window_start) : date(now) },
    });
    if (count !== 1) return { error: 'cooldown', retryAt: new Date(Date.parse(now) + cooldownMs).toISOString() };
    return { row: await this.activation(id) };
  }

  // Undoes a request whose email could not be sent (nobody has the code).
  async cancelActivation(id) {
    const { count } = await this.prisma.licenceActivation.updateMany({ where: { id, openFor: { not: null } }, data: { status: 'cancelled', openFor: null, otpHash: null } });
    return count === 1;
  }

  // Uses up one attempt of the current code before it is compared, so even
  // simultaneous guesses can't exceed the limit. The row, or null when no
  // attempt is left.
  async claimOtpAttempt(id, deviceId) {
    const { count } = await this.prisma.licenceActivation.updateMany({
      where: { id, deviceId, status: 'pending', otpHash: { not: null }, otpAttempts: { lt: MAX_OTP_ATTEMPTS } },
      data: { otpAttempts: { increment: 1 } },
    });
    return count === 1 ? this.activation(id) : null;
  }

  // The code was right: uses it up and activates the request's plan on this
  // site's user and subscription, in one transaction.
  // { subscription } or { error: 'invalid'|'expired'|'not_open' }.
  async activateWithOtp({ id, deviceId, otpHash, matches, now, plans, planExpiry }) {
    const r = await this.activation(id);
    if (!r || r.device_id !== deviceId || r.status !== 'pending' || !r.otp_hash) return { error: 'not_open' };
    if (!matches(r.otp_hash, otpHash)) return { error: 'invalid' };
    if (r.otp_expires_at <= now) return { error: 'expired' };
    const plan = plans[r.plan] || plans.free;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const used = await tx.licenceActivation.updateMany({
          where: { id, status: 'pending', otpHash: r.otp_hash, otpExpiresAt: { gt: date(now) } },
          data: { status: 'activated', openFor: null, otpHash: null, activatedAt: date(now) },
        });
        if (used.count !== 1) throw Object.assign(new Error('code already used'), { code: 'LF_USED' });
        const cur = await this.subscription(deviceId, now, tx);
        const lic = licenceForActivation(plan, cur, now, planExpiry);
        const sub = { status: 'active', plan: lic.plan, expiresAt: date(lic.expiresAt), activatedAt: date(now), suspendedAt: null };
        const user = await tx.user.findUnique({ where: { id: deviceId } });
        if (!user || user.id !== deviceId) {
          // This site's users need an email; activations don't ask for one.
          await tx.user.create({ data: { id: deviceId, email: placeholderEmail(deviceId), subscription: { create: sub } } });
        } else {
          await tx.subscription.upsert({ where: { userId: deviceId }, update: sub, create: { userId: deviceId, ...sub } });
        }
        return { subscription: await this.subscription(deviceId, now, tx) };
      });
    } catch (err) {
      if (err?.code === 'LF_USED') return { error: 'not_open' };
      throw err;
    }
  }

  // --- daily allowance -------------------------------------------------------------

  // Charges one qualified lead, atomically:
  //   the same lead (account + key) again    { granted: true, duplicate: true }, not charged
  //   room left today (or no limit)          { granted: true }, charged
  //   the counter is at its limit            { granted: false }, nothing written
  //
  // The day's counter row exists before the transaction, so the transaction
  // only takes its exclusive lock (an INSERT IGNORE inside would take a
  // shared lock first, and concurrent upgrades deadlock). Every transaction
  // locks in the same order (its own ledger row, then the counter); a
  // conflict MySQL still reports as retryable is retried.
  async reserveCredit({ account, key, day, bucket, limit, source, deviceId, now }) {
    await this.prisma.$executeRaw`INSERT IGNORE INTO licence_credit_usage (account, day, bucket, used) VALUES (${account}, ${day}, ${bucket}, 0)`;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.prisma.$transaction(
          async (tx) => {
            await tx.licenceCreditLead.create({ data: { account, leadKey: key, day, bucket, source, deviceId, createdAt: date(now) } });
            const { count } = await tx.licenceCreditUsage.updateMany({ where: { account, day, bucket, ...(limit === null ? {} : { used: { lt: limit } }) }, data: { used: { increment: 1 } } });
            if (count !== 1) throw new Exhausted();
          },
          { maxWait: 15_000, timeout: 15_000 },
        );
        return { granted: true, duplicate: false };
      } catch (err) {
        if (err instanceof Exhausted) return { granted: false, duplicate: false };
        if (isDuplicate(err)) return { granted: true, duplicate: true };
        // P2034: write conflict or deadlock (MySQL rolled it back).
        if (err?.code === 'P2034' && attempt < 8) {
          await new Promise((r) => setTimeout(r, 5 + Math.random() * 20 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
  }

  // Today's counters ({ total } or { maps, facebook }) and the leads
  // charged today by source.
  async usageToday(account, day) {
    const counters = {};
    for (const r of await this.prisma.licenceCreditUsage.findMany({ where: { account, day }, select: { bucket: true, used: true } })) counters[r.bucket] = r.used;
    const bySource = { maps: 0, facebook: 0 };
    for (const r of await this.prisma.licenceCreditLead.groupBy({ by: ['source'], where: { account, day }, _count: { _all: true } })) bySource[r.source] = r._count._all;
    return { counters, bySource };
  }

  discovered(account) {
    return this.prisma.licenceCreditLead.count({ where: { account } });
  }

  // Today's leads per device, for the dashboard: { [deviceId]: { maps, facebook } }.
  async usageByDevice(day) {
    const out = {};
    for (const r of await this.prisma.licenceCreditLead.groupBy({ by: ['deviceId', 'source'], where: { day }, _count: { _all: true } })) {
      (out[r.deviceId] ||= { maps: 0, facebook: 0 })[r.source] = r._count._all;
    }
    return out;
  }

  // --- audit -------------------------------------------------------------------------

  async audit({ at, actor, action, target, details }) {
    await this.prisma.licenceAuditLog.create({ data: { at: date(at), actor: String(actor).slice(0, 100), action, target: String(target).slice(0, 100), details: details ? JSON.stringify(details) : null } });
  }

  async auditLog(limit = 200) {
    const rows = await this.prisma.licenceAuditLog.findMany({ orderBy: { id: 'desc' }, take: limit });
    return rows.map((r) => ({ id: r.id, at: iso(r.at), actor: r.actor, action: r.action, target: r.target, details: r.details ? JSON.parse(r.details) : null }));
  }

  // --- admin dashboard -------------------------------------------------------------

  async listApplications({ status } = {}) {
    const rows = await this.prisma.licenceApplication.findMany({ where: status ? { status } : undefined, orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }], take: 500 });
    return rows.map(appRow);
  }
}

export { Store, MAX_OTP_ATTEMPTS, licenceForActivation };
