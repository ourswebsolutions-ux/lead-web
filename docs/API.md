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

## Lead Getter integration

The Lead Getter desktop app never calls the `/api/v1` routes above (they need admin credentials, which must never ship inside an app). It talks to the **Lead Getter licence server** (lead-getter repository, `server/`), served at:

`https://subscription.axorawebsolutions.com/lead-getter`

| Desktop call (no admin credentials) | Purpose | Protection (licence server) |
|---|---|---|
| `GET /lead-getter/api/plans` | Plan list | Public, read-only |
| `GET /lead-getter/api/license?nonce=…` | The device's own subscription status, as a server-signed token | Ed25519 device signature, ±5 min timestamp, single-use nonce; a device only ever sees its own status |
| `POST /lead-getter/api/trial/consume` | One of 3 free searches | Device signature; counted per computer |
| `POST /lead-getter/api/applications` | Apply with payment screenshot (registers the device here as an **inactive** user) | Device signature; 10 per device per day; image type/size checked |
| `GET/POST /lead-getter/admin/applications/:id/approve` (emailed link) | Administrator approves → activates here | Single-use, expiring token from the admin email |

The licence server uses this site's API server-to-server with `Authorization: Bearer <ADMIN_API_TOKEN>` (its `SUBSCRIPTION_API_TOKEN`) to look up a device (`GET /users?search=`), register it (`POST /users`, never changing an existing user; an email already used by another device is refused) and activate it on approval (`PATCH /users/:id/subscription`). Suspending a user here takes effect at the device's next status check.

**Routing.** nginx's `location /lead-getter/` (lead-getter `server/deploy/nginx-lead-getter.conf`) sends these requests to the licence server (port 8787). Requests for `/lead-getter/*` that reach this app instead are forwarded to `LEAD_GETTER_UPSTREAM` (default `http://127.0.0.1:8787`) without this site's admin login, and without any `Authorization` or `Cookie` header. Every other path on this site keeps the admin login. If the licence server is down, `/lead-getter/*` answers `502 { "error": { "code": "licence_server_unavailable" } }`.
