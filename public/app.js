/* Chatly client — vanilla JS single-page app. */

'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  me: null,
  chats: [],            // conversation list
  active: null,         // { partnerId, username, messages: [] }
  online: new Set(),    // online user ids
  ws: null,
  wsTimer: null,
  typing: new Map(),    // userId -> timeout id for "typing" indicator
  tempSeq: 0,
  authMode: 'login',
};

// ---------------------------------------------------------------- helpers

function show(viewId) {
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== viewId;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const esc = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function avatarColor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h}, 45%, 42%)`;
}

// ---------------------------------------------------------------- auth

function setAuthMode(mode) {
  state.authMode = mode;
  $('tab-login').classList.toggle('active', mode === 'login');
  $('tab-register').classList.toggle('active', mode === 'register');
  $('btn-auth').textContent = mode === 'login' ? 'Log in' : 'Sign up';
  $('input-password').setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
  $('auth-error').hidden = true;
}

$('tab-login').onclick = () => setAuthMode('login');
$('tab-register').onclick = () => setAuthMode('register');

$('form-auth').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('input-username').value.trim();
  const password = $('input-password').value;
  $('auth-error').hidden = true;
  $('btn-auth').disabled = true;
  try {
    const data = await api(state.authMode === 'login' ? '/api/login' : '/api/register', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    state.me = data.user;
    boot();
  } catch (err) {
    $('auth-error').textContent = err.message;
    $('auth-error').hidden = false;
  } finally {
    $('btn-auth').disabled = false;
  }
});

// ---------------------------------------------------------------- boot

async function boot() {
  try {
    const data = await api('/api/me');
    state.me = data.user;
  } catch {
    show('view-auth');
    return;
  }
  show('view-chats');
  connectWs();
  await loadChats();
  renderProfile();
}

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

function connectWs() {
  if (state.ws) { try { state.ws.close(); } catch {} }
  const ws = new WebSocket(wsUrl());
  state.ws = ws;

  ws.onopen = () => {
    clearTimeout(state.wsTimer);
    $('conn-banner').hidden = true;
    $('conn-banner-convo').hidden = true;
    // re-sync state after (re)connect
    loadChats();
    if (state.active) openChat(state.active.partnerId, state.active.username);
  };
  ws.onclose = () => {
    $('conn-banner').hidden = false;
    $('conn-banner-convo').hidden = false;
    state.wsTimer = setTimeout(connectWs, 3000);
  };
  ws.onerror = () => { try { ws.close(); } catch {} };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleWs(msg);
  };
}

function wsSend(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- chats list

async function loadChats() {
  const data = await api('/api/chats');
  state.chats = data.chats;
  renderChats();
}

function renderChats() {
  const list = $('chat-list');
  list.innerHTML = '';
  $('chats-empty').hidden = state.chats.length > 0;

  for (const c of state.chats) {
    const li = document.createElement('li');
    const p = c.partner;
    const last = c.lastMessage;
    const unread = c.unreadCount;
    const isOnline = state.online.has(p.id);
    const ticks = last && last.senderId === state.me.id
      ? `<span class="ticks${last.status === 2 ? ' read' : ''}">${last.status === 0 ? '✓' : '✓✓'}</span>`
      : '';
    li.innerHTML = `
      <div class="avatar" style="background:${avatarColor(p.username)}">
        ${esc(p.username[0].toUpperCase())}
        <span class="dot${isOnline ? ' online' : ''}"></span>
      </div>
      <div class="chat-meta">
        <div class="chat-name"><span>${esc(p.username)}</span>
          <span class="time">${last ? fmtTime(last.createdAt) : ''}</span></div>
        <div class="chat-preview">
          <span>${ticks} ${last ? esc(last.body.slice(0, 60)) : ''}</span>
          ${unread ? `<span class="unread">${unread}</span>` : ''}
        </div>
      </div>`;
    li.onclick = () => openChat(p.id, p.username);
    list.appendChild(li);
  }
}

function bumpUnread(partnerId, partnerUsername, message) {
  let chat = state.chats.find((c) => c.partner.id === partnerId);
  if (!chat) {
    chat = { partner: { id: partnerId, username: partnerUsername }, lastMessage: null, unreadCount: 0 };
    state.chats.unshift(chat);
  } else {
    state.chats = [chat, ...state.chats.filter((c) => c !== chat)];
  }
  chat.lastMessage = message;
  chat.unreadCount += 1;
  renderChats();
}

// ---------------------------------------------------------------- user search / new chat

$('btn-newchat').onclick = () => {
  const panel = $('newchat-panel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) $('input-search').focus();
};

let searchTimer = null;
$('input-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = $('input-search').value.trim();
    const ul = $('search-results');
    ul.innerHTML = '';
    if (!q) return;
    try {
      const data = await api('/api/users?q=' + encodeURIComponent(q));
      for (const u of data.users) {
        const li = document.createElement('li');
        li.innerHTML = `
          <div class="avatar" style="background:${avatarColor(u.username)}">${esc(u.username[0].toUpperCase())}</div>
          <span>${esc(u.username)}</span>`;
        li.onclick = () => {
          $('newchat-panel').hidden = true;
          $('input-search').value = '';
          ul.innerHTML = '';
          openChat(u.id, u.username);
        };
        ul.appendChild(li);
      }
      if (!data.users.length) ul.innerHTML = '<li>No users found.</li>';
    } catch { /* ignore transient search errors */ }
  }, 250);
});

// ---------------------------------------------------------------- conversation

function convoStatusText(partnerId) {
  if (state.typing.has(partnerId)) return 'typing…';
  return state.online.has(partnerId) ? 'online' : 'offline';
}

function refreshConvoHeader() {
  if (!state.active) return;
  const s = $('convo-status');
  s.textContent = convoStatusText(state.active.partnerId);
  s.classList.toggle('typing', state.typing.has(state.active.partnerId));
}

async function openChat(partnerId, username) {
  state.active = { partnerId, username, messages: [] };
  $('convo-name').textContent = username;
  $('messages').innerHTML = '';
  show('view-convo');
  refreshConvoHeader();
  try {
    const data = await api('/api/messages/' + partnerId);
    state.active.messages = data.messages;
    renderMessages();
    // reading this chat marks partner's messages read server-side;
    // refresh the list so unread badges clear.
    loadChats();
  } catch (err) {
    $('messages').innerHTML = `<p class="empty">Couldn't load messages.</p>`;
  }
}

function renderMessages() {
  const box = $('messages');
  box.innerHTML = '';
  let lastDay = '';
  for (const m of state.active.messages) {
    const day = new Date(m.createdAt).toDateString();
    if (day !== lastDay) {
      lastDay = day;
      const d = document.createElement('div');
      d.className = 'day-divider';
      d.textContent = new Date(m.createdAt).toLocaleDateString();
      box.appendChild(d);
    }
    const mine = m.senderId === state.me.id;
    const b = document.createElement('div');
    b.className = 'bubble ' + (mine ? 'mine' : 'theirs');
    b.dataset.id = m.id;
    const ticks = mine
      ? `<span class="ticks${m.status === 2 ? ' read' : ''}" data-ticks>${m.status === 0 ? '✓' : '✓✓'}</span>`
      : '';
    b.innerHTML = `${esc(m.body)}<span class="meta">${fmtTime(m.createdAt)}${ticks}</span>`;
    box.appendChild(b);
  }
  box.scrollTop = box.scrollHeight;
}

function appendIncoming(m) {
  if (!state.active || state.active.partnerId !== m.senderId) return false;
  state.active.messages.push(m);
  // no date-divider bookkeeping here; re-render keeps it simple and correct
  renderMessages();
  wsSend({ type: 'read', from: m.senderId });
  return true;
}

function applyReceipt(ids, status) {
  if (state.active) {
    const idSet = new Set(ids);
    let changed = false;
    for (const m of state.active.messages) {
      if (idSet.has(m.id) && m.senderId === state.me.id && m.status < status) {
        m.status = status;
        changed = true;
        const el = document.querySelector(`.bubble[data-id="${m.id}"] [data-ticks]`);
        if (el) {
          el.className = 'ticks' + (status === 2 ? ' read' : '');
          el.textContent = status === 0 ? '✓' : '✓✓';
        }
      }
    }
    if (changed) loadChats(); // keep preview ticks in sync
  }
}

// --- sending

let typingSent = false;
let typingStopTimer = null;

$('input-message').addEventListener('input', () => {
  if (!state.active) return;
  if (!typingSent) {
    wsSend({ type: 'typing', to: state.active.partnerId, typing: true });
    typingSent = true;
  }
  clearTimeout(typingStopTimer);
  typingStopTimer = setTimeout(() => {
    if (state.active) wsSend({ type: 'typing', to: state.active.partnerId, typing: false });
    typingSent = false;
  }, 1500);
});

$('form-send').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('input-message').value.trim();
  if (!text || !state.active) return;
  const tempId = 't' + (++state.tempSeq);
  const optimistic = {
    id: null, tempId, senderId: state.me.id, body: text, status: 0,
    createdAt: Date.now(),
  };
  state.active.messages.push(optimistic);
  renderMessages();
  $('input-message').value = '';
  clearTimeout(typingStopTimer);
  if (typingSent) { wsSend({ type: 'typing', to: state.active.partnerId, typing: false }); typingSent = false; }

  const ok = wsSend({ type: 'send', to: state.active.partnerId, text, tempId });
  if (!ok) {
    // dropped; remove optimistic message and complain gently
    state.active.messages = state.active.messages.filter((m) => m.tempId !== tempId);
    renderMessages();
    alert('Not connected — trying to reconnect…');
  }
});

// ---------------------------------------------------------------- ws events

function handleWs(msg) {
  switch (msg.type) {
    case 'init':
      state.online = new Set(msg.online);
      renderChats();
      refreshConvoHeader();
      break;

    case 'presence': {
      if (msg.online) state.online.add(msg.userId);
      else state.online.delete(msg.userId);
      renderChats();
      refreshConvoHeader();
      break;
    }

    case 'sent': {
      // server acknowledged our optimistic message
      const m = state.active?.messages.find((x) => x.tempId === msg.tempId);
      if (m) {
        Object.assign(m, msg.message);
        delete m.tempId;
        renderMessages();
        loadChats();
      }
      break;
    }

    case 'message': {
      const m = msg.message;
      const fromId = m.from ?? m.senderId;
      const shown = appendIncoming({ ...m, senderId: fromId });
      if (!shown) {
        // fetch the sender's username for the preview badge
        bumpUnread(fromId, msg.fromName || 'user', m);
        // refresh to get the real username in the list
        loadChats();
      } else {
        loadChats();
      }
      break;
    }

    case 'receipt':
      applyReceipt(msg.ids || [], msg.status || 0);
      break;

    case 'typing': {
      if (state.typing.has(msg.from)) clearTimeout(state.typing.get(msg.from));
      if (msg.typing) {
        const t = setTimeout(() => {
          state.typing.delete(msg.from);
          refreshConvoHeader();
          $('typing-line').hidden = true;
        }, 4000);
        state.typing.set(msg.from, t);
      } else {
        state.typing.delete(msg.from);
      }
      if (state.active && state.active.partnerId === msg.from) {
        refreshConvoHeader();
        const line = $('typing-line');
        if (msg.typing) {
          line.textContent = `${state.active.username} is typing…`;
          line.hidden = false;
        } else {
          line.hidden = true;
        }
      }
      break;
    }
  }
}

// ---------------------------------------------------------------- profile / nav

$('btn-back').onclick = () => { state.active = null; show('view-chats'); loadChats(); };
$('btn-back-profile').onclick = () => show('view-chats');
$('btn-profile').onclick = () => show('view-profile');

function renderProfile() {
  if (!state.me) return;
  $('profile-username').textContent = state.me.username;
  const av = $('profile-avatar');
  av.style.background = avatarColor(state.me.username);
  av.textContent = state.me.username[0].toUpperCase();
}

$('btn-logout').onclick = async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  state.me = null;
  state.active = null;
  state.chats = [];
  if (state.ws) { try { state.ws.close(); } catch {} }
  clearTimeout(state.wsTimer);
  $('input-username').value = '';
  $('input-password').value = '';
  show('view-auth');
};

// ---------------------------------------------------------------- start

boot();
