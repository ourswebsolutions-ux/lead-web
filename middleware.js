// Admin login for everything except /lead-getter, which belongs to the
// desktop app (authenticated there by its own device signature, never by
// the admin login). Also sets the security headers for the dashboard.

import { NextResponse } from 'next/server';
import { loadConfig } from './lib/config.js';
import { createAuth } from './lib/auth.js';

export const config = { runtime: 'nodejs', matcher: '/:path*' };

let auth = null;
function requireAdmin(request) {
  auth ||= createAuth(loadConfig());
  return auth(request);
}

const isLicencePath = (p) => p === '/lead-getter' || p.startsWith('/lead-getter/');

export function middleware(request) {
  const { pathname } = request.nextUrl;
  if (isLicencePath(pathname)) return NextResponse.next();

  let denied;
  try {
    denied = requireAdmin(request);
  } catch (err) {
    console.error(`[config] ${err.message}`);
    return new Response('The server is not configured (see the server log).', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  }
  if (denied) return denied;

  // Per-request nonce: Next.js adds it to its own scripts.
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const dev = process.env.NODE_ENV !== 'production';
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${dev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data: blob:",
    `connect-src 'self'${dev ? ' ws: wss:' : ''}`,
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; ');
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set('content-security-policy', csp);
  res.headers.set('x-content-type-options', 'nosniff');
  res.headers.set('x-frame-options', 'DENY');
  res.headers.set('referrer-policy', 'no-referrer');
  res.headers.set('cache-control', 'no-store');
  if (request.headers.get('x-forwarded-proto') === 'https') res.headers.set('strict-transport-security', 'max-age=31536000');
  return res;
}
