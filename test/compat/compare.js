// Differential check: the same desktop-app sessions against the original
// standalone Lead Getter licence server (reference) and this site's
// /lead-getter (candidate); every answer must match once random parts (IDs,
// tokens, times) are normalised.
//
//   node test/compat/compare.js <reference url> <candidate url> <ref outbox> <new outbox> <server public key>
//
// Both servers must sign with the same key and write emails as JSON files to
// the outbox folders (MAIL_OUTBOX_DIR here). See README, "Compatibility".

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [REF, NEW, REF_OUT, NEW_OUT, PUB] = process.argv.slice(2);
const serverKey = crypto.createPublicKey({ key: Buffer.from(PUB, 'base64'), format: 'der', type: 'spki' });
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);

function device(machine) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pk = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  return {
    deviceId: crypto.createHash('sha256').update(Buffer.from(pk, 'base64')).digest().toString('base64url').slice(0, 32),
    headers(method, pathQuery, payload, { skewMs = 0 } = {}) {
      const ts = String(Date.now() + skewMs);
      const nonce = crypto.randomBytes(16).toString('base64url');
      const digest = Buffer.from(`${method}\n${pathQuery}\n${ts}\n${nonce}\n${machine}\n${crypto.createHash('sha256').update(payload).digest('hex')}`);
      return { 'x-lf-key': pk, 'x-lf-ts': ts, 'x-lf-nonce': nonce, 'x-lf-machine': machine, 'x-lf-sig': crypto.sign(null, digest, privateKey).toString('base64') };
    },
  };
}

// Random parts of an answer, normalised.
function norm(v, ctx) {
  if (typeof v === 'string') {
    let s = v
      .replace(/LF-[0-9A-F]{10}/g, 'LF-<id>')
      .replace(/token=[A-Za-z0-9_%-]+/g, 'token=<token>')
      .replace(/value="[A-Za-z0-9_-]{43}"/g, 'value="<token>"')
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<time>')
      .replace(/(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} (GMT|UTC)/g, '<date>')
      .replace(/https?:\/\/127\.0\.0\.1:\d+\/lead-getter/g, '<base>');
    if (ctx?.deviceId) s = s.split(ctx.deviceId).join('<device>');
    return s;
  }
  if (Array.isArray(v)) return v.map((x) => norm(x, ctx));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'nonce' ? '<nonce>' : norm(x, ctx)]));
  return v;
}

const HEADERS = ['content-type', 'cache-control', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'content-security-policy', 'www-authenticate'];

async function call(base, { method = 'GET', path: p, headers = {}, body }, ctx) {
  let res;
  try {
    res = await fetch(base + p, { method, headers, body, redirect: 'manual' });
  } catch (err) {
    return { out: { connection: `closed without an answer (${err.cause?.code || err.message})` } };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get('content-type') || '';
  let data = null;
  if (type.startsWith('application/json')) data = JSON.parse(buf.toString('utf8'));
  const out = { status: res.status, headers: Object.fromEntries(HEADERS.map((h) => [h, res.headers.get(h)])) };
  if (data?.token) {
    const [b, sig] = data.token.split('.');
    const payload = crypto.verify(null, Buffer.from(b), serverKey, Buffer.from(sig, 'base64url')) ? JSON.parse(Buffer.from(b, 'base64url').toString()) : 'BAD SIGNATURE';
    // Expiry as a whole number of days after the server time: same plan dates.
    if (payload.subscription?.expiresAt) payload.subscription.days = Math.round((Date.parse(payload.subscription.expiresAt) - Date.parse(payload.serverTime)) / 86_400_000);
    out.payload = norm(payload, ctx);
  } else if (data) out.json = norm(data, ctx);
  else if (type.startsWith('text/html')) out.html = norm(buf.toString('utf8'), ctx);
  else out.bytes = crypto.createHash('sha256').update(buf).digest('hex');
  return { out, data, raw: buf.toString('utf8') };
}

function mails(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) : [];
}

// One desktop session; returns the list of normalised answers.
async function session(base, outbox) {
  const steps = [];
  const machine = 'ab'.repeat(32);
  const d = device(machine);
  const ctx = { deviceId: d.deviceId };
  const step = async (name, req) => {
    const r = await call(base, req, ctx);
    steps.push([name, r.out]);
    return r;
  };
  const signed = (method, pathQuery, body, opts) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
    return { method, path: pathQuery, headers: { ...d.headers(method, pathQuery, payload, opts), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? payload : undefined };
  };
  const nonce = () => crypto.randomBytes(18).toString('base64url');
  const application = (extra) => ({ plan: 'monthly', message: 'Paid via NayaPay', email: 'compat@example.com', screenshot: { type: 'image/png', data: png.toString('base64') }, ...extra });

  await step('health', { path: '/health' });
  await step('plans', { path: '/api/plans' });
  await step('plans with query', { path: '/api/plans?x=1' });
  await step('unknown api route', { path: '/api/nope' });
  await step('unknown page', { path: '/nope' });
  await step('wrong method', { method: 'PUT', path: '/api/plans' });
  await step('unsigned status', { path: `/api/license?nonce=${nonce()}` });
  const forged = signed('GET', `/api/license?nonce=${nonce()}`);
  forged.headers['x-lf-sig'] = Buffer.alloc(64).toString('base64');
  await step('forged signature', forged);
  const badKey = signed('GET', `/api/license?nonce=${nonce()}`);
  badKey.headers['x-lf-key'] = 'AAAA';
  await step('invalid device key', badKey);
  const badMachine = signed('GET', `/api/license?nonce=${nonce()}`);
  badMachine.headers['x-lf-machine'] = 'xyz';
  await step('invalid machine id', badMachine);
  await step('clock skew', signed('GET', `/api/license?nonce=${nonce()}`, null, { skewMs: -6 * 60 * 1000 }));
  await step('missing nonce', signed('GET', '/api/license?nonce=short'));
  const once = signed('GET', `/api/license?nonce=${nonce()}`);
  await step('status (new device)', once);
  await step('replayed request', once);
  for (let i = 1; i <= 4; i++) await step(`trial search ${i}`, signed('POST', '/api/trial/consume', {}));
  for (const [name, extra] of [
    ['no plan', { plan: 'weekly' }],
    ['no email', { email: '' }],
    ['bad email', { email: 'x' }],
    ['no screenshot', { screenshot: { data: '' } }],
    ['not an image', { screenshot: { data: Buffer.from('GIF89a').toString('base64') } }],
    ['long message', { message: 'x'.repeat(1001) }],
  ])
    await step(`apply: ${name}`, signed('POST', '/api/applications', application(extra)));
  const bad = signed('POST', '/api/applications', application());
  await step('apply: invalid JSON', { ...bad, body: Buffer.from('{bad') });
  await step('apply', signed('POST', '/api/applications', application()));
  await step('status after applying', signed('GET', `/api/license?nonce=${nonce()}`));

  const admin = mails(outbox).find((m) => m.subject.startsWith('Subscription request'));
  steps.push(['approval email', norm({ to: admin.to, subject: admin.subject, text: admin.text, html: admin.html }, ctx)]);
  const verifyMail = mails(outbox).find((m) => m.subject === 'Confirm your email for Lead Finder');
  steps.push(['verification email', norm({ to: verifyMail.to, subject: verifyMail.subject, text: verifyMail.text, html: verifyMail.html }, ctx)]);
  const [, approvePath, approveToken] = admin.text.match(/(\/admin\/applications\/LF-[0-9A-F]{10}\/approve)\?token=(\S+)/);
  const [, cancelPath, cancelToken] = admin.text.match(/(\/admin\/applications\/LF-[0-9A-F]{10}\/cancel)\?token=(\S+)/);
  const verifyToken = verifyMail.text.match(/verify-email\?token=(\S+)/)[1];
  const form = (p, t) => ({ method: 'POST', path: p, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(t)}` });

  await step('approve page', { path: `${approvePath}?token=${approveToken}` });
  await step('approve page, tampered token', { path: `${approvePath}?token=${approveToken.slice(0, -2)}xx` });
  await step('screenshot', { path: `${approvePath.replace('/approve', '/screenshot')}?token=${approveToken}` });
  await step('verify email', { path: `/verify-email?token=${verifyToken}` });
  await step('verify email again', { path: `/verify-email?token=${verifyToken}` });
  await step('approve', form(approvePath, approveToken));
  await step('status after approval', signed('GET', `/api/license?nonce=${nonce()}`));
  await step('trial search while subscribed', signed('POST', '/api/trial/consume', {}));
  await step('approve again', form(approvePath, approveToken));
  await step('cancel after approval', form(cancelPath, cancelToken));
  await step('screenshot after use', { path: `${approvePath.replace('/approve', '/screenshot')}?token=${approveToken}` });
  const notice = mails(outbox).find((m) => m.subject === 'Your Lead Finder subscription is active');
  steps.push(['customer notice', norm({ to: notice?.to, subject: notice?.subject, text: notice?.text }, ctx)]);

  // A second application: renewal continues from the current end date.
  await step('apply again (6 months)', signed('POST', '/api/applications', application({ plan: 'six_months' })));
  const renew = mails(outbox).filter((m) => m.subject.startsWith('Subscription request')).at(-1);
  const [, renewPath, renewToken] = renew.text.match(/(\/admin\/applications\/LF-[0-9A-F]{10}\/approve)\?token=(\S+)/);
  await step('approve renewal', form(renewPath, renewToken));
  await step('status after renewal', signed('GET', `/api/license?nonce=${nonce()}`));

  // Another computer using the same email.
  const other = device('cd'.repeat(32));
  const otherCtx = { deviceId: other.deviceId };
  const otherSigned = (method, pq, body) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
    return { method, path: pq, headers: { ...other.headers(method, pq, payload), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? payload : undefined };
  };
  steps.push(['other device: apply with the same email', (await call(base, otherSigned('POST', '/api/applications', application()), otherCtx)).out]);
  steps.push(['other device: status', (await call(base, otherSigned('GET', `/api/license?nonce=${nonce()}`), otherCtx)).out]);
  const big = Buffer.alloc(8 * 1024 * 1024 + 10, 0x61);
  await step('request too large', { method: 'POST', path: '/api/applications', headers: { 'content-type': 'application/json' }, body: big });
  return steps;
}

const ref = await session(REF, REF_OUT);
const cand = await session(NEW, NEW_OUT);
// Known, intended differences (step name -> why).
const EXPECTED = {
  'request too large': 'the original drops the connection on bodies over 8 MB instead of sending its 413 answer; this site sends the 413 {"error":"Request too large"}. The desktop app never sends that much (screenshots are limited to 5 MB).',
};
let failed = 0;
for (let i = 0; i < Math.max(ref.length, cand.length); i++) {
  const [name, a] = ref[i] || [];
  const [, b] = cand[i] || [];
  const same = JSON.stringify(a) === JSON.stringify(b);
  if (!same && EXPECTED[name]) {
    console.log(`~ ${name}: known difference — ${EXPECTED[name]}`);
    console.log('   reference:', JSON.stringify(a), '\n   candidate:', JSON.stringify(b));
    continue;
  }
  if (!same) failed++;
  console.log(`${same ? '✔' : '✘'} ${name}`);
  if (!same) {
    console.log('   reference:', JSON.stringify(a).slice(0, 1500));
    console.log('   candidate:', JSON.stringify(b).slice(0, 1500));
  }
}
console.log(failed ? `\n${failed} of ${ref.length} answers differ` : `\nALL ${ref.length} ANSWERS MATCH (${Object.keys(EXPECTED).length} known difference listed above)`);
process.exit(failed ? 1 : 0);
