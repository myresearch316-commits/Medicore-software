# MediCore HMS — Deploy to Render

This is a single-file hospital management system (`index.html`). No backend, no build step — it runs entirely in the browser and saves data in the browser's local storage.

## Option A — Deploy via GitHub (recommended)

1. Create a new GitHub repository (e.g. `medicore-hms`).
2. Upload these two files to the repo root:
   - `index.html`
   - `render.yaml`
   (You can drag-and-drop them in GitHub's "Add file → Upload files" screen.)
3. Go to https://dashboard.render.com → **New +** → **Static Site**.
4. Connect your GitHub account and pick the `medicore-hms` repo.
5. Render auto-reads `render.yaml`. If asked manually, use:
   - **Build Command:** *(leave empty)*
   - **Publish Directory:** `.`
6. Click **Create Static Site**. In ~1 minute you get a public URL like
   `https://medicore-hms.onrender.com`.

## Option B — Deploy without render.yaml

If you skip the blueprint, create the Static Site and set:
- **Build Command:** *(empty)*
- **Publish Directory:** `.`

## After deploying

- Open the URL. App login: **admin / medicore**.
- Page 2: choose **Admin** or **Departments**.
- Module logins (admin can change them in Admin → Credentials):
  opd/opd123, ipd/ipd123, doctor/doctor123, nursing/nursing123,
  pathology/pathology123, sonography/sonography123, radiology/radiology123,
  cardiology/cardiology123, accounting/accounting123, mrd/mrd123, help/help123.
- Modules open in new tabs — allow pop-ups the first time.

## Notes

- **Data storage:** entries are saved per browser (localStorage) and sync live
  across tabs. This is client-side only — data is per-device, not a shared
  central database. Different computers will each have their own data.
- **Live sync** (department → admin dashboard) works within ~1.5s and is more
  reliable on a real https domain than when opening the file locally.
- To later turn this into a true multi-user system with one shared database,
  a small backend (e.g. Node + a database) would be added — ask if you want that.
