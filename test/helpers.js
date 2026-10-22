// Shared test setup. Tests run against a real MySQL/MariaDB database and
// DROP EVERY TABLE IN IT, so never point them at a real database:
//   TEST_DATABASE_URL=mysql://user:pass@127.0.0.1:3306/axora_subs_test npm test
//
// Licence tests use a throwaway signing key and never read another licence
// server's .env or send email.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DB_URL = process.env.TEST_DATABASE_URL;
export const skip = !DB_URL && 'set TEST_DATABASE_URL to run';

const keys = crypto.generateKeyPairSync('ed25519');
export const TEST_PUBLIC_KEY = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
export const TEST_PRIVATE_KEY_B64 = Buffer.from(keys.privateKey.export({ format: 'pem', type: 'pkcs8' })).toString('base64');
export const serverPublicKey = keys.publicKey;

if (DB_URL) process.env.DATABASE_URL = DB_URL;
// Payment screenshots go to a temporary folder, never to data/uploads.
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'axora-test-uploads-'));
process.on('exit', () => fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true }));
process.env.LEAD_GETTER_ENV_FILE = 'none';
process.env.LEAD_GETTER_DATA_DIR = 'none';
process.env.LICENSE_PUBLIC_KEY = TEST_PUBLIC_KEY;
for (const k of ['LICENSE_PRIVATE_KEY', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SUBSCRIPTION_ADMIN_EMAIL', 'MAIL_OUTBOX_DIR']) delete process.env[k];

export async function dropAll(prisma) {
  const tables = (await prisma.$queryRaw`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()`).map((r) => r.t);
  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of tables) await prisma.$executeRawUnsafe(`DROP TABLE \`${t}\``);
  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
}

// A desktop app installation, signing requests like Lead Finder's
// src/main/license.js does (its own Ed25519 key; the path below /lead-getter).
export function device({ machine = crypto.randomBytes(32).toString('hex'), clock = () => Date.now() } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pk = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const deviceId = crypto.createHash('sha256').update(Buffer.from(pk, 'base64')).digest().toString('base64url').slice(0, 32);
  function signed(method, pathQuery, body = null, { tamper } = {}) {
    const payload = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
    const ts = String(clock());
    const nonce = crypto.randomBytes(16).toString('base64url');
    const digest = Buffer.from(`${method}\n${pathQuery}\n${ts}\n${nonce}\n${machine}\n${crypto.createHash('sha256').update(payload).digest('hex')}`);
    const headers = { 'x-lf-key': pk, 'x-lf-ts': ts, 'x-lf-nonce': nonce, ...(machine ? { 'x-lf-machine': machine } : {}), 'x-lf-sig': crypto.sign(null, digest, privateKey).toString('base64') };
    if (body) headers['content-type'] = 'application/json';
    if (tamper) tamper(headers);
    return { method, pathQuery, headers, body: body ? payload : undefined };
  }
  return { deviceId, publicKey: pk, machine, signed };
}

// The signed status payload, verified with the server's public key.
export function verifyToken(token, publicKey = serverPublicKey) {
  const [body, sig] = String(token).split('.');
  if (!crypto.verify(null, Buffer.from(body), publicKey, Buffer.from(sig, 'base64url'))) return null;
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
}

export const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(64)]);
