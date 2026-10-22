// Startup checks (Node.js runtime only; see instrumentation.js): reports,
// without secrets, whether the admin login and the Lead Getter licence system
// are ready, and stores the licence signing key in the database on first
// start (lib/licence/keys.js).

import { loadConfig } from './lib/config.js';
import { licence } from './lib/licence/index.js';

try {
  loadConfig();
} catch (err) {
  console.error(`[config] ${err.message} — the dashboard and admin API will answer 503 until this is fixed.`);
}
const l = licence();
if (!l.settings.smtp && !process.env.MAIL_OUTBOX_DIR) console.error(`[licence] email is not configured (${l.settings.smtpMissing.join(', ')}): desktop subscription applications will be refused until it is.`);
try {
  await l.getSigningKey();
  console.log('[licence] status signing key ready (matches installed Lead Finder apps)');
} catch {
  // getSigningKey has logged the reason; signed status answers 503 until then.
}
