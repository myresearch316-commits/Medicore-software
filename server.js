/*
 * MediCore HMS — backend server
 * Node.js + Express + PostgreSQL (hosted on Render)
 *
 * - Serves the frontend (public/index.html)
 * - Stores all app data in PostgreSQL
 *   • app_state    : current snapshot (JSONB) with a version number
 *   • state_history: append-only log of every save (audit trail, nothing lost)
 * - API:
 *   GET  /api/health  -> { ok, db }
 *   GET  /api/state   -> { version, data }
 *   PUT  /api/state   -> { ok, version }   body: { data: {...} }
 */
const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '8mb' }));

// ---- database connection (Render provides DATABASE_URL) ----
const connectionString = process.env.DATABASE_URL;
const pool = new Pool({
  connectionString,
  // Render's managed Postgres requires SSL
  ssl: connectionString ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => console.error('Unexpected PG pool error:', err.message));

// ---- schema ----
async function initDb() {
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
    INSERT INTO app_state (id, version, data)
      VALUES ('main', 0, '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING;
  `);
  console.log('Database ready.');
}

// ---- API ----
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: true });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: String(e.message || e) });
  }
});

app.get('/api/state', async (req, res) => {
  try {
    const r = await pool.query('SELECT version, data FROM app_state WHERE id = $1', ['main']);
    if (!r.rows.length) return res.json({ version: 0, data: null });
    res.json({ version: Number(r.rows[0].version), data: r.rows[0].data });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.put('/api/state', async (req, res) => {
  const data = req.body && req.body.data;
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'body.data (object) is required' });
  }
  const version = Number(data._v) || Date.now();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Only overwrite if the incoming version is newer or equal (last-write-wins, no stale clobber)
    const up = await client.query(
      `INSERT INTO app_state (id, version, data, updated_at)
         VALUES ('main', $1, $2, now())
       ON CONFLICT (id) DO UPDATE
         SET version = EXCLUDED.version, data = EXCLUDED.data, updated_at = now()
         WHERE app_state.version <= EXCLUDED.version
       RETURNING version`,
      [version, data]
    );
    // Always record the save in history (full audit trail)
    await client.query(
      'INSERT INTO state_history (state_id, version, data) VALUES ($1, $2, $3)',
      ['main', version, data]
    );
    await client.query('COMMIT');
    res.json({ ok: true, version, applied: up.rowCount > 0 });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    client.release();
  }
});

// ---- serve the frontend ----
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---- start ----
const PORT = process.env.PORT || 3000;
initDb()
  .then(() => app.listen(PORT, () => console.log('MediCore HMS running on port ' + PORT)))
  .catch((e) => {
    console.error('DB init failed, starting without DB:', e.message);
    app.listen(PORT, () => console.log('MediCore HMS (DB unavailable) on port ' + PORT));
  });
