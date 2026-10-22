// One-time import of an earlier standalone Lead Getter licence server's data
// (its SQLite subscriptions.db and uploads/), run by setup when one is found:
// LEAD_GETTER_DATA_DIR, the deploy kit's /var/lib/lead-getter or
// /opt/lead-getter/server/data, or a lead-getter / chrom-lead checkout next
// to this one.
//
// - Inserts what is missing; never overwrites or deletes anything here.
// - Copies payment screenshots into UPLOAD_DIR.
// - A licence it approved on its own (before this site decided
//   subscriptions) becomes the same subscription here, with the same expiry,
//   if this site has no user for that device yet.
// - Runs once per source (recorded in app_settings), so a user deleted here
//   later is not brought back.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function candidateDirs(env, cwd) {
  if (env.LEAD_GETTER_DATA_DIR === 'none') return [];
  return [env.LEAD_GETTER_DATA_DIR, '/var/lib/lead-getter', '/opt/lead-getter/server/data', path.resolve(cwd, '../lead-getter/server/data'), path.resolve(cwd, '../chrom-lead/server/data')].filter(Boolean);
}

const date = (s) => (s ? new Date(s) : null);

async function importLicenceSqlite({ prisma, users, uploadDir, env = process.env, cwd = process.cwd(), log = console.log }) {
  const dir = candidateDirs(env, cwd).find((d) => fs.existsSync(path.join(d, 'subscriptions.db')));
  if (!dir) return null;
  const file = path.join(dir, 'subscriptions.db');
  const key = `licence_sqlite_import:${crypto.createHash('sha256').update(path.resolve(file)).digest('hex').slice(0, 32)}`;
  if (await prisma.appSetting.findUnique({ where: { key } })) return { skipped: 'already imported', file };

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    log(`[setup] found ${file} (earlier licence server data) but this Node.js has no node:sqlite (Node 22.5+ is needed to import it); skipped.`);
    return { skipped: 'no node:sqlite', file };
  }
  const db = new DatabaseSync(file, { readOnly: true });
  const all = (sql) => db.prepare(sql).all();
  const counts = { devices: 0, applications: 0, tokens: 0, trials: 0, screenshots: 0, subscriptions: 0 };
  const notes = [];
  try {
    for (const d of all('SELECT * FROM devices')) {
      const r = await prisma.licenceDevice.createMany({ data: [{ id: d.id, publicKey: d.public_key, createdAt: date(d.created_at), lastSeenAt: date(d.last_seen_at) }], skipDuplicates: true });
      counts.devices += r.count;
    }
    for (const a of all('SELECT * FROM applications ORDER BY seq')) {
      const r = await prisma.licenceApplication.createMany({
        data: [{ id: a.id, deviceId: a.device_id, plan: a.plan, message: a.message || '', email: a.email, emailVerified: Boolean(a.email_verified), screenshotPath: a.screenshot_path, screenshotType: a.screenshot_type, screenshotSize: Number(a.screenshot_size), screenshotSha256: a.screenshot_sha256, status: a.status, createdAt: date(a.created_at), decidedAt: date(a.decided_at) }],
        skipDuplicates: true,
      });
      counts.applications += r.count;
      if (a.screenshot_path && /^applications\/LF-[0-9A-F]{10}\/[0-9a-f]{16}\.(png|jpg|webp)$/.test(a.screenshot_path)) {
        const from = path.join(dir, 'uploads', ...a.screenshot_path.split('/'));
        const to = path.join(uploadDir, ...a.screenshot_path.split('/'));
        if (fs.existsSync(from) && !fs.existsSync(to)) {
          fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
          fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
          fs.chmodSync(to, 0o600);
          counts.screenshots++;
        }
      }
    }
    for (const t of all('SELECT * FROM action_tokens')) {
      const r = await prisma.licenceActionToken.createMany({ data: [{ hash: t.hash, applicationId: t.application_id, action: t.action, createdAt: date(t.created_at), expiresAt: date(t.expires_at), usedAt: date(t.used_at) }], skipDuplicates: true });
      counts.tokens += r.count;
    }
    for (const t of all('SELECT * FROM trials')) {
      // Keep the higher count: free searches are never given back.
      const cur = await prisma.licenceTrial.findUnique({ where: { machineId: t.machine_id } });
      if (!cur) {
        await prisma.licenceTrial.create({ data: { machineId: t.machine_id, used: Number(t.used), updatedAt: date(t.updated_at) } });
        counts.trials++;
      } else if (cur.used < Number(t.used)) {
        await prisma.licenceTrial.update({ where: { machineId: t.machine_id }, data: { used: Number(t.used) } });
        counts.trials++;
      }
    }
    for (const l of all('SELECT * FROM licenses')) {
      const existing = await users.get(l.device_id);
      if (existing && existing.id === l.device_id) {
        notes.push(`device ${l.device_id}: already a user here (left unchanged)`);
        continue;
      }
      if (l.expires_at && Date.parse(l.expires_at) <= Date.now()) {
        notes.push(`device ${l.device_id}: its ${l.plan} licence expired ${l.expires_at} (not carried over)`);
        continue;
      }
      const email = db.prepare('SELECT email FROM applications WHERE device_id = ? AND email IS NOT NULL ORDER BY created_at DESC, seq DESC LIMIT 1').get(l.device_id)?.email;
      if (!email) {
        notes.push(`device ${l.device_id}: has an active ${l.plan} licence but no email; add it on the dashboard to keep it`);
        continue;
      }
      try {
        await users.create({ id: l.device_id, email });
      } catch (err) {
        if (err?.code !== 'P2002') throw err;
        notes.push(`device ${l.device_id}: ${email} already belongs to another user; licence not carried over (activate it on the dashboard)`);
        continue;
      }
      await users.activate(l.device_id, l.expires_at ? new Date(l.expires_at) : null);
      counts.subscriptions++;
      notes.push(`device ${l.device_id} (${email}): ${l.plan} subscription active until ${l.expires_at || 'never expires'}`);
    }
  } finally {
    db.close();
  }
  await prisma.appSetting.create({ data: { key, value: JSON.stringify({ file: path.resolve(file), importedAt: new Date().toISOString(), counts, notes }) } });
  log(`[setup] imported earlier licence server data from ${file}: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ')}`);
  for (const n of notes) log(`[setup]   ${n}`);
  return { file, counts, notes };
}

export { importLicenceSqlite };
