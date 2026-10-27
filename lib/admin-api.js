// Admin API (/api/v1), behind the admin login (middleware.js).
//
//   GET    /api/v1/users[?search=…]          list users (search by user ID or email)
//   POST   /api/v1/users                     add a user { id, email }
//   DELETE /api/v1/users/:id                 delete a user and their subscription
//   PATCH  /api/v1/users/:id/subscription    { status: 'active', expiresAt } | { status: 'suspended' }
//   GET    /api/v1/applications[?status=…]   Lead Getter payment applications
//   GET    /api/v1/applications/:id/screenshot
//   POST   /api/v1/applications/:id/approve | /cancel

// Same requests, responses and error codes as the earlier Express version.

import { prisma } from './prisma.js';
import { Users } from './users.js';
import { ID_RE, EMAIL_RE, ISO_RE } from './validation.js';
import { licence } from './licence/index.js';
import { PLANS, PLAN_IDS } from './licence/plans.js';
import { dayKey, entitlementFor } from './licence/credits.js';

const MAX_EXPIRY = Date.UTC(9999, 11, 31);

// Who did it, for the audit log: the signed-in administrator (the
// middleware already checked the credentials).
function actorOf(request) {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(request.headers.get('authorization') || '');
  const user = m ? Buffer.from(m[1], 'base64').toString('utf8').split(':')[0] : '';
  return `admin:${user || 'unknown'}`.slice(0, 100);
}

async function audit(request, action, target, details) {
  try {
    await licence().store.audit({ at: new Date().toISOString(), actor: actorOf(request), action, target, details });
  } catch (err) {
    console.error(`[audit] ${String(err.message).split('\n')[0]}`);
  }
}
const MAX_JSON = 10 * 1024;

// Prisma errors meaning the database can't be reached or used right now:
// P1000 auth failed, P1001 unreachable, P1002 timed out, P1003 no database,
// P1008 operation timed out, P1011 TLS, P1017 connection closed, P2024 pool timeout.
const DB_DOWN = new Set(['P1000', 'P1001', 'P1002', 'P1003', 'P1008', 'P1011', 'P1017', 'P2024']);

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status, data) => new Response(JSON.stringify(data), { status, headers });
const notFound = () => json(404, { error: { code: 'not_found', message: 'No such API route.' } });

let usersStore = null;
const users = () => (usersStore ||= new Users(prisma));

// Wraps a handler: errors become { error: { code, message } }.
function handler(fn, logger = console) {
  return async (request, ctx) => {
    try {
      return await fn(request, (await ctx?.params) || {});
    } catch (err) {
      let e = err;
      if (!(err instanceof ApiError)) {
        const code = err.code || err.errorCode || '';
        const down = DB_DOWN.has(code) || err.name === 'PrismaClientInitializationError';
        // Prisma messages are multi-line; the last line holds the cause.
        logger.error(`[error] ${request.method} ${new URL(request.url).pathname}: ${code} ${String(err.message).trim().split('\n').pop()}`);
        e = down ? new ApiError(503, 'database_unavailable', 'The database is unavailable. Please try again shortly.') : new ApiError(500, 'server_error', 'Something went wrong on the server.');
      }
      return json(e.status, { error: { code: e.code, message: e.message, ...(e.details ? { fields: e.details } : {}) } });
    }
  };
}

// Like express.json({ limit: '10kb', strict: true }): an empty body is
// "no body"; otherwise a JSON object or array.
async function readJson(request) {
  const buf = Buffer.from(await request.arrayBuffer());
  if (buf.length > MAX_JSON) throw new ApiError(413, 'body_too_large', 'The request body is too large.');
  const text = buf.toString('utf8');
  if (!text.trim()) return undefined;
  if (!/^\s*[{[]/.test(text)) throw new ApiError(400, 'invalid_json', 'The request body is not valid JSON.');
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'invalid_json', 'The request body is not valid JSON.');
  }
}

function requireBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_body', 'The request body must be a JSON object.');
  return body;
}

function userId(params) {
  const id = params.id;
  if (!ID_RE.test(id)) throw new ApiError(400, 'invalid_user_id', 'User ID must be 3–64 characters: letters, digits, "-" or "_".');
  return id;
}

// --- users ---------------------------------------------------------------------

// Each user with their effective plan (what their daily lead allowance
// comes from) and today's qualified leads.
export const listUsers = handler(async (request) => {
  const q = new URL(request.url).searchParams.get('search');
  const list = await users().list(typeof q === 'string' ? q.slice(0, 254) : '');
  const { store, handler: lh } = licence();
  const now = new Date();
  const usage = await store.usageByDevice(dayKey(now, lh.timezone));
  const withPlan = await Promise.all(
    list.map(async (u) => {
      const ent = entitlementFor(await store.subscription(u.id, now.toISOString()), PLANS);
      const p = PLANS[ent.planId] || PLANS.free;
      return { ...u, plan: { id: p.id, name: p.name, daily: p.daily }, usageToday: usage[u.id] || { maps: 0, facebook: 0 } };
    }),
  );
  return json(200, { users: withPlan, count: withPlan.length });
});

export const createUser = handler(async (request) => {
  const body = requireBody(await readJson(request));
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const errors = {};
  if (!ID_RE.test(id)) errors.id = 'User ID must be 3–64 characters: letters, digits, "-" or "_".';
  if (!EMAIL_RE.test(email) || email.length > 254) errors.email = 'Enter a valid email address.';
  if (Object.keys(errors).length) throw new ApiError(400, 'validation_failed', Object.values(errors).join(' '), errors);
  try {
    return json(201, { user: await users().create({ id, email }) });
  } catch (err) {
    if (err.code !== 'P2002') throw err;
    // meta.target is the violated index ('users_email_unique' or 'PRIMARY').
    if (/email/.test(String(err.meta?.target))) throw new ApiError(409, 'email_exists', `A user with the email ${email} already exists.`);
    throw new ApiError(409, 'user_exists', `A user with the ID ${id} already exists.`);
  }
});

export const deleteUser = handler(async (request, params) => {
  const id = userId(params);
  if (!(await users().remove(id))) throw new ApiError(404, 'user_not_found', `No user with the ID ${id}.`);
  await audit(request, 'user.deleted', id, null);
  return json(200, { deleted: true, id });
});

export const patchSubscription = handler(async (request, params) => {
  const id = userId(params);
  const body = requireBody(await readJson(request));
  if (body.id !== undefined && body.id !== id) throw new ApiError(400, 'user_id_mismatch', 'The user ID in the body does not match the URL.');
  if (body.plan !== undefined && !PLAN_IDS.includes(body.plan)) throw new ApiError(400, 'invalid_plan', `plan must be one of: ${PLAN_IDS.join(', ')}.`);
  if (body.plan !== undefined && body.status !== 'active') throw new ApiError(400, 'unexpected_plan', 'plan is only accepted when activating.');
  let user;
  if (body.status === 'active') {
    if (!('expiresAt' in body)) throw new ApiError(400, 'expiry_required', 'expiresAt is required when activating (an ISO 8601 date-time, or null for no expiry).');
    let expiresAt = null;
    if (body.expiresAt !== null) {
      const t = typeof body.expiresAt === 'string' && ISO_RE.test(body.expiresAt) ? Date.parse(body.expiresAt) : NaN;
      if (Number.isNaN(t) || t > MAX_EXPIRY) throw new ApiError(400, 'invalid_expiry', 'expiresAt must be an ISO 8601 date-time with a timezone, e.g. 2026-12-21T23:59:59Z.');
      if (t <= Date.now()) throw new ApiError(400, 'expiry_in_past', 'expiresAt must be in the future.');
      expiresAt = new Date(t);
    }
    user = await users().activate(id, expiresAt, body.plan || null);
  } else if (body.status === 'suspended' || body.status === 'inactive') {
    if (body.expiresAt !== undefined) throw new ApiError(400, 'unexpected_expiry', 'expiresAt is only accepted when activating.');
    // Suspended: no leads at all. Inactive (revoked): back to the Free allowance.
    user = body.status === 'suspended' ? await users().suspend(id) : await users().revoke(id);
  } else {
    throw new ApiError(400, 'invalid_status', 'status must be "active", "suspended" or "inactive".');
  }
  if (!user) throw new ApiError(404, 'user_not_found', `No user with the ID ${id}.`);
  await audit(request, `subscription.${body.status === 'inactive' ? 'revoked' : body.status}`, id, body.status === 'active' ? { plan: body.plan || user.subscription.plan, expiresAt: user.subscription.expiresAt } : null);
  return json(200, { user, status: user.subscription.effectiveStatus });
});

// --- payment applications (Lead Getter) --------------------------------------------

async function applicationView(a) {
  const plan = PLANS[a.plan];
  const user = await users().get(a.device_id);
  return {
    id: a.id,
    deviceId: a.device_id,
    plan: a.plan,
    planName: plan?.name || a.plan,
    priceLabel: plan?.priceLabel || '',
    email: a.email,
    emailVerified: Boolean(a.email_verified),
    message: a.message,
    status: a.status,
    createdAt: a.created_at,
    decidedAt: a.decided_at,
    hasScreenshot: Boolean(a.screenshot_path),
    user: user && user.id === a.device_id ? user : null,
  };
}

async function findApplication(params) {
  const app = await licence().handler.appRow(String(params.id || ''));
  if (!app) throw new ApiError(404, 'application_not_found', `No application with the ID ${params.id}.`);
  return app;
}

export const listApplications = handler(async (request) => {
  const status = new URL(request.url).searchParams.get('status') || '';
  if (status && !['pending', 'approved', 'cancelled'].includes(status)) throw new ApiError(400, 'invalid_status', 'status must be "pending", "approved" or "cancelled".');
  const rows = await licence().store.listApplications({ status: status || undefined });
  const applications = await Promise.all(rows.map(applicationView));
  return json(200, { applications, count: applications.length });
});

export const applicationScreenshot = handler(async (request, params) => {
  const app = await findApplication(params);
  if (!app.screenshot_path) throw new ApiError(410, 'screenshot_removed', 'The screenshot is no longer available.');
  const data = await licence().storage.download(app.screenshot_path);
  return new Response(data, { status: 200, headers: { 'content-type': app.screenshot_type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
});

// Same decision as the emailed Approve/Cancel links, by the signed-in admin.
export function decideApplication(action) {
  return handler(async (request, params) => {
    const app = await findApplication(params);
    const r = await licence().handler.decide(app, action, null);
    if (r.ok) await audit(request, `application.${action === 'approve' ? 'approved' : 'cancelled'}`, app.id, { deviceId: app.device_id, plan: app.plan });
    if (r.fail) throw new ApiError(r.fail[0], action === 'approve' ? 'not_activated' : 'not_cancelled', r.fail[2]);
    if (r.error === 'processed') throw new ApiError(409, 'already_processed', `Application ${app.id} was already ${r.status}.`);
    if (r.error) throw new ApiError(400, r.error, `Application ${app.id} could not be ${action === 'approve' ? 'approved' : 'cancelled'} (${r.error}).`);
    return json(200, { application: await applicationView(await licence().handler.appRow(app.id)) });
  });
}

export { notFound, json, handler };
