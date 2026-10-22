# Axora subscription management

One-page admin site and API for Axora Web Solutions subscriptions, deployed at `https://subscription.axorawebsolutions.com`.

- List, search (email or user ID), add and delete users
- One subscription action per user: **Activate** (with duration or expiry date) or **Suspend**
- Data in MySQL/MariaDB; no Supabase, Firebase or Render
- Node.js + Express + Prisma ORM; dependencies: `express`, `@prisma/client`, `prisma`

API reference, status values, database schema and the Lead Getter integration notes: **[docs/API.md](docs/API.md)**.

## Project layout

```
src/server.js              startup: env → database connection → HTTP (port 3060)
src/app.js                 routes, validation, error handling
src/auth.js                admin authorization (Basic / Bearer), CSRF and brute-force protection
src/lead-getter.js         forwards /lead-getter/* to the Lead Getter licence server (no admin login)
src/users.js               user and subscription queries (Prisma)
prisma/schema.prisma       database schema (applied with prisma db push)
prisma/seed.js             initial user (npx prisma db seed)
prisma/case-sensitive-ids.sql  optional one-time fix: case-sensitive user IDs
ecosystem.config.js        PM2 process definition
public/                    the admin page (HTML, CSS, JS; no secrets)
test/                      API tests against a real MySQL database
```

## Security

- **No login page.** The whole site, page included, is protected with HTTP Basic auth checked on the server; the browser shows its own sign-in prompt once. Scripts can use `Authorization: Bearer <ADMIN_API_TOKEN>`.
- **The admin account is not stored in the database.** It is `ADMIN_USERNAME` / `ADMIN_PASSWORD` in the environment, compared on the server in constant time. The `users` table holds customers (user ID + email) and has no passwords.
- Credentials and database settings exist only in server environment variables (`.env`, never committed). The page's JavaScript contains no secrets. Logged errors have the database password removed.
- Basic-authorized changes must come from the site's own origin (CSRF protection); 10 failed sign-ins lock an IP out for 15 minutes; strict Content-Security-Policy, `X-Frame-Options: DENY`, `no-store` caching, `noindex`.
- **Serve it over HTTPS only** — Basic auth sends the password with every request.
- **`/lead-getter/*` is the only path without the admin login.** It belongs to the Lead Getter licence server and is forwarded to it unchanged (`LEAD_GETTER_UPSTREAM`); that server authenticates every desktop request with the device's own Ed25519 signature (timestamp, single-use nonce) and applies its own limits. Admin credentials and cookies are never forwarded, and nothing under `/lead-getter` reaches this site's admin API.

## Environment variables (`.env`)

| Variable | Required | Example | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | `mysql://axora:p%40ss@localhost:3306/axora_subs` | MySQL/MariaDB connection used by Prisma (URL-encode the password; add `?sslaccept=strict` for TLS) |
| `ADMIN_USERNAME` | yes | `admin` | Admin sign-in |
| `ADMIN_PASSWORD` | yes | 12+ random characters | Admin sign-in |
| `ADMIN_API_TOKEN` | no | 64 hex characters | Bearer token for scripts (32+ characters) |
| `PORT`, `HOST` | no | `3060`, `0.0.0.0` | Listen address (`HOST=127.0.0.1` if only the reverse proxy should reach it) |
| `PUBLIC_ORIGIN` | no | `https://subscription.axorawebsolutions.com` | Allowed origin for changes |
| `TRUST_PROXY` | behind a proxy | `1` | Real client IP / HTTPS detection behind nginx, cPanel, Cloudflare |
| `LEAD_GETTER_UPSTREAM` | no | `http://127.0.0.1:8787` (default) | Lead Getter licence server that `/lead-getter/*` is forwarded to; `off` disables |
| `SEED_USER_ID`, `SEED_USER_EMAIL` | for the seed | `Ab3_-xY9…`, `owner@example.com` | Initial user created by `npx prisma db seed` |

Copy `.env.example` to `.env` and fill it in. Variables set by the hosting environment take precedence over `.env`.

## Deployment (PM2)

Requires Node.js 20+, PM2 (`npm install -g pm2`), and a MySQL 5.7+/8 or MariaDB 10.3+ database whose user has `SELECT, INSERT, UPDATE, DELETE` (plus `CREATE, ALTER, INDEX, REFERENCES` for `db push`).

First deployment:

```bash
cd /path/to/subcription.axorawebsolutions.com
npm install                  # also runs prisma generate
cp .env.example .env && chmod 600 .env   # fill in
npx prisma db push           # creates/updates the tables from prisma/schema.prisma
npx prisma db seed           # once: creates SEED_USER_ID / SEED_USER_EMAIL if missing
pm2 start ecosystem.config.js
pm2 save                     # restore on reboot (after `pm2 startup` once)
```

Updates:

```bash
git pull
npm install                  # also runs prisma generate
npx prisma db push           # only when prisma/schema.prisma changed
pm2 restart axora-subscriptions
```

- **Startup never changes the database schema.** It only connects; if the tables are missing or the database is unreachable, the error is in `pm2 logs axora-subscriptions`.
- `npx prisma db push` compares `prisma/schema.prisma` with the database and applies only the difference. If a change would lose data, Prisma stops and asks; **don't** pass `--accept-data-loss` or `--force-reset` on the production database.
- The seed is safe to re-run: it creates nothing if a user with that ID or email already exists. Leave `SEED_USER_*` empty and it does nothing.
- npm scripts with the same commands: `npm run db:generate`, `npm run db:push`, `npm run seed`, `npm start`.

### Lead Getter desktop app (`/lead-getter`)

Installed Lead Finder apps use `https://subscription.axorawebsolutions.com/lead-getter` (their `license-config.json`). That address is served by the **Lead Getter licence server** (the lead-getter repository's `server/`, deployed with its `server/deploy/install.sh` on this machine, port 8787), which in turn uses this site's API with `SUBSCRIPTION_API_TOKEN` = this site's `ADMIN_API_TOKEN` (server to server only).

- With nginx's `location /lead-getter/` (lead-getter `server/deploy/nginx-lead-getter.conf`), requests go to the licence server directly.
- Without it, they reach this app, which forwards them to `LEAD_GETTER_UPSTREAM`. If the licence server isn't running, the desktop app gets `502 licence_server_unavailable` (not this site's login).

Check from anywhere: `curl https://subscription.axorawebsolutions.com/lead-getter/health` must answer `{"ok":true}`, and `/lead-getter/api/plans` the plan list.

### Case-sensitive user IDs (one-time, recommended)

Lead Getter device IDs are case-sensitive. Prisma can't express column collations, so `db push` creates `users.id` and `subscriptions.user_id` case-insensitive. To fix that once (collation change only; no rows are touched; `db push` keeps it afterwards):

```bash
pm2 stop axora-subscriptions
mysql -u USER -p DB_NAME < prisma/case-sensitive-ids.sql
pm2 start axora-subscriptions
```

Check the result (both should be `ascii_bin`):

```sql
SELECT table_name, column_name, collation_name FROM information_schema.columns
WHERE table_schema = DATABASE() AND column_name IN ('id', 'user_id');
```

### Reverse proxy (nginx)

`certbot --nginx -d subscription.axorawebsolutions.com` adds HTTPS:

```nginx
server {
  server_name subscription.axorawebsolutions.com;
  location / {
    proxy_pass http://127.0.0.1:3060;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Keep `TRUST_PROXY=1` so client IPs (rate limiting) and HTTPS (HSTS) are detected through the proxy.

### Check

1. Open `https://subscription.axorawebsolutions.com` — the browser asks for the admin username and password.
2. Add a test user, activate, suspend and delete it.
3. Without credentials, `curl -i https://subscription.axorawebsolutions.com/api/v1/users` must return `401`.

### Backups

All data is in the MySQL tables `users` and `subscriptions`; include the database in your hosting backups (or `mysqldump DB_NAME users subscriptions`).

## Tests

The tests create the schema with `prisma db push` and **drop all tables** in the database they are given, so use an empty, separate database:

```bash
TEST_DATABASE_URL=mysql://user:pass@127.0.0.1:3306/axora_subs_test npm test
```
