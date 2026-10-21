# Subscription API and Lead Getter integration

Base URL: `https://subscription.axorawebsolutions.com/api/v1`

## Authorization

Every route (and the admin page) requires one of:

| Method | Header | Used by |
|---|---|---|
| HTTP Basic | `Authorization: Basic base64(ADMIN_USERNAME:ADMIN_PASSWORD)` | The admin page (the browser prompts once and sends it automatically) |
| Bearer token | `Authorization: Bearer <ADMIN_API_TOKEN>` | Scripts and server-side tools |

- Basic-authorized `POST`, `PATCH` and `DELETE` requests must come from the site's own origin (`PUBLIC_ORIGIN`); cross-site requests get `403 forbidden_origin`. Bearer requests are not origin-checked.
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
{ "status": "active", "expiresAt": "2026-12-21T23:59:59Z" }
```
- `expiresAt` is required: an ISO 8601 date-time **with timezone** (`Z` or `±hh:mm`) in the future, or `null` for no expiry (lifetime).
- Activating sets `activatedAt` to now and clears `suspendedAt`. Activating an already active user replaces the expiry.

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

Errors: `400 invalid_status`, `400 expiry_required`, `400 invalid_expiry`, `400 expiry_in_past`, `400 unexpected_expiry`, `400 user_id_mismatch` (an `id` in the body differs from the URL), `400 invalid_user_id`, `404 user_not_found`.

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

Defined in [prisma/schema.prisma](../prisma/schema.prisma) and created with `npx prisma db push`. The `ascii_bin` collation on the two ID columns is applied once with [prisma/case-sensitive-ids.sql](../prisma/case-sensitive-ids.sql), since Prisma can't express collations.

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
  updated_at    DATETIME(3)
)
```

An access check for a user ID, if read directly from the database:

```sql
SELECT status = 'active' AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP(3)) AS has_access
FROM subscriptions WHERE user_id = ?;
```

## Lead Getter integration — findings and current gap

I inspected the Lead Getter code (`chrom-lead`, repository `ourswebsolutions-ux/lead-getter`) without changing it. What it actually does today:

**User ID.** The desktop app identifies itself only by a **Device ID**: a 32-character, case-sensitive base64url string derived from the app installation's own Ed25519 key (`src/main/license.js`, `deviceId`). It sends no email or other user ID. The app UI does not display the Device ID; it appears as **"Device ID"** in the subscription request email that Lead Getter's licence server sends to the administrator. Use that value as the `id` when adding the user here.

**What the desktop calls.** It talks to the licence server set in `src/main/license-config.json` (`serverUrl`, currently `http://127.0.0.1:8787`) and trusts only responses signed with that file's `publicKey`:

| Desktop call | Purpose |
|---|---|
| `GET /api/license?nonce=…` | Subscription status. The request is signed with the device key (`x-lf-key`, `x-lf-ts`, `x-lf-nonce`, `x-lf-machine`, `x-lf-sig`); the response is `{ "token": … }`, an Ed25519-signed payload with `subscription.state` = `none` / `active` / `expired`, `expiresAt`, the nonce and server time |
| `POST /api/trial/consume` | Counts one of 3 free searches |
| `POST /api/applications` | Subscription application with payment screenshot |
| `GET /api/plans` | Plan list |

It checks status at startup, before each search, and after applying, and never caches status as authority, so a status change is picked up at the next check.

**The gap.** The current desktop build does **not** call any of the four `/api/v1` routes, and it cannot be pointed at this site as-is: this site (as specified) has no `/api/license` route and does not sign responses with the Lead Getter licence key. Suspending a user here therefore does **not** yet affect the desktop app. Closing the gap needs one of these decisions, none of which I made on my own because each conflicts with an instruction for this task:

1. **Add Lead Getter's existing status route to this site**: device-signed `GET /api/license` reading the `subscriptions` table, signed with `LICENSE_PRIVATE_KEY`, mapping `effectiveStatus` `active` → `active`, `expired` → `expired`, and `inactive`/`suspended` → a non-active state. No desktop change needed (only `license-config.json`'s `serverUrl` set to this domain and the installers rebuilt). Conflicts with "only these four APIs / no licence-validation endpoints". Note that the free-trial and application routes would also need a home.
2. **Have Lead Getter's own licence server (`chrom-lead/server`) read this MySQL database** for subscription state. No desktop change, but it modifies the Lead Getter codebase's server.
3. **Change the desktop app to call this API.** Excluded by the task, and not safe with these routes: they need admin credentials, which can't be shipped inside an app.

When mapping `suspended` into Lead Getter's current status format: the app treats any `state` other than `active` as no subscription, but it still allows a user's remaining free trial searches (up to 3 per computer), and it has no message specific to suspension.
