'use strict';

// npx prisma db seed (or npm run seed) — creates the initial user once.
//
// Creates the user given by SEED_USER_ID and SEED_USER_EMAIL, with an
// 'inactive' subscription (the same as adding a user on the page), unless a
// user with that ID or email already exists. Safe to run repeatedly.
//
// The users table holds customers (user ID + email) and has no password. The
// admin sign-in is not stored in the database: it is ADMIN_USERNAME and
// ADMIN_PASSWORD in the environment, checked by src/auth.js.

const { PrismaClient } = require('@prisma/client');
const { loadEnvFile } = require('../src/env');
const { redact } = require('../src/config');
const { ID_RE, EMAIL_RE } = require('../src/app');

async function seed({ prisma, id, email, log = console.log }) {
  id = (id || '').trim();
  email = (email || '').trim().toLowerCase();
  if (!id && !email) {
    log('[seed] SEED_USER_ID and SEED_USER_EMAIL are not set; nothing to seed.');
    return { created: false };
  }
  if (!ID_RE.test(id)) throw new Error('SEED_USER_ID must be 3–64 characters: letters, digits, "-" or "_".');
  if (!EMAIL_RE.test(email) || email.length > 254) throw new Error('SEED_USER_EMAIL is not a valid email address.');

  const existing = await prisma.user.findFirst({ where: { OR: [{ id }, { email }] }, select: { id: true, email: true } });
  if (existing) {
    log(`[seed] user ${existing.id} (${existing.email}) already exists; nothing created.`);
    return { created: false };
  }
  try {
    await prisma.user.create({ data: { id, email, subscription: { create: { status: 'inactive' } } } });
  } catch (err) {
    // Created concurrently by another run: still exactly one user.
    if (err.code === 'P2002') {
      log(`[seed] user ${id} already exists; nothing created.`);
      return { created: false };
    }
    throw err;
  }
  log(`[seed] created user ${id} (${email}) with an inactive subscription.`);
  return { created: true };
}

module.exports = { seed };

if (require.main === module) {
  loadEnvFile();
  const prisma = new PrismaClient();
  seed({ prisma, id: process.env.SEED_USER_ID, email: process.env.SEED_USER_EMAIL })
    .catch((err) => {
      const code = err.code || err.errorCode;
      console.error(`Seed failed: ${code ? `${code} ` : ''}${redact(String(err.message).trim())}`);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
