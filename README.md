# Axora subscription management

One-page admin site and API for Axora Web Solutions subscriptions, deployed at `https://subscription.axorawebsolutions.com`.

- List, search (email or user ID), add and delete users
- One subscription action per user: **Activate** (with duration or expiry date) or **Suspend**
- Data in MySQL/MariaDB; no Supabase, Firebase or Render
- Node.js + Express + Prisma ORM; dependencies: `express`, `@prisma/client`, `prisma`

API reference, status values, database schema and the Lead Getter integration notes: **[docs/API.md](docs/API.md)**.

## Project layout

```
src/server.js     startup: env → database → migrations → HTTP
src/app.js        routes, validation, error handling
src/auth.js       admin authorization (Basic / Bearer), CSRF and brute-force protection
src/users.js      (Prisma) user and subscription queries
prisma/           schema.prisma and migrations (prisma migrate)
scripts/migrate.js  npm run migrate: prisma migrate deploy (+ baseline of older databases)
public/           the admin page (HTML, CSS, JS; no secrets)
test/             API tests against a real MySQL database
```

## Security

- **No login page.** The whole site, page included, is protected with HTTP Basic auth checked on the server; the browser shows its own sign-in prompt once. Scripts can use `Authorization: Bearer <ADMIN_API_TOKEN>`.
- Credentials and database settings exist only in server environment variables. The page's JavaScript contains no secrets and calls the API with the browser's same-origin credentials.
- Basic-authorized changes must come from the site's own origin (CSRF protection); 10 failed sign-ins lock an IP out for 15 minutes; strict Content-Security-Policy, `X-Frame-Options: DENY`, `no-store` caching, `noindex`.
- **Serve it over HTTPS only** — Basic auth sends the password with every request.

## Local development

Requires Node.js 20+ and a MySQL 5.7+/8 or MariaDB 10.3+ database.

```bash
npm install
npm install               # also runs prisma generate
cp .env.example .env      # fill in DATABASE_URL, ADMIN_USERNAME, ADMIN_PASSWORD
npm run migrate           # optional: start also migrates when MIGRATE_ON_START=true
npm start                 # http://localhost:3000
```

Tests (drop and recreate the tables in the database you give them, so use an empty, separate one):

```bash
TEST_DATABASE_URL=mysql://user:pass@127.0.0.1:3306/axora_subs_test npm test
```

## Environment variables

| Variable | Required | Example | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | `mysql://axora:p%40ss@localhost:3306/axora_subs` | MySQL/MariaDB connection used by Prisma (URL-encode the password; add `?sslaccept=strict` for TLS) |
| `ADMIN_USERNAME` | yes | `admin` | Admin sign-in |
| `ADMIN_PASSWORD` | yes | 12+ random characters | Admin sign-in |
| `ADMIN_API_TOKEN` | no | 64 hex characters | Bearer token for scripts (32+ characters) |
| `PORT`, `HOST` | no | `3000`, `0.0.0.0` | Listen address |
| `PUBLIC_ORIGIN` | no | `https://subscription.axorawebsolutions.com` | Allowed origin for changes |
| `TRUST_PROXY` | behind a proxy | `1` | Real client IP / HTTPS detection behind cPanel, nginx, Cloudflare |
| `MIGRATE_ON_START` | no | `true` | Run `prisma migrate deploy` at startup |

Variables set by the hosting panel take precedence over `.env`.

## Deployment

### 1. Database (on your hosting)

1. In cPanel → **MySQL Databases** (or your host's equivalent), create a database, e.g. `axora_subs`, and a user with a strong password.
2. Add the user to the database with **ALL PRIVILEGES** (the migrations need `CREATE`, `ALTER`, `INDEX`, `REFERENCES`; the app then needs `SELECT`, `INSERT`, `UPDATE`, `DELETE`).
3. Note the host (usually `localhost` when the app runs on the same hosting), port `3306`, user, password and database name. cPanel prefixes names with your account name, e.g. `cpuser_axora_subs`.

### 2a. cPanel hosting with "Setup Node.js App"

1. Create the subdomain `subscription.axorawebsolutions.com` (cPanel → **Domains**), and issue an SSL certificate for it (**SSL/TLS Status** → AutoSSL).
2. Upload this folder (without `node_modules` and `.env`) to e.g. `~/subscription.axorawebsolutions.com`.
3. cPanel → **Setup Node.js App** → **Create Application**:
   - Node.js version: 20 or newer
   - Application mode: Production
   - Application root: `subscription.axorawebsolutions.com`
   - Application URL: `subscription.axorawebsolutions.com`
   - Application startup file: `src/server.js`
4. Add the environment variables from the table above (at least the database settings, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `TRUST_PROXY=1`). Alternatively create `.env` in the application root and `chmod 600 .env`.
5. Click **Run NPM Install** (this also generates the Prisma Client), then **Restart**. Pending migrations are applied on start (or run `npm run migrate` from the app's virtual-environment shell shown at the top of the page).
6. Force HTTPS: cPanel → **Domains** → turn on **Force HTTPS Redirect** for the subdomain.

### 2b. VPS (systemd + nginx)

```bash
# as the deploy user, Node.js 20+ installed
git clone <this repo> /srv/axora-subscriptions && cd /srv/axora-subscriptions
npm ci --omit=dev        # prisma is a runtime dependency; postinstall generates the client
cp .env.example .env && chmod 600 .env   # fill in; HOST=127.0.0.1, TRUST_PROXY=1
npm run migrate
```

`/etc/systemd/system/axora-subscriptions.service`:

```ini
[Unit]
Description=Axora subscription management
After=network.target mysql.service

[Service]
User=www-data
WorkingDirectory=/srv/axora-subscriptions
ExecStart=/usr/bin/node src/server.js
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

nginx (`certbot --nginx -d subscription.axorawebsolutions.com` adds HTTPS):

```nginx
server {
  server_name subscription.axorawebsolutions.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

```bash
sudo systemctl enable --now axora-subscriptions
```

### 3. DNS

Point `subscription.axorawebsolutions.com` (A record, or the subdomain cPanel created) at the hosting server.

### 4. Check

1. Open `https://subscription.axorawebsolutions.com` — the browser asks for the admin username and password.
2. Add a test user, activate, suspend and delete it.
3. Without credentials, `curl -i https://subscription.axorawebsolutions.com/api/v1/users` must return `401`.

### Database migrations

- Migrations live in `prisma/migrations/` and are applied with `prisma migrate deploy` (via `npm run migrate`, or automatically on start). This never resets or drops data, and needs no shadow database or `CREATE DATABASE` privilege.
- **Upgrading a database created by the previous (pre-Prisma) version:** `npm run migrate` detects its `schema_migrations` table and marks the identical init migration as applied (`prisma migrate resolve`) without running any SQL, so existing users and subscriptions are untouched. The old `schema_migrations` table is left in place and can be dropped by hand afterwards. A database with any other unrecognised `users` table is refused, unchanged.
- **Changing the schema:** edit `prisma/schema.prisma`, then create a migration on a development database, e.g. `npx prisma migrate dev --name add_x` (needs a user allowed to create a shadow database), review the SQL, and deploy it with `npm run migrate`. Keep the `ascii_bin` collation on the `id`/`user_id` columns: Prisma can't express it, and Lead Getter device IDs are case-sensitive.

### Backups

All data is in the two MySQL tables `users` and `subscriptions`; include the database in your hosting backups (or `mysqldump axora_subs users subscriptions _prisma_migrations`).
