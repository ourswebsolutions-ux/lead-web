// The licence system's singletons for this server process.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../prisma.js';
import { Users } from '../users.js';
import { Store } from './store.js';
import { Uploads } from './uploads.js';
import { createMailer } from './mailer.js';
import { Website } from './website.js';
import { licenceSettings } from './settings.js';
import { loadSigningKey, SigningKeyUnavailable } from './keys.js';
import { createLicenceHandler, HttpError } from './handler.js';

const g = globalThis;

function publicOrigin() {
  return (process.env.PUBLIC_ORIGIN || 'https://subscription.axorawebsolutions.com').replace(/\/$/, '');
}

// Without SMTP, sending fails like an SMTP error would: applications are
// refused with the original "email failed" answer and nothing is stored.
// MAIL_OUTBOX_DIR (testing): emails are written there as JSON instead of sent.
function mailerFor(settings) {
  if (process.env.MAIL_OUTBOX_DIR) {
    const dir = path.resolve(process.env.MAIL_OUTBOX_DIR);
    return {
      verify: async () => true,
      send: async (m) => {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`), JSON.stringify({ to: m.to, subject: m.subject, text: m.text, html: m.html, attachments: (m.attachments || []).map((a) => a.filename) }));
        return {};
      },
    };
  }
  if (settings.smtp) return createMailer({ smtp: settings.smtp });
  return { send: async () => Promise.reject(Object.assign(new Error('SMTP is not configured'), { code: 'ENOSMTP' })), verify: async () => Promise.reject(new Error('SMTP is not configured')) };
}

function build() {
  const settings = licenceSettings();
  let keyPromise = null;
  let reported = false;
  // Loaded (and stored in the database, if new) on first use, then reused.
  const getSigningKey = async () => {
    keyPromise ||= loadSigningKey({ prisma, settings }).then((k) => k.privateKey);
    try {
      return await keyPromise;
    } catch (err) {
      keyPromise = null;
      if (!(err instanceof SigningKeyUnavailable)) throw err;
      if (!reported) console.error(`[licence] ${err.message}`);
      reported = true;
      throw new HttpError(503, 'Subscriptions are temporarily unavailable on the server. Please try again later.');
    }
  };
  const users = new Users(prisma);
  const store = new Store(prisma);
  const storage = new Uploads(path.resolve(process.env.UPLOAD_DIR || 'data/uploads'));
  const handler = createLicenceHandler({
    publicBaseUrl: `${publicOrigin()}/lead-getter`,
    paymentInstructions: settings.paymentInstructions,
    adminEmail: settings.adminEmail,
    getSigningKey,
    store,
    storage,
    mailer: mailerFor(settings),
    website: new Website(users),
  });
  return { settings, getSigningKey, store, storage, handler, users };
}

export function licence() {
  return (g.__axoraLicence ||= build());
}
