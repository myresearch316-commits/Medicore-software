/**
 * MediCore HMS — application server
 * ---------------------------------
 * Real multi-user backend:
 *   • PostgreSQL storage (one row per record — not a whole-state blob)
 *   • Server-side sessions in httpOnly cookies (no client-side auth)
 *   • Role-based access control enforced on every request
 *   • Server-written audit trail (NABH)
 *   • Optimistic concurrency (rev) so two users can't silently overwrite each other
 *
 * Legacy /api/state is still served so existing browsers keep working while
 * you migrate, but it is now session-protected and no longer the source of truth.
 */
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

let Pool = null;
try { Pool = require('pg').Pool; } catch (e) { console.warn('[db] pg not installed'); }

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '8mb' }));

const PORT = process.env.PORT || 3000;
const SESSION_MS = 12 * 60 * 60 * 1000;        // 12 hours
const PROD = process.env.NODE_ENV === 'production';

/* ------------------------------------------------------------------ *
 * Access control
 * ------------------------------------------------------------------ */
const RESOURCES = ['patients','charges','opd_bills','appointments','vitals','nurse_notes',
  'discharges','lab_samples','rad_orders','prescriptions','pharmacy','pharma_moves',
  'claims','policies','packages','payroll','shifts','staff','departments','audit','settings',
  'beds','ot_bookings','sanitation','physio','mrd_files'];

const ROLES = {
  admin:     { label:'Administrator',  all:true },
  doctor:    { label:'Doctor',         allow:{ patients:'rw',charges:'rw',discharges:'rw',vitals:'rw',appointments:'rw',lab_samples:'rw',rad_orders:'rw',prescriptions:'rw',beds:'rw',ot_bookings:'rw',physio:'rw',departments:'r',audit:'r' } },
  nurse:     { label:'Nurse',          allow:{ patients:'r',vitals:'rw',nurse_notes:'rw',charges:'rw',beds:'rw',sanitation:'rw',appointments:'r',departments:'r' } },
  reception: { label:'Reception',      allow:{ patients:'rw',appointments:'rw',charges:'rw',opd_bills:'rw',beds:'r',departments:'r' } },
  pharmacy:  { label:'Pharmacy',       allow:{ pharmacy:'rw',pharma_moves:'rw',prescriptions:'rw',charges:'rw',patients:'r' } },
  lab:       { label:'Lab / Radiology',allow:{ lab_samples:'rw',rad_orders:'rw',charges:'rw',patients:'r' } },
  billing:   { label:'Billing',        allow:{ charges:'rw',opd_bills:'rw',claims:'rw',policies:'rw',packages:'rw',patients:'r',mrd_files:'r',audit:'r' } },
  hr:        { label:'HR',             allow:{ payroll:'rw',shifts:'rw',staff:'rw' } },
  viewer:    { label:'Read only',      readAll:true }
};

function can(role, resource, mode) {
  if (!RESOURCES.includes(resource)) return false;
  const r = ROLES[role];
  if (!r) return false;
  if (r.all) return true;
  if (r.readAll) return mode === 'r';
  const g = (r.allow || {})[resource];
  if (!g) return false;
  return mode === 'r' ? (g === 'r' || g === 'rw') : g === 'rw';
}
const safeResource = (x) => (RESOURCES.includes(String(x || '')) ? String(x) : null);
const clampLimit = (n) => { const v = parseInt(n, 10); return (isNaN(v) || v < 1) ? 100 : Math.min(v, 500); };
/* Sign-in ID. Accepts an email address (what the UI asks for) or a plain
 * staff username, so ward/lab logins created by an admin still work. */
const validUser = (u) => /^[a-z0-9._+@-]{3,64}$/i.test(String(u || ''));
const strongEnough = (pw) => String(pw || '').length >= 8;

/* ------------------------------------------------------------------ *
 * Passwords & tokens
 * ------------------------------------------------------------------ */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return 'scrypt$' + salt + '$' + crypto.scryptSync(String(pw), salt, 64).toString('hex');
}
function verifyPassword(pw, stored) {
  try {
    const [alg, salt, key] = String(stored || '').split('$');
    if (alg !== 'scrypt' || !salt || !key) return false;
    const calc = crypto.scryptSync(String(pw), salt, 64);
    const known = Buffer.from(key, 'hex');
    if (calc.length !== known.length) return false;
    return crypto.timingSafeEqual(calc, known);
  } catch (e) { return false; }
}
const newToken = () => crypto.randomBytes(32).toString('hex');

/* ------------------------------------------------------------------ *
 * Database
 * ------------------------------------------------------------------ */
let db = null, dbReady = false;
if (Pool && process.env.DATABASE_URL) {
  db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 10 });
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id           BIGSERIAL PRIMARY KEY,
  username     TEXT UNIQUE NOT NULL,
  password     TEXT NOT NULL,
  full_name    TEXT DEFAULT '',
  role         TEXT NOT NULL DEFAULT 'viewer',
  department   TEXT DEFAULT '',
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip         TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS records (
  id         BIGSERIAL PRIMARY KEY,
  resource   TEXT NOT NULL,
  rec_id     TEXT NOT NULL,
  doc        JSONB NOT NULL,
  rev        INT  NOT NULL DEFAULT 1,
  deleted    BOOLEAN NOT NULL DEFAULT FALSE,
  created_by TEXT DEFAULT '',
  updated_by TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (resource, rec_id)
);
CREATE INDEX IF NOT EXISTS records_res ON records(resource, deleted, updated_at DESC);
CREATE TABLE IF NOT EXISTS audit (
  id         BIGSERIAL PRIMARY KEY,
  username   TEXT DEFAULT '',
  role       TEXT DEFAULT '',
  action     TEXT NOT NULL,
  resource   TEXT DEFAULT '',
  rec_id     TEXT DEFAULT '',
  detail     TEXT DEFAULT '',
  ip         TEXT DEFAULT '',
  at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS audit_at ON audit(at DESC);
CREATE TABLE IF NOT EXISTS app_state (id INT PRIMARY KEY, doc JSONB NOT NULL, v BIGINT NOT NULL);
`;

async function initDb() {
  if (!db) return;
  await db.query(SCHEMA);
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM users');
  if (rows[0].n === 0) {
    const pw = process.env.ADMIN_PASSWORD || 'ChangeMe#2026';
    const adminId = String(process.env.ADMIN_EMAIL || 'admin@medicore.local').trim().toLowerCase();
    await db.query('INSERT INTO users (username,password,full_name,role) VALUES ($1,$2,$3,$4)',
      [adminId, hashPassword(pw), 'Administrator', 'admin']);
    console.log('[db] seeded first admin — sign in as "' + adminId + '", password from ADMIN_PASSWORD env' +
      (process.env.ADMIN_PASSWORD ? '' : ' (DEFAULT "ChangeMe#2026" — change it now)'));
  }
  dbReady = true;
  console.log('[db] ready');
}
if (db) initDb().catch((e) => console.error('[db] init failed:', e.message));

async function audit(req, action, resource, recId, detail) {
  if (!dbReady) return;
  try {
    await db.query('INSERT INTO audit (username,role,action,resource,rec_id,detail,ip) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [req.user?.username || '', req.user?.role || '', action, resource || '', recId || '', detail || '', reqIp(req)]);
  } catch (e) { /* auditing must never break the request */ }
}
const reqIp = (req) => (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim();

/* ------------------------------------------------------------------ *
 * Cookies & session middleware
 * ------------------------------------------------------------------ */
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function setSessionCookie(res, token) {
  const bits = ['mc_session=' + token, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=' + Math.floor(SESSION_MS / 1000)];
  if (PROD) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'mc_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

async function loadSession(req, _res, next) {
  req.user = null;
  if (!dbReady) return next();
  const token = parseCookies(req).mc_session;
  if (!token) return next();
  try {
    const { rows } = await db.query(
      `SELECT s.token, u.id, u.username, u.full_name, u.role, u.department, u.active
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = $1 AND s.expires_at > NOW()`, [token]);
    if (rows[0] && rows[0].active) req.user = rows[0];
  } catch (e) { /* treat as anonymous */ }
  next();
}
app.use(loadSession);

const requireAuth = (req, res, next) => {
  if (!dbReady) return res.status(503).json({ error: 'Database not configured' });
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  next();
};
const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator only' });
  next();
};

/* ------------------------------------------------------------------ *
 * Auth routes
 * ------------------------------------------------------------------ */
app.post('/api/auth/login', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Database not configured' });
  const { username, password } = req.body || {};
  if (!validUser(username)) return res.status(401).json({ error: 'Wrong email or password' });
  try {
    const { rows } = await db.query('SELECT * FROM users WHERE lower(username)=lower($1)', [username]);
    const u = rows[0];
    // Always run a hash comparison so timing doesn't reveal whether the user exists.
    const okPw = verifyPassword(password, u ? u.password : 'scrypt$00$00');
    if (!u || !u.active || !okPw) {
      await db.query('INSERT INTO audit (username,action,detail,ip) VALUES ($1,$2,$3,$4)',
        [String(username).slice(0, 32), 'login.failed', 'bad credentials', reqIp(req)]).catch(() => {});
      return res.status(401).json({ error: 'Wrong username or password' });
    }
    const token = newToken();
    await db.query('INSERT INTO sessions (token,user_id,ip,expires_at) VALUES ($1,$2,$3,NOW() + ($4 || \' milliseconds\')::interval)',
      [token, u.id, reqIp(req), String(SESSION_MS)]);
    setSessionCookie(res, token);
    req.user = u;
    await audit(req, 'login', '', '', '');
    res.json({ ok: true, user: { username: u.username, name: u.full_name, role: u.role, department: u.department, permissions: permsFor(u.role) } });
  } catch (e) { res.status(500).json({ error: 'Login failed' }); }
});

app.post('/api/auth/logout', async (req, res) => {
  const token = parseCookies(req).mc_session;
  if (token && dbReady) { await audit(req, 'logout', '', '', ''); await db.query('DELETE FROM sessions WHERE token=$1', [token]).catch(() => {}); }
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  const u = req.user;
  res.json({ user: { username: u.username, name: u.full_name, role: u.role, department: u.department, permissions: permsFor(u.role) } });
});

/* Change your own sign-in email and/or password. Both need the current
 * password, so a walk-up at an unlocked terminal cannot take the account. */
app.post('/api/auth/password', requireAuth, async (req, res) => {
  const { current, next, email } = req.body || {};
  const wantPw = !!next, wantEmail = !!email;
  if (!wantPw && !wantEmail) return res.status(400).json({ error: 'Nothing to change' });
  if (wantPw && !strongEnough(next)) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  if (wantEmail && !validUser(email)) return res.status(400).json({ error: 'Enter a valid email address' });

  const { rows } = await db.query('SELECT password FROM users WHERE id=$1', [req.user.id]);
  if (!verifyPassword(current, rows[0] && rows[0].password)) return res.status(403).json({ error: 'Current password is wrong' });

  if (wantEmail) {
    const taken = await db.query('SELECT id FROM users WHERE lower(username)=lower($1) AND id<>$2', [email, req.user.id]);
    if (taken.rows.length) return res.status(409).json({ error: 'That email is already in use' });
    await db.query('UPDATE users SET username=$1 WHERE id=$2', [String(email).trim().toLowerCase(), req.user.id]);
  }
  if (wantPw) await db.query('UPDATE users SET password=$1 WHERE id=$2', [hashPassword(next), req.user.id]);

  await db.query('DELETE FROM sessions WHERE user_id=$1', [req.user.id]); // force re-login everywhere
  clearSessionCookie(res);
  await audit(req, 'credentials.change', '', '', wantEmail ? 'email' + (wantPw ? '+password' : '') : 'password');
  res.json({ ok: true, message: 'Sign-in details updated — sign in again' });
});

function permsFor(role) {
  const out = {};
  RESOURCES.forEach((r) => { out[r] = { read: can(role, r, 'r'), write: can(role, r, 'w') }; });
  return out;
}

/* ------------------------------------------------------------------ *
 * User administration (admin only)
 * ------------------------------------------------------------------ */
app.get('/api/users', requireAuth, requireAdmin, async (_req, res) => {
  const { rows } = await db.query('SELECT id,username,full_name,role,department,active,created_at FROM users ORDER BY username');
  res.json({ users: rows, roles: Object.keys(ROLES).map((k) => ({ key: k, label: ROLES[k].label })) });
});

app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  const { username, password, full_name, role, department } = req.body || {};
  if (!validUser(username)) return res.status(400).json({ error: 'Sign-in ID: an email address, or 3-64 letters, digits, . _ -' });
  if (!strongEnough(password)) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!ROLES[role]) return res.status(400).json({ error: 'Unknown role' });
  try {
    const { rows } = await db.query(
      'INSERT INTO users (username,password,full_name,role,department) VALUES ($1,$2,$3,$4,$5) RETURNING id,username,role',
      [username, hashPassword(password), full_name || '', role, department || '']);
    await audit(req, 'user.create', 'staff', String(rows[0].id), username + ' as ' + role);
    res.json({ ok: true, user: rows[0] });
  } catch (e) {
    if (String(e.message).includes('duplicate')) return res.status(409).json({ error: 'That username already exists' });
    res.status(500).json({ error: 'Could not create user' });
  }
});

app.put('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const { role, department, active, full_name, password } = req.body || {};
  if (role && !ROLES[role]) return res.status(400).json({ error: 'Unknown role' });
  if (password && !strongEnough(password)) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (String(req.params.id) === String(req.user.id) && active === false) return res.status(400).json({ error: "You can't deactivate yourself" });
  const sets = [], vals = [];
  const add = (col, v) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
  if (role) add('role', role);
  if (department !== undefined) add('department', department);
  if (active !== undefined) add('active', !!active);
  if (full_name !== undefined) add('full_name', full_name);
  if (password) add('password', hashPassword(password));
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  await db.query(`UPDATE users SET ${sets.join(',')} WHERE id=$${vals.length}`, vals);
  if (password || active === false) await db.query('DELETE FROM sessions WHERE user_id=$1', [req.params.id]);
  await audit(req, 'user.update', 'staff', req.params.id, Object.keys(req.body || {}).join(','));
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * Per-record REST API  —  /api/r/:resource
 * ------------------------------------------------------------------ */
app.get('/api/r/:resource', requireAuth, async (req, res) => {
  const resource = safeResource(req.params.resource);
  if (!resource) return res.status(404).json({ error: 'Unknown resource' });
  if (!can(req.user.role, resource, 'r')) return res.status(403).json({ error: 'Not allowed to view ' + resource });
  const limit = clampLimit(req.query.limit);
  const since = req.query.since ? new Date(req.query.since) : null;
  const params = [resource, limit];
  let sql = 'SELECT rec_id, doc, rev, updated_at, updated_by FROM records WHERE resource=$1 AND deleted=FALSE';
  if (since && !isNaN(since)) { params.push(since.toISOString()); sql += ` AND updated_at > $${params.length}`; }
  sql += ' ORDER BY updated_at DESC LIMIT $2';
  const { rows } = await db.query(sql, params);
  res.json({ resource, count: rows.length, records: rows });
});

app.post('/api/r/:resource', requireAuth, async (req, res) => {
  const resource = safeResource(req.params.resource);
  if (!resource) return res.status(404).json({ error: 'Unknown resource' });
  if (!can(req.user.role, resource, 'w')) return res.status(403).json({ error: 'Not allowed to add to ' + resource });
  const doc = req.body && typeof req.body === 'object' ? req.body : {};
  const recId = String(doc.id || crypto.randomUUID());
  doc.id = recId;
  try {
    const { rows } = await db.query(
      `INSERT INTO records (resource,rec_id,doc,created_by,updated_by) VALUES ($1,$2,$3,$4,$4) RETURNING rev, updated_at`,
      [resource, recId, doc, req.user.username]);
    await audit(req, 'create', resource, recId, '');
    res.json({ ok: true, id: recId, rev: rows[0].rev });
  } catch (e) {
    if (String(e.message).includes('duplicate')) return res.status(409).json({ error: 'Record already exists' });
    res.status(500).json({ error: 'Could not save' });
  }
});

app.put('/api/r/:resource/:id', requireAuth, async (req, res) => {
  const resource = safeResource(req.params.resource);
  if (!resource) return res.status(404).json({ error: 'Unknown resource' });
  if (!can(req.user.role, resource, 'w')) return res.status(403).json({ error: 'Not allowed to edit ' + resource });
  const doc = req.body && typeof req.body === 'object' ? req.body : {};
  const expected = req.body && req.body._rev;
  const { rows } = await db.query('SELECT rev FROM records WHERE resource=$1 AND rec_id=$2 AND deleted=FALSE', [resource, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Record not found' });
  // Optimistic concurrency: refuse to silently overwrite someone else's change.
  if (expected !== undefined && Number(expected) !== rows[0].rev) {
    return res.status(409).json({ error: 'This record was changed by someone else — reload before saving', currentRev: rows[0].rev });
  }
  delete doc._rev; doc.id = req.params.id;
  const upd = await db.query(
    `UPDATE records SET doc=$3, rev=rev+1, updated_by=$4, updated_at=NOW()
      WHERE resource=$1 AND rec_id=$2 RETURNING rev`, [resource, req.params.id, doc, req.user.username]);
  await audit(req, 'update', resource, req.params.id, '');
  res.json({ ok: true, rev: upd.rows[0].rev });
});

app.delete('/api/r/:resource/:id', requireAuth, async (req, res) => {
  const resource = safeResource(req.params.resource);
  if (!resource) return res.status(404).json({ error: 'Unknown resource' });
  if (!can(req.user.role, resource, 'w')) return res.status(403).json({ error: 'Not allowed to delete from ' + resource });
  // Soft delete — clinical records must remain recoverable and auditable.
  await db.query('UPDATE records SET deleted=TRUE, updated_by=$3, updated_at=NOW() WHERE resource=$1 AND rec_id=$2',
    [resource, req.params.id, req.user.username]);
  await audit(req, 'delete', resource, req.params.id, 'soft delete');
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * Audit trail (read-only, NABH)
 * ------------------------------------------------------------------ */
app.get('/api/audit', requireAuth, async (req, res) => {
  if (!can(req.user.role, 'audit', 'r')) return res.status(403).json({ error: 'Not allowed' });
  const { rows } = await db.query('SELECT username,role,action,resource,rec_id,detail,ip,at FROM audit ORDER BY at DESC LIMIT $1', [clampLimit(req.query.limit)]);
  res.json({ entries: rows });
});

/* ------------------------------------------------------------------ *
 * Legacy whole-state sync (session-protected; kept for migration only)
 * ------------------------------------------------------------------ */
let memState = null, memVer = 0;
app.get('/api/state', requireAuth, async (_req, res) => {
  try {
    const { rows } = await db.query('SELECT doc, v FROM app_state WHERE id=1');
    if (rows[0]) return res.json(rows[0].doc);
  } catch (e) {}
  res.json(memState || { _v: memVer });
});
app.put('/api/state', requireAuth, async (req, res) => {
  const doc = req.body && typeof req.body === 'object' ? req.body : {};
  memVer = Math.max(memVer + 1, Number(doc._v) || 0);
  doc._v = memVer; memState = doc;
  try {
    await db.query('INSERT INTO app_state (id,doc,v) VALUES (1,$1,$2) ON CONFLICT (id) DO UPDATE SET doc=$1, v=$2', [doc, memVer]);
  } catch (e) {}
  res.json({ ok: true, _v: memVer });
});

/* ------------------------------------------------------------------ *
 * Health & static hosting
 * ------------------------------------------------------------------ */
app.get('/api/health', (req, res) => res.json({
  ok: true, db: dbReady, auth: 'session', signedIn: !!req.user,
  role: req.user?.role || null, resources: RESOURCES.length, roles: Object.keys(ROLES).length
}));

const publicDir = fs.existsSync(path.join(__dirname, 'public', 'index.html'))
  ? path.join(__dirname, 'public') : __dirname;
const reactDist = path.join(__dirname, 'react-app', 'dist');
if (fs.existsSync(reactDist)) app.use('/app', express.static(reactDist));
app.use(express.static(publicDir));
app.get('*', (req, res) => {
  if (req.path.indexOf('/api') === 0) return res.status(404).json({ error: 'not found' });
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.listen(PORT, () => console.log(`MediCore HMS listening on :${PORT} · db=${!!process.env.DATABASE_URL}`));
