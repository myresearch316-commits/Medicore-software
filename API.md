# MediCore HMS — server API

Real multi-user backend. Authentication and permissions are enforced **on the server**;
the browser can no longer grant itself access.

## What changed

| Before | Now |
|---|---|
| Login checked in the browser | Server-side sessions, httpOnly cookie |
| Whole-state blob overwritten on every save | One row per record, `POST/PUT/DELETE` per record |
| Last writer silently wins | Optimistic concurrency — stale saves rejected with `409` |
| Audit log written by the browser | Audit written by the server, browser can't forge it |
| Anyone could open any module | Role-based access checked on every request |

## Deploy

```
git add -A && git commit -m "Server-side auth, RBAC and per-record API" && git push
```

Then Render → **New → Blueprint → this repo → Apply**. It creates the web service and
PostgreSQL, and generates `ADMIN_PASSWORD`.

1. Open **Render → your service → Environment**, copy the generated `ADMIN_PASSWORD`.
2. Sign in as `admin` with that password.
3. Change it immediately: `POST /api/auth/password`.
4. Verify: `GET /api/health` → `{"ok":true,"db":true,"auth":"session"}`.

## Roles

| Role | Can do |
|---|---|
| `admin` | Everything, including user management |
| `doctor` | Patients, charges, discharges, vitals, appointments, orders |
| `nurse` | Vitals, nursing notes, charges; **reads** patients |
| `reception` | Patients, appointments, OPD bills, charges |
| `pharmacy` | Stock, movements, prescriptions, charges |
| `lab` | Lab samples, imaging orders, charges |
| `billing` | Charges, bills, claims, policies, packages |
| `hr` | Payroll, shifts, staff |
| `viewer` | Read-only across the system |

## Endpoints

### Auth
```
POST /api/auth/login      {username, password}   → sets mc_session cookie
POST /api/auth/logout
GET  /api/auth/me                                → user + permission matrix
POST /api/auth/password   {current, next}        → signs out all sessions
```

### Users (admin only)
```
GET  /api/users
POST /api/users           {username, password, full_name, role, department}
PUT  /api/users/:id       {role?, department?, active?, full_name?, password?}
```

### Records — one row per record
```
GET    /api/r/:resource?limit=100&since=ISO      → list (permission-checked)
POST   /api/r/:resource   {...record}            → create
PUT    /api/r/:resource/:id  {..., _rev}         → update (409 if _rev is stale)
DELETE /api/r/:resource/:id                      → soft delete (recoverable)
```

Resources: `patients, charges, opd_bills, appointments, vitals, nurse_notes, discharges,
lab_samples, rad_orders, prescriptions, pharmacy, pharma_moves, claims, policies, packages,
payroll, shifts, staff, departments, audit, settings`

**Concurrency.** Send the `_rev` you loaded. If someone else saved in between you get
`409` with `currentRev` — reload and retry instead of overwriting their work.

### Audit
```
GET /api/audit?limit=200     (admin, doctor, billing)
```
Every login, failed login, create, update, delete and permission change is recorded with
username, role, IP and timestamp.

## Security notes

- Passwords: **scrypt** with a per-user random salt; comparison is timing-safe.
- Login timing is constant whether or not the username exists, so accounts can't be enumerated.
- Session cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` in production — JavaScript
  (including any injected script) cannot read them.
- Deleting a user or changing a password **invalidates all their sessions** immediately.
- Deletes are soft, so clinical records stay recoverable and auditable per NABH.

## Still to do

- Point the browser app at `/api/r/...` (it currently still uses the legacy `/api/state`,
  which is now session-protected but remains last-writer-wins).
- ABDM M1/M2 certification needs your facility's ABDM credentials — not something the
  code can self-certify.
