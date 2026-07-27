/*
 * MediCore HMS — backend server
 * Node.js + Express, with PostgreSQL when available (hosted on Render)
 *
 * - Serves the frontend (public/index.html)
 * - Stores all app data as a single JSON snapshot with a monotonic version.
 *   • With DATABASE_URL  -> PostgreSQL (app_state + state_history audit trail)
 *   • Without a database -> durable in-memory store, mirrored to disk (state.json)
 *     so live sync keeps working out of the box and survives restarts on a disk.
 * - The SERVER owns the version number. Every accepted write bumps it strictly
 *   upward, so writes are never dropped and every other client sees a newer
 *   version and pulls it. This is what makes data entered in one department
 *   appear in the other sections and the administrator dashboard.
 * - API:
 *   GET  /api/health  -> { ok, db }
 *   GET  /api/state   -> { version, data }
 *   PUT  /api/state   -> { ok, version }   body: { data: {...} }
 */
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '8mb' }));

// ---- optional database (Render provides DATABASE_URL) ----
const connectionString = process.env.DATABASE_URL;
let pool = null;
let dbReady = false;

if (connectionString) {
  try {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false }, // Render's managed Postgres requires SSL
      max: 10,
      idleTimeoutMillis: 30000,
    });
    pool.on('error', (err) => console.error('Unexpected PG pool error:', err.message));
  } catch (e) {
    console.error('pg module unavailable, using file/in-memory store:', e.message);
    pool = null;
  }
}

// ---- durable fallback store (used when there is no reachable database) ----
const STATE_FILE = path.join(__dirname, 'state.json');
const mem = { version: 0, data: {} };
(function loadFromDisk() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const j = JSON.parse(raw);
    if (j && typeof j === 'object') {
      mem.version = Number(j.version) || 0;
      mem.data = j.data && typeof j.data === 'object' ? j.data : {};
      console.log('Loaded state.json (version ' + mem.version + ').');
    }
  } catch (e) { /* first run — no file yet */ }
})();
function saveToDisk() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(mem)); }
  catch (e) { console.error('Could not persist state.json:', e.message); }
}

// ---- feedback store (QR feedback / complaints from the public) ----
const FEEDBACK_FILE = path.join(__dirname, 'feedback.json');
let feedbackMem = [];   // { id, name, type, message, created_at }
(function loadFeedback() {
  try { const j = JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8')); if (Array.isArray(j)) feedbackMem = j; } catch (e) {}
})();
function saveFeedback() {
  try { fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(feedbackMem.slice(-1000))); }
  catch (e) { console.error('Could not persist feedback.json:', e.message); }
}

// ---- database schema ----
async function initDb() {
  if (!pool) throw new Error('no database configured');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id         TEXT PRIMARY KEY,
      version    BIGINT NOT NULL DEFAULT 0,
      data       JSONB  NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS state_history (
      seq        BIGSERIAL PRIMARY KEY,
      state_id   TEXT NOT NULL,
      version    BIGINT NOT NULL,
      data       JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_history_state ON state_history(state_id, seq DESC);
    CREATE TABLE IF NOT EXISTS feedback (
      id         BIGSERIAL PRIMARY KEY,
      name       TEXT,
      type       TEXT,
      message    TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    INSERT INTO app_state (id, version, data)
      VALUES ('main', 0, '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING;
  `);
  dbReady = true;
  console.log('Database ready.');
}

// Next version: strictly greater than what we already have and than the client's
// value, so pulls are always monotonic and no write is ever silently rejected.
function nextVersion(storedVersion, incoming) {
  return Math.max(Number(storedVersion) || 0, Number(incoming) || 0, Date.now()) + 1;
}

// ---- API ----
app.get('/api/health', async (req, res) => {
  if (!pool) return res.json({ ok: true, db: false, store: 'memory' });
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: true });
  } catch (e) {
    res.json({ ok: true, db: false, store: 'memory', error: String(e.message || e) });
  }
});

app.get('/api/state', async (req, res) => {
  // Try the database first; on any failure, serve the durable fallback store so
  // sync never goes dark.
  if (pool && dbReady) {
    try {
      const r = await pool.query('SELECT version, data FROM app_state WHERE id = $1', ['main']);
      if (r.rows.length) {
        return res.json({ version: Number(r.rows[0].version), data: r.rows[0].data });
      }
    } catch (e) {
      console.error('GET /api/state DB error, using fallback:', e.message);
    }
  }
  res.json({ version: mem.version, data: mem.data });
});

app.put('/api/state', async (req, res) => {
  const data = req.body && req.body.data;
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'body.data (object) is required' });
  }

  if (pool && dbReady) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query('SELECT version FROM app_state WHERE id = $1 FOR UPDATE', ['main']);
      const stored = cur.rows.length ? Number(cur.rows[0].version) : 0;
      const version = nextVersion(stored, data._v);
      data._v = version; // embed the authoritative version so clients compare correctly
      await client.query(
        `INSERT INTO app_state (id, version, data, updated_at)
           VALUES ('main', $1, $2, now())
         ON CONFLICT (id) DO UPDATE
           SET version = EXCLUDED.version, data = EXCLUDED.data, updated_at = now()`,
        [version, data]
      );
      await client.query(
        'INSERT INTO state_history (state_id, version, data) VALUES ($1, $2, $3)',
        ['main', version, data]
      );
      await client.query('COMMIT');
      // keep the fallback warm too
      mem.version = version; mem.data = data; saveToDisk();
      return res.json({ ok: true, version });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('PUT /api/state DB error, using fallback:', e.message);
      // fall through to the in-memory path below
    } finally {
      client.release();
    }
  }

  // Fallback store (no DB, or DB write failed)
  const version = nextVersion(mem.version, data._v);
  data._v = version;
  mem.version = version;
  mem.data = data;
  saveToDisk();
  res.json({ ok: true, version });
});

// ---- feedback API (public submit + admin read) ----
app.get('/api/feedback', async (req, res) => {
  if (pool && dbReady) {
    try {
      const r = await pool.query('SELECT id, name, type, message, created_at FROM feedback ORDER BY id DESC LIMIT 500');
      return res.json({ items: r.rows });
    } catch (e) { console.error('GET /api/feedback DB error, using fallback:', e.message); }
  }
  res.json({ items: feedbackMem.slice().reverse().slice(0, 500) });
});

app.post('/api/feedback', async (req, res) => {
  const b = req.body || {};
  const message = String(b.message || '').trim();
  if (!message) return res.status(400).json({ error: 'message is required' });
  const name = String(b.name || '').slice(0, 120);
  const type = String(b.type || 'Feedback').slice(0, 40);
  if (pool && dbReady) {
    try {
      const r = await pool.query('INSERT INTO feedback (name, type, message) VALUES ($1,$2,$3) RETURNING id, created_at', [name, type, message]);
      return res.json({ ok: true, id: r.rows[0].id });
    } catch (e) { console.error('POST /api/feedback DB error, using fallback:', e.message); }
  }
  const item = { id: Date.now(), name, type, message, created_at: new Date().toISOString() };
  feedbackMem.push(item); saveFeedback();
  res.json({ ok: true, id: item.id });
});

// ---- public feedback page (this is what the QR code points to) ----
app.get('/feedback', (req, res) => {
  res.type('html').send(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>MediCore — Share your feedback</title>
<style>
  :root{--brand:#1f6feb;--brand2:#0ea5a4;--ink:#0f2033;--muted:#5b6b7f;--line:#e4ebf3}
  *{box-sizing:border-box}
  body{margin:0;font-family:"Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif;color:var(--ink);
    background:linear-gradient(160deg,#134e9e,#1f6feb 55%,#0ea5a4);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
  .card{background:#fff;border-radius:20px;max-width:440px;width:100%;box-shadow:0 30px 70px -30px rgba(0,0,0,.5);padding:28px 24px}
  .brand{display:flex;align-items:center;gap:10px;margin-bottom:6px}
  .mark{width:40px;height:40px;border-radius:11px;background:linear-gradient(150deg,#1f6feb,#0ea5a4);display:grid;place-items:center}
  .mark svg{width:22px;height:22px}
  .brand b{font-size:17px;font-weight:800}.brand span{font-size:11.5px;color:var(--muted);display:block}
  h1{font-size:20px;margin:16px 0 4px}
  p.sub{color:var(--muted);font-size:13.5px;margin:0 0 18px}
  label{display:block;font-size:12.5px;font-weight:700;color:#33465c;margin:12px 0 6px}
  input,select,textarea{width:100%;border:1px solid var(--line);background:#fbfdff;border-radius:11px;padding:12px 13px;font-size:15px;font-family:inherit;color:var(--ink);outline:0}
  textarea{min-height:110px;resize:vertical}
  input:focus,select:focus,textarea:focus{border-color:var(--brand);box-shadow:0 0 0 4px rgba(31,111,235,.16);background:#fff}
  button{width:100%;margin-top:18px;border:0;border-radius:12px;padding:14px;font-size:15px;font-weight:700;color:#fff;
    background:linear-gradient(180deg,#1f6feb,#134e9e);box-shadow:0 12px 26px -12px rgba(31,111,235,.75);cursor:pointer}
  button:disabled{opacity:.6}
  .ok{text-align:center;padding:24px 6px}
  .ok .ic{width:64px;height:64px;border-radius:50%;background:#e9f7ee;color:#16a34a;display:grid;place-items:center;margin:0 auto 14px}
  .ok .ic svg{width:34px;height:34px}
  .ok h2{margin:0 0 6px;font-size:20px}.ok p{color:var(--muted);font-size:14px;margin:0}
  .foot{margin-top:16px;text-align:center;color:#93a2b5;font-size:11px}
</style></head><body>
  <div class="card" id="card">
    <div class="brand">
      <div class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2 5 4-14 2 9h6"/></svg></div>
      <div><b>MediCore</b><span>Hospital Management System</span></div>
    </div>
    <h1>Share your feedback</h1>
    <p class="sub">Tell us about your experience or report a problem. Your response goes straight to the hospital administrator.</p>
    <form id="f">
      <label>Your name (optional)</label>
      <input id="name" placeholder="Name">
      <label>Type</label>
      <select id="type"><option>Feedback</option><option>Complaint</option><option>Suggestion</option><option>Appreciation</option></select>
      <label>Message</label>
      <textarea id="message" placeholder="Write your feedback or complaint…" required></textarea>
      <button type="submit" id="btn">Send to administrator</button>
      <div class="foot">© MediCore Health Systems · Confidential</div>
    </form>
  </div>
<script>
  var f=document.getElementById('f');
  f.addEventListener('submit',function(e){
    e.preventDefault();
    var msg=document.getElementById('message').value.trim();
    if(!msg)return;
    var btn=document.getElementById('btn'); btn.disabled=true; btn.textContent='Sending…';
    fetch('/api/feedback',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({name:document.getElementById('name').value,type:document.getElementById('type').value,message:msg})})
      .then(function(r){return r.json();})
      .then(function(){
        document.getElementById('card').innerHTML='<div class="ok"><div class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></div><h2>Thank you!</h2><p>Your response has been sent to the administrator.</p></div>';
      })
      .catch(function(){ btn.disabled=false; btn.textContent='Send to administrator'; alert('Could not send. Please try again.'); });
  });
</script>
</body></html>`);
});

// ---- serve the frontend ----
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---- start ----
const PORT = process.env.PORT || 3000;
function start(msg) { app.listen(PORT, () => console.log(msg + ' on port ' + PORT)); }

if (pool) {
  initDb()
    .then(() => start('MediCore HMS running'))
    .catch((e) => {
      console.error('DB init failed, using in-memory/file store:', e.message);
      start('MediCore HMS (no DB — file store)');
    });
} else {
  start('MediCore HMS (no DB — file store)');
}
