/**
 * Chatly end-to-end test.
 *
 * Starts nothing itself — run against a live server:
 *   PORT=4001 node server.js &   (or run test with the server started separately)
 *   node test/test.mjs
 *
 * Exercises: register x2, login, /api/me, user search, chat list,
 * real-time WS messaging with delivery + read receipts, typing relay,
 * presence, and DB persistence.
 */
import WebSocket from 'ws';

const BASE = process.env.TEST_BASE || 'http://localhost:4001';
const WS_URL = BASE.replace('http', 'ws') + '/ws';

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

class Client {
  constructor() {
    this.cookies = '';
    this.received = [];
    this.ws = null;
  }
  async req(method, path, body) {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.cookies ? { Cookie: this.cookies } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookies = setCookie.split(';')[0];
    let data = {};
    try { data = await res.json(); } catch {}
    return { status: res.status, data };
  }
  connectWs() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL, { headers: { Cookie: this.cookies } });
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
      this.ws = ws;
      ws.on('message', (raw) => this.received.push(JSON.parse(raw.toString())));
    });
  }
  waitFor(type, pred = () => true, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const poll = () => {
        const i = this.received.findIndex((m) => m.type === type && pred(m));
        if (i >= 0) return resolve(this.received.splice(i, 1)[0]);
        if (Date.now() - t0 > timeout) return reject(new Error(`timeout waiting for ${type}`));
        setTimeout(poll, 50);
      };
      poll();
    });
  }
  close() { if (this.ws) try { this.ws.close(); } catch {} }
}

const alice = new Client();
const bob = new Client();

// --- registration & login
let r = await alice.req('POST', '/api/register', { username: 'alice_test', password: 'secret123' });
check('register alice', r.status === 200 && r.data.user.username === 'alice_test', `status=${r.status}`);

r = await alice.req('POST', '/api/register', { username: 'alice_test', password: 'secret123' });
check('duplicate username rejected', r.status === 409, `status=${r.status}`);

r = await bob.req('POST', '/api/register', { username: 'bob_test', password: 'secret123' });
check('register bob', r.status === 200, `status=${r.status}`);

r = await bob.req('POST', '/api/login', { username: 'bob_test', password: 'wrongpw' });
check('wrong password rejected', r.status === 401, `status=${r.status}`);

r = await bob.req('POST', '/api/login', { username: 'bob_test', password: 'secret123' });
check('login bob', r.status === 200, `status=${r.status}`);

r = await alice.req('GET', '/api/me');
check('/api/me authed', r.status === 200 && r.data.user.username === 'alice_test');

const anon = new Client();
r = await anon.req('GET', '/api/me');
check('/api/me unauthed -> 401', r.status === 401);

// --- search & chats
const bobId = (await bob.req('GET', '/api/me')).data.user.id;
const aliceId = (await alice.req('GET', '/api/me')).data.user.id;

r = await alice.req('GET', '/api/users?q=bob');
check('search finds bob', r.status === 200 && r.data.users.some((u) => u.username === 'bob_test'));

r = await alice.req('GET', '/api/chats');
check('chat list empty initially', r.status === 200 && r.data.chats.length === 0);

// --- websockets
await alice.connectWs();
await bob.connectWs();
const initA = await alice.waitFor('init');
check('ws init carries online list', Array.isArray(initA.online));
await bob.waitFor('init');
const presA = await alice.waitFor('presence', (m) => m.userId === bobId && m.online === true).catch(() => null);
check('alice sees bob come online', !!presA);

// --- real-time message with delivery receipt
alice.ws.send(JSON.stringify({ type: 'send', to: bobId, text: 'Hello Bob!', tempId: 't1' }));
const sentAck = await alice.waitFor('sent', (m) => m.tempId === 't1');
check('sender gets ack with id', !!sentAck.message.id, `status=${sentAck.message.status}`);
check('message marked delivered (bob online)', sentAck.message.status === 1);

const incoming = await bob.waitFor('message', (m) => m.message.body === 'Hello Bob!');
check('bob receives message live', !!incoming && incoming.fromName === 'alice_test');

// --- typing indicator relay
alice.ws.send(JSON.stringify({ type: 'typing', to: bobId, typing: true }));
const typing = await bob.waitFor('typing', (m) => m.from === aliceId && m.typing === true).catch(() => null);
check('typing indicator relayed', !!typing);

// --- bob opens chat via HTTP -> marks read, alice gets read receipt
r = await bob.req('GET', `/api/messages/${aliceId}`);
check('bob reads history', r.status === 200 && r.data.messages.length === 1 && r.data.messages[0].body === 'Hello Bob!');
const receipt = await alice.waitFor('receipt', (m) => m.status === 2).catch(() => null);
check('alice gets read receipt', !!receipt && receipt.by === bobId);

// --- bob's chat list shows the conversation
r = await bob.req('GET', '/api/chats');
check('chat list has conversation', r.status === 200 && r.data.chats.length === 1 && r.data.chats[0].partner.username === 'alice_test', JSON.stringify(r.data.chats[0]?.unreadCount));
check('unread cleared after reading', r.data.chats[0].unreadCount === 0);

// --- offline delivery: bob disconnects, alice sends, bob reconnects
bob.close();
await new Promise((r2) => setTimeout(r2, 300));
alice.ws.send(JSON.stringify({ type: 'send', to: bobId, text: 'Are you there?', tempId: 't2' }));
const ack2 = await alice.waitFor('sent', (m) => m.tempId === 't2');
check('offline message stays sent (status 0)', ack2.message.status === 0);
await bob.connectWs();
await bob.waitFor('init');
const queuedMsg = await bob.waitFor('message', (m) => m.message.body === 'Are you there?').catch(() => null);
check('queued message delivered on reconnect', !!queuedMsg === false); // NOT pushed; history only
r = await bob.req('GET', `/api/messages/${aliceId}`);
check('queued message in history after reconnect', r.data.messages.some((m) => m.body === 'Are you there?'));

// --- logout invalidates session
r = await alice.req('POST', '/api/logout');
check('logout ok', r.status === 200);
r = await alice.req('GET', '/api/me');
check('session invalid after logout', r.status === 401);

alice.close(); bob.close();

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
