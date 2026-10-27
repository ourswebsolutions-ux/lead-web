# Subscription API and Lead Getter integration

Base URL: `https://subscription.axorawebsolutions.com/api/v1`

## Authorization

Every `/api/v1` route (and the dashboard) requires the admin login as HTTP Basic auth: `Authorization: Basic base64(ADMIN_USERNAME:ADMIN_PASSWORD)`. The browser asks for it once and sends it automatically.

- `POST`, `PATCH` and `DELETE` requests must come from the site's own origin (`PUBLIC_ORIGIN`); cross-site requests get `403 forbidden_origin`.
- After 10 failed attempts from one IP, that IP gets `429 too_many_attempts` for 15 minutes.
- These are **administrative** credentials. They must never be embedded in the desktop app or any other client that customers can inspect: anyone holding them can activate, suspend or delete every subscription.

## Data model

```jsonc
// User object (every response that returns a user)
{
  "id": "Ab3_-xY9Ab3_-xY9Ab3_-xY9Ab3_-xY9",   // user ID (Lead Getter Device ID), case-sensitive
  "email": "customer@example.com",          // stored lower-case, unique
  "createdAt": "2026-10-21T14:37:00.263Z",
  "updatedAt": "2026-10-21T14:37:00.263Z",
  "subscription": {
    "status": "active",                     // stored status: inactive | active | suspended
    "effectiveStatus": "active",            // inactive | active | expired | suspended
    "expiresAt": "2026-12-21T23:59:59.000Z",// null = no expiry (or never activated)
    "activatedAt": "2026-10-21T14:37:00.404Z",
    "suspendedAt": null,
    "updatedAt": "2026-10-21T14:37:00.404Z"
  }
}
```

### Status values

| `status` (stored) | `effectiveStatus` | Meaning | Access should be granted |
|---|---|---|---|
| `inactive` | `inactive` | User added, never activated | No |
| `active` | `active` | Active, `expiresAt` in the future or `null` | **Yes** |
| `active` | `expired` | Active but `expiresAt` has passed (computed on every read, server clock) | No |
| `suspended` | `suspended` | Suspended by the admin; takes effect immediately | No |

**Only `effectiveStatus === "active"` means access.** All times are ISO 8601 UTC.

## Routes

### `GET /users`

Lists all users, newest first. Optional `?search=` matches the user ID exactly or by prefix (case-sensitive), or any part of the email (case-insensitive).

```http
GET /api/v1/users?search=customer@
```
```json
200 { "users": [ { …user… } ], "count": 1 }
```

### `POST /users`

```json
{ "id": "Ab3_-xY9Ab3_-xY9Ab3_-xY9Ab3_-xY9", "email": "customer@example.com" }
```

- `id`: required, 3–64 characters `A-Z a-z 0-9 - _`. For Lead Getter customers, use their Device ID.
- `email`: required, valid address, unique (case-insensitive).
- New users start with subscription status `inactive`.

`201 { "user": { … } }` · `400 validation_failed` (with `fields`) · `409 user_exists` · `409 email_exists`

### `DELETE /users/:id`

Deletes the user and their subscription row.

`200 { "deleted": true, "id": "…" }` · `404 user_not_found`

### `PATCH /users/:id/subscription`

Activate:
```json
{ "status": "active", "expiresAt": "2026-12-21T23:59:59Z", "plan": "monthly" }
```
- `expiresAt` is required: an ISO 8601 date-time **with timezone** (`Z` or `±hh:mm`) in the future, or `null` for no expiry (lifetime).
- `plan` (optional): `free`, `monthly`, `six_months` or `lifetime`, the plan the Lead Getter daily allowance comes from. Without it the current plan is kept.
- Activating sets `activatedAt` to now and clears `suspendedAt`. Activating an already active user replaces the expiry.

Revoke (back to the Free allowance):
```json
{ "status": "inactive" }
```

Suspend:
```json
{ "status": "suspended" }
```
- Takes effect immediately; `expiresAt` is kept for the record. Repeating it is harmless (`suspendedAt` keeps the first time).
- `expiresAt` must not be sent when suspending.

Response:
```json
200 { "user": { …updated user… }, "status": "active" }
```
(`status` here is the resulting `effectiveStatus`.)

Every change here is recorded in the audit log (`licence_audit_log`) with the signed-in administrator.

Errors: `400 invalid_status`, `400 invalid_plan`, `400 unexpected_plan`, `400 expiry_required`, `400 invalid_expiry`, `400 expiry_in_past`, `400 unexpected_expiry`, `400 user_id_mismatch` (an `id` in the body differs from the URL), `400 invalid_user_id`, `404 user_not_found`.

### Payment applications (Lead Getter)

The dashboard's "Payment approvals" list. Approving or cancelling here is the same decision as the Approve/Cancel buttons in the emailed request (each application is decided once).

| Route | Answer |
|---|---|
| `GET /applications[?status=pending\|approved\|cancelled]` | `{ "applications": [ { id, deviceId, plan, planName, priceLabel, email, emailVerified, message, status, createdAt, decidedAt, hasScreenshot, user } ], "count" }` (`user`: the device's user here, or `null`) |
| `GET /applications/:id/screenshot` | The payment screenshot (PNG/JPEG/WebP) |
| `POST /applications/:id/approve` | `{ "application": { … } }`; activates the device's subscription (registering it with the application's email if needed). Monthly/Six Months count from now, or from the current end date when renewing early; Lifetime never expires. |
| `POST /applications/:id/cancel` | `{ "application": { … } }`; nothing is activated |

Errors: `404 application_not_found`, `409 already_processed`, `409 not_activated` (no email, or the email belongs to another user), `503 not_activated` (database unavailable).

## Errors

All errors are JSON:

```json
{ "error": { "code": "user_not_found", "message": "No user with the ID abc.", "fields": { } } }
```

`fields` appears only on `validation_failed`.

| HTTP | Codes |
|---|---|
| 400 | `invalid_json`, `invalid_body`, `validation_failed`, `invalid_user_id`, `invalid_status`, `expiry_required`, `invalid_expiry`, `expiry_in_past`, `unexpected_expiry`, `user_id_mismatch` |
| 401 | `unauthorized` |
| 403 | `forbidden_origin` |
| 404 | `user_not_found`, `not_found` |
| 409 | `user_exists`, `email_exists` |
| 413 | `body_too_large` (bodies are limited to 10 KB) |
| 429 | `too_many_attempts` |
| 500 | `server_error` (details only in the server log) |
| 503 | `database_unavailable` |

## Database schema (MySQL / MariaDB)

Defined in [prisma/schema.prisma](../prisma/schema.prisma) and created by `npm run build` / `npm run dev` ([prisma/setup.js](../prisma/setup.js), additions only). The ID columns use the case-sensitive `ascii_bin` collation, which setup applies since Prisma can't express collations. The desktop API's tables (`licence_devices`, `licence_applications`, `licence_action_tokens`, `licence_trials`, `licence_seen_requests`, `licence_signing_keys`, `licence_activations`, `licence_credit_usage`, `licence_credit_leads`, `licence_audit_log`) and `app_settings` are described in the schema file.

```sql
users (
  id          VARCHAR(64) ascii_bin PRIMARY KEY,   -- case-sensitive user ID
  email       VARCHAR(254) UNIQUE NOT NULL,
  created_at  DATETIME(3), updated_at DATETIME(3)
)
subscriptions (
  user_id       VARCHAR(64) ascii_bin PRIMARY KEY  -> users.id ON DELETE CASCADE,
  status        ENUM('inactive','active','suspended') NOT NULL DEFAULT 'inactive',
  expires_at    DATETIME(3) NULL,                  -- UTC; NULL while active = no expiry
  activated_at  DATETIME(3) NULL,
  suspended_at  DATETIME(3) NULL,
  plan          VARCHAR(32) NULL,                  -- free | monthly | six_months | lifetime (daily allowance)
  updated_at    DATETIME(3)
)
```

An access check for a user ID, if read directly from the database:

```sql
SELECT status = 'active' AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP(3)) AS has_access
FROM subscriptions WHERE user_id = ?;
```

## Lead Getter desktop API (`/lead-getter`)

Served by this app at `https://subscription.axorawebsolutions.com/lead-getter` (installed apps' `license-config.json`), with the same routes, requests, answers, messages and signed payloads as the former standalone Lead Getter licence server. No admin login: every device request is signed with the device's own Ed25519 key.

| Desktop call | Purpose | Protection |
|---|---|---|
| `GET /lead-getter/health` | `{"ok":true}` | Public |
| `GET /lead-getter/api/plans` | `{ plans (paid), freePlan, paymentMethods, paymentInstructions, trialSearches, timezone }`; each plan has its daily allowance (`daily`: `{ total }`, `{ maps, facebook }` or `null` = unlimited) | Public, read-only |
| `GET /lead-getter/api/license?nonce=…` | `{ "token": … }`: the device's own status, signed by the server: `v` (2), `deviceId, nonce, serverTime`, the earlier fields (`subscription, registration, application, pendingApplications, trial`) and `plan` (the plan in effect), `credits` (today's allowance: `day, timezone, resetsAt, scope, total, maps, facebook, discovered`), `activation` (the open request: `id, plan, status, code { expiresAt, attemptsLeft, resendAt }`; never the code) | Device signature (`x-lf-key`, `x-lf-ts` ±5 min, `x-lf-nonce`, `x-lf-machine`, `x-lf-sig`); each signature accepted once |
| `POST /lead-getter/api/activation` | `{ plan }` (`monthly`, `six_months`, `lifetime`): an Activation ID and a 4-digit code, emailed with the plan and Device ID to `SUBSCRIPTION_ADMIN_EMAIL` only. The same plan again keeps the request; another plan replaces it | Device signature; 5 requests per device per day |
| `POST /lead-getter/api/activation/verify` | `{ code }`: activates the request's plan at once (`{ activated, plan, expiresAt }`). Errors carry `reason`: `invalid` (with `attemptsLeft`), `locked`, `expired`, `used`, `not_open` | Device signature; 5 tries per code, counted before comparing; codes last 24 hours and work once; only an HMAC is stored |
| `POST /lead-getter/api/activation/resend` | A new code for the open request, to the administrator | Device signature; once a minute, 5 a day |
| `POST /lead-getter/api/credits/reserve` | `{ source: "maps"\|"facebook", key }` (64 hex: a hash of the lead, never the lead): charges one new qualified lead. `{ granted, duplicate, reason, credits }`; the same lead is never charged twice | Device signature; limits from this site's record of the plan, enforced in one transaction |
| `POST /lead-getter/api/trial/consume` | One of 3 free searches per computer (`402` when used up) | Device signature |
| `POST /lead-getter/api/applications` | Apply with a payment screenshot; emails the administrator; registers the device here as an **inactive** user | Device signature; 10 per device per day; PNG/JPEG/WebP ≤ 5 MB |
| `GET/POST /lead-getter/admin/applications/:id/approve\|cancel`, `…/screenshot`, `/lead-getter/verify-email` | Emailed links | Single-use, expiring tokens |

Errors are `{ "error": "<message>" }` (JSON) under `/lead-getter/api/`, HTML pages elsewhere, exactly as before.

**Daily allowance.** Free: 5 Google Maps + 5 Facebook leads a day per computer (`x-lf-machine`). Monthly: 100 and Six Months: 250 a day, both sources together. One-Time: unlimited. Days end at midnight in `CREDITS_TIMEZONE`. An expired plan falls back to Free; a suspended one gets nothing. Subscriptions activated before plans were recorded take the plan of their approved payment application, or One-Time when they never expire, otherwise Monthly.

**Status values** in the signed token's `subscription.state`: `active`, `expired`, `suspended`, `inactive` (registered, not activated), `none` (not registered) — this site's `effectiveStatus` for that Device ID. Suspending or activating a user here takes effect at the device's next status check.

**Signing key.** Installed apps only accept a status signed with the key matching the public key in their `license-config.json` (`MCowBQYDK2VwAyEAJqP+z5ZlpDVYDMLWlgGAcf6+H01wGWAiP2Rs5CpUlZY=`). Setup finds that key automatically, verifies it and stores it in the database; it never generates or replaces one. Without it, `/lead-getter/api/license` answers `503 {"error":"Subscriptions are temporarily unavailable on the server. Please try again later."}` and the log says why; plans and health keep working.
