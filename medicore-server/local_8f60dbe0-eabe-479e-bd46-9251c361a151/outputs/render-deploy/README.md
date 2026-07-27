# MediCore HMS — Deploy + Cloud Data Setup

`index.html` is the whole app. To make data appear on **any computer/browser**
when logged in, connect it to a free **Supabase** database (steps below).
Without those keys it still works, but data stays per-browser.

--------------------------------------------------------------------
## PART 1 — Set up the free cloud database (Supabase)
--------------------------------------------------------------------

1. Go to https://supabase.com → sign up (free) → **New project**.
   - Give it a name and a database password, pick a region, create it.
   - Wait ~1 minute for it to finish setting up.

2. In your project, open **SQL Editor** (left sidebar) → **New query**,
   paste the block below, and click **Run**:

   ```sql
   create table if not exists app_state (
     id text primary key,
     data jsonb
   );
   alter table app_state enable row level security;
   create policy "public access" on app_state
     for all using (true) with check (true);
   ```

3. Open **Project Settings → API**. Copy these two values:
   - **Project URL**  (looks like `https://abcdxyz.supabase.co`)
   - **anon public** key (a long text string under "Project API keys")

4. Open `index.html` in any text editor and find these two lines near the
   top of the `<script>` (around line 2050):

   ```js
   const SUPABASE_URL = ''; // e.g. https://abcdxyz.supabase.co
   const SUPABASE_KEY = ''; // your anon public key
   ```

   Paste your values inside the quotes, e.g.:

   ```js
   const SUPABASE_URL = 'https://abcdxyz.supabase.co';
   const SUPABASE_KEY = 'eyJhbGciOi....(your long anon key)....';
   ```

   Save the file. (Or just send me those two values and I'll paste them in.)

That's it — now every device that opens the app shares the same data.

--------------------------------------------------------------------
## PART 2 — Deploy on Render
--------------------------------------------------------------------

1. Create a GitHub repo (e.g. `medicore-hms`).
2. Upload `index.html` and `render.yaml` to the repo root → **Commit**.
3. Render dashboard → **New +** → **Static Site** → connect the repo.
   (Build Command: empty · Publish Directory: `.`)
4. **Create Static Site** → you get a public URL in ~1 minute.

To update later: upload the new `index.html` → Commit → Render auto-redeploys →
hard-refresh the page (Ctrl/Cmd+Shift+R).

--------------------------------------------------------------------
## Logins
--------------------------------------------------------------------

- App login: **admin / medicore**
- Admin portal: **admin / admin123** (changeable in Admin → Credentials)
- Modules: `opd/opd123`, `ipd/ipd123`, `doctor/doctor123`, `nursing/nursing123`,
  `pathology/pathology123`, `sonography/sonography123`, `radiology/radiology123`,
  `cardiology/cardiology123`, `accounting/accounting123`, `mrd/mrd123`, `help/help123`.

## Notes

- Cross-device updates land within a few seconds (the app polls the cloud).
- The anon key is safe to include in the file — the table policy above is what
  grants access. For a stricter production setup, add real Supabase Auth later.
