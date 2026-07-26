# MediCore HMS — Full-Stack (Node + PostgreSQL on Render)

A real backend with a strong database. Data is stored in **Render PostgreSQL**,
so when you log in from any computer or browser, the same data is there.

```
medicore-server/
├── server.js         Express API + serves the app
├── package.json      dependencies (express, pg)
├── render.yaml       Render blueprint: web service + PostgreSQL database
└── public/
    └── index.html    the MediCore HMS frontend
```

## How it works
- **PostgreSQL** holds two tables (auto-created on first start):
  - `app_state` – the current data (JSONB) + a version number
  - `state_history` – an append-only log of **every** save (full audit trail; nothing is ever lost)
- The frontend talks to `/api/state` on the same server (no keys, no third parties).
- Saves use last-write-wins by version, so newer data never gets clobbered by stale writes.
- If the DB is briefly unavailable, the app keeps working from the browser and re-syncs.

## Deploy on Render (Blueprint — easiest)

1. Put this whole `medicore-server` folder into a **GitHub repo** (keep the structure).
2. Render dashboard → **New +** → **Blueprint**.
3. Connect the repo. Render reads `render.yaml` and creates **two things**:
   - a **PostgreSQL** database (`medicore-db`)
   - a **Web Service** (`medicore-hms`) with `DATABASE_URL` wired in automatically
4. Click **Apply**. First build takes a few minutes.
5. Open the web service URL (e.g. `https://medicore-hms.onrender.com`). Done —
   the database is connected automatically.

### Manual alternative (no blueprint)
1. Render → **New + → PostgreSQL** → create `medicore-db` → copy its **Internal Database URL**.
2. Render → **New + → Web Service** → connect the repo. Settings:
   - Runtime: **Node**
   - Build Command: `npm install`
   - Start Command: `node server.js`
   - Add env var **DATABASE_URL** = the Internal Database URL from step 1.
   - Health Check Path: `/api/health`
3. Create → wait for the build → open the URL.

## Updating later
Push changes to the repo (or upload a new `public/index.html`). Render auto-redeploys.
Existing data stays safe in PostgreSQL across deploys.

## Logins
- App login: **admin / medicore**
- Admin portal: **admin / admin123** (changeable in Admin → Credentials)
- Modules: `opd/opd123`, `ipd/ipd123`, `doctor/doctor123`, `nursing/nursing123`,
  `pathology/pathology123`, `sonography/sonography123`, `radiology/radiology123`,
  `cardiology/cardiology123`, `accounting/accounting123`, `mrd/mrd123`, `help/help123`.

## Health check
Visit `/api/health` on your deployed URL → should return `{"ok":true,"db":true}`.

## Notes
- Render's **free** PostgreSQL is time-limited; for long-term production choose a paid
  database instance (same setup, just pick a paid plan in render.yaml or the dashboard).
- The free web service sleeps after inactivity and wakes on the next visit (first load
  may take a few seconds). Paid instances stay always-on.
