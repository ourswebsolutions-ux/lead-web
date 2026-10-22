// Admin authorization for the dashboard and /api/v1 (used by middleware.js).
// /lead-getter/* never comes here: the desktop app authenticates there with
// its own device signature.
//
// HTTP Basic auth (the browser's own credentials prompt, no login page).
// The credentials live only in server environment variables and are never
// sent to the page's JavaScript.
//
// Basic credentials are sent by the browser automatically, so state-changing
// requests authorized that way must also come from this site's own origin
// (CSRF protection).

import crypto from 'node:crypto';

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

// The client address: behind `trustProxy` proxies, the entry they added to
// X-Forwarded-For; otherwise the address the request came from.
function clientIp(request, trustProxy) {
  const hops = String(request.headers.get('x-forwarded-for') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!hops.length) return 'unknown';
  const trusted = trustProxy === true ? hops.length - 1 : Number(trustProxy) || 0;
  return hops[Math.max(0, hops.length - 1 - trusted)];
}

function json(status, data, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });
}

function text(status, body, extra = {}) {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra } });
}

function createAuth({ admin, publicOrigin, trustProxy }, { now = () => Date.now() } = {}) {
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

  function check(request) {
    const basic = parseBasic(request.headers.get('authorization') || '');
    if (!basic) return null;
    // Both compared every time, so timing doesn't reveal which was wrong.
    const userOk = safeEqual(basic.username, admin.username);
    const passOk = safeEqual(basic.password, admin.password);
    return userOk && passOk;
  }

  function sameOrigin(request) {
    const origin = request.headers.get('origin');
    const site = request.headers.get('sec-fetch-site');
    if (!origin) return site ? site === 'same-origin' : true;
    const url = new URL(request.url);
    const proto = request.headers.get('x-forwarded-proto') || url.protocol.replace(':', '');
    const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || url.host;
    return origin === publicOrigin || origin === `${proto}://${host}`;
  }

  // null when allowed; otherwise the response to send.
  return function requireAdmin(request) {
    const { pathname } = new URL(request.url);
    const isApi = pathname.startsWith('/api/');
    const ip = clientIp(request, trustProxy);
    if (blocked(ip)) {
      const message = 'Too many failed sign-in attempts. Try again in 15 minutes.';
      return isApi ? json(429, { error: { code: 'too_many_attempts', message } }) : text(429, message);
    }
    if (!check(request)) {
      if (request.headers.get('authorization')) fail(ip);
      // Only the page triggers the browser prompt; API calls just get 401.
      return isApi
        ? json(401, { error: { code: 'unauthorized', message: 'Missing or invalid admin credentials.' } })
        : text(401, 'Authorization required.', { 'www-authenticate': 'Basic realm="Axora Subscriptions", charset="UTF-8"' });
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !sameOrigin(request)) {
      return json(403, { error: { code: 'forbidden_origin', message: 'Cross-site request refused.' } });
    }
    failures.delete(ip);
    return null;
  };
}

export { createAuth, clientIp, safeEqual };
