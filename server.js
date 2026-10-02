/**
 * Chatly server v3.4 — real-time messenger.
 *
 * Stack: Node.js + Express + WebSocket (ws) + SQLite via libsql
 *        + nodemailer (SMTP email for verification / password reset).
 * No native modules, no build step.
 *
 * Database backend (env):
 *   TURSO_URL         — Turso (hosted SQLite) database URL, e.g.
 *                       libsql://chatly-xxxx.turso.io  (production on Faable)
 *   TURSO_AUTH_TOKEN  — Turso auth token for TURSO_URL
 *   DB_PATH           — local SQLite file path, used ONLY when TURSO_URL is
 *                       unset (dev + tests; default ./data/chatly.db)
 * Faable's disk is ephemeral, so production MUST set TURSO_URL or all data
 * is wiped on every restart/deploy.
 *
 * Config (env vars):
 *   PORT       — port to listen on (default 3000)
 *   DB_PATH    — SQLite file path (default ./data/chatly.db, file mode only)
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
import { createClient } from '@libsql/client';
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
// Backend: Turso (hosted SQLite) when TURSO_URL is set, otherwise a local
// SQLite file (dev + tests). Same SQL dialect either way.

const TURSO_URL = process.env.TURSO_URL || '';
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || '';
if (!TURSO_URL) mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = TURSO_URL
  ? createClient({ url: TURSO_URL, authToken: TURSO_AUTH_TOKEN || undefined })
  : createClient({ url: 'file:' + DB_PATH });
const DB_BACKEND = TURSO_URL ? 'turso' : 'file:' + DB_PATH;

// Thin async wrappers over libsql's db.execute. Rows come back as objects,
// so these mirror the old sync API: dbGet → row|undefined, dbAll → rows[],
// dbRun → result ({rowsAffected, lastInsertRowid}).
async function dbGet(sql, args = []) {
  const r = await db.execute({ sql, args });
  return r.rows.length ? r.rows[0] : undefined;
}
async function dbAll(sql, args = []) {
  const r = await db.execute({ sql, args });
  return r.rows;
}
async function dbRun(sql, args = []) {
  return db.execute({ sql, args });
}

// Add a column only if it does not exist yet (safe to run on every boot,
// so old databases migrate forward automatically).
async function ensureColumn(table, col, ddl) {
  const cols = (await dbAll(`PRAGMA table_info(${table})`)).map((c) => c.name);
  if (!cols.includes(col)) await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}

async function initDb() {
  // WAL only makes sense for a local file; Turso manages its own storage.
  if (!TURSO_URL) {
    try {
      await db.execute('PRAGMA journal_mode = WAL');
    } catch {
      /* non-fatal */
    }
  }
  await db.executeMultiple(`
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
  await ensureColumn('users', 'email', 'TEXT'); // UNIQUE index created below
  await ensureColumn('users', 'verified', 'INTEGER NOT NULL DEFAULT 1'); // legacy accounts grandfathered
  await ensureColumn('users', 'verify_code', 'TEXT');
  await ensureColumn('users', 'verify_expiry', 'INTEGER');
  await ensureColumn('users', 'reset_code', 'TEXT');
  await ensureColumn('users', 'reset_expiry', 'INTEGER');
  await ensureColumn('users', 'display_name', 'TEXT');
  await ensureColumn('users', 'bio', 'TEXT');
  await ensureColumn('users', 'avatar', 'TEXT'); // base64 data URL (<= 500KB)
  await ensureColumn('users', 'blocked', "TEXT NOT NULL DEFAULT '[]'"); // JSON array of user ids
  await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
// SQLite allows many NULLs in a UNIQUE index, so legacy accounts without an
// email coexist fine.

// --- v3.0 migrations: rich message fields ---------------------------------
  await ensureColumn('messages', 'kind', "TEXT NOT NULL DEFAULT 'text'"); // text|image|audio|location
  await ensureColumn('messages', 'data', 'TEXT'); // base64 payload or JSON (location)
  await ensureColumn('messages', 'mime', 'TEXT'); // e.g. image/jpeg
  await ensureColumn('messages', 'reactions', "TEXT NOT NULL DEFAULT '{}'"); // {"❤️":["alice"]}
  await ensureColumn('messages', 'ttl', 'INTEGER'); // disappearing-message TTL in seconds
  await ensureColumn('messages', 'expire_at', 'INTEGER'); // epoch ms; NULL = never expires

// --- v3.5 migrations: view-once media ---------------------------------------
  await ensureColumn('messages', 'view_once', 'INTEGER NOT NULL DEFAULT 0'); // 1 = view-once image/voice
  await ensureColumn('messages', 'viewed_at', 'INTEGER'); // epoch ms when the recipient viewed it

// --- v3.0: groups ----------------------------------------------------------
  await db.executeMultiple(`
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
  // --- v3.5: view-once columns on group_messages (table now exists) -----------
  await ensureColumn('group_messages', 'view_once', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('group_messages', 'viewed_at', 'INTEGER');

// --- v3.1 migrations: pending email changes --------------------------------
  await ensureColumn('users', 'pending_email', 'TEXT'); // new address awaiting verification
  await ensureColumn('users', 'pending_code', 'TEXT');
  await ensureColumn('users', 'pending_expiry', 'INTEGER');

// --- v3.2 migrations: privacy settings + last seen --------------------------
  await ensureColumn('users', 'privacy', "TEXT NOT NULL DEFAULT '{}'"); // JSON: {lastSeen,photo,about} each "everyone"|"nobody"
  await ensureColumn('users', 'last_seen', 'INTEGER'); // epoch ms of last activity (WS connect/disconnect)

// --- v3.1: statuses (24h stories) -------------------------------------------
  await db.executeMultiple(`
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
  await db.executeMultiple(`
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
  -- Starred messages (v3.6): per-user bookmarks into DM or group messages.
  CREATE TABLE IF NOT EXISTS starred_messages (
    user_id INTEGER NOT NULL,
    scope TEXT NOT NULL DEFAULT 'dm', -- 'dm' | 'group'
    message_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, scope, message_id)
  );
`);
}

await initDb();

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

async function newSession(userId) {
  (await dbRun('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?', [userId, Date.now()]));
  const token = randomBytes(32).toString('hex');
  (await dbRun('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', [token, userId, Date.now() + SESSION_TTL_MS]));
  return token;
}

async function apiUserFromToken(token) {
  if (typeof token !== 'string' || !token) return null;
  const row = await dbGet(
    'SELECT s.user_id, u.username, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?',
    [token]
  );
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    (await dbRun('DELETE FROM sessions WHERE token = ?', [token]));
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

async function getUserFromReq(req) {
  const cookies = parseCookies(req.headers.cookie);
  return await apiUserFromToken(cookies[SESSION_COOKIE]);
}

// Token for the JSON API: body field, query string, or Bearer header.
async function getApiUser(req) {
  const b = req.body || {};
  let token = b.token || req.query.token;
  const auth = req.headers.authorization;
  if (!token && typeof auth === 'string' && auth.startsWith('Bearer ')) {
    token = auth.slice(7);
  }
  return token ? await apiUserFromToken(String(token)) : null;
}

// WebSocket handshake: cookie first (web UI), then ?token= (Android).
async function getUserFromWs(req) {
  const viaCookie = await getUserFromReq(req);
  if (viaCookie) return viaCookie;
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const token = url.searchParams.get('token');
    if (token) return await apiUserFromToken(token);
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
  return async (req, res, next) => {
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

async function requireAuth(req, res, next) {
  // Web UI: HttpOnly session cookie. API/Android: token via body/query/Bearer.
  try {
    const user = (await getUserFromReq(req)) || (await getApiUser(req));
    if (!user) return res.status(401).json({ error: 'unauthorized', message: 'Not logged in.' });
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

async function requireApiUser(req, res, next) {
  try {
    const user = await getApiUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized', message: 'Invalid or expired token.' });
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

// ---------------------------------------------------------------- user helpers

const getUserById = async (id) => (await dbGet('SELECT * FROM users WHERE id = ?', [id]));
const getUserByUsername = async (name) =>
  (await dbGet('SELECT * FROM users WHERE username = ?', [String(name || '').trim()]));
const getUserByEmail = async (email) =>
  (await dbGet('SELECT * FROM users WHERE email = ?', [String(email || '').trim().toLowerCase()]));

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

async function blockedIds(userId) {
  const row = (await dbGet('SELECT blocked FROM users WHERE id = ?', [userId]));
  try {
    const arr = JSON.parse(row?.blocked || '[]');
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

async function isBlocked(recipientId, senderId) {
  return (await blockedIds(recipientId)).has(senderId);
}

async function blockedUsernames(userId) {
  const ids = [...(await blockedIds(userId))];
  if (!ids.length) return [];
  const rows = await dbAll(
    `SELECT username FROM users WHERE id IN (${ids.map(() => '?').join(',')})`,
    [...ids]
  );
  return rows.map((r) => r.username);
}

async function setBlockedIds(userId, ids) {
  (await dbRun('UPDATE users SET blocked = ? WHERE id = ?', [JSON.stringify([...ids]), userId]));
}

async function publicProfile(user, viewer) {
  const priv = getPrivacy(user);
  const isOwner = viewer && viewer.id === user.id;
  return {
    username: user.username,
    name: user.display_name || user.username,
    bio: isOwner || priv.about !== 'nobody' ? user.bio || '' : '',
    avatar: isOwner || priv.photo !== 'nobody' ? user.avatar || null : null,
    online: onlineIds().includes(user.id),
    last_seen: isOwner || priv.lastSeen !== 'nobody' ? user.last_seen || null : null,
  };
}

// Privacy settings live on users.privacy as JSON {lastSeen,photo,about};
// each value is "everyone" or "nobody". Missing keys default to "everyone".
function getPrivacy(user) {
  const def = { lastSeen: 'everyone', photo: 'everyone', about: 'everyone' };
  if (!user) return def;
  try {
    const p = JSON.parse(user.privacy || '{}');
    return {
      lastSeen: p.lastSeen === 'nobody' ? 'nobody' : 'everyone',
      photo: p.photo === 'nobody' ? 'nobody' : 'everyone',
      about: p.about === 'nobody' ? 'nobody' : 'everyone',
    };
  } catch {
    return def;
  }
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

async function insertMessage(senderId, recipientId, { kind = 'text', body = '', data = null, mime = null, ttl = null, viewOnce = false }) {
  const now = Date.now();
  const expireAt = ttl ? now + ttl * 1000 : null;
  const info = await dbRun(
    'INSERT INTO messages (sender_id, recipient_id, body, status, created_at, kind, data, mime, ttl, expire_at, view_once) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)',
    [senderId, recipientId, body, now, kind, data, mime, ttl, expireAt, viewOnce ? 1 : 0]
  );
  return (await dbGet('SELECT * FROM messages WHERE id = ?', [info.lastInsertRowid]));
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
  const viewOnce = !!m.view_once;
  const viewed = m.viewed_at != null;
  const o = {
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
    viewOnce,
    viewed,
  };
  if (viewOnce && viewed) delete o.data; // placeholder only — the media is gone for good
  return o;
}

async function insertGroupMessage(groupId, senderId, { kind = 'text', body = '', data = null, mime = null, ttl = null, viewOnce = false }) {
  const now = Date.now();
  const expireAt = ttl ? now + ttl * 1000 : null;
  const info = await dbRun(
    'INSERT INTO group_messages (group_id, sender_id, kind, body, data, mime, ttl, expire_at, created_at, view_once) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [groupId, senderId, kind, body, data, mime, ttl, expireAt, now, viewOnce ? 1 : 0]
  );
  return (await dbGet('SELECT * FROM group_messages WHERE id = ?', [info.lastInsertRowid]));
}

function toClientGroupMessage(m, senderUsername) {
  const viewOnce = !!m.view_once;
  const viewed = m.viewed_at != null;
  const o = {
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
    viewOnce,
    viewed,
  };
  if (viewOnce && viewed) delete o.data; // placeholder only — the media is gone for good
  return o;
}

async function isMember(groupId, userId) {
  return Boolean(
    (await dbGet('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, userId]))
  );
}

async function groupMemberRows(groupId) {
  return dbAll(
    'SELECT u.id, u.username FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? ORDER BY u.username',
    [groupId]
  );
}

async function groupSummary(groupId) {
  const g = (await dbGet('SELECT * FROM groups WHERE id = ?', [groupId]));
  if (!g) return null;
  return {
    groupId: g.id,
    name: g.name,
    members: (await groupMemberRows(groupId)).map((r) => r.username),
    createdAt: Math.floor(g.created_at / 1000),
  };
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
  // View-once: only for image/voice notes, explicit opt-in from the sender.
  const viewOnce = (kind === 'image' || kind === 'audio') && msg.viewOnce === true;
  return { kind, body, data, mime, ttl, viewOnce };
}

// ---------------------------------------------------------------- express app

const app = express();
// Async route-handler wrapper: Express 4 does not catch rejections from
// async handlers, so funnel them into the error middleware (JSON 422, never
// 5xx — the hosting edge proxy swallows 5xx responses).
const ah = (fn) => async (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
// Global JSON limit sized for the largest legitimate payload (1MB media for
// statuses/channel posts, base64-inflated); each handler enforces its own
// tighter cap with a JSON 413. Anything beyond this → JSON 413 via the error
// handler below (no stack/path leaks).
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(process.cwd(), 'public')));

app.get('/api/health', ah(async (req, res) => res.json({ ok: true, app: 'Chatly', version: '3.6.0' })));

// --- accounts -------------------------------------------------------------

// POST /api/register {username, password, email?}
//  - With email    → new v3 flow: creates an UNVERIFIED account, emails a
//                    6-digit code (10 min). 503 if SMTP is not configured.
//  - Without email → legacy web flow: creates a verified account and logs in
//                    (cookie), exactly like v1/v2 did.
app.post('/api/register', rateLimit('register', 10), ah(async (req, res) => {
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
  if (await getUserByUsername(name)) {
    return res.status(409).json({ error: 'username_taken', message: 'That username is taken.' });
  }

  // ---- legacy flow (web UI): no email supplied -------------------------
  if (email == null || String(email).trim() === '') {
    try {
      (await dbRun('INSERT INTO users (username, password_hash, created_at, verified) VALUES (?, ?, ?, 1)', [name, hashPassword(password), Date.now()]));
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ error: 'username_taken', message: 'That username is taken.' });
      }
      throw e;
    }
    const user = await getUserByUsername(name);
    const token = await newSession(user.id);
    setSessionCookie(res, token);
    return res.json({ ok: true, user: { id: user.id, username: user.username } });
  }

  // ---- new v3 flow: email verification ----------------------------------
  const mail = normalizeEmail(email);
  if (!EMAIL_RE.test(mail)) {
    return res.status(400).json({ error: 'invalid_email', message: 'That email address looks invalid.' });
  }
  if (await getUserByEmail(mail)) {
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
    await dbRun(
      'INSERT INTO users (username, password_hash, created_at, email, verified, verify_code, verify_expiry) VALUES (?, ?, ?, ?, 0, ?, ?)',
      [name, hashPassword(password), Date.now(), mail, code, Date.now() + CODE_TTL_MS]
    );
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
}));

// POST /api/login {username|login, password} — `login` may be a username OR an
// email address. {token, username} on success, cookie set for the web UI.
// Legacy cookie flow keeps working; unverified accounts get 403.
app.post('/api/login', rateLimit('login', 20), ah(async (req, res) => {
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
  const row = await getUserByUsername(ident) || await getUserByEmail(ident);
  if (!row || !verifyPassword(password, row.password_hash)) {
    return res.status(401).json({ error: 'bad_credentials', message: 'Wrong username or password.' });
  }
  if (!row.verified) {
    return res
      .status(403)
      .json({ error: 'not_verified', message: 'Please verify your email address first.' });
  }
  const token = await newSession(row.id);
  setSessionCookie(res, token);
  res.json({
    ok: true,
    token,
    username: row.username,
    user: { id: row.id, username: row.username },
    id: row.id,
  });
}));

app.post('/api/logout', ah(async (req, res, next) => {
  req.user = await getUserFromReq(req) || await getApiUser(req);
  next();
}), ah(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'unauthorized', message: 'Not logged in.' });
  (await dbRun('DELETE FROM sessions WHERE token = ?', [req.user.sessionToken]));
  clearSessionCookie(res);
  res.json({ ok: true });
}));

// GET /api/me?token= and POST /api/me {token} → full self profile.
// Legacy {user:{id,username}} shape is preserved inside; the top level adds
// the profile fields the app needs. Public /api/profile/:username deliberately
// omits email/verified.
async function selfProfileHandler(req, res) {
  const user = await getUserFromReq(req) || await getApiUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized', message: 'Not logged in.' });
  const full = await getUserById(user.id);
  res.json({
    user: { id: full.id, username: full.username },
    username: full.username,
    name: full.display_name || full.username,
    bio: full.bio || '',
    avatar: full.avatar || null,
    email: full.email || null,
    verified: Boolean(full.verified),
    online: onlineIds().includes(full.id),
    privacy: getPrivacy(full),
  });
}
app.get('/api/me', ah(selfProfileHandler));
app.post('/api/me', ah(selfProfileHandler));

// POST /api/auth/google {idToken, username?} — Google sign-in.
// Verifies the ID token with Google, requires aud == GOOGLE_CLIENT_ID and
// email_verified. Find-or-create by email; new users get a unique username
// (requested one if valid+free, else derived from the email prefix).
// 503 {error:"google_not_configured"} when GOOGLE_CLIENT_ID is missing.
app.post('/api/auth/google', rateLimit('google', 20), ah(async (req, res) => {
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
  let user = await getUserByEmail(email);
  if (!user) {
    let name = String(username || '').trim();
    if (!name || !USERNAME_RE.test(name) || await getUserByUsername(name)) name = '';
    if (!name) {
      let base = email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 20) || 'user';
      if (!USERNAME_RE.test(base)) base = 'user';
      let candidate = base;
      for (let n = 1; await getUserByUsername(candidate); n++) candidate = `${base}${n}`.slice(0, 20);
      name = candidate;
    }
    // Google-only accounts get a random, unusable password hash and are
    // verified from the start (Google already verified the email).
    await dbRun(
      'INSERT INTO users (username, password_hash, created_at, email, verified) VALUES (?, ?, ?, ?, 1)',
      [name, `google:${randomBytes(16).toString('hex')}`, Date.now(), email]
    );
    user = await getUserByUsername(name);
  }
  const token = await newSession(user.id);
  setSessionCookie(res, token);
  res.json({ ok: true, token, username: user.username });
}));

// POST /api/verify-email {email, code} → {ok:true}
// Also completes a pending email change when `email` matches the account's
// pending_email (email becomes the new address, pending fields cleared).
app.post('/api/verify-email', rateLimit('verify', 20), ah(async (req, res) => {
  const { email, code } = req.body || {};
  const mail = normalizeEmail(email);
  const codeStr = String(code || '').trim();
  // Look up by current email OR by a pending new address (email change flow).
  const user =
    await getUserByEmail(mail) ||
    (await dbGet('SELECT * FROM users WHERE pending_email = ?', [mail]));

  // Case 1: pending email change for this address.
  if (user && user.pending_email && normalizeEmail(user.pending_email) === mail) {
    if (!user.pending_code || codeStr !== user.pending_code) {
      return res.status(400).json({ error: 'bad_code', message: 'Wrong verification code.' });
    }
    if (user.pending_expiry < Date.now()) {
      return res.status(400).json({ error: 'expired', message: 'That code expired. Request a new one.' });
    }
    await dbRun(
      'UPDATE users SET email = ?, verified = 1, pending_email = NULL, pending_code = NULL, pending_expiry = NULL WHERE id = ?',
      [mail, user.id]
    );
    const token = await newSession(user.id);
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
  (await dbRun('UPDATE users SET verified = 1, verify_code = NULL, verify_expiry = NULL WHERE id = ?', [user.id]));
  const token = await newSession(user.id);
  setSessionCookie(res, token);
  res.json({ ok: true, token, username: user.username });
}));

// POST /api/resend-code {email} → {ok:true}; 429 if asked again within 60s.
// Works for new-account verification AND for pending email changes
// (pass the new/pending address in that case).
const lastCodeSent = new Map(); // normalized email → epoch ms (best effort, in-memory)
app.post('/api/resend-code', rateLimit('resend', 10), ah(async (req, res) => {
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
    await getUserByEmail(mail) ||
    (await dbGet('SELECT * FROM users WHERE pending_email = ?', [mail]));
  if (user) {
    const isPending = user.pending_email && normalizeEmail(user.pending_email) === mail;
    if (isPending) {
      // Pending email change: fresh code goes to the NEW address.
      const code = genCode();
      (await dbRun('UPDATE users SET pending_code = ?, pending_expiry = ? WHERE id = ?', [code, now + CODE_TTL_MS, user.id]));
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
      (await dbRun('UPDATE users SET verify_code = ?, verify_expiry = ? WHERE id = ?', [code, now + CODE_TTL_MS, user.id]));
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
}));

// POST /api/forgot-password {email} → always {ok:true} (no account probing).
app.post('/api/forgot-password', rateLimit('forgot', 10), ah(async (req, res) => {
  const mail = normalizeEmail(req.body && req.body.email);
  if (!mail) return res.status(400).json({ error: 'bad_request', message: 'Email required.' });
  if (!smtpConfigured()) {
    return res.status(422).json({ error: 'email_not_configured' });
  }
  const user = await getUserByEmail(mail);
  if (user) {
    const code = genCode();
    (await dbRun('UPDATE users SET reset_code = ?, reset_expiry = ? WHERE id = ?', [code, Date.now() + CODE_TTL_MS, user.id]));
    try {
      await sendMail(mail, 'Your Chatly password reset code', resetEmailText(code));
    } catch (e) {
      logMailError('forgot-password', e);
      // Still {ok:true}: don't leak whether the account exists.
    }
  }
  res.json({ ok: true });
}));

// POST /api/reset-password {email, code, newPassword} → {ok:true}
app.post('/api/reset-password', rateLimit('reset', 10), ah(async (req, res) => {
  const { email, code, newPassword } = req.body || {};
  const user = await getUserByEmail(email);
  if (!user || !user.reset_code || String(code || '').trim() !== user.reset_code) {
    return res.status(400).json({ error: 'bad_code', message: 'Wrong reset code.' });
  }
  if (user.reset_expiry < Date.now()) {
    return res.status(400).json({ error: 'expired', message: 'That code expired. Request a new one.' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < 6 || newPassword.length > 200) {
    return res.status(400).json({ error: 'weak_password', message: 'Password must be at least 6 characters.' });
  }
  (await dbRun('UPDATE users SET password_hash = ?, reset_code = NULL, reset_expiry = NULL WHERE id = ?', [hashPassword(newPassword), user.id]));
  (await dbRun('DELETE FROM sessions WHERE user_id = ?', [user.id])); // log out everywhere
  res.json({ ok: true });
}));

// POST /api/check-username {username} → {available:true/false}
app.post('/api/check-username', ah(async (req, res) => {
  const username = String((req.body && req.body.username) || '').trim();
  if (!USERNAME_RE.test(username)) return res.json({ available: false, reason: 'invalid' });
  res.json({ available: !await getUserByUsername(username) });
}));

// POST /api/change-password {token,newPassword} or {username,oldPassword,newPassword}
app.post('/api/change-password', rateLimit('changepw', 10), ah(async (req, res) => {
  const { token, username, oldPassword, newPassword } = req.body || {};
  let user = null;
  if (token) {
    user = await apiUserFromToken(String(token));
  } else if (typeof username === 'string' && typeof oldPassword === 'string') {
    const row = await getUserByUsername(username);
    if (row && verifyPassword(oldPassword, row.password_hash)) user = row;
  }
  if (!user) {
    return res.status(401).json({ error: 'unauthorized', message: 'Invalid token or credentials.' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < 6 || newPassword.length > 200) {
    return res.status(400).json({ error: 'weak_password', message: 'Password must be at least 6 characters.' });
  }
  (await dbRun('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(newPassword), user.id]));
  res.json({ ok: true });
}));

// POST /api/set-email {token, email} — for legacy accounts without an email:
// sets it, marks the account unverified, and sends a code.
app.post('/api/set-email', rateLimit('setemail', 10), ah(async (req, res) => {
  const user = await getApiUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const full = await getUserById(user.id);
  if (full.email) {
    return res.status(400).json({ error: 'already_set', message: 'This account already has an email.' });
  }
  const mail = normalizeEmail(req.body && req.body.email);
  if (!EMAIL_RE.test(mail)) {
    return res.status(400).json({ error: 'invalid_email', message: 'That email address looks invalid.' });
  }
  if (await getUserByEmail(mail)) {
    return res.status(409).json({ error: 'email_taken', message: 'That email is already registered.' });
  }
  if (!smtpConfigured()) {
    return res.status(422).json({ error: 'email_not_configured' });
  }
  const code = genCode();
  (await dbRun('UPDATE users SET email = ?, verified = 0, verify_code = ?, verify_expiry = ? WHERE id = ?', [mail, code, Date.now() + CODE_TTL_MS, user.id]));
  try {
    await sendMail(mail, 'Your Chatly verification code', verifyEmailText(code));
  } catch (e) {
    logMailError('set-email', e);
    if (e.code === 'email_not_configured') return res.status(422).json({ error: 'email_not_configured' });
    return res.status(422).json({ error: 'email_send_failed' });
  }
  res.json({ ok: true, email: mail, message: 'Verification code sent. Check your inbox.' });
}));

// POST /api/change-email {token, newEmail} — re-verification flow:
// stores the new address as pending, emails a 6-digit code (10 min) to the
// NEW address. Completes via POST /api/verify-email {email:newEmail, code}.
app.post('/api/change-email', rateLimit('changeemail', 10), ah(async (req, res) => {
  const user = await getApiUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const newMail = normalizeEmail(req.body && req.body.newEmail);
  if (!EMAIL_RE.test(newMail)) {
    return res.status(400).json({ error: 'invalid_email', message: 'That email address looks invalid.' });
  }
  const full = await getUserById(user.id);
  if (full.email && normalizeEmail(full.email) === newMail) {
    return res.status(400).json({ error: 'same_email', message: 'That is already your email address.' });
  }
  if (await getUserByEmail(newMail)) {
    return res.status(409).json({ error: 'email_taken', message: 'That email is already registered.' });
  }
  const pendingTaken = await dbGet('SELECT id FROM users WHERE pending_email = ? AND id != ?', [
    newMail,
    user.id,
  ]);
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
  (await dbRun('UPDATE users SET pending_email = ?, pending_code = ?, pending_expiry = ? WHERE id = ?', [newMail, code, Date.now() + CODE_TTL_MS, user.id]));
  try {
    await sendMail(newMail, 'Your Chatly verification code', verifyEmailText(code));
  } catch (e) {
    logMailError('change-email', e);
    if (e.code === 'email_not_configured') return res.status(422).json({ error: 'email_not_configured' });
    return res.status(422).json({ error: 'email_send_failed', message: 'Could not send the email.' });
  }
  res.json({ ok: true, pendingEmail: newMail, message: 'Verification code sent to your new address.' });
}));

// --- profiles ---------------------------------------------------------------

// POST /api/set-profile {token, name?, bio?, avatar?} — avatar ≤ 500KB else 413.
app.post('/api/set-profile', ah(async (req, res) => {
  const user = await getApiUser(req);
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
  const cur = await getUserById(user.id);
  await dbRun('UPDATE users SET display_name = ?, bio = ?, avatar = ? WHERE id = ?', [
    name != null ? String(name) : cur.display_name,
    bio != null ? String(bio) : cur.bio,
    avatar != null ? String(avatar) : cur.avatar,
    user.id,
  ]);
  res.json({ ok: true, profile: await publicProfile(await getUserById(user.id)) });
}));

// GET /api/profile/:username → public profile + online presence.
// Honors the target's privacy settings (photo/about/lastSeen); the owner
// always sees their own full profile. Auth is optional.
app.get('/api/profile/:username', ah(async (req, res) => {
  const u = await getUserByUsername(req.params.username);
  if (!u) return res.status(404).json({ error: 'not_found', message: 'No such user.' });
  const viewer = await getUserFromReq(req) || await getApiUser(req);
  res.json(await publicProfile(u, viewer));
}));

// POST /api/set-privacy {token, lastSeen?, photo?, about?}
// Each value: "everyone" | "nobody". Read receipts stay client-side only.
app.post('/api/set-privacy', ah(async (req, res) => {
  const user = await getApiUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized', message: 'Not logged in.' });
  const b = req.body || {};
  const cur = getPrivacy(await getUserById(user.id));
  for (const key of ['lastSeen', 'photo', 'about']) {
    if (b[key] === undefined) continue;
    if (b[key] !== 'everyone' && b[key] !== 'nobody') {
      return res
        .status(422)
        .json({ error: 'invalid_privacy', message: 'Privacy values must be "everyone" or "nobody".' });
    }
    cur[key] = b[key];
  }
  (await dbRun('UPDATE users SET privacy = ? WHERE id = ?', [JSON.stringify(cur), user.id]));
  res.json({ ok: true, privacy: cur });
}));

// POST /api/delete-account {token, password} — permanently deletes the
// account and all of the user's data (messages, groups, statuses, sessions…).
app.post('/api/delete-account', ah(async (req, res) => {
  const user = await getApiUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized', message: 'Not logged in.' });
  const full = await getUserById(user.id);
  if (!full || !verifyPassword(String((req.body && req.body.password) || ''), full.password_hash)) {
    return res.status(403).json({ error: 'bad_password', message: 'Wrong password.' });
  }
  const id = user.id;
  (await dbRun('DELETE FROM sessions WHERE user_id = ?', [id]));
  (await dbRun('DELETE FROM messages WHERE sender_id = ? OR recipient_id = ?', [id, id]));
  (await dbRun('DELETE FROM group_messages WHERE sender_id = ?', [id]));
  (await dbRun('DELETE FROM group_members WHERE user_id = ?', [id]));
  (await dbRun('DELETE FROM groups WHERE creator_id = ?', [id]));
  (await dbRun('DELETE FROM statuses WHERE user_id = ?', [id]));
  (await dbRun('DELETE FROM channel_subs WHERE user_id = ?', [id]));
  (await dbRun('DELETE FROM channels WHERE creator_id = ?', [id]));
  for (const row of (await dbAll('SELECT id, blocked FROM users'))) {
    try {
      const arr = JSON.parse(row.blocked || '[]').filter((x) => x !== id);
      (await dbRun('UPDATE users SET blocked = ? WHERE id = ?', [JSON.stringify(arr), row.id]));
    } catch {
      /* keep going */
    }
  }
  (await dbRun('DELETE FROM users WHERE id = ?', [id]));
  res.json({ ok: true });
}));

// --- blocks -----------------------------------------------------------------

// POST /api/block {token, username} / POST /api/unblock {token, username}
// GET /api/blocked?token= → {blocked:[usernames]}
async function blockTarget(req, res, block) {
  const user = await getApiUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const target = await getUserByUsername(req.body && req.body.username);
  if (!target || target.id === user.id) {
    return res.status(404).json({ error: 'not_found', message: 'No such user.' });
  }
  const ids = await blockedIds(user.id);
  if (block) ids.add(target.id);
  else ids.delete(target.id);
  await setBlockedIds(user.id, ids);
  res.json({ ok: true, blocked: await blockedUsernames(user.id) });
}

app.post('/api/block', ah(async (req, res) => await blockTarget(req, res, true)));
app.post('/api/unblock', ah(async (req, res) => await blockTarget(req, res, false)));

app.get('/api/blocked', ah(async (req, res) => {
  const user = await getApiUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  res.json({ blocked: await blockedUsernames(user.id) });
}));

// --- groups -----------------------------------------------------------------

app.post('/api/groups/create', ah(async (req, res) => {
  const user = await getApiUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const name = String((req.body && req.body.name) || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'bad_request', message: 'Group name required.' });
  const wanted = Array.isArray(req.body.members) ? req.body.members : [];
  const memberIds = new Set([user.id]);
  for (const m of wanted) {
    const u = await getUserByUsername(m);
    if (u && u.id !== user.id) memberIds.add(u.id);
  }
  const info = await dbRun('INSERT INTO groups (name, creator_id, created_at) VALUES (?, ?, ?)', [
    name,
    user.id,
    Date.now(),
  ]);
  const gid = Number(info.lastInsertRowid);
  for (const id of memberIds) {
    await dbRun('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)', [gid, id]);
  }
  res.json(await groupSummary(gid));
}));

app.get('/api/groups', ah(async (req, res) => {
  const user = await getApiUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const rows = await dbAll('SELECT group_id FROM group_members WHERE user_id = ? ORDER BY group_id DESC', [
    user.id,
  ]);
  const groups = await Promise.all(rows.map(async (r) => await groupSummary(r.group_id)));
  res.json({ groups: groups.filter(Boolean) });
}));

app.post('/api/groups/:id/add', ah(async (req, res) => {
  const user = await getApiUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const gid = Number(req.params.id);
  if (!await groupSummary(gid) || !await isMember(gid, user.id)) {
    return res.status(404).json({ error: 'not_found', message: 'Group not found.' });
  }
  const target = await getUserByUsername(req.body && req.body.username);
  if (!target) return res.status(404).json({ error: 'not_found', message: 'No such user.' });
  if (await isMember(gid, target.id)) {
    return res.status(400).json({ error: 'already_member', message: 'User is already in the group.' });
  }
  (await dbRun('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', [gid, target.id]));
  res.json(await groupSummary(gid));
}));

app.post('/api/groups/:id/remove', ah(async (req, res) => {
  const user = await getApiUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const gid = Number(req.params.id);
  if (!await groupSummary(gid) || !await isMember(gid, user.id)) {
    return res.status(404).json({ error: 'not_found', message: 'Group not found.' });
  }
  const target = await getUserByUsername(req.body && req.body.username);
  if (!target || !await isMember(gid, target.id)) {
    return res.status(404).json({ error: 'not_member', message: 'User is not in the group.' });
  }
  (await dbRun('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', [gid, target.id]));
  const left = (await dbGet('SELECT COUNT(*) AS c FROM group_members WHERE group_id = ?', [gid])).c;
  if (left === 0) {
    (await dbRun('DELETE FROM group_messages WHERE group_id = ?', [gid]));
    (await dbRun('DELETE FROM groups WHERE id = ?', [gid]));
    return res.json({ ok: true, deleted: true });
  }
  res.json(await groupSummary(gid));
}));

// GET /api/groups/:id/history?token=&limit=50 — newest `limit`, oldest→newest,
// expired messages excluded, messages from blocked senders hidden.
app.get('/api/groups/:id/history', ah(async (req, res) => {
  const user = await getApiUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const gid = Number(req.params.id);
  if (!await groupSummary(gid) || !await isMember(gid, user.id)) {
    return res.status(404).json({ error: 'not_found', message: 'Group not found.' });
  }
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 100);
  const after = Number(req.query.after || 0);
  const now = Date.now();
  let rows;
  if (after > 0) {
    // v3.6: incremental poll for messages newer than `after` (fallback when WS drops).
    rows = await dbAll(
      `SELECT gm.*, u.username AS sender_username FROM group_messages gm
       JOIN users u ON u.id = gm.sender_id
       WHERE gm.group_id = ? AND gm.id > ? AND (gm.expire_at IS NULL OR gm.expire_at > ?)
       ORDER BY gm.id ASC LIMIT ?`,
      [gid, after, now, limit]
    );
  } else {
    rows = await dbAll(
      `SELECT gm.*, u.username AS sender_username FROM group_messages gm
       JOIN users u ON u.id = gm.sender_id
       WHERE gm.group_id = ? AND (gm.expire_at IS NULL OR gm.expire_at > ?)
       ORDER BY gm.id DESC LIMIT ?`,
      [gid, now, limit]
    );
    rows.reverse();
  }
  const blocked = await blockedIds(user.id);
  res.json({
    groupId: gid,
    messages: rows
      .filter((m) => !blocked.has(m.sender_id))
      .map((m) => toClientGroupMessage(m, m.sender_username)),
  });
}));

// --- statuses (24h stories) --------------------------------------------------
// Expired statuses (>24h) are purged on every read.

const STATUS_TTL_MS = 24 * 60 * 60 * 1000;

async function purgeStatuses() {
  (await dbRun('DELETE FROM statuses WHERE expire_at <= ?', [Date.now()]));
}

async function toClientStatus(s) {
  const u = await getUserById(s.user_id);
  return {
    statusId: s.id,
    userId: s.user_id,
    username: u ? u.username : null,
    name: u ? u.display_name || u.username : null,
    avatar: u ? u.avatar || null : null,
    kind: s.kind,
    text: s.text || null,
    data: s.data || null,
    bg: s.bg || null,
    ts: s.created_at,
    createdAt: Math.floor(s.created_at / 1000),
    expireAt: s.expire_at,
  };
}

// POST /api/status {token, kind:"text"|"image", text?, data? (base64 ≤1MB), bg?}
app.post('/api/status', requireApiUser, ah(async (req, res) => {
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
  const info = await dbRun(
    'INSERT INTO statuses (user_id, kind, text, data, bg, created_at, expire_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      req.user.id,
      k,
      body,
      payload,
      typeof bg === 'number' ? String(Math.trunc(bg)) : typeof bg === 'string' ? bg.slice(0, 40) : null,
      now,
      now + STATUS_TTL_MS,
    ]
  );
  res.json({ ok: true, statusId: Number(info.lastInsertRowid) });
}));

// GET /api/status/feed?token= — all non-expired statuses, newest first, cap 100.
// Hides statuses from users you blocked or who blocked you.
app.get('/api/status/feed', requireApiUser, ah(async (req, res) => {
  await purgeStatuses();
  const rows = await dbAll('SELECT * FROM statuses ORDER BY created_at DESC LIMIT 100');
  const myBlocked = await blockedIds(req.user.id);
  const feed = [];
  for (const s of rows) {
    if (s.user_id === req.user.id) {
      feed.push(await toClientStatus(s));
      continue;
    }
    if (myBlocked.has(s.user_id)) continue; // I blocked them
    if (await isBlocked(req.user.id, s.user_id)) continue; // they blocked me
    feed.push(await toClientStatus(s));
  }
  res.json({ statuses: feed });
}));

// DELETE /api/status/:id {token} — owner only.
app.delete('/api/status/:id', requireApiUser, ah(async (req, res) => {
  const id = Number(req.params.id);
  const s = (await dbGet('SELECT * FROM statuses WHERE id = ?', [id]));
  if (!s) return res.status(404).json({ error: 'not_found', message: 'Status not found.' });
  if (s.user_id !== req.user.id) {
    return res.status(403).json({ error: 'forbidden', message: 'You can only delete your own statuses.' });
  }
  (await dbRun('DELETE FROM statuses WHERE id = ?', [id]));
  res.json({ ok: true });
}));

// --- channels (broadcast) -----------------------------------------------------

async function channelSummary(id, forUserId) {
  const c = (await dbGet('SELECT * FROM channels WHERE id = ?', [id]));
  if (!c) return null;
  const creator = await getUserById(c.creator_id);
  const subs = (await dbGet('SELECT COUNT(*) AS n FROM channel_subs WHERE channel_id = ?', [id])).n;
  const out = {
    channelId: c.id,
    id: c.id, // alias — some clients read "id"
    name: c.name,
    description: c.description || '',
    subscribers: subs,
    creator: creator ? creator.username : null,
    createdAt: Math.floor(c.created_at / 1000),
  };
  if (forUserId) {
    out.mine = c.creator_id === forUserId;
    out.subscribed = !!(await dbGet(
      'SELECT 1 AS x FROM channel_subs WHERE channel_id = ? AND user_id = ?',
      [id, forUserId]
    ));
  }
  return out;
}

// POST /api/channels/create {token, name, description?} — creator auto-subscribed.
app.post('/api/channels/create', requireApiUser, ah(async (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'bad_request', message: 'Channel name required.' });
  const description = String((req.body && req.body.description) || '').slice(0, 500);
  const info = await dbRun(
    'INSERT INTO channels (name, description, creator_id, created_at) VALUES (?, ?, ?, ?)',
    [name, description, req.user.id, Date.now()]
  );
  await dbRun('INSERT OR IGNORE INTO channel_subs (channel_id, user_id) VALUES (?, ?)', [
    info.lastInsertRowid,
    req.user.id,
  ]);
  const s = await channelSummary(info.lastInsertRowid);
  res.json({ ok: true, channelId: s.channelId, name: s.name });
}));

// GET /api/channels?token= — public directory with subscriber counts. When a
// token is supplied, each row also carries `mine` + `subscribed` for that user.
app.get('/api/channels', ah(async (req, res) => {
  const user = await getApiUser(req);
  const rows = (await dbAll('SELECT id FROM channels ORDER BY id DESC LIMIT 200'));
  const chs = await Promise.all(rows.map(async (r) => await channelSummary(r.id, user ? user.id : undefined)));
  res.json({ channels: chs.filter(Boolean) });
}));

async function channelSubHandler(req, res, subscribe) {
  const user = await getApiUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const id = Number(req.params.id);
  if (!await channelSummary(id)) {
    return res.status(404).json({ error: 'not_found', message: 'Channel not found.' });
  }
  if (subscribe) {
    (await dbRun('INSERT OR IGNORE INTO channel_subs (channel_id, user_id) VALUES (?, ?)', [id, user.id]));
  } else {
    (await dbRun('DELETE FROM channel_subs WHERE channel_id = ? AND user_id = ?', [id, user.id]));
  }
  res.json({ ok: true, subscribers: (await dbGet('SELECT COUNT(*) AS n FROM channel_subs WHERE channel_id = ?', [id])).n });
}

app.post('/api/channels/:id/subscribe', ah(async (req, res) => await channelSubHandler(req, res, true)));
app.post('/api/channels/:id/unsubscribe', ah(async (req, res) => await channelSubHandler(req, res, false)));

// POST /api/channels/:id/post {token, text, kind?, data?} — creator only.
app.post('/api/channels/:id/post', requireApiUser, ah(async (req, res) => {
  const id = Number(req.params.id);
  const c = (await dbGet('SELECT * FROM channels WHERE id = ?', [id]));
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
  const info = await dbRun(
    'INSERT INTO channel_posts (channel_id, kind, text, data, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, kind, text, data, Date.now()]
  );
  res.json({ ok: true, postId: Number(info.lastInsertRowid) });
}));

// GET /api/channels/:id/posts — public read, newest first, cap 100.
app.get('/api/channels/:id/posts', ah(async (req, res) => {
  const id = Number(req.params.id);
  if (!await channelSummary(id)) {
    return res.status(404).json({ error: 'not_found', message: 'Channel not found.' });
  }
  const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 100);
  const rows = await dbAll('SELECT * FROM channel_posts WHERE channel_id = ? ORDER BY id DESC LIMIT ?', [
    id,
    limit,
  ]);
  res.json({
    channelId: id,
    posts: rows.map((p) => ({
      postId: p.id,
      kind: p.kind,
      text: p.text,
      data: p.data || null,
      ts: p.created_at,
      createdAt: Math.floor(p.created_at / 1000),
    })),
  });
}));

// DELETE /api/channels/:id {token} — creator only; wipes posts + subscriptions.
app.delete('/api/channels/:id', requireApiUser, ah(async (req, res) => {
  const id = Number(req.params.id);
  const c = (await dbGet('SELECT * FROM channels WHERE id = ?', [id]));
  if (!c) return res.status(404).json({ error: 'not_found', message: 'Channel not found.' });
  if (c.creator_id !== req.user.id) {
    return res.status(403).json({ error: 'forbidden', message: 'Only the channel creator can delete it.' });
  }
  (await dbRun('DELETE FROM channel_posts WHERE channel_id = ?', [id]));
  (await dbRun('DELETE FROM channel_subs WHERE channel_id = ?', [id]));
  (await dbRun('DELETE FROM channels WHERE id = ?', [id]));
  res.json({ ok: true });
}));

// --- discover -------------------------------------------------------------------

// GET /api/discover/users?q={prefix}&token= — username/name prefix search,
// cap 20, excludes self.
app.get('/api/discover/users', requireApiUser, ah(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 30);
  if (!q) return res.json({ users: [] });
  const like = `${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
  const rows = await dbAll(
    `SELECT id, username, display_name, bio, avatar FROM users
     WHERE id != ? AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')
     ORDER BY username LIMIT 20`,
    [req.user.id, like, like]
  );
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
}));

// --- users & chats (v1/v2 behavior, plus expiry filtering) -------------------

app.get('/api/users', requireAuth, ah(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 1) return res.json({ users: [] });
  const rows = await dbAll(
    "SELECT id, username FROM users WHERE id != ? AND username LIKE ? ESCAPE '\\' ORDER BY username LIMIT 20",
    [req.user.id, `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`]
  );
  // last_seen is included only when the target's privacy allows it.
  const users = await Promise.all(
    rows.map(async (r) => {
      const u = await getUserById(r.id);
      const priv = getPrivacy(u);
      return {
        id: r.id,
        username: r.username,
        last_seen: priv.lastSeen !== 'nobody' ? u.last_seen || null : null,
      };
    })
  );
  res.json({ users });
}));

async function conversationList(userId) {
  const now = Date.now();
  const live = '(expire_at IS NULL OR expire_at > ?)';
  // One row per conversation partner, with last message + unread count.
  const rows = await dbAll(
    `SELECT
       CASE WHEN m.sender_id = ? THEN m.recipient_id ELSE m.sender_id END AS partner_id,
       MAX(m.id) AS last_id
     FROM messages m
     WHERE (m.sender_id = ? OR m.recipient_id = ?) AND ${live}
     GROUP BY partner_id
     ORDER BY last_id DESC
     LIMIT 100`,
    [userId, userId, userId, now]
  );
  const unread = new Map(
    (
      await dbAll(
        `SELECT sender_id, COUNT(*) AS c FROM messages
         WHERE recipient_id = ? AND status < 2 AND ${live} GROUP BY sender_id`,
        [userId, now]
      )
    ).map((r) => [r.sender_id, r.c])
  );
  return Promise.all(
    rows.map(async (r) => {
      const partner = (await dbGet('SELECT id, username FROM users WHERE id = ?', [r.partner_id]));
      const last = (await dbGet('SELECT * FROM messages WHERE id = ?', [r.last_id]));
      return {
        partner,
        lastMessage: toClientMessage(last),
        unreadCount: unread.get(r.partner_id) || 0,
      };
    })
  );
}

app.get('/api/chats', requireAuth, ah(async (req, res) => {
  res.json({ chats: await conversationList(req.user.id) });
}));

app.get('/api/messages/:partnerId', requireAuth, ah(async (req, res) => {
  const partnerId = Number(req.params.partnerId);
  const before = Number(req.query.before || 0);
  const after = Number(req.query.after || 0);
  const limit = Math.min(Number(req.query.limit || 50), 100);
  const now = Date.now();
  const live = '(expire_at IS NULL OR expire_at > ?)';
  const partner = (await dbGet('SELECT id, username FROM users WHERE id = ?', [partnerId]));
  if (!partner || partnerId === req.user.id) {
    return res.status(404).json({ error: 'not_found', message: 'Chat not found.' });
  }
  let rows;
  const convo = `((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)) AND ${live}`;
  if (after > 0) {
    // v3.6: incremental poll for messages newer than `after` (fallback when WS drops).
    rows = await dbAll(`SELECT * FROM messages WHERE ${convo} AND id > ? ORDER BY id ASC LIMIT ?`, [
      req.user.id,
      partnerId,
      partnerId,
      req.user.id,
      now,
      after,
      limit,
    ]);
  } else if (before > 0) {
    rows = await dbAll(`SELECT * FROM messages WHERE ${convo} AND id < ? ORDER BY id DESC LIMIT ?`, [
      req.user.id,
      partnerId,
      partnerId,
      req.user.id,
      now,
      before,
      limit,
    ]);
  } else {
    rows = await dbAll(`SELECT * FROM messages WHERE ${convo} ORDER BY id DESC LIMIT ?`, [
      req.user.id,
      partnerId,
      partnerId,
      req.user.id,
      now,
      limit,
    ]);
  }
  rows.reverse();

  // Opening the latest view marks everything from the partner as read.
  if (!before) {
    const pending = await dbAll(
      `SELECT id FROM messages WHERE sender_id = ? AND recipient_id = ? AND status < 2 AND ${live}`,
      [partnerId, req.user.id, now]
    );
    if (pending.length) {
      await dbRun(
        `UPDATE messages SET status = 2 WHERE sender_id = ? AND recipient_id = ? AND status < 2 AND ${live}`,
        [partnerId, req.user.id, now]
      );
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
}));

// POST /api/message-viewed {token, id, scope} — mark a view-once message as
// viewed. Only the recipient (DM) or a non-sender member (group) may do this.
// Wipes the media bytes so they can never be fetched again, and pushes a WS
// event to the sender so their row flips to "Opened". Idempotent.
app.post('/api/message-viewed', requireApiUser, ah(async (req, res) => {
  const id = Number(req.body && req.body.id);
  const scope = req.body && req.body.scope === 'group' ? 'group' : 'dm';
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(422).json({ error: 'bad_request', message: 'Message id is required.' });
  }
  if (scope === 'group') {
    const m = await dbGet('SELECT * FROM group_messages WHERE id = ?', [id]);
    if (!m) return res.status(404).json({ error: 'not_found', message: 'Message not found.' });
    if (!(await isMember(m.group_id, req.user.id))) {
      return res.status(403).json({ error: 'forbidden', message: 'Not a group member.' });
    }
    if (m.sender_id === req.user.id || !m.view_once) return res.json({ ok: true });
    if (m.viewed_at == null) {
      await dbRun('UPDATE group_messages SET viewed_at = ?, data = ? WHERE id = ?', [Date.now(), '', id]);
      await deliverTo(m.sender_id, req.user.id, { type: 'view_once_viewed', id, scope: 'group' });
    }
    return res.json({ ok: true });
  }
  const m = await dbGet('SELECT * FROM messages WHERE id = ?', [id]);
  if (!m) return res.status(404).json({ error: 'not_found', message: 'Message not found.' });
  if (m.sender_id !== req.user.id && m.recipient_id !== req.user.id) {
    return res.status(403).json({ error: 'forbidden', message: 'Not your conversation.' });
  }
  if (m.recipient_id !== req.user.id || !m.view_once) return res.json({ ok: true });
  if (m.viewed_at == null) {
    await dbRun('UPDATE messages SET viewed_at = ?, data = ? WHERE id = ?', [Date.now(), '', id]);
    await deliverTo(m.sender_id, req.user.id, { type: 'view_once_viewed', id, scope: 'dm' });
  }
  return res.json({ ok: true });
}));

// POST /api/star {token, id, scope:'dm'|'group', starred?} — star/unstar a message
// (default starred=true). Only messages the user can see (their DMs, or groups
// they belong to) may be starred. — v3.6
app.post('/api/star', requireApiUser, ah(async (req, res) => {
  const id = Number(req.body && req.body.id);
  const scope = req.body && req.body.scope === 'group' ? 'group' : 'dm';
  const want = !(req.body && req.body.starred === false);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(422).json({ error: 'bad_request', message: 'Message id is required.' });
  }
  if (scope === 'group') {
    const m = await dbGet('SELECT * FROM group_messages WHERE id = ?', [id]);
    if (!m) return res.status(404).json({ error: 'not_found', message: 'Message not found.' });
    if (!(await isMember(m.group_id, req.user.id))) {
      return res.status(403).json({ error: 'forbidden', message: 'Not a group member.' });
    }
  } else {
    const m = await dbGet('SELECT * FROM messages WHERE id = ?', [id]);
    if (!m) return res.status(404).json({ error: 'not_found', message: 'Message not found.' });
    if (m.sender_id !== req.user.id && m.recipient_id !== req.user.id) {
      return res.status(403).json({ error: 'forbidden', message: 'Not your conversation.' });
    }
  }
  if (want) {
    await dbRun(
      'INSERT OR IGNORE INTO starred_messages (user_id, scope, message_id, created_at) VALUES (?, ?, ?, ?)',
      [req.user.id, scope, id, Date.now()]
    );
  } else {
    await dbRun(
      'DELETE FROM starred_messages WHERE user_id = ? AND scope = ? AND message_id = ?',
      [req.user.id, scope, id]
    );
  }
  res.json({ ok: true, starred: want });
}));

// GET /api/starred?token= — starred messages with chat context, newest first. — v3.6
app.get('/api/starred', requireApiUser, ah(async (req, res) => {
  const rows = await dbAll(
    'SELECT * FROM starred_messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 200',
    [req.user.id]
  );
  const out = [];
  for (const s of rows) {
    if (s.scope === 'group') {
      const m = await dbGet('SELECT * FROM group_messages WHERE id = ?', [s.message_id]);
      if (!m || !(await isMember(m.group_id, req.user.id))) continue;
      const g = await dbGet('SELECT * FROM groups WHERE id = ?', [m.group_id]);
      const su = await dbGet('SELECT username FROM users WHERE id = ?', [m.sender_id]);
      const cm = toClientGroupMessage(m, su && su.username);
      cm.chatName = g ? g.name : 'Group';
      cm.chatKey = String(m.group_id);
      cm.chatKind = 'group';
      out.push(cm);
    } else {
      const m = await dbGet('SELECT * FROM messages WHERE id = ?', [s.message_id]);
      if (!m || (m.sender_id !== req.user.id && m.recipient_id !== req.user.id)) continue;
      const partnerId = m.sender_id === req.user.id ? m.recipient_id : m.sender_id;
      const p = await dbGet('SELECT username, display_name FROM users WHERE id = ?', [partnerId]);
      const cm = toClientMessage(m);
      cm.chatName = p ? (p.display_name || p.username) : 'Chat';
      cm.chatKey = String(partnerId);
      cm.chatKind = 'dm';
      out.push(cm);
    }
  }
  res.json({ starred: out });
}));

// --- SPA fallback (API routes above take precedence)
app.get('*', ah(async (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path === '/ws') return next();
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
}));

// JSON error responses for oversized bodies (no stack/path leaks).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && (err.status === 413 || err.type === 'entity.too.large')) {
    return res.status(413).json({ error: 'payload_too_large', message: 'Request body is too large.' });
  }
  console.error('[server] unhandled error:', (err && err.message) || err);
  if (!res.headersSent) {
    res.status(422).json({ error: 'server_error', message: 'Something went wrong.' });
  }
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
async function deliverTo(recipientId, senderId, obj) {
  if (await isBlocked(recipientId, senderId)) return false; // drop silently
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
async function resolveRecipient(to) {
  if (typeof to === 'number' && Number.isInteger(to) && to > 0) return await getUserById(to);
  if (typeof to === 'string' && to.trim()) return await getUserByUsername(to);
  return null;
}

const CALL_TYPES = new Set(['call-offer', 'call-answer', 'ice-candidate', 'call-reject', 'call-hangup']);

wss.on('connection', async (ws, req) => {
  let user = null;
  try {
    user = await getUserFromWs(req);
  } catch (e) {
    console.error('[ws] auth lookup failed:', (e && e.message) || e);
  }
  if (!user) {
    ws.close(4401, 'unauthorized');
    return;
  }
  const userId = user.id;

  if (!online.has(userId)) online.set(userId, new Set());
  online.get(userId).add(ws);
  ws.userId = userId;
  try {
    (await dbRun('UPDATE users SET last_seen = ? WHERE id = ?', [Date.now(), userId]));
  } catch {
    /* non-fatal */
  }

  // Tell everyone this user is now online; send them the current online list.
  broadcast({ type: 'presence', userId, online: true }, userId);
  ws.send(JSON.stringify({ type: 'init', me: { id: user.id, username: user.username }, online: onlineIds() }));

  // Anything queued for this user while offline counts as delivered now.
  // FIX (v3.6): actually PUSH the undelivered message content to the reconnecting
  // client — previously we only marked them delivered and sent receipts, so a
  // recipient whose socket had silently died never received the bodies.
  try {
    const now0 = Date.now();
    const queued = await dbAll(
      'SELECT * FROM messages WHERE recipient_id = ? AND status = 0 AND (expire_at IS NULL OR expire_at > ?) ORDER BY id ASC LIMIT 50',
      [userId, now0]
    );
    if (queued.length) {
      const blockedBy = new Map();
      for (const m of queued) {
        let blocked = blockedBy.get(m.sender_id);
        if (blocked === undefined) {
          blocked = await isBlocked(userId, m.sender_id);
          blockedBy.set(m.sender_id, blocked);
        }
        if (blocked) continue;
        const sender = await getUserById(m.sender_id);
        sendToUser(userId, {
          type: 'message',
          from: m.sender_id,
          fromName: sender ? sender.username : null,
          message: { ...toClientMessage(m), from: m.sender_id },
        });
      }
      (await dbRun('UPDATE messages SET status = 1 WHERE recipient_id = ? AND status = 0', [userId]));
      const bySender = new Map();
      for (const m of queued) {
        if (!bySender.has(m.sender_id)) bySender.set(m.sender_id, []);
        bySender.get(m.sender_id).push(m.id);
      }
      for (const [senderId, ids] of bySender) {
        sendToUser(senderId, { type: 'receipt', by: userId, ids, status: 1 });
      }
    }
  } catch (e) {
    console.error('[ws] queued delivery failed:', (e && e.message) || e);
  }

  ws.on('message', async (raw) => {
    try {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

    // ---- 1:1 send (text | image | audio | location, optional ttl) ---------
    if (msg.type === 'send') {
      const partner = await resolveRecipient(msg.to);
      if (!partner || partner.id === userId) return;

      const content = parseRichContent(msg);
      if (content === 'too_large') {
        ws.send(JSON.stringify({ type: 'error', error: 'too_large' }));
        return;
      }
      if (!content) return;

      // Persist always; deliver only if the recipient hasn't blocked us.
      const m = await insertMessage(userId, partner.id, content);
      const blocked = await isBlocked(partner.id, userId);
      let delivered = false;
      if (!blocked) {
        delivered = sendToUser(partner.id, {
          type: 'message',
          fromName: user.username,
          message: { ...toClientMessage(m), from: userId },
        });
      }
      if (delivered) {
        (await dbRun('UPDATE messages SET status = 1 WHERE id = ?', [m.id]));
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
      const pending = await dbAll(
        'SELECT id FROM messages WHERE sender_id = ? AND recipient_id = ? AND status < 2 AND (expire_at IS NULL OR expire_at > ?)',
        [fromId, userId, now]
      );
      if (pending.length) {
        await dbRun('UPDATE messages SET status = 2 WHERE sender_id = ? AND recipient_id = ? AND status < 2', [
          fromId,
          userId,
        ]);
        await deliverTo(fromId, userId, {
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
      const partner = await resolveRecipient(msg.to);
      if (!partner) return;
      await deliverTo(partner.id, userId, { type: 'typing', from: userId, typing: !!msg.typing });
      return;
    }

    // ---- reactions ----------------------------------------------------------
    // {type:"reaction", to, from, msgId, emoji} → persist + relay.
    if (msg.type === 'reaction') {
      const partner = await resolveRecipient(msg.to);
      const msgId = Number(msg.msgId);
      const emoji = String(msg.emoji || '').trim();
      if (!partner || !Number.isInteger(msgId) || !emoji || [...emoji].length > 8) return;
      const m = (await dbGet('SELECT * FROM messages WHERE id = ?', [msgId]));
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
      (await dbRun('UPDATE messages SET reactions = ? WHERE id = ?', [JSON.stringify(reactions), msgId]));
      const otherId = m.sender_id === userId ? m.recipient_id : m.sender_id;
      await deliverTo(otherId, userId, {
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
      const group = (await dbGet('SELECT id FROM groups WHERE id = ?', [groupId]));
      if (!group || !await isMember(groupId, userId)) return;

      const content = parseRichContent(msg);
      if (content === 'too_large') {
        ws.send(JSON.stringify({ type: 'error', error: 'too_large' }));
        return;
      }
      if (!content) return;

      const gm = await insertGroupMessage(groupId, userId, content);
      const clientMsg = toClientGroupMessage(gm, user.username);
      const payload = {
        type: 'group-message',
        groupId,
        from: user.username,
        fromId: userId,
        message: clientMsg,
      };
      for (const member of await groupMemberRows(groupId)) {
        if (member.id === userId) continue;
        await deliverTo(member.id, userId, payload); // block-aware: skips members who blocked us
      }
      ws.send(JSON.stringify({ type: 'sent', tempId: msg.tempId || null, groupId, message: clientMsg }));
      return;
    }

    // ---- call signaling relay (server never touches media) ------------------
    // call-offer / call-answer / ice-candidate / call-reject / call-hangup
    if (CALL_TYPES.has(msg.type)) {
      const target = await resolveRecipient(msg.to);
      if (!target || target.id === userId) return;
      if (await isBlocked(target.id, userId)) return; // blocked → drop silently, no reply
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
    } catch (e) {
      console.error('[ws] message handler error:', (e && e.message) || e);
    }
  });

  const onClose = async () => {
    const set = online.get(userId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) {
        online.delete(userId);
        try {
          (await dbRun('UPDATE users SET last_seen = ? WHERE id = ?', [Date.now(), userId]));
        } catch {
          /* non-fatal */
        }
        broadcast({ type: 'presence', userId, online: false });
      }
    }
  };
  ws.on('close', onClose);
  ws.on('error', onClose);
});

// ---------------------------------------------------------------- start

server.listen(PORT, () => {
  console.log(`Chatly v3.6 listening on port ${PORT} (db: ${DB_BACKEND})`);
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
