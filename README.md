# Axora subscription management

One Next.js app (JavaScript, App Router) at `https://subscription.axorawebsolutions.com`, with MySQL/MariaDB through Prisma, run as **one PM2 process**:

- **Admin dashboard** (`/`): add, search, activate (by duration or expiry date), suspend and delete users; approve or cancel Lead Getter payments.
- **Admin API** (`/api/v1`): the dashboard's API.
- **Lead Getter desktop API** (`/lead-getter`): plans, signed subscription status, activation codes (emailed to `SUBSCRIPTION_ADMIN_EMAIL` only) and the daily qualified-lead allowance (Lead Finder 1.6+). The earlier routes (free trials, payment applications, emailed Approve/Cancel links) still answer for older app versions.

API reference: **[docs/API.md](docs/API.md)**.

## Deploy (VPS + PM2)

```bash
cd /path/to/subcription.axorawebsolutions.com
git pull
npm install                 # also generates the Prisma client
cp -n .env.example .env     # first time only: DATABASE_URL, ADMIN_USERNAME, ADMIN_PASSWORD
npm run build               # prepares the database (below), then builds
pm2 start ecosystem.config.cjs && pm2 save        # first time
pm2 restart axora-subscriptions                   # every later update (after npm run build)
```

**Switching from the earlier Express version:** its PM2 entry runs `src/server.js`, which no longer exists. Replace it once: `pm2 delete axora-subscriptions && pm2 start ecosystem.config.cjs && pm2 save`.

The app listens on port **3060** (nginx proxies `subscription.axorawebsolutions.com` to `127.0.0.1:3060`). No nginx `location /lead-getter/` or second process is needed any more; remove the Lead Getter licence server's PM2 process (`pm2 delete lead-getter-licence`) if it was ever set up.

Local development: `npm run dev` (http://localhost:3060).

### What `npm run build` / `npm run dev` set up automatically

`prisma/setup.js`, safe to run any number of times; it never resets or deletes data:

1. **Tables**: creates missing tables and indexes from `prisma/schema.prisma`. Only additions are applied; if the database differs in any other way, nothing is changed and the build stops with the details.
2. **Case-sensitive IDs**: Lead Getter Device IDs are case-sensitive; the ID columns are switched to `ascii_bin` (no rows change).
3. **Signing key**: installed Lead Finder apps only accept a subscription status signed with their existing key. It is found automatically (`LICENSE_PRIVATE_KEY`, or an earlier Lead Getter licence server's `.env` in `/opt/lead-getter/server/`, or a `lead-getter`/`chrom-lead` checkout next to this folder), checked against the public key built into the apps, and stored in the database, so later builds and restarts reuse it. A new key is **never** generated (it would lock out every installed app) and a stored key is never replaced.
4. **Earlier licence data**: if that licence server's data (`subscriptions.db`) is found, its devices, applications, free-trial counts and payment screenshots are imported once; a licence it had approved becomes the same active subscription here.

The licence server's email settings (`SMTP_*`, `SUBSCRIPTION_ADMIN_EMAIL`, `PAYMENT_INSTRUCTIONS`) are reused from its `.env` the same way. The build log says what it found.

### Settings (`.env`)

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | `mysql://USER:PASSWORD@HOST:3306/DB` (URL-encode the password) |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | yes | Dashboard sign-in (browser prompt) |
| `PUBLIC_ORIGIN` | no | `https://subscription.axorawebsolutions.com` (links in emails) |
| `TRUST_PROXY` | behind nginx | `1` |
| `LICENSE_PRIVATE_KEY`, `SMTP_*`, `SUBSCRIPTION_ADMIN_EMAIL`, `PAYMENT_INSTRUCTIONS` | only if not found automatically | See above |
| `UPLOAD_DIR` | no | Payment screenshots (default `data/uploads`) |
| `CREDITS_TIMEZONE` | no | Daily lead allowances reset at midnight here (default `Asia/Karachi`) |
| `PLAN_*` | no | Prices, durations and daily allowances (defaults: Monthly PKR 3,000 / 1 month / 100 a day; Six Months PKR 10,000 / 6 / 250; One-Time PKR 20,000 / unlimited; Free 5 Google Maps + 5 Facebook). Names: `PLAN_MONTHLY_PRICE`, `PLAN_MONTHLY_MONTHS`, `PLAN_MONTHLY_DAILY_LEADS`, `PLAN_SIX_MONTHS_*`, `PLAN_ONE_TIME_PRICE`, `PLAN_FREE_DAILY_MAPS`, `PLAN_FREE_DAILY_FACEBOOK` |
| `SEED_USER_ID`, `SEED_USER_EMAIL` | no | Initial user for `npm run seed` |

### Check after deploying

```bash
curl https://subscription.axorawebsolutions.com/lead-getter/health      # {"ok":true}
curl https://subscription.axorawebsolutions.com/lead-getter/api/plans   # the plan list
curl -i https://subscription.axorawebsolutions.com/api/v1/users         # 401 without the admin login
pm2 logs axora-subscriptions --lines 20    # "[licence] status signing key ready"
```

## Security

- The dashboard and `/api/v1` need the admin login; changes must come from the site itself. 10 wrong passwords lock an address out for 15 minutes.
- `/lead-getter` needs no admin login: the desktop app signs every request with its own device key (checked, with replay protection), and only ever sees its own status.
- Secrets stay on the server (`.env`, database). The signing key is never logged or served. Serve the site over HTTPS only.

## Development

```
app/                 dashboard (page.jsx, dashboard.jsx) and route handlers
  api/v1/…           admin API          lead-getter/[[...path]]/   desktop API
lib/                 admin API, users, login (auth.js), lib/licence/ (desktop API)
middleware.js        admin login for everything except /lead-getter
prisma/              schema.prisma, setup.js (automatic setup), seed.js
test/                tests (need an empty test database)
```

```bash
TEST_DATABASE_URL=mysql://user:pass@127.0.0.1:3306/axora_subs_test npm test   # drops every table in that database
```
