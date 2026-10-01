/**
 * Chatly server — real-time web messenger.
 *
 * Stack: Node.js + Express + WebSocket (ws) + SQLite (node:sqlite, built in).
 * No native modules, no build step. SQLite file keeps everything persistent.
 *
 * Config (env vars):
 *   PORT    — port to listen on (default 3000)
 *   DB_PATH — SQLite file path (default ./data/chatly.db)
 */
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- config

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'chatly.db');
const SESSION_COOKIE = 'chatly_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_TEXT_LEN = 2000;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

// ---------------------------------------------------------------- database

mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    status INTEGER NOT NULL DEFAULT 0, -- 0 = sent, 1 = delivered, 2 = read
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_convo
    ON messages(sender_id, recipient_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`);

// ---------------------------------------------------------------- auth helpers

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const hash = scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function getUserFromReq(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const row = db
    .prepare('SELECT s.user_id, u.username, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?')
    .get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return { id: row.user_id, username: row.username, sessionToken: token };
}

function setSessionCookie(res, token) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  );
}

// Simple in-memory rate limiter (per IP per endpoint label).
const rateBuckets = new Map();
function rateLimit(label, maxPerMinute) {
  return (req, res, next) => {
    const key = `${label}:${req.ip}`;
    const now = Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.start > 60000) bucket = { start: now, count: 0 };
    bucket.count += 1;
    rateBuckets.set(key, bucket);
    if (bucket.count > maxPerMinute) {
      return res.status(429).json({ error: 'Too many requests, slow down.' });
    }
    next();
  };
}

function requireAuth(req, res, next) {
  const user = getUserFromReq(req);
  if (!user) return res.status(401).json({ error: 'Not logged in.' });
  req.user = user;
  next();
}

// ---------------------------------------------------------------- express app

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(process.cwd(), 'public')));

app.get('/api/health', (req, res) => res.json({ ok: true, app: 'Chatly' }));

// --- accounts

app.post('/api/register', rateLimit('register', 10), (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || !USERNAME_RE.test(username.trim())) {
    return res.status(400).json({ error: 'Username must be 3–20 letters, numbers or _.' });
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 200) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  const name = username.trim();
  try {
    const stmt = db.prepare(
      'INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)'
    );
    stmt.run(name, hashPassword(password), Date.now());
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'That username is taken.' });
    }
    throw e;
  }
  const user = db.prepare('SELECT id, username FROM users WHERE username = ?').get(name);
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, user.id, Date.now() + SESSION_TTL_MS);
  setSessionCookie(res, token);
  res.json({ ok: true, user });
});

app.post('/api/login', rateLimit('login', 20), (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password required.' });
  }
  const row = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?')
    .get(username.trim());
  if (!row || !verifyPassword(password, row.password_hash)) {
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  // prune expired sessions, then create a fresh one
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?').run(row.id, Date.now());
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, row.id, Date.now() + SESSION_TTL_MS);
  setSessionCookie(res, token);
  res.json({ ok: true, user: { id: row.id, username: row.username } });
});

app.post('/api/logout', requireAuth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.user.sessionToken);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const user = getUserFromReq(req);
  if (!user) return res.status(401).json({ error: 'Not logged in.' });
  res.json({ user: { id: user.id, username: user.username } });
});

// --- users & chats

app.get('/api/users', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 1) return res.json({ users: [] });
  const rows = db
    .prepare(
      "SELECT id, username FROM users WHERE id != ? AND username LIKE ? ESCAPE '\\' ORDER BY username LIMIT 20"
    )
    .all(req.user.id, `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
  res.json({ users: rows });
});

function conversationList(userId) {
  // One row per conversation partner, with last message + unread count.
  const rows = db
    .prepare(
      `SELECT
         CASE WHEN m.sender_id = ? THEN m.recipient_id ELSE m.sender_id END AS partner_id,
         MAX(m.id) AS last_id
       FROM messages m
       WHERE m.sender_id = ? OR m.recipient_id = ?
       GROUP BY partner_id
       ORDER BY last_id DESC
       LIMIT 100`
    )
    .all(userId, userId, userId);
  const unread = new Map(
    db
      .prepare(
        'SELECT sender_id, COUNT(*) AS c FROM messages WHERE recipient_id = ? AND status < 2 GROUP BY sender_id'
      )
      .all(userId)
      .map((r) => [r.sender_id, r.c])
  );
  return rows.map((r) => {
    const partner = db.prepare('SELECT id, username FROM users WHERE id = ?').get(r.partner_id);
    const last = db.prepare('SELECT * FROM messages WHERE id = ?').get(r.last_id);
    return {
      partner,
      lastMessage: {
        id: last.id,
        senderId: last.sender_id,
        body: last.body,
        status: last.status,
        createdAt: last.created_at,
      },
      unreadCount: unread.get(r.partner_id) || 0,
    };
  });
}

app.get('/api/chats', requireAuth, (req, res) => {
  res.json({ chats: conversationList(req.user.id) });
});

app.get('/api/messages/:partnerId', requireAuth, (req, res) => {
  const partnerId = Number(req.params.partnerId);
  const before = Number(req.query.before || 0);
  const limit = Math.min(Number(req.query.limit || 50), 100);
  const partner = db.prepare('SELECT id, username FROM users WHERE id = ?').get(partnerId);
  if (!partner || partnerId === req.user.id) {
    return res.status(404).json({ error: 'Chat not found.' });
  }
  let rows;
  if (before > 0) {
    rows = db
      .prepare(
        `SELECT * FROM messages
         WHERE ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))
           AND id < ?
         ORDER BY id DESC LIMIT ?`
      )
      .all(req.user.id, partnerId, partnerId, req.user.id, before, limit);
  } else {
    rows = db
      .prepare(
        `SELECT * FROM messages
         WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
         ORDER BY id DESC LIMIT ?`
      )
      .all(req.user.id, partnerId, partnerId, req.user.id, limit);
  }
  rows.reverse();

  // Opening the latest view marks everything from the partner as read.
  if (!before) {
    const pending = db
      .prepare(
        'SELECT id FROM messages WHERE sender_id = ? AND recipient_id = ? AND status < 2'
      )
      .all(partnerId, req.user.id);
    if (pending.length) {
      db.prepare(
        'UPDATE messages SET status = 2 WHERE sender_id = ? AND recipient_id = ? AND status < 2'
      ).run(partnerId, req.user.id);
      for (const m of pending) {
        sendToUser(partnerId, {
          type: 'receipt',
          by: req.user.id,
          ids: [m.id],
          status: 2,
        });
      }
    }
  }

  res.json({
    partner,
    messages: rows.map((m) => ({
      id: m.id,
      senderId: m.sender_id,
      body: m.body,
      status: m.status,
      createdAt: m.created_at,
    })),
    hasMore: before ? rows.length === limit : false,
  });
});

// --- SPA fallback (API routes above take precedence)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path === '/ws') return next();
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

// ---------------------------------------------------------------- websocket

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// userId -> Set of live sockets
const online = new Map();

function sendToUser(userId, obj) {
  const sockets = online.get(userId);
  if (!sockets) return false;
  const data = JSON.stringify(obj);
  let sent = false;
  for (const ws of sockets) {
    if (ws.readyState === 1) {
      ws.send(data);
      sent = true;
    }
  }
  return sent;
}

function broadcast(obj, exceptUserId = null) {
  const data = JSON.stringify(obj);
  for (const [userId, sockets] of online) {
    if (exceptUserId !== null && userId === exceptUserId) continue;
    for (const ws of sockets) {
      if (ws.readyState === 1) ws.send(data);
    }
  }
}

function onlineIds() {
  return [...online.keys()];
}

function insertMessage(senderId, recipientId, body) {
  const info = db
    .prepare(
      'INSERT INTO messages (sender_id, recipient_id, body, status, created_at) VALUES (?, ?, ?, 0, ?)'
    )
    .run(senderId, recipientId, body, Date.now());
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);
}

function toClientMessage(m) {
  return {
    id: m.id,
    senderId: m.sender_id,
    body: m.body,
    status: m.status,
    createdAt: m.created_at,
  };
}

wss.on('connection', (ws, req) => {
  const user = getUserFromReq(req);
  if (!user) {
    ws.close(4401, 'unauthorized');
    return;
  }
  const userId = user.id;

  if (!online.has(userId)) online.set(userId, new Set());
  online.get(userId).add(ws);
  ws.userId = userId;

  // Tell everyone this user is now online; send them the current online list.
  broadcast({ type: 'presence', userId, online: true }, userId);
  ws.send(JSON.stringify({ type: 'init', me: { id: user.id, username: user.username }, online: onlineIds() }));

  // Anything queued for this user while offline counts as delivered now.
  const queued = db
    .prepare('SELECT id, sender_id FROM messages WHERE recipient_id = ? AND status = 0')
    .all(userId);
  if (queued.length) {
    db.prepare('UPDATE messages SET status = 1 WHERE recipient_id = ? AND status = 0').run(userId);
    const bySender = new Map();
    for (const m of queued) {
      if (!bySender.has(m.sender_id)) bySender.set(m.sender_id, []);
      bySender.get(m.sender_id).push(m.id);
    }
    for (const [senderId, ids] of bySender) {
      sendToUser(senderId, { type: 'receipt', by: userId, ids, status: 1 });
    }
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'send') {
      const toId = Number(msg.to);
      const text = typeof msg.text === 'string' ? msg.text.trim() : '';
      if (!Number.isInteger(toId) || toId <= 0 || toId === userId) return;
      if (text.length < 1 || text.length > MAX_TEXT_LEN) return;
      const partner = db.prepare('SELECT id FROM users WHERE id = ?').get(toId);
      if (!partner) return;

      let m = insertMessage(userId, toId, text);
      const delivered = sendToUser(toId, {
        type: 'message',
        fromName: user.username,
        message: { ...toClientMessage(m), from: userId },
      });
      if (delivered) {
        db.prepare('UPDATE messages SET status = 1 WHERE id = ?').run(m.id);
        m = db.prepare('SELECT * FROM messages WHERE id = ?').get(m.id);
      }
      ws.send(JSON.stringify({ type: 'sent', tempId: msg.tempId || null, message: toClientMessage(m) }));
    }

    if (msg.type === 'read') {
      const fromId = Number(msg.from);
      if (!Number.isInteger(fromId) || fromId <= 0) return;
      const pending = db
        .prepare('SELECT id FROM messages WHERE sender_id = ? AND recipient_id = ? AND status < 2')
        .all(fromId, userId);
      if (pending.length) {
        db.prepare('UPDATE messages SET status = 2 WHERE sender_id = ? AND recipient_id = ? AND status < 2')
          .run(fromId, userId);
        sendToUser(fromId, {
          type: 'receipt',
          by: userId,
          ids: pending.map((r) => r.id),
          status: 2,
        });
      }
    }

    if (msg.type === 'typing') {
      const toId = Number(msg.to);
      if (!Number.isInteger(toId) || toId <= 0) return;
      sendToUser(toId, { type: 'typing', from: userId, typing: !!msg.typing });
    }
  });

  const onClose = () => {
    const set = online.get(userId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) {
        online.delete(userId);
        broadcast({ type: 'presence', userId, online: false });
      }
    }
  };
  ws.on('close', onClose);
  ws.on('error', onClose);
});

// ---------------------------------------------------------------- start

server.listen(PORT, () => {
  console.log(`Chatly listening on port ${PORT} (db: ${DB_PATH})`);
});

function shutdown() {
  console.log('\nShutting down…');
  wss.close(() => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
