/**
 * Chatly server v3.1 — real-time messenger.
 *
 * Stack: Node.js + Express + WebSocket (ws) + SQLite (node:sqlite, built in)
 *        + nodemailer (SMTP email for verification / password reset).
 * No native modules, no build step. SQLite file keeps everything persistent.
 *
 * Config (env vars):
 *   PORT       — port to listen on (default 3000)
 *   DB_PATH    — SQLite file path (default ./data/chatly.db)
 *   SMTP_HOST  — SMTP server hostname (required for any email sending)
 *   SMTP_PORT  — SMTP port (default 587)
 *   SMTP_USER  — SMTP username (required for any email sending)
 *   SMTP_PASS  — SMTP password (required for any email sending)
 *   SMTP_FROM  — From: address (default: SMTP_USER)
 *
 * Email is honest: if the SMTP_* vars are missing, every endpoint that needs
 * to send mail answers HTTP 503 {error:"email_not_configured"}. Nothing is
 * ever faked.
 *
 * Auth: the web UI keeps using the HttpOnly session cookie. API / Android
 * clients use the session token directly (returned by /api/login) via
 *   - JSON body field  {token: "..."}
 *   - query string     ?token=...
 *   - header           Authorization: Bearer ...
 * The same token also works as ?token= on the /ws WebSocket upgrade.
 */
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';

// ---------------------------------------------------------------- config

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'chatly.db');
const SESSION_COOKIE = 'chatly_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_TEXT_LEN = 2000;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CODE_TTL_MS = 10 * 60 * 1000; // verification / reset codes live 10 min
const MAX_MEDIA_BYTES = 1024 * 1024; // 1 MB decoded payload for image/audio
const MAX_AVATAR_CHARS = 500 * 1024; // 500 KB base64 / data-URL string
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60; // disappearing messages: max 7 days

const SMTP = {
  host: process.env.SMTP_HOST || '',
  port: Number(process.env.SMTP_PORT || 587),
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.SMTP_FROM || process.env.SMTP_USER || '',
};
const smtpConfigured = () => Boolean(SMTP.host && SMTP.user && SMTP.pass);

// Google sign-in: the Android app's OAuth client ID. Verified against the
// `aud` claim of Google's ID tokens. Missing → /api/auth/google answers 503.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

// NOTE (2026-10-01): mail/config problems answer HTTP 422 (not 503/502): the
// hosting edge proxy swallows 5xx responses and substitutes its own error
// page. Clients read the JSON `error` field, never the status code.

// ---------------------------------------------------------------- database

mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

// Add a column only if it does not exist yet (safe to run on every boot,
// so old databases migrate forward automatically).
function ensureColumn(table, col, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}

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

// --- v3.0 migrations: email + verification on users ----------------------
ensureColumn('users', 'email', 'TEXT'); // UNIQUE index created below
ensureColumn('users', 'verified', 'INTEGER NOT NULL DEFAULT 1'); // legacy accounts grandfathered
ensureColumn('users', 'verify_code', 'TEXT');
ensureColumn('users', 'verify_expiry', 'INTEGER');
ensureColumn('users', 'reset_code', 'TEXT');
ensureColumn('users', 'reset_expiry', 'INTEGER');
ensureColumn('users', 'display_name', 'TEXT');
ensureColumn('users', 'bio', 'TEXT');
ensureColumn('users', 'avatar', 'TEXT'); // base64 data URL (<= 500KB)
ensureColumn('users', 'blocked', "TEXT NOT NULL DEFAULT '[]'"); // JSON array of user ids
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
// SQLite allows many NULLs in a UNIQUE index, so legacy accounts without an
// email coexist fine.

// --- v3.0 migrations: rich message fields ---------------------------------
ensureColumn('messages', 'kind', "TEXT NOT NULL DEFAULT 'text'"); // text|image|audio|location
ensureColumn('messages', 'data', 'TEXT'); // base64 payload or JSON (location)
ensureColumn('messages', 'mime', 'TEXT'); // e.g. image/jpeg
ensureColumn('messages', 'reactions', "TEXT NOT NULL DEFAULT '{}'"); // {"❤️":["alice"]}
ensureColumn('messages', 'ttl', 'INTEGER'); // disappearing-message TTL in seconds
ensureColumn('messages', 'expire_at', 'INTEGER'); // epoch ms; NULL = never expires

// --- v3.0: groups ----------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    creator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS group_members (
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS group_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'text',
    body TEXT NOT NULL DEFAULT '',
    data TEXT,
    mime TEXT,
    reactions TEXT NOT NULL DEFAULT '{}',
    ttl INTEGER,
    expire_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_group_messages ON group_messages(group_id, id);
  CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);
`);

// --- v3.1 migrations: pending email changes --------------------------------
ensureColumn('users', 'pending_email', 'TEXT'); // new address awaiting verification
ensureColumn('users', 'pending_code', 'TEXT');
ensureColumn('users', 'pending_expiry', 'INTEGER');

// --- v3.1: statuses (24h stories) -------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS statuses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'text', -- text|image
    text TEXT,
    data TEXT, -- base64 image, <= 1MB decoded
    bg TEXT, -- background style identifier chosen by the client
    created_at INTEGER NOT NULL,
    expire_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_statuses_expire ON statuses(expire_at);
`);

// --- v3.1: broadcast channels ------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    creator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS channel_subs (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (channel_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS channel_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'text', -- text|image
    text TEXT NOT NULL DEFAULT '',
    data TEXT, -- base64 image, <= 1MB decoded
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_channel_posts ON channel_posts(channel_id, id);
`);

// ---------------------------------------------------------------- auth helpers

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored || '').split(':');
  if (!saltHex || !hashHex) return false;
  const hash = scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
}

function newSession(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?').run(userId, Date.now());
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, Date.now() + SESSION_TTL_MS);
  return token;
}

function apiUserFromToken(token) {
  if (typeof token !== 'string' || !token) return null;
  const row = db
    .prepare(
      'SELECT s.user_id, u.username, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'
    )
    .get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return { id: row.user_id, username: row.username, sessionToken: token };
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
  return apiUserFromToken(cookies[SESSION_COOKIE]);
}

// Token for the JSON API: body field, query string, or Bearer header.
function getApiUser(req) {
  const b = req.body || {};
  let token = b.token || req.query.token;
  const auth = req.headers.authorization;
  if (!token && typeof auth === 'string' && auth.startsWith('Bearer ')) {
    token = auth.slice(7);
  }
  return token ? apiUserFromToken(String(token)) : null;
}

// WebSocket handshake: cookie first (web UI), then ?token= (Android).
function getUserFromWs(req) {
  const viaCookie = getUserFromReq(req);
  if (viaCookie) return viaCookie;
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const token = url.searchParams.get('token');
    if (token) return apiUserFromToken(token);
  } catch {
    /* ignore */
  }
  return null;
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
      return res.status(429).json({ error: 'rate_limited', message: 'Too many requests, slow down.' });
    }
    next();
  };
}

function requireAuth(req, res, next) {
  // Web UI: HttpOnly session cookie. API/Android: token via body/query/Bearer.
  const user = getUserFromReq(req) || getApiUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized', message: 'Not logged in.' });
  req.user = user;
  next();
}

function requireApiUser(req, res, next) {
  const user = getApiUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized', message: 'Invalid or expired token.' });
  req.user = user;
  next();
}

// ---------------------------------------------------------------- user helpers

const getUserById = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
const getUserByUsername = (name) =>
  db.prepare('SELECT * FROM users WHERE username = ?').get(String(name || '').trim());
const getUserByEmail = (email) =>
  db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

function blockedIds(userId) {
  const row = db.prepare('SELECT blocked FROM users WHERE id = ?').get(userId);
  try {
    const arr = JSON.parse(row?.blocked || '[]');
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function isBlocked(recipientId, senderId) {
  return blockedIds(recipientId).has(senderId);
}

function blockedUsernames(userId) {
  const ids = [...blockedIds(userId)];
  if (!ids.length) return [];
  const rows = db
    .prepare(`SELECT username FROM users WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids);
  return rows.map((r) => r.username);
}

function setBlockedIds(userId, ids) {
  db.prepare('UPDATE users SET blocked = ? WHERE id = ?').run(JSON.stringify([...ids]), userId);
}

function publicProfile(user) {
  return {
    username: user.username,
    name: user.display_name || user.username,
    bio: user.bio || '',
    avatar: user.avatar || null,
    online: onlineIds().includes(user.id),
  };
}

// ---------------------------------------------------------------- email

let mailer = null;
function getMailer() {
  if (!smtpConfigured()) return null;
  if (!mailer) {
    mailer = nodemailer.createTransport({
      host: SMTP.host,
      port: SMTP.port,
      secure: SMTP.port === 465, // implicit TLS on 465, STARTTLS otherwise
      auth: { user: SMTP.user, pass: SMTP.pass },
    });
  }
  return mailer;
}

async function sendMail(to, subject, text) {
  const m = getMailer();
  if (!m) {
    const err = new Error('email_not_configured');
    err.code = 'email_not_configured';
    throw err;
  }
  await m.sendMail({
    from: SMTP.from || SMTP.user,
    to,
    subject,
    text,
    html: `<p>${text.replace(/\n/g, '<br>')}</p>`,
  });
}

const verifyEmailText = (code) =>
  `Welcome to Chatly!\n\nYour verification code is: ${code}\n\nIt expires in 10 minutes.\nIf you didn't create a Chatly account, just ignore this email.`;

const resetEmailText = (code) =>
  `You asked to reset your Chatly password.\n\nYour reset code is: ${code}\n\nIt expires in 10 minutes.\nIf you didn't ask for this, just ignore this email — your password stays the same.`;

// Server-side logging for mail failures (never includes credentials or codes).
function logMailError(where, err) {
  const detail = err && err.code ? `${err.code}: ${err.message}` : String((err && err.message) || err);
  console.error(`[mail] ${where} failed: ${detail}`);
}

// ---------------------------------------------------------------- messages

function insertMessage(senderId, recipientId, { kind = 'text', body = '', data = null, mime = null, ttl = null }) {
  const now = Date.now();
  const expireAt = ttl ? now + ttl * 1000 : null;
  const info = db
    .prepare(
      'INSERT INTO messages (sender_id, recipient_id, body, status, created_at, kind, data, mime, ttl, expire_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?)'
    )
    .run(senderId, recipientId, body, now, kind, data, mime, ttl, expireAt);
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);
}

function parseReactions(json) {
  try {
    const o = JSON.parse(json || '{}');
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

function toClientMessage(m) {
  return {
    id: m.id,
    senderId: m.sender_id,
    kind: m.kind || 'text',
    body: m.body,
    data: m.data || null,
    mime: m.mime || null,
    reactions: parseReactions(m.reactions),
    ttl: m.ttl || null,
    expireAt: m.expire_at || null,
    status: m.status,
    createdAt: m.created_at,
  };
}

function insertGroupMessage(groupId, senderId, { kind = 'text', body = '', data = null, mime = null, ttl = null }) {
  const now = Date.now();
  const expireAt = ttl ? now + ttl * 1000 : null;
  const info = db
    .prepare(
      'INSERT INTO group_messages (group_id, sender_id, kind, body, data, mime, ttl, expire_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(groupId, senderId, kind, body, data, mime, ttl, expireAt, now);
  return db.prepare('SELECT * FROM group_messages WHERE id = ?').get(info.lastInsertRowid);
}

function toClientGroupMessage(m, senderUsername) {
  return {
    id: m.id,
    groupId: m.group_id,
    senderId: m.sender_id,
    senderUsername: senderUsername || null,
    kind: m.kind || 'text',
    body: m.body,
    data: m.data || null,
    mime: m.mime || null,
    reactions: parseReactions(m.reactions),
    ttl: m.ttl || null,
    expireAt: m.expire_at || null,
    createdAt: m.created_at,
  };
}

function isMember(groupId, userId) {
  return Boolean(
    db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId)
  );
}

function groupMemberRows(groupId) {
  return db
    .prepare(
      'SELECT u.id, u.username FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? ORDER BY u.username'
    )
    .all(groupId);
}

function groupSummary(groupId) {
  const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  if (!g) return null;
  return { groupId: g.id, name: g.name, members: groupMemberRows(groupId).map((r) => r.username) };
}

// Decoded byte length of a base64 string (Infinity on garbage).
function base64ByteLength(b64) {
  try {
    if (typeof b64 !== 'string' || !b64.length) return 0;
    return Buffer.byteLength(b64, 'base64');
  } catch {
    return Infinity;
  }
}

// Normalise the rich-content fields shared by 1:1 "send" and "group-message".
// Returns null when the payload is invalid.
function parseRichContent(msg) {
  const kind = ['text', 'image', 'audio', 'location'].includes(msg.kind) ? msg.kind : 'text';
  let body = typeof msg.text === 'string' ? msg.text.trim() : '';
  if (typeof msg.body === 'string' && !body) body = msg.body.trim();
  let data = null;
  let mime = null;
  let ttl = null;
  if (msg.ttl != null) {
    const t = Number(msg.ttl);
    if (Number.isInteger(t) && t > 0 && t <= MAX_TTL_SECONDS) ttl = t;
    else if (msg.ttl !== undefined) return null; // invalid ttl → reject
  }

  if (kind === 'text') {
    if (body.length < 1 || body.length > MAX_TEXT_LEN) return null;
  } else if (kind === 'image' || kind === 'audio') {
    const b64 = typeof msg.data === 'string' ? msg.data : '';
    const bytes = base64ByteLength(b64);
    if (bytes < 1 || bytes > MAX_MEDIA_BYTES) return 'too_large';
    data = b64;
    mime = typeof msg.mime === 'string' ? msg.mime.slice(0, 100) : null;
    body = body.slice(0, 500); // optional caption
  } else if (kind === 'location') {
    let loc = msg.data;
    if (typeof loc === 'string') {
      try {
        loc = JSON.parse(loc);
      } catch {
        return null;
      }
    }
    const lat = Number(loc && loc.lat);
    const lng = Number(loc && loc.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    data = JSON.stringify({ lat, lng });
  }
  return { kind, body, data, mime, ttl };
}

// ---------------------------------------------------------------- express app

const app = express();
// Global JSON limit sized for the largest legitimate payload (1MB media for
// statuses/channel posts, base64-inflated); each handler enforces its own
// tighter cap with a JSON 413. Anything beyond this → JSON 413 via the error
// handler below (no stack/path leaks).
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(process.cwd(), 'public')));

app.get('/api/health', (req, res) => res.json({ ok: true, app: 'Chatly', version: '3.1.0' }));

// --- accounts -------------------------------------------------------------

// POST /api/register {username, password, email?}
//  - With email    → new v3 flow: creates an UNVERIFIED account, emails a
//                    6-digit code (10 min). 503 if SMTP is not configured.
//  - Without email → legacy web flow: creates a verified account and logs in
//                    (cookie), exactly like v1/v2 did.
app.post('/api/register', rateLimit('register', 10), async (req, res) => {
  const { username, password, email } = req.body || {};
  if (typeof username !== 'string' || !USERNAME_RE.test(username.trim())) {
    return res
      .status(400)
      .json({ error: 'invalid_username', message: 'Username must be 3–20 letters, numbers or _.' });
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 200) {
    return res
      .status(400)
      .json({ error: 'weak_password', message: 'Password must be at least 6 characters.' });
  }
  const name = username.trim();
  if (getUserByUsername(name)) {
    return res.status(409).json({ error: 'username_taken', message: 'That username is taken.' });
  }

  // ---- legacy flow (web UI): no email supplied -------------------------
  if (email == null || String(email).trim() === '') {
    try {
      db.prepare('INSERT INTO users (username, password_hash, created_at, verified) VALUES (?, ?, ?, 1)')
        .run(name, hashPassword(password), Date.now());
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ error: 'username_taken', message: 'That username is taken.' });
      }
      throw e;
    }
    const user = getUserByUsername(name);
    const token = newSession(user.id);
    setSessionCookie(res, token);
    return res.json({ ok: true, user: { id: user.id, username: user.username } });
  }

  // ---- new v3 flow: email verification ----------------------------------
  const mail = normalizeEmail(email);
  if (!EMAIL_RE.test(mail)) {
    return res.status(400).json({ error: 'invalid_email', message: 'That email address looks invalid.' });
  }
  if (getUserByEmail(mail)) {
    return res.status(409).json({ error: 'email_taken', message: 'That email is already registered.' });
  }
  if (!smtpConfigured()) {
    // Honest failure: no account is created, the client can retry once the
    // server owner configures SMTP.
    return res
      .status(422)
      .json({ error: 'email_not_configured', message: 'Email is not configured on this server yet.' });
  }
  const code = genCode();
  try {
    db.prepare(
      'INSERT INTO users (username, password_hash, created_at, email, verified, verify_code, verify_expiry) VALUES (?, ?, ?, ?, 0, ?, ?)'
    ).run(name, hashPassword(password), Date.now(), mail, code, Date.now() + CODE_TTL_MS);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'username_taken', message: 'That username is taken.' });
    }
    throw e;
  }
  try {
    await sendMail(mail, 'Your Chatly verification code', verifyEmailText(code));
  } catch (e) {
    logMailError('register', e);
    if (e.code === 'email_not_configured') {
      return res.status(422).json({ error: 'email_not_configured' });
    }
    // Account exists but the mail didn't go out: leave it unverified so the
    // user can use /api/resend-code later. Never fake success.
    return res.status(422).json({
      ok: false,
      error: 'email_send_failed',
      message: 'Account created, but the verification email could not be sent. Try resending the code.',
    });
  }
  res.json({ ok: true, email: mail, message: 'Verification code sent. Check your inbox.' });
});

// POST /api/login {username|login, password} — `login` may be a username OR an
// email address. {token, username} on success, cookie set for the web UI.
// Legacy cookie flow keeps working; unverified accounts get 403.
app.post('/api/login', rateLimit('login', 20), (req, res) => {
  const { username, login, password } = req.body || {};
  const ident =
    typeof login === 'string' && login.trim()
      ? login.trim()
      : typeof username === 'string'
        ? username.trim()
        : '';
  if (!ident || typeof password !== 'string') {
    return res.status(400).json({ error: 'bad_request', message: 'Username/email and password required.' });
  }
  const row = getUserByUsername(ident) || getUserByEmail(ident);
  if (!row || !verifyPassword(password, row.password_hash)) {
    return res.status(401).json({ error: 'bad_credentials', message: 'Wrong username or password.' });
  }
  if (!row.verified) {
    return res
      .status(403)
      .json({ error: 'not_verified', message: 'Please verify your email address first.' });
  }
  const token = newSession(row.id);
  setSessionCookie(res, token);
  res.json({
    ok: true,
    token,
    username: row.username,
    user: { id: row.id, username: row.username },
  });
});

app.post('/api/logout', (req, res, next) => {
  req.user = getUserFromReq(req) || getApiUser(req);
  next();
}, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'unauthorized', message: 'Not logged in.' });
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.user.sessionToken);
  clearSessionCookie(res);
  res.json({ ok: true });
});

// GET /api/me?token= and POST /api/me {token} → full self profile.
// Legacy {user:{id,username}} shape is preserved inside; the top level adds
// the profile fields the app needs. Public /api/profile/:username deliberately
// omits email/verified.
function selfProfileHandler(req, res) {
  const user = getUserFromReq(req) || getApiUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized', message: 'Not logged in.' });
  const full = getUserById(user.id);
  res.json({
    user: { id: full.id, username: full.username },
    username: full.username,
    name: full.display_name || full.username,
    bio: full.bio || '',
    avatar: full.avatar || null,
    email: full.email || null,
    verified: Boolean(full.verified),
    online: onlineIds().includes(full.id),
  });
}
app.get('/api/me', selfProfileHandler);
app.post('/api/me', selfProfileHandler);

// POST /api/auth/google {idToken, username?} — Google sign-in.
// Verifies the ID token with Google, requires aud == GOOGLE_CLIENT_ID and
// email_verified. Find-or-create by email; new users get a unique username
// (requested one if valid+free, else derived from the email prefix).
// 503 {error:"google_not_configured"} when GOOGLE_CLIENT_ID is missing.
app.post('/api/auth/google', rateLimit('google', 20), async (req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    return res.status(422).json({
      error: 'google_not_configured',
      message: 'Google sign-in is not configured on this server yet.',
    });
  }
  const { idToken, username } = req.body || {};
  if (typeof idToken !== 'string' || !idToken) {
    return res.status(400).json({ error: 'bad_request', message: 'idToken is required.' });
  }
  let info;
  try {
    const r = await fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
      { signal: AbortSignal.timeout(10000) }
    );
    if (!r.ok) {
      return res.status(401).json({ error: 'invalid_token', message: 'Google token is not valid.' });
    }
    info = await r.json();
  } catch (e) {
    console.error('[auth] google tokeninfo unreachable:', (e && e.message) || e);
    return res.status(422).json({ error: 'google_unreachable', message: 'Could not reach Google.' });
  }
  if (info.aud !== GOOGLE_CLIENT_ID) {
    return res.status(401).json({ error: 'invalid_audience', message: 'Token was not issued for this app.' });
  }
  if (info.email_verified !== true && info.email_verified !== 'true') {
    return res.status(403).json({ error: 'email_not_verified', message: 'Your Google email is not verified.' });
  }
  const email = normalizeEmail(info.email);
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'invalid_email', message: 'Google returned an invalid email.' });
  }
  let user = getUserByEmail(email);
  if (!user) {
    let name = String(username || '').trim();
    if (!name || !USERNAME_RE.test(name) || getUserByUsername(name)) name = '';
    if (!name) {
      let base = email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 20) || 'user';
      if (!USERNAME_RE.test(base)) base = 'user';
      let candidate = base;
      for (let n = 1; getUserByUsername(candidate); n++) candidate = `${base}${n}`.slice(0, 20);
      name = candidate;
    }
    // Google-only accounts get a random, unusable password hash and are
    // verified from the start (Google already verified the email).
    db.prepare(
      'INSERT INTO users (username, password_hash, created_at, email, verified) VALUES (?, ?, ?, ?, 1)'
    ).run(name, `google:${randomBytes(16).toString('hex')}`, Date.now(), email);
    user = getUserByUsername(name);
  }
  const token = newSession(user.id);
  setSessionCookie(res, token);
  res.json({ ok: true, token, username: user.username });
});

// POST /api/verify-email {email, code} → {ok:true}
// Also completes a pending email change when `email` matches the account's
// pending_email (email becomes the new address, pending fields cleared).
app.post('/api/verify-email', rateLimit('verify', 20), (req, res) => {
  const { email, code } = req.body || {};
  const mail = normalizeEmail(email);
  const codeStr = String(code || '').trim();
  // Look up by current email OR by a pending new address (email change flow).
  const user =
    getUserByEmail(mail) ||
    db.prepare('SELECT * FROM users WHERE pending_email = ?').get(mail);

  // Case 1: pending email change for this address.
  if (user && user.pending_email && normalizeEmail(user.pending_email) === mail) {
    if (!user.pending_code || codeStr !== user.pending_code) {
      return res.status(400).json({ error: 'bad_code', message: 'Wrong verification code.' });
    }
    if (user.pending_expiry < Date.now()) {
      return res.status(400).json({ error: 'expired', message: 'That code expired. Request a new one.' });
    }
    db.prepare(
      'UPDATE users SET email = ?, verified = 1, pending_email = NULL, pending_code = NULL, pending_expiry = NULL WHERE id = ?'
    ).run(mail, user.id);
    const token = newSession(user.id);
    setSessionCookie(res, token);
    return res.json({ ok: true, token, username: user.username, emailChanged: true });
  }

  // Case 2: normal new-account verification.
  if (!user) {
    return res.status(400).json({ error: 'no_account', message: 'No account with that email.' });
  }
  if (user.verified) return res.json({ ok: true, already: true });
  if (!user.verify_code || codeStr !== user.verify_code) {
    return res.status(400).json({ error: 'bad_code', message: 'Wrong verification code.' });
  }
  if (user.verify_expiry < Date.now()) {
    return res
      .status(400)
      .json({ error: 'expired', message: 'That code expired. Request a new one.' });
  }
  db.prepare('UPDATE users SET verified = 1, verify_code = NULL, verify_expiry = NULL WHERE id = ?')
    .run(user.id);
  const token = newSession(user.id);
  setSessionCookie(res, token);
  res.json({ ok: true, token, username: user.username });
});

// POST /api/resend-code {email} → {ok:true}; 429 if asked again within 60s.
// Works for new-account verification AND for pending email changes
// (pass the new/pending address in that case).
const lastCodeSent = new Map(); // normalized email → epoch ms (best effort, in-memory)
app.post('/api/resend-code', rateLimit('resend', 10), async (req, res) => {
  const mail = normalizeEmail(req.body && req.body.email);
  if (!mail) return res.status(400).json({ error: 'bad_request', message: 'Email required.' });
  const now = Date.now();
  const last = lastCodeSent.get(mail) || 0;
  if (now - last < 60000) {
    return res.status(429).json({
      error: 'too_soon',
      message: 'A code was just sent. Wait a minute before requesting another.',
      retryAfter: Math.ceil((60000 - (now - last)) / 1000),
    });
  }
  if (!smtpConfigured()) {
    return res.status(422).json({ error: 'email_not_configured' });
  }
  const user =
    getUserByEmail(mail) ||
    db.prepare('SELECT * FROM users WHERE pending_email = ?').get(mail);
  if (user) {
    const isPending = user.pending_email && normalizeEmail(user.pending_email) === mail;
    if (isPending) {
      // Pending email change: fresh code goes to the NEW address.
      const code = genCode();
      db.prepare('UPDATE users SET pending_code = ?, pending_expiry = ? WHERE id = ?')
        .run(code, now + CODE_TTL_MS, user.id);
      try {
        await sendMail(mail, 'Your Chatly verification code', verifyEmailText(code));
      } catch (e) {
        logMailError('resend-code (pending change)', e);
        if (e.code === 'email_not_configured') return res.status(422).json({ error: 'email_not_configured' });
        return res.status(422).json({ error: 'email_send_failed', message: 'Could not send the email.' });
      }
    } else if (!user.verified) {
      // New-account verification.
      const code = genCode();
      db.prepare('UPDATE users SET verify_code = ?, verify_expiry = ? WHERE id = ?')
        .run(code, now + CODE_TTL_MS, user.id);
      try {
        await sendMail(mail, 'Your Chatly verification code', verifyEmailText(code));
      } catch (e) {
        logMailError('resend-code', e);
        if (e.code === 'email_not_configured') return res.status(422).json({ error: 'email_not_configured' });
        return res.status(422).json({ error: 'email_send_failed', message: 'Could not send the email.' });
      }
    }
    // Unknown or already-verified emails: same {ok:true}, don't leak existence.
  }
  lastCodeSent.set(mail, now);
  res.json({ ok: true });
});

// POST /api/forgot-password {email} → always {ok:true} (no account probing).
app.post('/api/forgot-password', rateLimit('forgot', 10), async (req, res) => {
  const mail = normalizeEmail(req.body && req.body.email);
  if (!mail) return res.status(400).json({ error: 'bad_request', message: 'Email required.' });
  if (!smtpConfigured()) {
    return res.status(422).json({ error: 'email_not_configured' });
  }
  const user = getUserByEmail(mail);
  if (user) {
    const code = genCode();
    db.prepare('UPDATE users SET reset_code = ?, reset_expiry = ? WHERE id = ?')
      .run(code, Date.now() + CODE_TTL_MS, user.id);
    try {
      await sendMail(mail, 'Your Chatly password reset code', resetEmailText(code));
    } catch (e) {
      logMailError('forgot-password', e);
      // Still {ok:true}: don't leak whether the account exists.
    }
  }
  res.json({ ok: true });
});

// POST /api/reset-password {email, code, newPassword} → {ok:true}
app.post('/api/reset-password', rateLimit('reset', 10), (req, res) => {
  const { email, code, newPassword } = req.body || {};
  const user = getUserByEmail(email);
  if (!user || !user.reset_code || String(code || '').trim() !== user.reset_code) {
    return res.status(400).json({ error: 'bad_code', message: 'Wrong reset code.' });
  }
  if (user.reset_expiry < Date.now()) {
    return res.status(400).json({ error: 'expired', message: 'That code expired. Request a new one.' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < 6 || newPassword.length > 200) {
    return res.status(400).json({ error: 'weak_password', message: 'Password must be at least 6 characters.' });
  }
  db.prepare('UPDATE users SET password_hash = ?, reset_code = NULL, reset_expiry = NULL WHERE id = ?')
    .run(hashPassword(newPassword), user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id); // log out everywhere
  res.json({ ok: true });
});

// POST /api/check-username {username} → {available:true/false}
app.post('/api/check-username', (req, res) => {
  const username = String((req.body && req.body.username) || '').trim();
  if (!USERNAME_RE.test(username)) return res.json({ available: false, reason: 'invalid' });
  res.json({ available: !getUserByUsername(username) });
});

// POST /api/change-password {token,newPassword} or {username,oldPassword,newPassword}
app.post('/api/change-password', rateLimit('changepw', 10), (req, res) => {
  const { token, username, oldPassword, newPassword } = req.body || {};
  let user = null;
  if (token) {
    user = apiUserFromToken(String(token));
  } else if (typeof username === 'string' && typeof oldPassword === 'string') {
    const row = getUserByUsername(username);
    if (row && verifyPassword(oldPassword, row.password_hash)) user = row;
  }
  if (!user) {
    return res.status(401).json({ error: 'unauthorized', message: 'Invalid token or credentials.' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < 6 || newPassword.length > 200) {
    return res.status(400).json({ error: 'weak_password', message: 'Password must be at least 6 characters.' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), user.id);
  res.json({ ok: true });
});

// POST /api/set-email {token, email} — for legacy accounts without an email:
// sets it, marks the account unverified, and sends a code.
app.post('/api/set-email', rateLimit('setemail', 10), async (req, res) => {
  const user = getApiUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const full = getUserById(user.id);
  if (full.email) {
    return res.status(400).json({ error: 'already_set', message: 'This account already has an email.' });
  }
  const mail = normalizeEmail(req.body && req.body.email);
  if (!EMAIL_RE.test(mail)) {
    return res.status(400).json({ error: 'invalid_email', message: 'That email address looks invalid.' });
  }
  if (getUserByEmail(mail)) {
    return res.status(409).json({ error: 'email_taken', message: 'That email is already registered.' });
  }
  if (!smtpConfigured()) {
    return res.status(422).json({ error: 'email_not_configured' });
  }
  const code = genCode();
  db.prepare('UPDATE users SET email = ?, verified = 0, verify_code = ?, verify_expiry = ? WHERE id = ?')
    .run(mail, code, Date.now() + CODE_TTL_MS, user.id);
  try {
    await sendMail(mail, 'Your Chatly verification code', verifyEmailText(code));
  } catch (e) {
    logMailError('set-email', e);
    if (e.code === 'email_not_configured') return res.status(422).json({ error: 'email_not_configured' });
    return res.status(422).json({ error: 'email_send_failed' });
  }
  res.json({ ok: true, email: mail, message: 'Verification code sent. Check your inbox.' });
});

// POST /api/change-email {token, newEmail} — re-verification flow:
// stores the new address as pending, emails a 6-digit code (10 min) to the
// NEW address. Completes via POST /api/verify-email {email:newEmail, code}.
app.post('/api/change-email', rateLimit('changeemail', 10), async (req, res) => {
  const user = getApiUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const newMail = normalizeEmail(req.body && req.body.newEmail);
  if (!EMAIL_RE.test(newMail)) {
    return res.status(400).json({ error: 'invalid_email', message: 'That email address looks invalid.' });
  }
  const full = getUserById(user.id);
  if (full.email && normalizeEmail(full.email) === newMail) {
    return res.status(400).json({ error: 'same_email', message: 'That is already your email address.' });
  }
  if (getUserByEmail(newMail)) {
    return res.status(409).json({ error: 'email_taken', message: 'That email is already registered.' });
  }
  const pendingTaken = db
    .prepare('SELECT id FROM users WHERE pending_email = ? AND id != ?')
    .get(newMail, user.id);
  if (pendingTaken) {
    return res.status(409).json({ error: 'email_taken', message: 'That email is already registered.' });
  }
  if (!smtpConfigured()) {
    return res.status(422).json({
      error: 'email_not_configured',
      message: 'Email is not configured on this server yet.',
    });
  }
  const code = genCode();
  db.prepare('UPDATE users SET pending_email = ?, pending_code = ?, pending_expiry = ? WHERE id = ?')
    .run(newMail, code, Date.now() + CODE_TTL_MS, user.id);
  try {
    await sendMail(newMail, 'Your Chatly verification code', verifyEmailText(code));
  } catch (e) {
    logMailError('change-email', e);
    if (e.code === 'email_not_configured') return res.status(422).json({ error: 'email_not_configured' });
    return res.status(422).json({ error: 'email_send_failed', message: 'Could not send the email.' });
  }
  res.json({ ok: true, pendingEmail: newMail, message: 'Verification code sent to your new address.' });
});

// --- profiles ---------------------------------------------------------------

// POST /api/set-profile {token, name?, bio?, avatar?} — avatar ≤ 500KB else 413.
app.post('/api/set-profile', (req, res) => {
  const user = getApiUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const { name, bio, avatar } = req.body || {};
  if (avatar != null) {
    const s = String(avatar);
    if (s.length > MAX_AVATAR_CHARS) {
      return res.status(413).json({ error: 'avatar_too_large', message: 'Avatar must be 500KB or less.' });
    }
    if (!/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(s) && !/^[A-Za-z0-9+/=\s]+$/.test(s)) {
      return res.status(400).json({ error: 'bad_request', message: 'Avatar must be a base64 data URL or raw base64.' });
    }
  }
  if (name != null && String(name).length > 60) {
    return res.status(400).json({ error: 'bad_request', message: 'Name is too long (max 60).' });
  }
  if (bio != null && String(bio).length > 500) {
    return res.status(400).json({ error: 'bad_request', message: 'Bio is too long (max 500).' });
  }
  db.prepare('UPDATE users SET display_name = ?, bio = ?, avatar = ? WHERE id = ?').run(
    name != null ? String(name) : getUserById(user.id).display_name,
    bio != null ? String(bio) : getUserById(user.id).bio,
    avatar != null ? String(avatar) : getUserById(user.id).avatar,
    user.id
  );
  res.json({ ok: true, profile: publicProfile(getUserById(user.id)) });
});

// GET /api/profile/:username → public profile + online presence.
app.get('/api/profile/:username', (req, res) => {
  const u = getUserByUsername(req.params.username);
  if (!u) return res.status(404).json({ error: 'not_found', message: 'No such user.' });
  res.json(publicProfile(u));
});

// --- blocks -----------------------------------------------------------------

// POST /api/block {token, username} / POST /api/unblock {token, username}
// GET /api/blocked?token= → {blocked:[usernames]}
function blockTarget(req, res, block) {
  const user = getApiUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const target = getUserByUsername(req.body && req.body.username);
  if (!target || target.id === user.id) {
    return res.status(404).json({ error: 'not_found', message: 'No such user.' });
  }
  const ids = blockedIds(user.id);
  if (block) ids.add(target.id);
  else ids.delete(target.id);
  setBlockedIds(user.id, ids);
  res.json({ ok: true, blocked: blockedUsernames(user.id) });
}

app.post('/api/block', (req, res) => blockTarget(req, res, true));
app.post('/api/unblock', (req, res) => blockTarget(req, res, false));

app.get('/api/blocked', (req, res) => {
  const user = getApiUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  res.json({ blocked: blockedUsernames(user.id) });
});

// --- groups -----------------------------------------------------------------

app.post('/api/groups/create', (req, res) => {
  const user = getApiUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const name = String((req.body && req.body.name) || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'bad_request', message: 'Group name required.' });
  const wanted = Array.isArray(req.body.members) ? req.body.members : [];
  const memberIds = new Set([user.id]);
  for (const m of wanted) {
    const u = getUserByUsername(m);
    if (u && u.id !== user.id) memberIds.add(u.id);
  }
  const info = db
    .prepare('INSERT INTO groups (name, creator_id, created_at) VALUES (?, ?, ?)')
    .run(name, user.id, Date.now());
  const gid = info.lastInsertRowid;
  const add = db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)');
  for (const id of memberIds) add.run(gid, id);
  res.json(groupSummary(gid));
});

app.get('/api/groups', (req, res) => {
  const user = getApiUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const rows = db
    .prepare('SELECT group_id FROM group_members WHERE user_id = ? ORDER BY group_id DESC')
    .all(user.id);
  res.json({ groups: rows.map((r) => groupSummary(r.group_id)).filter(Boolean) });
});

app.post('/api/groups/:id/add', (req, res) => {
  const user = getApiUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const gid = Number(req.params.id);
  if (!groupSummary(gid) || !isMember(gid, user.id)) {
    return res.status(404).json({ error: 'not_found', message: 'Group not found.' });
  }
  const target = getUserByUsername(req.body && req.body.username);
  if (!target) return res.status(404).json({ error: 'not_found', message: 'No such user.' });
  if (isMember(gid, target.id)) {
    return res.status(400).json({ error: 'already_member', message: 'User is already in the group.' });
  }
  db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(gid, target.id);
  res.json(groupSummary(gid));
});

app.post('/api/groups/:id/remove', (req, res) => {
  const user = getApiUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const gid = Number(req.params.id);
  if (!groupSummary(gid) || !isMember(gid, user.id)) {
    return res.status(404).json({ error: 'not_found', message: 'Group not found.' });
  }
  const target = getUserByUsername(req.body && req.body.username);
  if (!target || !isMember(gid, target.id)) {
    return res.status(404).json({ error: 'not_member', message: 'User is not in the group.' });
  }
  db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(gid, target.id);
  const left = db.prepare('SELECT COUNT(*) AS c FROM group_members WHERE group_id = ?').get(gid).c;
  if (left === 0) {
    db.prepare('DELETE FROM group_messages WHERE group_id = ?').run(gid);
    db.prepare('DELETE FROM groups WHERE id = ?').run(gid);
    return res.json({ ok: true, deleted: true });
  }
  res.json(groupSummary(gid));
});

// GET /api/groups/:id/history?token=&limit=50 — newest `limit`, oldest→newest,
// expired messages excluded, messages from blocked senders hidden.
app.get('/api/groups/:id/history', (req, res) => {
  const user = getApiUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const gid = Number(req.params.id);
  if (!groupSummary(gid) || !isMember(gid, user.id)) {
    return res.status(404).json({ error: 'not_found', message: 'Group not found.' });
  }
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 100);
  const now = Date.now();
  const rows = db
    .prepare(
      `SELECT gm.*, u.username AS sender_username FROM group_messages gm
       JOIN users u ON u.id = gm.sender_id
       WHERE gm.group_id = ? AND (gm.expire_at IS NULL OR gm.expire_at > ?)
       ORDER BY gm.id DESC LIMIT ?`
    )
    .all(gid, now, limit);
  rows.reverse();
  const blocked = blockedIds(user.id);
  res.json({
    groupId: gid,
    messages: rows
      .filter((m) => !blocked.has(m.sender_id))
      .map((m) => toClientGroupMessage(m, m.sender_username)),
  });
});

// --- statuses (24h stories) --------------------------------------------------
// Expired statuses (>24h) are purged on every read.

const STATUS_TTL_MS = 24 * 60 * 60 * 1000;

function purgeStatuses() {
  db.prepare('DELETE FROM statuses WHERE expire_at <= ?').run(Date.now());
}

function toClientStatus(s) {
  const u = getUserById(s.user_id);
  return {
    statusId: s.id,
    username: u ? u.username : null,
    name: u ? u.display_name || u.username : null,
    avatar: u ? u.avatar || null : null,
    kind: s.kind,
    text: s.text || null,
    data: s.data || null,
    bg: s.bg || null,
    ts: s.created_at,
    expireAt: s.expire_at,
  };
}

// POST /api/status {token, kind:"text"|"image", text?, data? (base64 ≤1MB), bg?}
app.post('/api/status', requireApiUser, (req, res) => {
  const { kind, text, data, bg } = req.body || {};
  const k = kind === 'image' ? 'image' : 'text';
  let payload = null;
  if (k === 'image') {
    const b64 = typeof data === 'string' ? data : '';
    const bytes = base64ByteLength(b64);
    if (bytes < 1 || bytes > MAX_MEDIA_BYTES) {
      return res.status(413).json({ error: 'too_large', message: 'Status image must be 1MB or less.' });
    }
    payload = b64;
  }
  const body = typeof text === 'string' ? text.slice(0, 500) : null;
  if (k === 'text' && (!body || !body.trim())) {
    return res.status(400).json({ error: 'bad_request', message: 'Text status needs text.' });
  }
  const now = Date.now();
  const info = db
    .prepare(
      'INSERT INTO statuses (user_id, kind, text, data, bg, created_at, expire_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      req.user.id,
      k,
      body,
      payload,
      typeof bg === 'string' ? bg.slice(0, 40) : null,
      now,
      now + STATUS_TTL_MS
    );
  res.json({ ok: true, statusId: info.lastInsertRowid });
});

// GET /api/status/feed?token= — all non-expired statuses, newest first, cap 100.
// Hides statuses from users you blocked or who blocked you.
app.get('/api/status/feed', requireApiUser, (req, res) => {
  purgeStatuses();
  const rows = db
    .prepare('SELECT * FROM statuses ORDER BY created_at DESC LIMIT 100')
    .all();
  const myBlocked = blockedIds(req.user.id);
  const feed = [];
  for (const s of rows) {
    if (s.user_id === req.user.id) {
      feed.push(toClientStatus(s));
      continue;
    }
    if (myBlocked.has(s.user_id)) continue; // I blocked them
    if (isBlocked(req.user.id, s.user_id)) continue; // they blocked me
    feed.push(toClientStatus(s));
  }
  res.json({ statuses: feed });
});

// DELETE /api/status/:id {token} — owner only.
app.delete('/api/status/:id', requireApiUser, (req, res) => {
  const id = Number(req.params.id);
  const s = db.prepare('SELECT * FROM statuses WHERE id = ?').get(id);
  if (!s) return res.status(404).json({ error: 'not_found', message: 'Status not found.' });
  if (s.user_id !== req.user.id) {
    return res.status(403).json({ error: 'forbidden', message: 'You can only delete your own statuses.' });
  }
  db.prepare('DELETE FROM statuses WHERE id = ?').run(id);
  res.json({ ok: true });
});

// --- channels (broadcast) -----------------------------------------------------

function channelSummary(id) {
  const c = db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
  if (!c) return null;
  const creator = getUserById(c.creator_id);
  const subs = db.prepare('SELECT COUNT(*) AS n FROM channel_subs WHERE channel_id = ?').get(id).n;
  return {
    channelId: c.id,
    name: c.name,
    description: c.description || '',
    subscribers: subs,
    creator: creator ? creator.username : null,
    createdAt: c.created_at,
  };
}

// POST /api/channels/create {token, name, description?} — creator auto-subscribed.
app.post('/api/channels/create', requireApiUser, (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'bad_request', message: 'Channel name required.' });
  const description = String((req.body && req.body.description) || '').slice(0, 500);
  const info = db
    .prepare('INSERT INTO channels (name, description, creator_id, created_at) VALUES (?, ?, ?, ?)')
    .run(name, description, req.user.id, Date.now());
  db.prepare('INSERT OR IGNORE INTO channel_subs (channel_id, user_id) VALUES (?, ?)')
    .run(info.lastInsertRowid, req.user.id);
  const s = channelSummary(info.lastInsertRowid);
  res.json({ ok: true, channelId: s.channelId, name: s.name });
});

// GET /api/channels — public directory with subscriber counts.
app.get('/api/channels', (req, res) => {
  const rows = db.prepare('SELECT id FROM channels ORDER BY id DESC LIMIT 200').all();
  res.json({ channels: rows.map((r) => channelSummary(r.id)).filter(Boolean) });
});

function channelSubHandler(req, res, subscribe) {
  const user = getApiUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const id = Number(req.params.id);
  if (!channelSummary(id)) {
    return res.status(404).json({ error: 'not_found', message: 'Channel not found.' });
  }
  if (subscribe) {
    db.prepare('INSERT OR IGNORE INTO channel_subs (channel_id, user_id) VALUES (?, ?)').run(id, user.id);
  } else {
    db.prepare('DELETE FROM channel_subs WHERE channel_id = ? AND user_id = ?').run(id, user.id);
  }
  res.json({ ok: true, subscribers: db.prepare('SELECT COUNT(*) AS n FROM channel_subs WHERE channel_id = ?').get(id).n });
}

app.post('/api/channels/:id/subscribe', (req, res) => channelSubHandler(req, res, true));
app.post('/api/channels/:id/unsubscribe', (req, res) => channelSubHandler(req, res, false));

// POST /api/channels/:id/post {token, text, kind?, data?} — creator only.
app.post('/api/channels/:id/post', requireApiUser, (req, res) => {
  const id = Number(req.params.id);
  const c = db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ error: 'not_found', message: 'Channel not found.' });
  if (c.creator_id !== req.user.id) {
    return res.status(403).json({ error: 'forbidden', message: 'Only the channel creator can post.' });
  }
  const kind = req.body && req.body.kind === 'image' ? 'image' : 'text';
  const text = String((req.body && req.body.text) || '').slice(0, MAX_TEXT_LEN);
  let data = null;
  if (kind === 'image') {
    const b64 = typeof req.body.data === 'string' ? req.body.data : '';
    const bytes = base64ByteLength(b64);
    if (bytes < 1 || bytes > MAX_MEDIA_BYTES) {
      return res.status(413).json({ error: 'too_large', message: 'Image must be 1MB or less.' });
    }
    data = b64;
  }
  if (kind === 'text' && !text.trim()) {
    return res.status(400).json({ error: 'bad_request', message: 'Post needs text.' });
  }
  const info = db
    .prepare('INSERT INTO channel_posts (channel_id, kind, text, data, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, kind, text, data, Date.now());
  res.json({ ok: true, postId: info.lastInsertRowid });
});

// GET /api/channels/:id/posts — public read, newest first, cap 100.
app.get('/api/channels/:id/posts', (req, res) => {
  const id = Number(req.params.id);
  if (!channelSummary(id)) {
    return res.status(404).json({ error: 'not_found', message: 'Channel not found.' });
  }
  const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 100);
  const rows = db
    .prepare('SELECT * FROM channel_posts WHERE channel_id = ? ORDER BY id DESC LIMIT ?')
    .all(id, limit);
  res.json({
    channelId: id,
    posts: rows.map((p) => ({
      postId: p.id,
      kind: p.kind,
      text: p.text,
      data: p.data || null,
      ts: p.created_at,
    })),
  });
});

// --- discover -------------------------------------------------------------------

// GET /api/discover/users?q={prefix}&token= — username/name prefix search,
// cap 20, excludes self.
app.get('/api/discover/users', requireApiUser, (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 30);
  if (!q) return res.json({ users: [] });
  const like = `${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
  const rows = db
    .prepare(
      `SELECT id, username, display_name, bio, avatar FROM users
       WHERE id != ? AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')
       ORDER BY username LIMIT 20`
    )
    .all(req.user.id, like, like);
  const ids = onlineIds();
  res.json({
    users: rows.map((u) => ({
      username: u.username,
      name: u.display_name || u.username,
      bio: u.bio || '',
      avatar: u.avatar || null,
      online: ids.includes(u.id),
    })),
  });
});

// --- users & chats (v1/v2 behavior, plus expiry filtering) -------------------

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
  const now = Date.now();
  const live = '(expire_at IS NULL OR expire_at > ?)';
  // One row per conversation partner, with last message + unread count.
  const rows = db
    .prepare(
      `SELECT
         CASE WHEN m.sender_id = ? THEN m.recipient_id ELSE m.sender_id END AS partner_id,
         MAX(m.id) AS last_id
       FROM messages m
       WHERE (m.sender_id = ? OR m.recipient_id = ?) AND ${live}
       GROUP BY partner_id
       ORDER BY last_id DESC
       LIMIT 100`
    )
    .all(userId, userId, userId, now);
  const unread = new Map(
    db
      .prepare(
        `SELECT sender_id, COUNT(*) AS c FROM messages
         WHERE recipient_id = ? AND status < 2 AND ${live} GROUP BY sender_id`
      )
      .all(userId, now)
      .map((r) => [r.sender_id, r.c])
  );
  return rows.map((r) => {
    const partner = db.prepare('SELECT id, username FROM users WHERE id = ?').get(r.partner_id);
    const last = db.prepare('SELECT * FROM messages WHERE id = ?').get(r.last_id);
    return {
      partner,
      lastMessage: toClientMessage(last),
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
  const now = Date.now();
  const live = '(expire_at IS NULL OR expire_at > ?)';
  const partner = db.prepare('SELECT id, username FROM users WHERE id = ?').get(partnerId);
  if (!partner || partnerId === req.user.id) {
    return res.status(404).json({ error: 'not_found', message: 'Chat not found.' });
  }
  let rows;
  const convo = `((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)) AND ${live}`;
  if (before > 0) {
    rows = db
      .prepare(
        `SELECT * FROM messages WHERE ${convo} AND id < ? ORDER BY id DESC LIMIT ?`
      )
      .all(req.user.id, partnerId, partnerId, req.user.id, now, before, limit);
  } else {
    rows = db
      .prepare(`SELECT * FROM messages WHERE ${convo} ORDER BY id DESC LIMIT ?`)
      .all(req.user.id, partnerId, partnerId, req.user.id, now, limit);
  }
  rows.reverse();

  // Opening the latest view marks everything from the partner as read.
  if (!before) {
    const pending = db
      .prepare(
        `SELECT id FROM messages WHERE sender_id = ? AND recipient_id = ? AND status < 2 AND ${live}`
      )
      .all(partnerId, req.user.id, now);
    if (pending.length) {
      db.prepare(
        `UPDATE messages SET status = 2 WHERE sender_id = ? AND recipient_id = ? AND status < 2 AND ${live}`
      ).run(partnerId, req.user.id, now);
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
    messages: rows.map(toClientMessage),
    hasMore: before ? rows.length === limit : false,
  });
});

// --- SPA fallback (API routes above take precedence)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path === '/ws') return next();
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

// JSON error responses for oversized bodies (no stack/path leaks).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && (err.status === 413 || err.type === 'entity.too.large')) {
    return res.status(413).json({ error: 'payload_too_large', message: 'Request body is too large.' });
  }
  next(err);
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

// Block-aware delivery: never relay anything to a recipient who blocked the sender.
function deliverTo(recipientId, senderId, obj) {
  if (isBlocked(recipientId, senderId)) return false; // drop silently
  return sendToUser(recipientId, obj);
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

// Accept a numeric user id or a username string.
function resolveRecipient(to) {
  if (typeof to === 'number' && Number.isInteger(to) && to > 0) return getUserById(to);
  if (typeof to === 'string' && to.trim()) return getUserByUsername(to);
  return null;
}

const CALL_TYPES = new Set(['call-offer', 'call-answer', 'ice-candidate', 'call-reject', 'call-hangup']);

wss.on('connection', (ws, req) => {
  const user = getUserFromWs(req);
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
  const now0 = Date.now();
  const queued = db
    .prepare(
      'SELECT id, sender_id FROM messages WHERE recipient_id = ? AND status = 0 AND (expire_at IS NULL OR expire_at > ?)'
    )
    .all(userId, now0);
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

    // ---- 1:1 send (text | image | audio | location, optional ttl) ---------
    if (msg.type === 'send') {
      const partner = resolveRecipient(msg.to);
      if (!partner || partner.id === userId) return;

      const content = parseRichContent(msg);
      if (content === 'too_large') {
        ws.send(JSON.stringify({ type: 'error', error: 'too_large' }));
        return;
      }
      if (!content) return;

      // Persist always; deliver only if the recipient hasn't blocked us.
      const m = insertMessage(userId, partner.id, content);
      const blocked = isBlocked(partner.id, userId);
      let delivered = false;
      if (!blocked) {
        delivered = sendToUser(partner.id, {
          type: 'message',
          fromName: user.username,
          message: { ...toClientMessage(m), from: userId },
        });
      }
      if (delivered) {
        db.prepare('UPDATE messages SET status = 1 WHERE id = ?').run(m.id);
        m.status = 1;
      }
      ws.send(JSON.stringify({ type: 'sent', tempId: msg.tempId || null, message: toClientMessage(m) }));
      return;
    }

    // ---- read receipts ----------------------------------------------------
    if (msg.type === 'read') {
      const fromId = Number(msg.from);
      if (!Number.isInteger(fromId) || fromId <= 0) return;
      const now = Date.now();
      const pending = db
        .prepare(
          'SELECT id FROM messages WHERE sender_id = ? AND recipient_id = ? AND status < 2 AND (expire_at IS NULL OR expire_at > ?)'
        )
        .all(fromId, userId, now);
      if (pending.length) {
        db.prepare(
          'UPDATE messages SET status = 2 WHERE sender_id = ? AND recipient_id = ? AND status < 2'
        ).run(fromId, userId);
        deliverTo(fromId, userId, {
          type: 'receipt',
          by: userId,
          ids: pending.map((r) => r.id),
          status: 2,
        });
      }
      return;
    }

    // ---- typing ------------------------------------------------------------
    if (msg.type === 'typing') {
      const partner = resolveRecipient(msg.to);
      if (!partner) return;
      deliverTo(partner.id, userId, { type: 'typing', from: userId, typing: !!msg.typing });
      return;
    }

    // ---- reactions ----------------------------------------------------------
    // {type:"reaction", to, from, msgId, emoji} → persist + relay.
    if (msg.type === 'reaction') {
      const partner = resolveRecipient(msg.to);
      const msgId = Number(msg.msgId);
      const emoji = String(msg.emoji || '').trim();
      if (!partner || !Number.isInteger(msgId) || !emoji || [...emoji].length > 8) return;
      const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
      if (!m) return;
      if (m.sender_id !== userId && m.recipient_id !== userId) return; // not our chat
      const reactions = parseReactions(m.reactions);
      const list = Array.isArray(reactions[emoji]) ? reactions[emoji] : [];
      if (list.includes(user.username)) {
        reactions[emoji] = list.filter((x) => x !== user.username);
        if (!reactions[emoji].length) delete reactions[emoji];
      } else {
        reactions[emoji] = [...list, user.username];
      }
      db.prepare('UPDATE messages SET reactions = ? WHERE id = ?').run(JSON.stringify(reactions), msgId);
      const otherId = m.sender_id === userId ? m.recipient_id : m.sender_id;
      deliverTo(otherId, userId, {
        type: 'reaction',
        from: user.username,
        msgId,
        emoji,
        reactions,
      });
      return;
    }

    // ---- group messages ------------------------------------------------------
    // {type:"group-message", groupId, from, text, kind?, data?, mime?, id, ts, ttl?}
    if (msg.type === 'group-message') {
      const groupId = Number(msg.groupId);
      if (!Number.isInteger(groupId) || groupId <= 0) return;
      const group = db.prepare('SELECT id FROM groups WHERE id = ?').get(groupId);
      if (!group || !isMember(groupId, userId)) return;

      const content = parseRichContent(msg);
      if (content === 'too_large') {
        ws.send(JSON.stringify({ type: 'error', error: 'too_large' }));
        return;
      }
      if (!content) return;

      const gm = insertGroupMessage(groupId, userId, content);
      const clientMsg = toClientGroupMessage(gm, user.username);
      const payload = {
        type: 'group-message',
        groupId,
        from: user.username,
        fromId: userId,
        message: clientMsg,
      };
      for (const member of groupMemberRows(groupId)) {
        if (member.id === userId) continue;
        deliverTo(member.id, userId, payload); // block-aware: skips members who blocked us
      }
      ws.send(JSON.stringify({ type: 'sent', tempId: msg.tempId || null, groupId, message: clientMsg }));
      return;
    }

    // ---- call signaling relay (server never touches media) ------------------
    // call-offer / call-answer / ice-candidate / call-reject / call-hangup
    if (CALL_TYPES.has(msg.type)) {
      const target = resolveRecipient(msg.to);
      if (!target || target.id === userId) return;
      if (isBlocked(target.id, userId)) return; // blocked → drop silently, no reply
      const payload = { type: msg.type, from: user.username, to: target.username };
      if (msg.sdp !== undefined) payload.sdp = msg.sdp;
      if (msg.candidate !== undefined) payload.candidate = msg.candidate;
      if (msg.video !== undefined) payload.video = !!msg.video;
      const delivered = sendToUser(target.id, payload);
      if (!delivered && msg.type === 'call-offer') {
        ws.send(JSON.stringify({ type: 'call-unavailable', to: user.username }));
      }
      return;
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
  console.log(`Chatly v3.1 listening on port ${PORT} (db: ${DB_PATH})`);
  console.log(`Email sending: ${smtpConfigured() ? 'configured' : 'NOT configured (SMTP_* env vars missing)'}`);
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
