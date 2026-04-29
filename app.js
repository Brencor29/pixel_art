'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function envInt(name, def, lo, hi) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? clamp(n, lo, hi) : def;
}

const CANVAS_W = envInt('CANVAS_WIDTH',  128, 16, 512);
const CANVAS_H = envInt('CANVAS_HEIGHT', 128, 16, 512);
const CANVAS_SIZE = CANVAS_W * CANVAS_H;
const PALETTE_SIZE = 32;
const DEFAULT_COLOR = 7;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

console.log(`[config] canvas=${CANVAS_W}x${CANVAS_H} reset=${ADMIN_TOKEN ? 'ON' : 'OFF'}`);

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'canvas.db');
const JSON_PATH = path.join(DATA_DIR, 'canvas.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Persistance : better-sqlite3 si dispo, sinon JSON plat en fallback
// ---------------------------------------------------------------------------
let storage;
try {
  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS canvas_state (
      id    INTEGER PRIMARY KEY CHECK (id = 1),
      data  BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  storage = {
    kind: 'sqlite',
    load() {
      const row = db.prepare('SELECT data FROM canvas_state WHERE id = 1').get();
      if (row && row.data && row.data.length === CANVAS_SIZE) return Buffer.from(row.data);
      return null;
    },
    save(buf) {
      db.prepare(`
        INSERT INTO canvas_state (id, data, updated_at) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
      `).run(buf, Date.now());
    },
  };
  console.log('[storage] better-sqlite3 OK ->', DB_PATH);
} catch (err) {
  console.warn('[storage] better-sqlite3 indisponible, fallback JSON :', err.message);
  storage = {
    kind: 'json',
    load() {
      if (!fs.existsSync(JSON_PATH)) return null;
      try {
        const raw = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
        if (raw && typeof raw.data === 'string') {
          const buf = Buffer.from(raw.data, 'base64');
          if (buf.length === CANVAS_SIZE) return buf;
        }
      } catch (_) { /* noop */ }
      return null;
    },
    save(buf) {
      const tmp = JSON_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ data: buf.toString('base64'), updated_at: Date.now() }));
      fs.renameSync(tmp, JSON_PATH);
    },
  };
  console.log('[storage] JSON fallback ->', JSON_PATH);
}

// ---------------------------------------------------------------------------
// État + flush debouncé
// ---------------------------------------------------------------------------
let canvas = storage.load();
if (!canvas) {
  canvas = Buffer.alloc(CANVAS_SIZE, DEFAULT_COLOR);
  storage.save(canvas);
}

let dirty = false;
let flushTimer = null;
function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (!dirty) return;
    dirty = false;
    try { storage.save(canvas); }
    catch (err) { console.error('[storage] flush error:', err); dirty = true; }
  }, 1000);
}
function gracefulFlush() { if (dirty) { try { storage.save(canvas); } catch (_) {} } }
process.on('SIGINT', () => { gracefulFlush(); process.exit(0); });
process.on('SIGTERM', () => { gracefulFlush(); process.exit(0); });
process.on('exit', gracefulFlush);

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1kb' }));

app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: '1h' }));

app.get('/canvas.bin', (req, res) => {
  res.set('Content-Type', 'application/octet-stream');
  res.set('Cache-Control', 'no-store');
  res.send(canvas);
});

app.get('/health', (req, res) => {
  res.json({ ok: true, storage: storage.kind, users: sseClients.size });
});

// ---------------------------------------------------------------------------
// Server-Sent Events (remplace WebSocket : compatible Passenger mutualisé)
// ---------------------------------------------------------------------------
const sseClients = new Set();

function sseSend(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
  catch (_) { /* noop */ }
}

function sseBroadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) { /* noop */ }
  }
}

function broadcastUserCount() {
  sseBroadcast('users', { count: sseClients.size });
}

app.get('/events', (req, res) => {
  // Headers SSE — `no-transform` + Content-Type spécifique évite la
  // compression et le buffering Apache/Passenger.
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  // Padding 2 KB : force certains proxies (Apache mod_deflate, Passenger
  // ancien) à flusher la réponse sans attendre que le buffer soit plein.
  res.write(':' + ' '.repeat(2048) + '\n\n');

  // État initial
  sseSend(res, 'init', {
    width: CANVAS_W,
    height: CANVAS_H,
    paletteSize: PALETTE_SIZE,
    canvas: canvas.toString('base64'),
  });

  sseClients.add(res);
  broadcastUserCount();

  // Keep-alive (commentaire SSE) toutes les 20 s pour empêcher les
  // intermédiaires de couper la connexion sur idle.
  const ka = setInterval(() => {
    try { res.write(': ka\n\n'); } catch (_) { /* noop */ }
  }, 20000);

  req.on('close', () => {
    clearInterval(ka);
    sseClients.delete(res);
    broadcastUserCount();
  });
});

app.post('/pixel', (req, res) => {
  const body = req.body || {};
  const x = body.x | 0;
  const y = body.y | 0;
  const c = body.c | 0;
  if (x < 0 || x >= CANVAS_W) return res.status(400).json({ ok: false });
  if (y < 0 || y >= CANVAS_H) return res.status(400).json({ ok: false });
  if (c < 0 || c >= PALETTE_SIZE) return res.status(400).json({ ok: false });

  const idx = y * CANVAS_W + x;
  if (canvas[idx] !== c) {
    canvas[idx] = c;
    scheduleFlush();
    sseBroadcast('pixel', { x, y, c });
  }
  res.json({ ok: true });
});

// --- Admin : reset du canvas (gardé par token) ------------------------------
app.post('/admin/reset', (req, res) => {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ ok: false, error: 'reset disabled (no ADMIN_TOKEN configured)' });
  }
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token || token !== ADMIN_TOKEN) {
    return res.status(403).json({ ok: false, error: 'invalid token' });
  }

  canvas.fill(DEFAULT_COLOR);
  // flush immédiat pour ce cas-ci (pas de risque d'écrasement par un pixel concurrent)
  try { storage.save(canvas); dirty = false; }
  catch (_) { scheduleFlush(); }

  sseBroadcast('reset', {
    width: CANVAS_W,
    height: CANVAS_H,
    color: DEFAULT_COLOR,
  });
  console.log('[admin] canvas reset');
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Démarrage : Passenger (o2switch) ou autonome
// ---------------------------------------------------------------------------
const server = http.createServer(app);

const isPassenger = typeof PhusionPassenger !== 'undefined';
if (isPassenger) {
  // eslint-disable-next-line no-undef
  PhusionPassenger.configure({ autoInstall: false });
  server.listen('passenger', () => console.log('[server] Phusion Passenger ready'));
} else {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`[server] listening on http://localhost:${PORT}`));
}

module.exports = app;
