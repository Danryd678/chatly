# Chatly

Chatly is a small, self-hosted, real-time messenger — a WhatsApp-style chat app you can
run on your own server. Users sign up with a username and password, find each other by
username, and message in real time.

**Stack:** Node.js + Express + WebSocket (`ws`) + SQLite (`node:sqlite`, built into Node —
no native modules, no build step, no frameworks on the frontend).

## Features

- Sign up / log in with username + password (passwords hashed with scrypt)
- Session auth via httpOnly cookies, with log out
- Find users by username and start 1-on-1 chats
- Real-time messaging over WebSocket — messages arrive instantly
- Online / offline presence dots
- Read receipts: ✓ sent → ✓✓ delivered → ✓✓ (blue) read
- Typing indicator ("typing…")
- Message history stored in SQLite and loaded when you open a chat
- Clean, mobile-friendly WhatsApp-like UI (chat list, conversation, profile)
- Single `PORT` env var, SQLite file path via `DB_PATH`

## Run locally

Requirements: **Node.js 22.5 or newer** (uses the built-in `node:sqlite`).

```bash
cd chat-app
npm install
npm start
```

Then open **http://localhost:3000** in your browser.

To test with a friend on the same Wi-Fi, find your computer's local IP (e.g. `192.168.1.5`)
and give them `http://192.168.1.5:3000` — see DEPLOY.md for details.

To run the automated test suite (starts against a server you run on port 4001):

```bash
PORT=4001 node server.js &
node test/test.mjs
```

## Important: why it needs a server

Chatly is **not** a purely client-side app and can't work as one. Real messaging between
two people requires a server in the middle: someone has to hold accounts, store messages,
and push new messages to the recipient's phone the moment they arrive. Your browser alone
can't reach someone else's browser directly.

So for real multi-user messaging, Chatly must be hosted on a server that's reachable over
the internet (see **DEPLOY.md** for a free option). On your own computer it works for
testing and for people on your local network, but friends elsewhere can't reach it unless
the server is online and public.

## Project layout

```
chat-app/
├── server.js            # Express + WebSocket server, REST API, auth, presence
├── package.json         # deps: express, ws (pinned)
├── public/
│   ├── index.html       # app shell
│   ├── styles.css       # mobile-friendly WhatsApp-like UI
│   └── app.js           # vanilla-JS single-page client
├── test/
│   └── test.mjs         # end-to-end test suite (run against a live server)
├── DEPLOY.md            # free hosting guide (Render) + local-network guide
└── data/                # SQLite database file lives here (created on first run)
```

## API summary

- `POST /api/register` `{username, password}` → sets session cookie
- `POST /api/login` `{username, password}` → sets session cookie
- `POST /api/logout`
- `GET /api/me`
- `GET /api/users?q=…` — search users by username
- `GET /api/chats` — conversation list with last message + unread counts
- `GET /api/messages/:partnerId` — message history (marks as read)
- WebSocket `/ws` — `send`, `read`, `typing` events; server pushes `message`,
  `sent`, `receipt`, `presence`, `typing`, `init`

## Known limitations (honest list)

- **1-on-1 chats only** — no group chats yet.
- **Text only** — no images, voice notes, or file attachments.
- **No end-to-end encryption** — messages are encrypted in transit (HTTPS) but stored
  in plain text on the server, which the server operator can read.
- **Single server** — no federation; everyone you chat with must have an account on
  the same Chatly server.
- Render's free tier sleeps after inactivity (first message wakes it up in ~30–60s),
  and its disk is ephemeral — see DEPLOY.md for the SQLite caveat.
- Password reset is not implemented; usernames are first-come, first-served.
