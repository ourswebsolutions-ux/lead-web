// The Ed25519 key that signs licence status for the desktop app.
//
// Installed Lead Finder apps trust exactly one public key (their
// license-config.json), so the signing key can never be generated or
// replaced without breaking them. It is therefore:
//   - reused: the key stored in the database, else LICENSE_PRIVATE_KEY from
//     the environment or an earlier licence server's .env (settings.js);
//   - checked: its public key must equal the one installed apps trust
//     (LICENSE_PUBLIC_KEY overrides that for tests/other builds);
//   - stored once in the database (licence_signing_keys), so restarts and
//     redeploys reuse it with nothing to configure;
//   - never generated, overwritten or exposed by any route.

import crypto from 'node:crypto';

// Public key shipped in Lead Finder's src/main/license-config.json (public, not a secret).
const INSTALLED_APP_PUBLIC_KEY = 'MCowBQYDK2VwAyEAJqP+z5ZlpDVYDMLWlgGAcf6+H01wGWAiP2Rs5CpUlZY=';
const KEY_ID = 'status';

class SigningKeyUnavailable extends Error {}

function publicKeyOf(pem) {
  return crypto.createPublicKey(crypto.createPrivateKey(pem)).export({ format: 'der', type: 'spki' }).toString('base64');
}

// LICENSE_PRIVATE_KEY is base64 of a PKCS#8 PEM (the licence server's format).
function pemFromEnvValue(base64) {
  const pem = Buffer.from(base64, 'base64').toString('utf8');
  const key = crypto.createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('not an Ed25519 key');
  return pem;
}

// Returns { privateKey (KeyObject), publicKey, source }; throws
// SigningKeyUnavailable with the reason when no usable key exists.
async function loadSigningKey({ prisma, settings, expected = process.env.LICENSE_PUBLIC_KEY || INSTALLED_APP_PUBLIC_KEY, log = console.log }) {
  const stored = await prisma.licenceSigningKey.findUnique({ where: { id: KEY_ID } });
  if (stored) {
    if (stored.publicKey !== expected || publicKeyOf(stored.privateKeyPem) !== expected) {
      throw new SigningKeyUnavailable(`The stored licence signing key (from ${stored.source}) does not match the public key installed apps trust. It was left unchanged; licence status can't be signed.`);
    }
    return { privateKey: crypto.createPrivateKey(stored.privateKeyPem), publicKey: stored.publicKey, source: 'database' };
  }

  if (!settings.privateKey) {
    throw new SigningKeyUnavailable(
      'No licence signing key found (database, LICENSE_PRIVATE_KEY, or a Lead Getter licence server .env). Installed apps only accept status signed with their existing key, so a new one is never generated.',
    );
  }
  let pem;
  try {
    pem = pemFromEnvValue(settings.privateKey.base64);
  } catch {
    throw new SigningKeyUnavailable(`LICENSE_PRIVATE_KEY from ${settings.privateKey.from} is not a valid Ed25519 key.`);
  }
  const publicKey = publicKeyOf(pem);
  if (publicKey !== expected) {
    throw new SigningKeyUnavailable(`LICENSE_PRIVATE_KEY from ${settings.privateKey.from} does not match the public key installed apps trust, so it was not used.`);
  }
  try {
    await prisma.licenceSigningKey.create({ data: { id: KEY_ID, privateKeyPem: pem, publicKey, source: settings.privateKey.from === 'environment' ? 'LICENSE_PRIVATE_KEY' : settings.privateKey.from } });
    log(`[licence] signing key from ${settings.privateKey.from} verified and stored in the database`);
  } catch (err) {
    // Stored concurrently by another start: use that one (checked above to be the same public key).
    if (err?.code !== 'P2002') throw err;
  }
  return loadSigningKey({ prisma, settings, expected, log });
}

export { loadSigningKey, SigningKeyUnavailable, INSTALLED_APP_PUBLIC_KEY, publicKeyOf };
