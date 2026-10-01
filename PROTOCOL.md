# Chatly Server v3.1 — Protocol Reference

Base URL (production): `https://chatly-4vsww.faable.link`
WebSocket URL: `wss://chatly-4vsww.faable.link/ws`

All REST endpoints are JSON. New v3.1 endpoints are marked **v3.1**; **v3**
marks the earlier additions; the rest are the original v1/v2 web endpoints
(unchanged behavior).

Brand: **Chatly**. Error bodies always carry a machine-readable `error` code and a
human `message`.

---

## 1. Authentication

Two interchangeable mechanisms, both backed by the same session store
(7-day expiry):

- **Web UI:** `HttpOnly` cookie `chatly_session` (set by `/api/register` and `/api/login`).
- **API / Android:** the `token` string returned by `/api/login` (and by
  `/api/verify-email`). Pass it as any of:
  - JSON body field: `{ "token": "..." }`
  - query string: `?token=...`
  - header: `Authorization: Bearer ...`
  - WebSocket: `wss://host/ws?token=...`

The legacy cookie-only endpoints (`/api/me`, `/api/logout`, `/api/users`,
`/api/chats`, `/api/messages/:partnerId`) also accept the API token.

---

## 2. Accounts & email verification

### POST /api/register — **v3** (also keeps the legacy flow)
Body: `{ "username", "password", "email"? }`

- Username: 3–20 chars, letters/digits/`_`. Password: 6–200 chars.
- **Without `email`** → legacy web flow: account is created verified and the
  caller is logged in immediately (cookie), exactly like v1/v2.
- **With `email`** → new flow:
  - Validates email format (`invalid_email` → 400), unique username
    (`username_taken` → 409), unique email (`email_taken` → 409).
  - If the server has no SMTP configured → **422 `{error:"email_not_configured"}`**
    and no account is created (retry later — never a fake success).
  - Otherwise creates an **UNVERIFIED** account, emails a 6-digit code
    (10-minute expiry) → `200 {ok:true, email, message}`.
  - If the account was created but the mail failed → `422 {error:"email_send_failed"}`;
    the user can retry via `/api/resend-code`.

### POST /api/login
Body: `{ "username", "password" }` **or** `{ "login", "password" }` — `login`
accepts a **username or an email address**. → `200 {ok:true, token, username, user:{id,username}}`
(also sets the cookie for the web UI).

- `401 {error:"bad_credentials"}` — wrong username/email or password.
- `403 {error:"not_verified"}` — account exists but email not verified yet.

### POST /api/verify-email — **v3** (extended **v3.1**)
Body: `{ "email", "code" }` → `200 {ok:true, token, username}` (auto-logs in).

- `400 {error:"no_account"}` — no account with that email.
- `400 {error:"bad_code"}` — wrong code.
- `400 {error:"expired"}` — code older than 10 minutes.
- **Pending email change:** when `email` matches an account's `pending_email`
  (see `/api/change-email`), a correct code completes the change instead:
  `200 {ok:true, token, username, emailChanged:true}` — the address is swapped
  in, pending fields cleared, account marked verified.

### POST /api/resend-code — **v3** (extended **v3.1**)
Body: `{ "email" }` → `200 {ok:true}`.

- Rate-limited: one code per email per 60s → `429 {error:"too_soon", retryAfter}`.
- `422 {error:"email_not_configured"}` when SMTP is missing.
- `422 {error:"email_send_failed"}` when the mail genuinely fails to send.
- Unknown/already-verified emails still return `{ok:true}` (no account probing).
- **Also works for pending email changes:** pass the *new* (pending) address —
  a fresh code is generated and sent to it.

### POST /api/forgot-password — **v3**
Body: `{ "email" }` → **always** `200 {ok:true}` (never reveals whether the
email is registered). If the account exists, a 6-digit reset code (10 min) is
emailed. `422 {error:"email_not_configured"}` when SMTP is missing.

### POST /api/reset-password — **v3**
Body: `{ "email", "code", "newPassword" }` → `200 {ok:true}`.
All sessions are invalidated (logged out everywhere).

- `400 {error:"bad_code"}` / `400 {error:"expired"}` / `400 {error:"weak_password"}`.

### POST /api/check-username — **v3**
Body: `{ "username" }` → `200 {available:true/false}` (`reason:"invalid"` when the
format itself is illegal).

### POST /api/change-password — **v3**
Body: `{ "token", "newPassword" }` **or** `{ "username", "oldPassword", "newPassword" }`
→ `200 {ok:true}`. `401 {error:"unauthorized"}` on bad token/credentials,
`400 {error:"weak_password"}` on short password.

### POST /api/set-email — **v3**
For legacy accounts that have no email yet. Body: `{ "token", "email" }` →
sets the email, marks the account **unverified**, emails a code.

- `400 {error:"already_set"}` if the account already has an email.
- `409 {error:"email_taken"}`, `400 {error:"invalid_email"}`.
- `422 {error:"email_not_configured"}` when SMTP is missing.

### POST /api/logout · GET /api/me · POST /api/me
Logout is unchanged; both also accept the API token now.

`GET /api/me?token=` and `POST /api/me {token}` → full **self** profile
(**v3.1**):

```json
{
  "user": { "id": 1, "username": "anna" },
  "username": "anna", "name": "Anna", "bio": "...", "avatar": "data:...",
  "email": "anna@yahoo.com", "verified": true, "online": false,
  "privacy": { "lastSeen": "everyone", "photo": "everyone", "about": "everyone" }
}
```

The legacy `user` object is preserved for the web UI. `GET /api/profile/:username`
stays public and deliberately omits `email`/`verified`.

**Email addresses are provider-agnostic:** signup, verification, reset and
change-email accept Gmail, Yahoo, Outlook, iCloud or any other valid address —
codes are always delivered to whatever address the user registered.

### POST /api/change-email — **v3.1**
Re-verification flow for changing your address. Body: `{ "token", "newEmail" }`.
Validates format (`invalid_email` → 400) and uniqueness (`email_taken` → 409,
checked against both current and pending addresses); `400 {error:"same_email"}`
if unchanged. Stores the new address as `pending_email`, generates a 6-digit
code (10 min) and **really sends it to the NEW address** via SMTP:

- `422 {error:"email_not_configured"}` when SMTP is missing.
- `422 {error:"email_send_failed"}` when sending genuinely fails (logged server-side).
- Success → `200 {ok:true, pendingEmail, message}`.
- Complete with `POST /api/verify-email {email:newEmail, code}`; resend with
  `POST /api/resend-code {email:newEmail}`. The old address keeps working until
  the change completes.

### POST /api/auth/google — **v3.1**
Google sign-in. Body: `{ "idToken", "username"? }`.

- The server verifies the ID token live at
  `https://oauth2.googleapis.com/tokeninfo`, requires `aud` to equal the
  configured `GOOGLE_CLIENT_ID`, and requires `email_verified`.
- Find-or-create by email: new users get the requested `username` if valid and
  free, otherwise one derived from the email prefix (made unique); the account
  is created `verified=true` with the Google email stored.
- → `200 {ok:true, token, username}` (cookie also set).
- `422 {error:"google_not_configured"}` when `GOOGLE_CLIENT_ID` is not set.
- `401 {error:"invalid_token"}` / `{error:"invalid_audience"}`,
  `403 {error:"email_not_verified"}`, `422 {error:"google_unreachable"}`.

---

## 3. Profiles — **v3**

### POST /api/set-profile
Body: `{ "token", "name"?, "bio"?, "avatar"? }` → `200 {ok:true, profile}`.

- `name` ≤ 60 chars, `bio` ≤ 500 chars.
- `avatar`: base64 data URL (e.g. `data:image/png;base64,...`) or raw base64,
  **≤ 500 KB** as a string, else `413 {error:"avatar_too_large"}`.
  (Bodies over 600 KB → `413 {error:"payload_too_large"}`.)
- Omitted fields keep their current values.

### GET /api/profile/:username
Public: `200 {username, name, bio, avatar, online, last_seen}` (`online` = has a live socket;
`last_seen` = epoch ms of last activity, or `null`).
`404 {error:"not_found"}` for unknown users.
Honors the target's privacy settings: `avatar` is `null` when their photo visibility is
"nobody" (unless you're viewing your own profile), `bio` is `""` when their about visibility
is "nobody", and `last_seen` is `null` when their last-seen visibility is "nobody".
Auth is optional — pass a token to be recognized as the owner.

### POST /api/set-privacy — **v3.2**
Body: `{ "token", "lastSeen"?, "photo"?, "about"? }` — each value `"everyone"` or `"nobody"`.
→ `200 {ok:true, privacy:{lastSeen, photo, about}}`.
Invalid values → `422 {error:"invalid_privacy"}`. Read receipts are client-side only
(the app simply stops sending WS `read` events) and are not stored here.
`GET /api/me` includes the caller's `privacy` object.

### POST /api/delete-account — **v3.2**
Body: `{ "token", "password" }` → `200 {ok:true}`. Verifies the password, then permanently
deletes the account and all of its data (messages, groups it created, statuses, channel
subscriptions, sessions, block-list entries). Wrong password → `403 {error:"bad_password"}`.

---

## 4. Blocks — **v3**

Block lists are per-user. A blocked sender's messages/reactions/calls/group
messages are **silently dropped** for the recipient who blocked them — the
sender still gets a normal `sent` ack (1:1 messages stay at single-tick).

- `POST /api/block {token, username}` → `200 {ok:true, blocked:[usernames]}`
- `POST /api/unblock {token, username}` → `200 {ok:true, blocked:[usernames]}`
- `GET /api/blocked?token=` → `200 {blocked:[usernames]}`
- Blocking yourself or an unknown user → `404 {error:"not_found"}`.

---

## 5. Groups — **v3**

- `POST /api/groups/create {token, name, members:[usernames]}`
  → `200 {groupId, name, members:[usernames]}` (creator is always added;
  unknown usernames are skipped).
- `GET /api/groups?token=` → `200 {groups:[{groupId, name, members}]}`.
- `POST /api/groups/:id/add {token, username}` → `200 {groupId, name, members}`.
  `400 {error:"already_member"}` if already in.
- `POST /api/groups/:id/remove {token, username}` → `200 {groupId, name, members}`
  (or `{ok:true, deleted:true}` if the group became empty).
  Caller must be a member; `404 {error:"not_found"}` / `{error:"not_member"}` otherwise.
- `GET /api/groups/:id/history?token=&limit=50`
  → `200 {groupId, messages:[...]}` — newest `limit` (max 100), oldest→newest.
  Expired messages are excluded; messages from senders you blocked are hidden.

---

## 5b. Statuses (24h stories) — **v3.1**

Expired statuses (older than 24h) are purged on every read.

- `POST /api/status {token, kind:"text"|"image", text?, data?, bg?}`
  → `200 {ok:true, statusId}`.
  - `kind:"image"` → `data` = base64 ≤ 1 MB decoded, else `413 {error:"too_large"}`.
  - `kind:"text"` requires non-empty `text` (≤ 500 chars).
  - `bg`: optional background style identifier (≤ 40 chars).
- `GET /api/status/feed?token=`
  → `200 {statuses:[{statusId, username, name, avatar, kind, text, data, bg, ts, expireAt}]}`,
  newest first, cap 100. Includes your own. Statuses from users you blocked —
  or who blocked you — are hidden.
- `DELETE /api/status/:id` with `{token}` in the body → `200 {ok:true}`.
  Owner only: `403 {error:"forbidden"}` for others, `404 {error:"not_found"}`
  when missing.

## 5c. Channels (broadcast) — **v3.1**

- `POST /api/channels/create {token, name, description?}`
  → `200 {ok:true, channelId, name}`. The creator is auto-subscribed.
- `GET /api/channels` — public directory (no auth needed):
  `200 {channels:[{channelId, name, description, subscribers, creator, createdAt}]}`.
- `POST /api/channels/:id/subscribe {token}` /
  `POST /api/channels/:id/unsubscribe {token}`
  → `200 {ok:true, subscribers}`. `404 {error:"not_found"}` for unknown channels.
- `POST /api/channels/:id/post {token, text, kind?, data?}`
  → `200 {ok:true, postId}`. **Creator only** — others get `403 {error:"forbidden"}`.
  `kind` is `"text"` (default) or `"image"` (base64 ≤ 1 MB, else `413 {error:"too_large"}`).
- `GET /api/channels/:id/posts?limit=` — public read, newest first, cap 100:
  `200 {channelId, posts:[{postId, kind, text, data, ts}]}`.

## 5d. Discover — **v3.1**

- `GET /api/discover/users?q={prefix}&token=`
  → `200 {users:[{username, name, bio, avatar, online}]}` — prefix search over
  username and display name, cap 20, excludes yourself. (Channel discovery is
  covered by `GET /api/channels` above.)

## 6. 1:1 chats (unchanged endpoints, richer message shape)

- `GET /api/users?q=` — search users (auth required). Each result is
  `{id, username, last_seen}`; `last_seen` is `null` when that user set last-seen
  visibility to "nobody".
- `GET /api/chats` — conversation list with last message + unread counts.
- `GET /api/messages/:partnerId?before=&limit=` — history (expired messages
  excluded); opening the latest view marks messages read (as before).

**Message object** (REST + WebSocket):

```json
{
  "id": 12, "senderId": 3, "kind": "text",
  "body": "hello", "data": null, "mime": null,
  "reactions": {"❤️": ["alice"]},
  "ttl": 3600, "expireAt": 1727745600000,
  "status": 2, "createdAt": 1727742000000
}
```

- `kind`: `"text"` | `"image"` | `"audio"` | `"location"`.
- `data`: base64 payload for image/audio (≤ 1 MB decoded), or
  `{"lat":..,"lng":..}` JSON for location. `mime`: e.g. `image/jpeg`.
- `reactions`: `{ emoji: [usernames] }`.
- `ttl`: disappearing-message lifetime in **seconds** (max 7 days);
  `expireAt`: epoch ms. Expired messages never appear in history.

---

## 7. WebSocket protocol

Connect: `ws(s)://host/ws` with the session cookie, or `?token=...`.

### Server → client (existing, unchanged)
| type | payload |
|---|---|
| `init` | `{me:{id,username}, online:[userIds]}` |
| `presence` | `{userId, online:bool}` |
| `message` | `{fromName, message:{...message, from:userId}}` |
| `sent` | `{tempId, message}` (ack for your `send` / `group-message`) |
| `receipt` | `{by, ids:[msgIds], status:1\|2}` (delivered / read) |
| `typing` | `{from:userId, typing:bool}` |
| `error` | `{error:"too_large"}` (media over 1 MB) |

### Client → server (existing, extended)
- `{type:"send", to, text, tempId?}` — `to` accepts a **user id or username**.
  Optional: `kind` (`text`|`image`|`audio`|`location`), `data`, `mime`, `ttl`.
  Text ≤ 2000 chars; image/audio base64 ≤ 1 MB decoded (else `error/too_large`);
  location `data` = `{lat,lng}` (object or JSON string).
- `{type:"read", from}` — mark sender's messages read.
- `{type:"typing", to, typing}` — `to` accepts id or username.

### Reactions — **v3**
- Client → server: `{type:"reaction", to, from, msgId, emoji}`
  (`to`: username or user id). Toggles your reaction; persisted on the message.
- Server → target: `{type:"reaction", from:username, msgId, emoji, reactions}`
  (full updated map). Silently dropped if the target blocked you.

### Group messages — **v3**
- Client → server:
  `{type:"group-message", groupId, from, text, kind?, data?, mime?, id?, ts?, ttl?}`
  Same content rules/limits as `send`. Must be a group member.
- Server → each **online** member except sender (block-aware):
  `{type:"group-message", groupId, from:username, fromId, message}`.
- Persisted to group history; `ttl`/`expireAt` honored.

### Call signaling — **v3** (server only relays JSON; **no media passes through**)
Routed by `to` (username or user id):

| type | fields |
|---|---|
| `call-offer` | `{to, from, sdp, video}` |
| `call-answer` | `{to, from, sdp}` |
| `ice-candidate` | `{to, from, candidate}` |
| `call-reject` | `{to, from}` |
| `call-hangup` | `{to, from}` |

Server → caller only: `{type:"call-unavailable", to:<callerUsername>}` when a
`call-offer` targets an **offline** user. If the target blocked the caller, the
offer is dropped silently (no `call-unavailable`).

### Block enforcement (all relays)
Before relaying **any** `message` / `reaction` / `call-*` / `group-message` to a
recipient, the server checks the recipient's block list; if the sender is
blocked, the payload is dropped silently.

### Disappearing messages
Any message may carry `ttl` (seconds). The server stores
`expireAt = now + ttl*1000` and excludes expired messages from every history
endpoint and from offline-delivery queues.

---

## 8. Server configuration (server owner)

Set in the hosting dashboard (Faable → Environment):

```
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=you@example.com
SMTP_PASS=********
SMTP_FROM=Chatly <you@example.com>   # optional, defaults to SMTP_USER

GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com   # for Google sign-in
```

**Email is always genuinely delivered** via nodemailer + the SMTP settings
above — never simulated, logged-and-pretended, or skipped. Until SMTP is set,
registration-with-email, resend-code, forgot-password, set-email and
change-email answer `422 {error:"email_not_configured"}`; genuine send
failures are logged server-side (`[mail] ...`) and answered
`422 {error:"email_send_failed"}`, and nothing is ever marked verified on
failure. Legacy username/password accounts keep working without email.
Google sign-in answers `422 {error:"google_not_configured"}` until
`GOOGLE_CLIENT_ID` is set.

---

## 9. Database notes

SQLite (`node:sqlite`), file at `data/chatly.db` (`DB_PATH` env overrides).
v3 migrations run automatically on boot via `ALTER TABLE` guards, so existing
databases upgrade in place:

- `users`: `email` (unique, nullable), `verified` (legacy rows default 1),
  `verify_code`, `verify_expiry`, `reset_code`, `reset_expiry`,
  `display_name`, `bio`, `avatar`, `blocked` (JSON array of user ids).
- `messages`: `kind`, `data`, `mime`, `reactions` (JSON), `ttl`, `expire_at`.
- New: `groups`, `group_members`, `group_messages`.
- **v3.1:** `users.pending_email`, `users.pending_code`, `users.pending_expiry`;
  new `statuses`, `channels`, `channel_subs`, `channel_posts` tables.

Auth tokens = rows in the existing `sessions` table (shared by cookie + API).

> **Note (2026-10-01):** mail/config errors use HTTP 422 instead of 503/502 because the hosting proxy intercepts 5xx responses and replaces them with its own error page. Clients must read the `error` field in the JSON body.
