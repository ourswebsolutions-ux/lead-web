// Licence-system settings, with no manual setup when an earlier standalone
// Lead Getter licence server is (or was) configured on the machine:
//
//   1. this app's environment (.env / PM2 env), then
//   2. that licence server's own .env, found automatically in its usual
//      places (LEAD_GETTER_ENV_FILE, the deploy kit's /opt/lead-getter, or a
//      lead-getter / chrom-lead checkout next to this one).
//
// Values are only read from there, never written back or logged.

import fs from 'node:fs';
import path from 'node:path';

const KEYS = ['LICENSE_PRIVATE_KEY', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SUBSCRIPTION_ADMIN_EMAIL', 'PAYMENT_INSTRUCTIONS'];

// LEAD_GETTER_ENV_FILE=none turns the search off.
function candidateFiles(env, cwd) {
  if (env.LEAD_GETTER_ENV_FILE === 'none') return [];
  return [env.LEAD_GETTER_ENV_FILE, '/opt/lead-getter/server/.env', path.resolve(cwd, '../lead-getter/server/.env'), path.resolve(cwd, '../chrom-lead/server/.env')].filter(Boolean);
}

function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

// The first existing licence server .env, as { file, values }, or null.
function findLicenceServerEnv(env = process.env, cwd = process.cwd()) {
  for (const file of candidateFiles(env, cwd)) {
    try {
      return { file, values: parseEnvFile(fs.readFileSync(file, 'utf8')) };
    } catch {}
  }
  return null;
}

function licenceSettings(env = process.env, cwd = process.cwd()) {
  const found = findLicenceServerEnv(env, cwd);
  const pick = (k) => (env[k] ? { value: env[k], from: 'environment' } : found?.values[k] ? { value: found.values[k], from: found.file } : { value: '', from: null });
  const v = Object.fromEntries(KEYS.map((k) => [k, pick(k)]));
  const smtpMissing = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SUBSCRIPTION_ADMIN_EMAIL'].filter((k) => !v[k].value);
  return {
    privateKey: v.LICENSE_PRIVATE_KEY.value ? { base64: v.LICENSE_PRIVATE_KEY.value, from: v.LICENSE_PRIVATE_KEY.from } : null,
    adminEmail: v.SUBSCRIPTION_ADMIN_EMAIL.value,
    paymentInstructions: v.PAYMENT_INSTRUCTIONS.value,
    smtp: smtpMissing.length ? null : { host: v.SMTP_HOST.value, port: Number(v.SMTP_PORT.value), user: v.SMTP_USER.value, pass: v.SMTP_PASS.value, from: v.SMTP_FROM.value },
    smtpMissing,
    smtpFrom: v.SMTP_HOST.from,
  };
}

export { licenceSettings, findLicenceServerEnv, parseEnvFile };
