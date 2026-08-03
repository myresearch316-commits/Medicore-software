# Deploying MediCore HMS to Render

Follow this once. It takes about 15 minutes, most of which is waiting for Render.

---

## Before you start

You need a free [GitHub](https://github.com) account and a free [Render](https://render.com) account.
Sign in to Render **with your GitHub account** — it makes step 2 one click instead of ten.

---

## Step 1 — Put the code on GitHub

Open Terminal and paste these one at a time.

```bash
cd "/Users/dkarthikeyan/Desktop/untitled folder 2/medicore-server"
```

Stop the app from uploading junk:

```bash
printf 'node_modules/\n.DS_Store\n*.log\nreact-app/node_modules/\nreact-app/dist/\nlocal_*/\n' > .gitignore
```

That `local_*/` line is important — it keeps a folder of private session data (which
holds credentials) out of GitHub. Verify it worked before committing:

```bash
git status --short | grep local_ || echo "good — no private folder staged"
```

Create the repository and make the first commit:

```bash
git init
git add .
git commit -m "MediCore HMS — server, RBAC, audit trail"
git branch -M main
```

Now create an **empty** repository on GitHub: go to <https://github.com/new>, name it
`medicore-hms`, choose **Private**, and do **not** tick "Add a README".
GitHub then shows you a URL. Use it here:

```bash
git remote add origin https://github.com/YOUR-USERNAME/medicore-hms.git
git push -u origin main
```

If Git asks for a password, it wants a **personal access token**, not your GitHub password.
Create one at <https://github.com/settings/tokens> → *Generate new token (classic)* → tick
**repo** → copy it and paste it as the password.

---

## Step 2 — Create the service on Render

1. Go to <https://dashboard.render.com>.
2. Click **New → Blueprint**.
3. Pick your `medicore-hms` repository. Render reads `render.yaml` and offers to create
   **two** things: a web service and a PostgreSQL database. That is correct.
4. Before clicking Apply, set **ADMIN_EMAIL** to the address you want to sign in with —
   for example `macmaster381@gmail.com`. This account is created once, on first boot.
5. Click **Apply**.

The first build takes 3–5 minutes. Watch the log until you see:

```
[db] seeded first admin — sign in as "your@email.com", password from ADMIN_PASSWORD env
MediCore HMS listening on :10000 · db=true
```

`db=true` is the line that matters. If it says `db=false`, the database did not attach —
check the web service's **Environment** tab for `DATABASE_URL`.

---

## Step 3 — Get your password

Render generated a strong one for you.

1. Open your **medicore-hms** web service.
2. **Environment** tab → find `ADMIN_PASSWORD` → click the eye icon → copy it.

Your site is at `https://medicore-hms.onrender.com` (Render shows the exact URL at the top).

Sign in with the email from step 2 and this password. **Then change the password in the app**
so the one sitting in Render's dashboard stops being the live one.

---

## Step 4 — The two-browser test

This is the part worth doing carefully. It proves the backend is real and not just
browser storage pretending to be a server.

Open your site in **Chrome** and in a **private/incognito window** (or Safari) side by side.
The private window is important — it has its own cookies, so it is a genuinely separate user.

### 4a. Create a second user

In Chrome, signed in as admin, create a nurse account (Admin → Users).
In the second browser, sign in as that nurse.

### 4b. Does data actually cross?

- Register a patient in Chrome.
- Refresh the nurse's window. **The patient should appear.**

If it appears, your data is on the server. If it does not, the browsers are still isolated —
tell me and I will trace it.

### 4c. Do the permissions hold?

As the nurse, try to open **Payroll** or **TPA Claims**.
She should be refused — nurses have no HR or billing rights. If she can see payroll,
RBAC is not wired to that screen.

### 4d. Fight over a bed — the real test

This is the one that finds bugs.

1. Both browsers: go to **IPD** and look at the same empty bed, say `GEN-3`.
2. **Do not refresh either window.**
3. In Chrome, admit a patient to `GEN-3`.
4. In the nurse's window — still showing `GEN-3` as free — admit a *different* patient to it.

**Expected:** the second admit is refused with a message about the bed having changed, and
that window reloads to show the real occupant. **Not expected:** both admits "succeed" and
one patient silently vanishes.

### 4e. Pull the plug

1. In one browser, turn off Wi-Fi.
2. Add a charge. It should be accepted and marked as pending/queued.
3. Turn Wi-Fi back on and wait a moment.
4. Check the other browser — **the charge should arrive.**

### 4f. Check the audit trail

As admin, open the audit log. You should see every one of the above actions with the
username, what changed, and when — including the nurse's failed attempts.

---

## What to expect on the free plan

- **The service sleeps after 15 minutes idle.** The next visit takes ~50 seconds to wake.
  This is normal, and it is the single reason not to use the free plan for a real ward.
- **The free database expires after 90 days.** Render emails you. Upgrade before then or
  you lose the data.
- For actual hospital use, move both to a paid plan (~$7/month each) and take backups.

---

## If something breaks

| What you see | What it usually means |
|---|---|
| `Database not configured` | `DATABASE_URL` is not set. Check the Environment tab. |
| `Wrong email or password` | The email does not match `ADMIN_EMAIL` exactly, or you are using an old password. Check the deploy log for the exact address seeded. |
| Site loads but nothing saves | You are signed out. Look at the server badge in the app header. |
| Build fails on `npm install` | Node version — `package.json` requires 18+. Set `NODE_VERSION=20` in Environment. |
| Code changes do not show up | `git push` again; `autoDeploy` is on, so a push redeploys. |

---

## An honest note on scope

This deployment gives you a real multi-user system with server-enforced permissions and an
audit trail. It does **not** make the system certified. ABDM M1/M2 compliance requires
credentials issued to your facility and a government milestone process, and lab-machine
(LIS) integration needs an HL7/ASTM bridge to your specific analysers. Those parts of the
app are working stubs with the right data shapes, waiting for real credentials — they are
not live integrations. Please do not represent them as certified to a buyer.
