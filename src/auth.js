'use strict';

// Server-side admin authorization for the page and the API.
//
// Browsers: HTTP Basic auth (the browser's own credentials prompt, no login
// page). The credentials live only in server environment variables and are
// never sent to the page's JavaScript.
// Scripts/tools: "Authorization: Bearer <ADMIN_API_TOKEN>".
//
// Basic credentials are sent by the browser automatically, so state-changing
// requests authorized that way must also come from this site's own origin
// (CSRF protection).

const crypto = require('node:crypto');

const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function parseBasic(header) {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header || '');
  if (!m) return null;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  return i < 0 ? null : { username: decoded.slice(0, i), password: decoded.slice(i + 1) };
}

function createAuth({ admin, publicOrigin }, { now = () => Date.now() } = {}) {
  const failures = new Map(); // ip -> { count, since }

  function blocked(ip) {
    const f = failures.get(ip);
    if (!f) return false;
    if (now() - f.since > FAILURE_WINDOW_MS) {
      failures.delete(ip);
      return false;
    }
    return f.count >= MAX_FAILURES;
  }

  function fail(ip) {
    const f = failures.get(ip);
    if (!f || now() - f.since > FAILURE_WINDOW_MS) failures.set(ip, { count: 1, since: now() });
    else f.count += 1;
    if (failures.size > 10_000) failures.clear();
  }

  function check(req) {
    const header = req.get('authorization') || '';
    const bearer = /^Bearer\s+(\S+)$/i.exec(header);
    if (bearer) return admin.apiToken && safeEqual(bearer[1], admin.apiToken) ? 'token' : null;
    const basic = parseBasic(header);
    if (!basic) return null;
    // Both compared every time, so timing doesn't reveal which was wrong.
    const userOk = safeEqual(basic.username, admin.username);
    const passOk = safeEqual(basic.password, admin.password);
    return userOk && passOk ? 'basic' : null;
  }

  function sameOrigin(req) {
    const origin = req.get('origin');
    if (!origin) return req.get('sec-fetch-site') ? req.get('sec-fetch-site') === 'same-origin' : true;
    return origin === publicOrigin || origin === `${req.protocol}://${req.get('host')}`;
  }

  return function requireAdmin(req, res, next) {
    const isApi = req.path.startsWith('/api/');
    if (blocked(req.ip)) {
      return isApi
        ? res.status(429).json({ error: { code: 'too_many_attempts', message: 'Too many failed sign-in attempts. Try again in 15 minutes.' } })
        : res.status(429).type('text').send('Too many failed sign-in attempts. Try again in 15 minutes.');
    }
    const method = check(req);
    if (!method) {
      if (req.get('authorization')) fail(req.ip);
      // Only the page triggers the browser prompt; API calls just get 401.
      if (!isApi) res.set('WWW-Authenticate', 'Basic realm="Axora Subscriptions", charset="UTF-8"');
      return isApi
        ? res.status(401).json({ error: { code: 'unauthorized', message: 'Missing or invalid admin credentials.' } })
        : res.status(401).type('text').send('Authorization required.');
    }
    if (method === 'basic' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sameOrigin(req)) {
      return res.status(403).json({ error: { code: 'forbidden_origin', message: 'Cross-site request refused.' } });
    }
    failures.delete(req.ip);
    next();
  };
}

module.exports = { createAuth };
