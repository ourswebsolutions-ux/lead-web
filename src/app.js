'use strict';

// Admin page and API for Axora subscriptions.
//
//   GET    /api/v1/users[?search=…]          list users (search by user ID or email)
//   POST   /api/v1/users                     add a user { id, email }
//   DELETE /api/v1/users/:id                 delete a user and their subscription
//   PATCH  /api/v1/users/:id/subscription    { status: 'active', expiresAt } | { status: 'suspended' }
//
// Everything, the page included, requires admin authorization (src/auth.js).

const path = require('node:path');
const express = require('express');
const { createAuth } = require('./auth');

const ID_RE = /^[A-Za-z0-9_-]{3,64}$/;
const EMAIL_RE = /^[^\s@<>()",;:]{1,64}@[^\s@<>()",;:]{1,189}\.[a-z]{2,24}$/i;
// ISO 8601 date-time with an explicit timezone (Z or ±hh:mm).
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_EXPIRY = Date.UTC(9999, 11, 31);

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// Prisma errors meaning the database can't be reached or used right now:
// P1000 auth failed, P1001 unreachable, P1002 timed out, P1003 no database,
// P1008 operation timed out, P1011 TLS, P1017 connection closed, P2024 pool timeout.
const DB_DOWN = new Set(['P1000', 'P1001', 'P1002', 'P1003', 'P1008', 'P1011', 'P1017', 'P2024']);
const prismaCode = (err) => err.code || err.errorCode;

function createApp({ config, users, now = () => new Date(), logger = console }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('etag', false);

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
    });
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  app.use(createAuth(config));
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', etag: false, lastModified: false }));

  const api = express.Router();
  api.use(express.json({ limit: '10kb', strict: true, type: () => true }));

  function userId(req) {
    const { id } = req.params;
    if (!ID_RE.test(id)) throw new ApiError(400, 'invalid_user_id', 'User ID must be 3–64 characters: letters, digits, "-" or "_".');
    return id;
  }

  function requireBody(req) {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new ApiError(400, 'invalid_body', 'The request body must be a JSON object.');
    return req.body;
  }

  api.get('/users', async (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 254) : '';
    const list = await users.list(search);
    res.json({ users: list, count: list.length });
  });

  api.post('/users', async (req, res) => {
    const body = requireBody(req);
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const errors = {};
    if (!ID_RE.test(id)) errors.id = 'User ID must be 3–64 characters: letters, digits, "-" or "_".';
    if (!EMAIL_RE.test(email) || email.length > 254) errors.email = 'Enter a valid email address.';
    if (Object.keys(errors).length) throw new ApiError(400, 'validation_failed', Object.values(errors).join(' '), errors);
    try {
      const user = await users.create({ id, email });
      res.status(201).json({ user });
    } catch (err) {
      if (err.code !== 'P2002') throw err;
      // meta.target is the violated index ('users_email_unique' or 'PRIMARY').
      if (/email/.test(String(err.meta?.target))) throw new ApiError(409, 'email_exists', `A user with the email ${email} already exists.`);
      throw new ApiError(409, 'user_exists', `A user with the ID ${id} already exists.`);
    }
  });

  api.delete('/users/:id', async (req, res) => {
    const id = userId(req);
    if (!(await users.remove(id))) throw new ApiError(404, 'user_not_found', `No user with the ID ${id}.`);
    res.json({ deleted: true, id });
  });

  api.patch('/users/:id/subscription', async (req, res) => {
    const id = userId(req);
    const body = requireBody(req);
    if (body.id !== undefined && body.id !== id) throw new ApiError(400, 'user_id_mismatch', 'The user ID in the body does not match the URL.');
    let user;
    if (body.status === 'active') {
      if (!('expiresAt' in body)) throw new ApiError(400, 'expiry_required', 'expiresAt is required when activating (an ISO 8601 date-time, or null for no expiry).');
      let expiresAt = null;
      if (body.expiresAt !== null) {
        const t = typeof body.expiresAt === 'string' && ISO_RE.test(body.expiresAt) ? Date.parse(body.expiresAt) : NaN;
        if (Number.isNaN(t) || t > MAX_EXPIRY) throw new ApiError(400, 'invalid_expiry', 'expiresAt must be an ISO 8601 date-time with a timezone, e.g. 2026-12-21T23:59:59Z.');
        if (t <= now().getTime()) throw new ApiError(400, 'expiry_in_past', 'expiresAt must be in the future.');
        expiresAt = new Date(t);
      }
      user = await users.activate(id, expiresAt);
    } else if (body.status === 'suspended') {
      if (body.expiresAt !== undefined) throw new ApiError(400, 'unexpected_expiry', 'expiresAt is only accepted when activating.');
      user = await users.suspend(id);
    } else {
      throw new ApiError(400, 'invalid_status', 'status must be "active" or "suspended".');
    }
    if (!user) throw new ApiError(404, 'user_not_found', `No user with the ID ${id}.`);
    res.json({ user, status: user.subscription.effectiveStatus });
  });

  api.use((req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'No such API route.' } });
  });

  app.use('/api/v1', api);
  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'not_found', message: 'No such API route.' } }));
  app.use((req, res) => res.status(404).type('text').send('Not found'));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let e = err;
    if (err.type === 'entity.parse.failed') e = new ApiError(400, 'invalid_json', 'The request body is not valid JSON.');
    else if (err.type === 'entity.too.large') e = new ApiError(413, 'body_too_large', 'The request body is too large.');
    else if (!(err instanceof ApiError)) {
      const code = prismaCode(err) || '';
      const down = DB_DOWN.has(code) || err.name === 'PrismaClientInitializationError';
      // Prisma messages are multi-line; the last line holds the cause.
      logger.error(`[error] ${req.method} ${req.path}: ${code} ${String(err.message).trim().split('\n').pop()}`);
      e = down ? new ApiError(503, 'database_unavailable', 'The database is unavailable. Please try again shortly.') : new ApiError(500, 'server_error', 'Something went wrong on the server.');
    }
    res.status(e.status).json({ error: { code: e.code, message: e.message, ...(e.details ? { fields: e.details } : {}) } });
  });

  return app;
}

module.exports = { createApp };
