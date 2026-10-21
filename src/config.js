'use strict';

// All settings come from the environment (see .env.example).

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

// Removes the database password from text before it is logged: as written
// in DATABASE_URL (percent-encoded), decoded, and in canonical encoding.
function redact(text, databaseUrl = process.env.DATABASE_URL) {
  const secrets = new Set();
  try {
    const raw = new URL(databaseUrl).password;
    secrets.add(raw);
    secrets.add(decodeURIComponent(raw));
    secrets.add(encodeURIComponent(decodeURIComponent(raw)));
  } catch {}
  let out = String(text);
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(secret).join('***');
  return out;
}

// Prisma reads DATABASE_URL itself; this only checks it early with a clear
// message (never including the URL, which holds the password).
function checkDatabaseUrl(value) {
  if (!value) throw new Error('Missing environment variable: DATABASE_URL');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL (URL-encode special characters in the password)');
  }
  if (url.protocol !== 'mysql:') throw new Error('DATABASE_URL must start with mysql://');
  if (!url.pathname.replace(/^\//, '')) throw new Error('DATABASE_URL must include the database name');
  return value;
}

function loadConfig(env = process.env) {
  const missing = ['ADMIN_USERNAME', 'ADMIN_PASSWORD'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  if (env.ADMIN_PASSWORD.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters');
  if (env.ADMIN_API_TOKEN && env.ADMIN_API_TOKEN.length < 32) throw new Error('ADMIN_API_TOKEN must be at least 32 characters');
  return {
    port: Number(env.PORT || 3060),
    host: env.HOST || '0.0.0.0',
    publicOrigin: (env.PUBLIC_ORIGIN || 'https://subscription.axorawebsolutions.com').replace(/\/$/, ''),
    trustProxy: env.TRUST_PROXY ? (/^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY) : bool(env.TRUST_PROXY, false)) : false,
    admin: { username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD, apiToken: env.ADMIN_API_TOKEN || '' },
    databaseUrl: checkDatabaseUrl(env.DATABASE_URL),
  };
}

module.exports = { loadConfig, redact };
