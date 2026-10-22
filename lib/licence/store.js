// Licence data in MySQL (Prisma), replacing the licence server's SQLite
// store (server/src/store.js) method for method. Rows and values come back in
// the same shapes as before (snake_case rows, ISO time strings), so the
// request handling is unchanged. Operations that must happen once (replay
// protection, free searches, single-use links, decisions) use conditional
// writes, so concurrent requests can't both succeed.

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

  // --- admin dashboard -------------------------------------------------------------

  async listApplications({ status } = {}) {
    const rows = await this.prisma.licenceApplication.findMany({ where: status ? { status } : undefined, orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }], take: 500 });
    return rows.map(appRow);
  }
}

export { Store };
