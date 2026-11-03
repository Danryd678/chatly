/* Chatly client — vanilla JS single-page app. */

'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  me: null,
  chats: [],            // DM conversation list
  groups: [],           // group list (v7.1)
  active: null,         // { kind:'dm'|'group', partnerId, username, groupId, groupName, messages: [], myRole }
  online: new Set(),    // online user ids
  ws: null,
  wsTimer: null,
  typing: new Map(),    // userId -> timeout id for "typing" indicator
  groupTyping: new Map(), // groupId -> Map(username -> timeout id) (v7.1)
  tempSeq: 0,
  authMode: 'login',
  replyTo: null,        // v6.7: { id, sender, snippet } — message being replied to
};

// v7.1: message scope for the active conversation ('group' inside a group chat).
function msgScope() {
  return (state.active && state.active.kind === 'group') ? 'group' : 'dm';
}

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

function fmtDur(s) {
  s = Math.max(0, Math.round(Number(s) || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
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
  await loadGroups(); // v7.1
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
    loadGroups(); // v7.1
    if (state.active) {
      if (state.active.kind === 'group') openGroup(state.active.groupId);
      else openChat(state.active.partnerId, state.active.username);
    }
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

// v7.1: groups
async function loadGroups() {
  try {
    const data = await api('/api/groups');
    state.groups = data.groups || [];
  } catch {
    state.groups = [];
  }
  renderChats();
}

function groupPreviewText(last) {
  if (!last) return '';
  const who = last.sender ? esc(last.sender) + ': ' : '';
  return who + esc(last.snippet.slice(0, 60));
}

function renderChats() {
  const list = $('chat-list');
  list.innerHTML = '';
  const dmCount = state.chats.length;
  const gCount = state.groups.length;
  $('chats-empty').hidden = (dmCount + gCount) > 0;

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
          <span>${ticks} ${last ? (voicePreview(last) || esc(last.body.slice(0, 60))) : ''}</span>
          ${unread ? `<span class="unread">${unread}</span>` : ''}
        </div>
      </div>`;
    li.onclick = () => openChat(p.id, p.username);
    list.appendChild(li);
  }

  // ---- groups (v7.1) ----
  for (const g of state.groups) {
    const li = document.createElement('li');
    const last = g.lastMessage;
    const unread = g.unreadCount;
    li.innerHTML = `
      <div class="avatar group-avatar" style="background:${avatarColor(g.name)}">👥</div>
      <div class="chat-meta">
        <div class="chat-name"><span>${esc(g.name)}</span>
          <span class="time">${last ? fmtTime(last.createdAt) : ''}</span></div>
        <div class="chat-preview">
          <span>${groupPreviewText(last)}</span>
          ${unread ? `<span class="unread">${unread}</span>` : ''}
        </div>
      </div>`;
    li.onclick = () => openGroup(g.groupId);
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

// v7.1: new group
$('btn-newgroup').onclick = () => openNewGroupModal();

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

// ---------------------------------------------------------------- v6.9: in-app message search

$('btn-msgsearch').onclick = () => {
  const panel = $('msgsearch-panel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) $('input-msgsearch').focus();
};

let msgSearchTimer = null;
$('input-msgsearch').addEventListener('input', () => {
  clearTimeout(msgSearchTimer);
  msgSearchTimer = setTimeout(runMsgSearch, 300);
});

function highlightMatch(raw, idx, len) {
  if (idx == null || idx < 0 || !len) return esc(String(raw || ''));
  const s = String(raw || '');
  return esc(s.slice(0, idx)) + '<mark>' + esc(s.slice(idx, idx + len)) + '</mark>' + esc(s.slice(idx + len));
}

async function runMsgSearch() {
  const q = $('input-msgsearch').value.trim();
  const ul = $('msgsearch-results');
  ul.innerHTML = '';
  if (q.length < 2) {
    if (q) ul.innerHTML = '<li class="empty">Type at least 2 characters.</li>';
    return;
  }
  ul.innerHTML = '<li class="empty">Searching…</li>';
  try {
    const data = await api('/api/search?q=' + encodeURIComponent(q));
    ul.innerHTML = '';
    if (!data.results || !data.results.length) {
      ul.innerHTML = '<li class="empty">No messages found.</li>';
      return;
    }
    let lastPartner = null;
    for (const r of data.results) {
      if (r.partner !== lastPartner) {
        lastPartner = r.partner;
        const h = document.createElement('li');
        h.className = 'msgsearch-group';
        h.textContent = r.partner;
        ul.appendChild(h);
      }
      const li = document.createElement('li');
      li.className = 'msgsearch-row';
      const kindTag = r.kind === 'audio' ? '🎤 ' : '';
      li.innerHTML = `<span class="msgsearch-snippet">${kindTag}${highlightMatch(r.snippet, r.matchIndex, r.matchLength)}</span>` +
        `<span class="msgsearch-time">${fmtTime(r.createdAt)}</span>`;
      li.onclick = () => {
        $('msgsearch-panel').hidden = true;
        openChatAndJump(r.partnerId, r.partner, r.id);
      };
      ul.appendChild(li);
    }
  } catch {
    ul.innerHTML = '<li class="empty">Search failed — try again.</li>';
  }
}

// Open a chat and scroll to a specific message, paging older history if needed.
async function openChatAndJump(partnerId, username, messageId) {
  await openChat(partnerId, username);
  let guard = 0;
  while (guard++ < 20 && state.active) {
    if (document.querySelector(`.bubble[data-id="${messageId}"]`)) break;
    const msgs = state.active.messages;
    if (!msgs.length) break;
    let more, hasMore = false;
    try {
      const data = await api('/api/messages/' + partnerId + '?before=' + msgs[0].id + '&limit=50');
      more = data.messages || [];
      hasMore = !!data.hasMore;
    } catch { break; }
    if (!more.length) break;
    state.active.messages = more.concat(msgs);
    renderMessages();
    if (!hasMore) break;
  }
  jumpToMessage(messageId);
}

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
  stopVoiceNote();
  state.active = { kind: 'dm', partnerId, username, messages: [] };
  $('convo-name').textContent = username;
  $('messages').innerHTML = '';
  $('btn-export').style.display = '';
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

// v7.1: tap the convo header to open the group info panel (groups only).
$('convo-name').style.cursor = 'pointer';
$('convo-name').onclick = () => {
  if (state.active && state.active.kind === 'group') openGroupPanel();
};

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
    b.className = 'bubble ' + (mine ? 'mine' : 'theirs') + (m.deleted ? ' deleted' : '');
    b.dataset.id = m.id;
    const ticks = mine
      ? `<span class="ticks${m.status === 2 ? ' read' : ''}" data-ticks>${m.status === 0 ? '✓' : '✓✓'}</span>`
      : '';
    const editedTag = m.edited ? '<span class="edited-tag">edited</span>' : '';
    // v7.1: in groups, show the sender's name on other people's bubbles.
    const senderTag = (state.active && state.active.kind === 'group' && !mine && !m.deleted)
      ? `<div class="sender-name" style="color:${avatarColor(m.senderUsername || m.sender || '?')}">${esc(m.senderUsername || m.sender || '?')}</div>`
      : '';
    if (m.deleted) {
      b.innerHTML = `${senderTag}<span class="deleted-text">🚫 This message was deleted</span><span class="meta">${fmtTime(m.createdAt)}${ticks}</span>`;
    } else if (m.kind === 'audio' && m.data) {
      const uid = m.id != null ? m.id : m.tempId;
      b.innerHTML = `${senderTag}${m.body ? esc(m.body) : ''}<div class="voice-row"><button type="button" class="voice-play" data-vplay="${uid}" aria-label="Play voice note">▶</button><div class="voice-track" data-vtrack="${uid}"><div class="voice-fill" data-vfill="${uid}"></div></div><span class="voice-dur">${fmtDur(m.durationSec)}</span></div><span class="meta">${editedTag}${fmtTime(m.createdAt)}${ticks}</span>${reactionPillsHtml(m)}`;
    } else {
      b.innerHTML = `${senderTag}${replyQuoteHtml(m)}${esc(m.body)}<span class="meta">${editedTag}${fmtTime(m.createdAt)}${ticks}</span>${reactionPillsHtml(m)}`;
    }
    wireBubbleReactions(b, m);
    const qb = b.querySelector('.quote-block');
    if (qb) qb.addEventListener('click', (ev) => { ev.stopPropagation(); jumpToMessage(qb.dataset.quote); });
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

// ---------------------------------------------------------------- groups (v7.1)

function findGroup(groupId) {
  return state.groups.find((g) => String(g.groupId) === String(groupId));
}

function groupStatusText(g) {
  const typing = state.groupTyping.get(String(g.groupId));
  if (typing && typing.size) {
    const names = [...typing.keys()].slice(0, 2).join(', ');
    return `${names} typing…`;
  }
  const n = (g.members || []).length;
  return `${n} member${n === 1 ? '' : 's'}`;
}

function refreshGroupHeader() {
  if (!state.active || state.active.kind !== 'group') return;
  const g = findGroup(state.active.groupId) || state.active.group;
  if (!g) return;
  $('convo-name').textContent = '👥 ' + g.name;
  const s = $('convo-status');
  s.textContent = groupStatusText(g);
  s.classList.remove('typing');
}

async function openGroup(groupId) {
  stopVoiceNote();
  let g = findGroup(groupId);
  state.active = { kind: 'group', groupId: String(groupId), groupName: g ? g.name : 'Group', messages: [], group: g || null, myRole: g ? g.myRole : null };
  $('convo-name').textContent = '👥 ' + state.active.groupName;
  $('messages').innerHTML = '';
  $('btn-export').style.display = 'none'; // export is DM-only for now
  show('view-convo');
  refreshGroupHeader();
  try {
    const data = await api('/api/groups/' + encodeURIComponent(groupId) + '/history?limit=50');
    state.active.messages = data.messages || [];
    // refresh group meta (roles may have changed)
    await loadGroups();
    const g2 = findGroup(groupId);
    if (g2 && state.active && state.active.kind === 'group') {
      state.active.group = g2;
      state.active.groupName = g2.name;
      state.active.myRole = g2.myRole;
      $('convo-name').textContent = '👥 ' + g2.name;
    }
    renderMessages();
    markGroupRead();
  } catch (err) {
    $('messages').innerHTML = `<p class="empty">Couldn't load group messages.</p>`;
  }
}

async function markGroupRead() {
  if (!state.active || state.active.kind !== 'group') return;
  const msgs = state.active.messages;
  if (!msgs.length) return;
  const lastId = Math.max(...msgs.map((m) => m.id || 0));
  try {
    await api('/api/groups/' + encodeURIComponent(state.active.groupId) + '/read', {
      method: 'POST',
      body: JSON.stringify({ lastReadMsg: lastId }),
    });
    const g = findGroup(state.active.groupId);
    if (g) g.unreadCount = 0;
    renderChats();
  } catch {}
}

function bumpGroupUnread(groupId, message) {
  let g = findGroup(groupId);
  if (!g) { loadGroups(); return; }
  g.lastMessage = {
    id: message.id,
    sender: message.senderUsername || message.from,
    snippet: message.kind === 'audio' ? '🎤 Voice note' : String(message.body || '').slice(0, 80),
    createdAt: message.createdAt,
  };
  g.unreadCount = (g.unreadCount || 0) + 1;
  // move to top
  state.groups = [g, ...state.groups.filter((x) => x !== g)];
  renderChats();
}

function appendGroupIncoming(m) {
  if (!state.active || state.active.kind !== 'group' ||
      String(state.active.groupId) !== String(m.groupId)) return false;
  state.active.messages.push(m);
  renderMessages();
  markGroupRead();
  return true;
}

// ---- group info panel ----

function closeGroupPanel() {
  const p = $('group-panel');
  if (p) p.remove();
}

function openGroupPanel() {
  if (!state.active || state.active.kind !== 'group') return;
  closeGroupPanel();
  const g = findGroup(state.active.groupId) || state.active.group;
  if (!g) return;
  const isAdmin = state.active.myRole === 'admin' || g.myRole === 'admin';
  const roles = g.memberRoles || {};
  const members = (g.members || []).map((u) => {
    const role = roles[u] || 'member';
    const crown = role === 'admin' ? ' 👑' : '';
    // v7.1: admins see the remove button (server enforces creator-removes-admin).
    const canRemove = isAdmin && u !== state.me.username;
    return `<li class="gmember"><span class="avatar small" style="background:${avatarColor(u)}">${esc(u[0].toUpperCase())}</span>
      <span class="gmember-name">${esc(u)}${crown}</span>
      ${canRemove ? `<button class="link-btn" data-remove="${esc(u)}">Remove</button>` : ''}</li>`;
  }).join('');
  const p = document.createElement('div');
  p.id = 'group-panel';
  p.className = 'modal-overlay';
  p.innerHTML = `
    <div class="modal">
      <div class="modal-head"><h3>${esc(g.name)}</h3>
        <button class="icon-btn" id="gp-close" aria-label="Close">✕</button></div>
      <p class="muted">${esc(g.description || '')}</p>
      <h4>Members (${(g.members || []).length})</h4>
      <ul class="gmember-list">${members}</ul>
      ${isAdmin ? `<div class="row"><input id="gp-add-input" placeholder="Add member by username…" />
        <button id="gp-add-btn" class="btn-small">Add</button></div>` : ''}
      <div class="row"><button id="gp-leave" class="btn-danger">Leave group</button></div>
    </div>`;
  document.body.appendChild(p);
  $('gp-close').onclick = closeGroupPanel;
  p.addEventListener('click', (e) => { if (e.target === p) closeGroupPanel(); });
  p.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.onclick = async () => {
      const u = btn.dataset.remove;
      if (!window.confirm(`Remove ${u} from the group?`)) return;
      try {
        await api('/api/groups/' + encodeURIComponent(g.groupId) + '/remove', {
          method: 'POST', body: JSON.stringify({ username: u }),
        });
        closeGroupPanel();
        await loadGroups();
        openGroupPanel();
      } catch (err) { alert(err.message); }
    };
  });
  const addBtn = $('gp-add-btn');
  if (addBtn) {
    addBtn.onclick = async () => {
      const u = $('gp-add-input').value.trim();
      if (!u) return;
      try {
        const data = await api('/api/groups/' + encodeURIComponent(g.groupId) + '/add', {
          method: 'POST', body: JSON.stringify({ username: u }),
        });
        if (!data.ok || !(data.added || []).length) {
          alert(data.full ? 'Group is full (50 members)' : "Couldn't add " + u);
          return;
        }
        closeGroupPanel();
        await loadGroups();
        openGroupPanel();
      } catch (err) { alert(err.message); }
    };
  }
  $('gp-leave').onclick = async () => {
    if (!window.confirm('Leave this group?')) return;
    try {
      const data = await api('/api/groups/' + encodeURIComponent(g.groupId) + '/leave', { method: 'POST', body: '{}' });
      closeGroupPanel();
      if (data.promoted) alert(`${data.promoted} is now an admin.`);
      state.active = null;
      show('view-chats');
      await loadGroups();
    } catch (err) { alert(err.message); }
  };
}

// ---- new group modal ----

function closeNewGroupModal() {
  const m = $('newgroup-modal');
  if (m) m.remove();
}

function openNewGroupModal() {
  closeNewGroupModal();
  const picked = new Map(); // username -> true
  const m = document.createElement('div');
  m.id = 'newgroup-modal';
  m.className = 'modal-overlay';
  m.innerHTML = `
    <div class="modal">
      <div class="modal-head"><h3>New group</h3>
        <button class="icon-btn" id="ng-close" aria-label="Close">✕</button></div>
      <input id="ng-name" placeholder="Group name…" maxlength="80" />
      <input id="ng-search" type="search" placeholder="Add members — search username…" />
      <div id="ng-chips" class="chips"></div>
      <ul id="ng-results" class="user-list"></ul>
      <button id="ng-create" class="btn-primary">Create group</button>
    </div>`;
  document.body.appendChild(m);
  $('ng-close').onclick = closeNewGroupModal;
  m.addEventListener('click', (e) => { if (e.target === m) closeNewGroupModal(); });

  const renderChips = () => {
    $('ng-chips').innerHTML = [...picked.keys()]
      .map((u) => `<span class="chip">${esc(u)}<button data-unpick="${esc(u)}">✕</button></span>`).join('');
    m.querySelectorAll('[data-unpick]').forEach((b) => {
      b.onclick = () => { picked.delete(b.dataset.unpick); renderChips(); };
    });
  };
  let timer = null;
  $('ng-search').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = e.target.value.trim();
      const ul = $('ng-results');
      ul.innerHTML = '';
      if (!q) return;
      try {
        const data = await api('/api/users?q=' + encodeURIComponent(q));
        for (const u of data.users || []) {
          if (picked.has(u.username)) continue;
          const li = document.createElement('li');
          li.innerHTML = `<span class="avatar small" style="background:${avatarColor(u.username)}">${esc(u.username[0].toUpperCase())}</span><span>${esc(u.username)}</span>`;
          li.onclick = () => { picked.set(u.username, true); renderChips(); e.target.value = ''; ul.innerHTML = ''; };
          ul.appendChild(li);
        }
      } catch {}
    }, 300);
  });
  $('ng-create').onclick = async () => {
    const name = $('ng-name').value.trim();
    if (!name) { alert('Give the group a name.'); return; }
    try {
      const data = await api('/api/groups', {
        method: 'POST',
        body: JSON.stringify({ name, members: [...picked.keys()] }),
      });
      closeNewGroupModal();
      await loadGroups();
      openGroup(data.groupId);
    } catch (err) { alert(err.message); }
  };
  setTimeout(() => $('ng-name').focus(), 50);
}

// ---------------------------------------------------------------- reactions (web)

const REACT_EMOJIS = ['😀', '❤️', '😂', '😮', '😢', '🙏', '👍', '👎'];

function reactionPillsHtml(m) {
  const r = m.reactions || {};
  const keys = Object.keys(r).filter((e) => Array.isArray(r[e]) && r[e].length);
  if (!keys.length) return '';
  return '<div class="react-pills">' + keys.map((e) =>
    `<span class="rpill" data-emoji="${esc(e)}">${esc(e)}<b>${r[e].length}</b></span>`
  ).join('') + '</div>';
}

function wireBubbleReactions(b, m) {
  if (!m || !m.id) return; // optimistic temp message — no id yet
  if (m.deleted) return; // deleted messages have no actions
  b.addEventListener('click', (ev) => {
    if (b.classList.contains('editing')) return;
    const pill = ev.target.closest('.rpill');
    if (pill) reactTo(m, pill.dataset.emoji);
  });
  let lpTimer = null;
  const cancelLp = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
  b.addEventListener('touchstart', () => {
    if (b.classList.contains('editing')) return;
    cancelLp();
    lpTimer = setTimeout(() => { lpTimer = null; showReactPicker(m, b); }, 550);
  }, { passive: true });
  b.addEventListener('touchend', cancelLp);
  b.addEventListener('touchmove', cancelLp);
  b.addEventListener('contextmenu', (ev) => {
    if (b.classList.contains('editing')) return;
    ev.preventDefault();
    showReactPicker(m, b);
  });
}

function showReactPicker(m, b) {
  hideReactPicker();
  const pk = document.createElement('div');
  pk.id = 'react-picker';
  const row = document.createElement('div');
  row.className = 'react-emoji-row';
  for (const e of REACT_EMOJIS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = e;
    btn.onclick = (ev) => { ev.stopPropagation(); reactTo(m, e); };
    row.appendChild(btn);
  }
  pk.appendChild(row);
  if (canEditMessage(m)) {
    const eb = document.createElement('button');
    eb.type = 'button';
    eb.className = 'picker-edit';
    eb.textContent = '✏️ Edit message';
    eb.onclick = (ev) => { ev.stopPropagation(); hideReactPicker(); startInlineEdit(m); };
    pk.appendChild(eb);
  }
  const db = document.createElement('button');
  db.type = 'button';
  db.className = 'picker-delete';
  db.textContent = '🗑️ Delete message';
  db.onclick = (ev) => { ev.stopPropagation(); hideReactPicker(); deleteMessageDialog(m); };
  pk.appendChild(db);
  const rp = document.createElement('button');
  rp.type = 'button';
  rp.className = 'picker-reply';
  rp.textContent = '↩️ Reply';
  rp.onclick = (ev) => { ev.stopPropagation(); hideReactPicker(); startReply(m); };
  pk.appendChild(rp);
  document.body.appendChild(pk);
  const r = b.getBoundingClientRect();
  pk.style.left = Math.max(8, Math.min(window.innerWidth - pk.offsetWidth - 8, r.left)) + 'px';
  pk.style.top = Math.max(8, r.top - pk.offsetHeight - 8) + 'px';
  setTimeout(() => {
    document.addEventListener('click', hideReactPicker, { once: true });
  }, 0);
}

function hideReactPicker() {
  const pk = document.getElementById('react-picker');
  if (pk) pk.remove();
}

// ---------------------------------------------------------------- replies (web, v6.7)

function replyInfoOf(m) {
  if (!m) return null;
  if (m.replyTo && m.replyTo.messageId) {
    return { id: m.replyTo.messageId, sender: m.replyTo.sender || 'user', snippet: m.replyTo.snippet || '' };
  }
  const mine = m.senderId === (state.me && state.me.id);
  return { id: m.id, sender: mine ? 'You' : (m.sender || 'user'), snippet: String(m.body || '').slice(0, 80) };
}

function ensureReplyBar() {
  let bar = document.getElementById('reply-bar');
  if (bar) return bar;
  const form = document.getElementById('form-send');
  bar = document.createElement('div');
  bar.id = 'reply-bar';
  bar.hidden = true;
  form.parentNode.insertBefore(bar, form);
  return bar;
}

function startReply(m) {
  const info = replyInfoOf(m);
  if (!info || !info.id) return;
  state.replyTo = info;
  const bar = ensureReplyBar();
  bar.hidden = false;
  bar.innerHTML = '';
  const q = document.createElement('div');
  q.className = 'reply-quote';
  const nm = document.createElement('div');
  nm.className = 'reply-quote-name';
  nm.textContent = info.sender;
  const sn = document.createElement('div');
  sn.className = 'reply-quote-snippet';
  sn.textContent = info.snippet || '(message)';
  q.appendChild(nm); q.appendChild(sn);
  const x = document.createElement('button');
  x.type = 'button'; x.className = 'reply-cancel'; x.textContent = '✕';
  x.onclick = cancelReply;
  bar.appendChild(q); bar.appendChild(x);
  document.getElementById('input-message').focus();
}

function cancelReply() {
  state.replyTo = null;
  const bar = document.getElementById('reply-bar');
  if (bar) { bar.hidden = true; bar.innerHTML = ''; }
}

function replyQuoteHtml(m) {
  const r = m.replyTo;
  if (!r || !r.messageId) return '';
  const nm = esc(r.sender || 'user');
  const sn = esc(r.snippet || '(message)');
  return `<div class="quote-block" data-quote="${r.messageId}"><div class="quote-name">${nm}</div><div class="quote-snippet">${sn}</div></div>`;
}

function jumpToMessage(id) {
  const el = document.querySelector(`.bubble[data-id="${id}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.add('quote-flash');
  setTimeout(() => el.classList.remove('quote-flash'), 1200);
}

async function reactTo(m, emoji) {
  hideReactPicker();
  try {
    // session cookie authenticates the web UI (server falls back to it)
    const data = await api('/api/message/react', {
      method: 'POST',
      body: JSON.stringify({ messageId: m.id, emoji, scope: msgScope() }),
    });
    m.reactions = data.reactions;
    renderMessages();
  } catch (err) {
    // transient — picker already closed; stay quiet
  }
}

// ---------------------------------------------------------------- edit message (web)

const EDIT_WINDOW_MS = 15 * 60 * 1000;

function canEditMessage(m) {
  return !!(m && m.id && state.me && m.senderId === state.me.id &&
    (!m.kind || m.kind === 'text') && // v6.8: text only — voice notes can't be edited
    (Date.now() - m.createdAt < EDIT_WINDOW_MS));
}

function startInlineEdit(m) {
  const b = document.querySelector(`.bubble[data-id="${m.id}"]`);
  if (!b) return;
  b.classList.add('editing');
  const ta = document.createElement('textarea');
  ta.className = 'edit-box';
  ta.value = m.body;
  const bar = document.createElement('div');
  bar.className = 'edit-bar';
  const save = document.createElement('button');
  save.type = 'button'; save.className = 'edit-save'; save.textContent = 'Save';
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.className = 'edit-cancel'; cancel.textContent = 'Cancel';
  bar.append(save, cancel);
  b.innerHTML = '';
  b.append(ta, bar);
  ta.focus();
  try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch {}
  cancel.onclick = () => renderMessages();
  save.onclick = async () => {
    const text = ta.value.trim();
    if (!text || text.length > 2000) { ta.focus(); return; }
    save.disabled = true;
    try {
      const data = await api('/api/message/edit', {
        method: 'POST',
        body: JSON.stringify({ messageId: m.id, newText: text, scope: msgScope() }),
      });
      m.body = data.newText;
      m.edited = true;
      m.editedAt = data.editedAt;
      renderMessages();
      loadChats(); // chat preview may still show the old text
    } catch (err) {
      save.disabled = false;
      alert(err.message);
    }
  };
}

// ---------------------------------------------------------------- delete message (web)

const DELETE_WINDOW_MS = 48 * 60 * 60 * 1000; // delete-for-everyone: sender only, 48h

function canDeleteEveryone(m) {
  return !!(m && m.id && state.me && m.senderId === state.me.id &&
    (Date.now() - m.createdAt < DELETE_WINDOW_MS));
}

function deleteMessageDialog(m) {
  if (!m || !m.id || m.deleted) return;
  const mine = m.senderId === state.me.id;
  if (mine && canDeleteEveryone(m)) {
    if (window.confirm('Delete this message for everyone?\n\nOK = everyone · Cancel = only for me')) {
      doWebDelete(m, 'everyone');
    } else if (window.confirm('Delete this message for you only?')) {
      doWebDelete(m, 'me');
    }
  } else if (mine) {
    if (window.confirm('Delete-for-everyone has expired for this message (48h).\n\nDelete it for you only?')) {
      doWebDelete(m, 'me');
    }
  } else {
    if (window.confirm('Delete this message for you?\n\nThe other person will still see it.')) {
      doWebDelete(m, 'me');
    }
  }
}

async function doWebDelete(m, mode) {
  try {
    await api('/api/message/delete', {
      method: 'POST',
      body: JSON.stringify({ messageId: m.id, mode, scope: msgScope() }),
    });
    if (mode === 'everyone') {
      m.deleted = true;
      m.body = '🚫 This message was deleted';
      m.reactions = {};
      m.data = null;
    } else {
      state.active.messages = state.active.messages.filter((x) => x.id !== m.id);
    }
    renderMessages();
    loadChats();
    loadGroups();
  } catch (err) {
    alert(err.message);
  }
}

// ---------------------------------------------------------------- voice notes (web, v6.8)

const VOICE_MAX_SEC = 120; // client-side cap: 2 minutes
let voiceAudio = null;
let voicePlayingUid = null;
let recStream = null, recRecorder = null, recChunks = [], recStartTs = 0;
let recTimerInt = null, recMime = '', recStopping = false;

function voicePreview(m) {
  if (!m || m.kind !== 'audio') return null;
  return '🎤 Voice note' + (m.durationSec ? ' (' + fmtDur(m.durationSec) + ')' : '');
}

function playVoiceNote(m, btn) {
  const uid = String(m.id != null ? m.id : m.tempId);
  if (voiceAudio && voicePlayingUid === uid) {
    if (voiceAudio.paused) { voiceAudio.play().catch(() => {}); btn.textContent = '⏸'; }
    else { voiceAudio.pause(); btn.textContent = '▶'; }
    return;
  }
  stopVoiceNote();
  const mime = m.mime || 'audio/mp4';
  voiceAudio = new Audio('data:' + mime + ';base64,' + m.data);
  voicePlayingUid = uid;
  const fill = document.querySelector('[data-vfill="' + uid + '"]');
  voiceAudio.addEventListener('timeupdate', () => {
    if (fill && voiceAudio && voiceAudio.duration) {
      fill.style.width = (voiceAudio.currentTime / voiceAudio.duration * 100) + '%';
    }
  });
  const reset = () => {
    btn.textContent = '▶';
    if (fill) fill.style.width = '0%';
    if (voicePlayingUid === uid) voicePlayingUid = null;
  };
  voiceAudio.addEventListener('ended', reset);
  voiceAudio.addEventListener('error', reset);
  voiceAudio.play().then(() => { btn.textContent = '⏸'; }).catch(() => { btn.textContent = '▶'; voicePlayingUid = null; });
}

function stopVoiceNote() {
  if (voiceAudio) { try { voiceAudio.pause(); } catch {} voiceAudio = null; }
  voicePlayingUid = null;
  document.querySelectorAll('.voice-play').forEach((el) => { el.textContent = '▶'; });
  document.querySelectorAll('.voice-fill').forEach((el) => { el.style.width = '0%'; });
}

function cleanupRec() {
  if (recStream) { recStream.getTracks().forEach((t) => { try { t.stop(); } catch {} }); recStream = null; }
  recRecorder = null;
  recStopping = false;
}

function blobToBase64(blob) {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result || '');
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : '');
    };
    fr.onerror = () => resolve('');
    fr.readAsDataURL(blob);
  });
}

async function startWebRecording() {
  if (!state.active || recRecorder) return;
  if (!window.MediaRecorder || !navigator.mediaDevices) {
    alert('Voice notes are not supported in this browser.');
    return;
  }
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    alert("Couldn't access the microphone.");
    return;
  }
  recChunks = [];
  recMime = '';
  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) recMime = 'audio/webm;codecs=opus';
  else if (MediaRecorder.isTypeSupported('audio/mp4')) recMime = 'audio/mp4';
  try {
    recRecorder = recMime ? new MediaRecorder(recStream, { mimeType: recMime }) : new MediaRecorder(recStream);
  } catch {
    cleanupRec();
    alert("Couldn't start recording.");
    return;
  }
  recStopping = false;
  recRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  recRecorder.onstop = onRecStopped;
  recRecorder.start(250);
  recStartTs = Date.now();
  $('btn-mic').classList.add('recording');
  const input = $('input-message');
  input.disabled = true;
  input.placeholder = '● 0:00 — release to send';
  recTimerInt = setInterval(() => {
    const s = Math.floor((Date.now() - recStartTs) / 1000);
    input.placeholder = '● ' + fmtDur(s) + ' — release to send';
    if (s >= VOICE_MAX_SEC) stopWebRecording(); // auto-stop at 2 minutes
  }, 500);
}

function stopWebRecording() {
  if (!recRecorder || recStopping) return;
  recStopping = true;
  clearInterval(recTimerInt);
  recTimerInt = null;
  try { recRecorder.stop(); } catch { onRecStopped(); }
}

async function onRecStopped() {
  const btn = $('btn-mic');
  if (btn) btn.classList.remove('recording');
  const input = $('input-message');
  if (input) { input.disabled = false; input.placeholder = 'Type a message'; }
  const secs = Math.round((Date.now() - recStartTs) / 1000);
  const chunks = recChunks;
  recChunks = [];
  const mime = recMime;
  cleanupRec();
  if (secs < 1 || !chunks.length) return;
  const b64 = await blobToBase64(new Blob(chunks, { type: mime || 'audio/webm' }));
  if (!b64 || b64.length > 1400000) { // ~1MB decoded cap
    alert('Voice note too long — keep it under 2 minutes.');
    return;
  }
  sendVoiceNote(b64, mime || 'audio/webm', Math.min(secs, VOICE_MAX_SEC));
}

function sendVoiceNote(b64, mime, secs) {
  if (!state.active) return;
  const tempId = 't' + (++state.tempSeq);
  const optimistic = {
    id: null, tempId, senderId: state.me.id, body: '', kind: 'audio',
    data: b64, mime, durationSec: secs, status: 0, createdAt: Date.now(),
  };
  state.active.messages.push(optimistic);
  renderMessages();
  // v7.1: group voice notes ride the group-message frame.
  const payload = (state.active.kind === 'group')
    ? { type: 'group-message', groupId: state.active.groupId, kind: 'audio', data: b64, mime, durationSec: secs, tempId }
    : { type: 'send', to: state.active.partnerId, kind: 'audio', data: b64, mime, durationSec: secs, tempId };
  const ok = wsSend(payload);
  if (!ok) {
    state.active.messages = state.active.messages.filter((m) => m.tempId !== tempId);
    renderMessages();
    alert('Not connected — trying to reconnect…');
  }
}

function wireMicButton() {
  const mic = $('btn-mic');
  if (!mic || mic.dataset.wired) return;
  mic.dataset.wired = '1';
  mic.addEventListener('mousedown', (e) => { e.preventDefault(); startWebRecording(); });
  mic.addEventListener('mouseup', () => stopWebRecording());
  mic.addEventListener('mouseleave', () => stopWebRecording());
  mic.addEventListener('touchstart', (e) => { e.preventDefault(); startWebRecording(); }, { passive: false });
  mic.addEventListener('touchend', (e) => { e.preventDefault(); stopWebRecording(); });
  mic.addEventListener('touchcancel', () => stopWebRecording());
  mic.addEventListener('contextmenu', (e) => e.preventDefault());
  // delegated voice-play clicks (bubbles re-render, so delegation is sturdier)
  $('messages').addEventListener('click', (ev) => {
    const vp = ev.target.closest('.voice-play');
    if (!vp || !state.active) return;
    const uid = vp.dataset.vplay;
    const m = state.active.messages.find(
      (x) => String(x.id) === uid || String(x.tempId) === uid);
    if (m && m.data) { ev.stopPropagation(); playVoiceNote(m, vp); }
  });
}

// --- sending

let typingSent = false;
let typingStopTimer = null;

// v7.1: typing target depends on conversation kind.
function typingPayload(typing) {
  if (!state.active) return null;
  if (state.active.kind === 'group') {
    return { type: 'typing', groupId: state.active.groupId, typing };
  }
  return { type: 'typing', to: state.active.partnerId, typing };
}

$('input-message').addEventListener('input', () => {
  if (!state.active) return;
  if (!typingSent) {
    wsSend(typingPayload(true));
    typingSent = true;
  }
  clearTimeout(typingStopTimer);
  typingStopTimer = setTimeout(() => {
    if (state.active) wsSend(typingPayload(false));
    typingSent = false;
  }, 1500);
});

$('form-send').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('input-message').value.trim();
  if (!text || !state.active) return;
  const tempId = 't' + (++state.tempSeq);
  const replyTo = state.replyTo; // v6.7: may be null
  const optimistic = {
    id: null, tempId, senderId: state.me.id, body: text, status: 0,
    createdAt: Date.now(),
  };
  if (replyTo) optimistic.replyTo = { messageId: replyTo.id, sender: replyTo.sender, snippet: replyTo.snippet, deleted: false };
  state.active.messages.push(optimistic);
  renderMessages();
  $('input-message').value = '';
  cancelReply();
  clearTimeout(typingStopTimer);
  if (typingSent) { wsSend(typingPayload(false)); typingSent = false; }

  // v7.1: group sends use the group-message frame.
  let payload;
  if (state.active.kind === 'group') {
    payload = { type: 'group-message', groupId: state.active.groupId, text, tempId };
  } else {
    payload = { type: 'send', to: state.active.partnerId, text, tempId };
  }
  if (replyTo) payload.replyTo = replyTo.id;
  const ok = wsSend(payload);
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
        loadGroups(); // v7.1
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

    case 'message-reaction': {
      const m = state.active?.messages.find((x) => x.id === msg.messageId);
      if (m) {
        m.reactions = msg.reactions || {};
        renderMessages();
      }
      break;
    }

    case 'message-edited': {
      const m = state.active?.messages.find((x) => x.id === msg.messageId);
      if (m) {
        m.body = msg.newText;
        m.edited = true;
        m.editedAt = msg.editedAt;
        renderMessages();
        loadChats();
        loadGroups(); // v7.1
      }
      break;
    }

    case 'message-deleted': {
      const m = state.active?.messages.find((x) => x.id === msg.messageId);
      if (m) {
        m.deleted = true;
        m.body = '🚫 This message was deleted';
        m.reactions = {};
        m.data = null;
        renderMessages();
        loadChats();
        loadGroups(); // v7.1
      }
      break;
    }

    case 'group-message': {
      // v7.1: live group message
      const m = msg.message;
      const gid = String(msg.groupId || (m && m.groupId) || '');
      const shown = appendGroupIncoming({ ...m, groupId: gid });
      if (!shown) {
        bumpGroupUnread(gid, { ...m, groupId: gid });
      } else {
        loadGroups();
      }
      break;
    }

    case 'error': {
      if (msg.error === 'bad_reply_to' && state.active) {
        // v6.7: server rejected our reply — drop the optimistic bubble.
        state.active.messages = state.active.messages.filter((x) => x.tempId !== msg.tempId);
        renderMessages();
        alert("Couldn't send reply — the quoted message is gone.");
      }
      break;
    }

    case 'typing': {
      // v7.1: group typing carries groupId + fromName.
      if (msg.groupId) {
        const gid = String(msg.groupId);
        if (!state.groupTyping.has(gid)) state.groupTyping.set(gid, new Map());
        const tm = state.groupTyping.get(gid);
        const who = msg.fromName || 'Someone';
        if (tm.has(who)) clearTimeout(tm.get(who));
        if (msg.typing) {
          tm.set(who, setTimeout(() => {
            tm.delete(who);
            refreshGroupHeader();
          }, 4000));
        } else {
          tm.delete(who);
        }
        refreshGroupHeader();
        break;
      }
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

// ---------------------------------------------------------------- status / stories (v7.2)

const STATUS_BGS = [
  'linear-gradient(135deg,#2dd4bf,#8b5cf6)', 'linear-gradient(135deg,#8b5cf6,#ec4899)',
  'linear-gradient(135deg,#0ea5e9,#8b5cf6)', 'linear-gradient(135deg,#2dd4bf,#0ea5e9)',
  'linear-gradient(135deg,#6366f1,#8b5cf6)', 'linear-gradient(135deg,#111122,#2a2a40)',
];
let scBg = 0;
const st = { groups: [], mine: [], viewedIds: new Set() };

function ago(ts) {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

$('btn-status').onclick = () => { show('view-status'); loadStatus(); };
$('btn-back-status').onclick = () => show('view-chats');
$('btn-addstatus').onclick = () => openStatusCreate();

async function loadStatus() {
  try {
    const feed = await api('/api/status/feed');
    const groups = feed.groups || buildGroups(feed.statuses || []);
    st.viewedIds = new Set();
    for (const g of groups) for (const id of (g.viewed || [])) st.viewedIds.add(String(id));
    st.mine = [];
    st.groups = [];
    for (const g of groups) {
      if (g.mine || (state.me && g.userId === state.me.id)) st.mine = g.items;
      else st.groups.push(g);
    }
    renderStatus();
  } catch (e) { /* keep old list on failure */ }
}

function buildGroups(statuses) {
  const map = new Map();
  for (const s of statuses) {
    const key = s.userId;
    if (!map.has(key)) map.set(key, { userId: s.userId, username: s.username, name: s.name, avatar: s.avatar, items: [], viewed: [], mine: false });
    map.get(key).items.push(s);
  }
  return [...map.values()];
}

function statusViewed(id) { return st.viewedIds.has(String(id)); }

function renderStatus() {
  const mr = $('status-mine-row');
  const nm = state.me ? state.me.username : '?';
  mr.innerHTML = `
    <div class="st-avatar mine" style="background:${avatarColor(nm)}">${esc(nm[0].toUpperCase())}<span class="st-plus">+</span></div>
    <div class="st-meta"><b>My status</b><span>${st.mine.length ? st.mine.length + (st.mine.length === 1 ? ' update' : ' updates') : 'Disappears after 24 hours'}</span></div>`;
  mr.onclick = () => {
    if (st.mine.length) openStatusViewer(st.mine, 0, true);
    else openStatusCreate();
  };
  const ul = $('status-list');
  ul.innerHTML = '';
  $('status-empty').hidden = st.groups.length > 0;
  for (const g of st.groups) {
    const unviewed = g.items.some((s) => !statusViewed(s.statusId));
    const li = document.createElement('li');
    li.className = 'st-row';
    li.innerHTML = `
      <div class="st-avatar${unviewed ? ' ring' : ''}" style="background:${avatarColor(g.username || '?')}">${esc((g.username || '?')[0].toUpperCase())}</div>
      <div class="st-meta"><b>${esc(g.username || '?')}</b><span>${g.items.length > 1 ? g.items.length + ' updates · ' : ''}${ago(g.items[0].ts)}</span></div>`;
    li.onclick = () => openStatusViewer(g.items, 0, false);
    ul.appendChild(li);
  }
}

// ---- viewer ----
let sv = { items: [], index: 0, mine: false, timer: null, progress: 0, paused: false };

function openStatusViewer(items, index, mine) {
  sv = { items, index, mine, timer: null, progress: 0, paused: false };
  $('status-viewer').hidden = false;
  $('sv-viewerlist').hidden = true;
  showStatusItem();
}

function closeStatusViewer() {
  clearInterval(sv.timer);
  $('status-viewer').hidden = true;
}

function showStatusItem() {
  clearInterval(sv.timer);
  sv.progress = 0;
  const s = sv.items[sv.index];
  if (!s) { closeStatusViewer(); return; }
  const segs = $('sv-segments');
  segs.innerHTML = '';
  sv.items.forEach((_, i) => {
    const d = document.createElement('div');
    d.className = 'sv-seg' + (i < sv.index ? ' done' : '');
    d.innerHTML = '<div class="sv-fill"></div>';
    segs.appendChild(d);
  });
  $('sv-name').textContent = s.username || '?';
  $('sv-time').textContent = ago(s.ts);
  const body = $('sv-body');
  body.innerHTML = '';
  body.style.background = STATUS_BGS[Number(s.bg) || 0];
  if (s.kind !== 'text' && s.data) {
    const img = document.createElement('img');
    img.src = 'data:image/jpeg;base64,' + s.data;
    img.className = 'sv-img';
    body.appendChild(img);
  }
  if (s.text) {
    const t = document.createElement('div');
    t.className = 'sv-text';
    t.textContent = s.text;
    body.appendChild(t);
  }
  const isMine = sv.mine;
  $('sv-del').hidden = !isMine;
  $('sv-viewers').hidden = !isMine;
  if (isMine) loadViewerCount(s.statusId);
  else api(`/api/status/${s.statusId}/view`, { method: 'POST' }).catch(() => {});
  sv.timer = setInterval(() => {
    if (sv.paused) return;
    sv.progress += 2;
    const fills = segs.querySelectorAll('.sv-seg .sv-fill');
    if (fills[sv.index]) fills[sv.index].style.width = Math.min(100, sv.progress) + '%';
    if (sv.progress >= 100) svNext();
  }, 100);
}

function svNext() {
  if (sv.index + 1 >= sv.items.length) { closeStatusViewer(); loadStatus(); return; }
  sv.index++;
  showStatusItem();
}
function svPrev() {
  if (sv.index <= 0) { sv.progress = 0; return; }
  sv.index--;
  showStatusItem();
}

async function loadViewerCount(id) {
  try {
    const r = await api(`/api/status/${id}/views`);
    $('sv-count').textContent = (r.views || []).length;
  } catch { $('sv-count').textContent = '0'; }
}

$('sv-close').onclick = () => { closeStatusViewer(); loadStatus(); };
let svDownAt = 0, svDownX = 0;
$('sv-body').addEventListener('pointerdown', (e) => { sv.paused = true; svDownAt = Date.now(); svDownX = e.clientX; });
$('sv-body').addEventListener('pointerup', (e) => {
  sv.paused = false;
  // Quick tap (not a hold): left third = previous, otherwise next.
  if (Date.now() - svDownAt < 350) {
    const r = $('sv-body').getBoundingClientRect();
    if (e.clientX - r.left < r.width / 3) svPrev(); else svNext();
  }
});
$('sv-body').addEventListener('pointercancel', () => { sv.paused = false; });

$('sv-viewers').onclick = async (e) => {
  e.stopPropagation();
  const s = sv.items[sv.index];
  const box = $('sv-viewerlist');
  try {
    const r = await api(`/api/status/${s.statusId}/views`);
    const vs = r.views || [];
    box.innerHTML = '<h4>Viewed by</h4>' + (vs.length
      ? vs.map((v) => `<div class="sv-vrow"><b>${esc(v.name || v.username)}</b><span>${ago(v.viewedAt * 1000)}</span></div>`).join('')
      : '<p class="muted">No views yet.</p>');
  } catch { box.innerHTML = '<p class="muted">Could not load views.</p>'; }
  box.hidden = !box.hidden;
};

$('sv-del').onclick = async (e) => {
  e.stopPropagation();
  const s = sv.items[sv.index];
  if (!confirm('Delete this status?')) return;
  try {
    await api(`/api/status/${s.statusId}`, { method: 'DELETE' });
    sv.items.splice(sv.index, 1);
    if (!sv.items.length) { closeStatusViewer(); loadStatus(); return; }
    if (sv.index >= sv.items.length) sv.index = sv.items.length - 1;
    showStatusItem();
    loadStatus();
  } catch (err) { alert('Could not delete: ' + err.message); }
};

// ---- create ----
function openStatusCreate() {
  scBg = 0;
  $('sc-text').value = '';
  $('sc-file').value = '';
  const bgs = $('sc-bgs');
  bgs.innerHTML = '';
  STATUS_BGS.forEach((g, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sc-bg' + (i === 0 ? ' sel' : '');
    b.style.background = g;
    b.onclick = () => { scBg = i; [...bgs.children].forEach((c, j) => c.classList.toggle('sel', j === i)); };
    bgs.appendChild(b);
  });
  $('status-create').hidden = false;
}
$('sc-cancel').onclick = () => { $('status-create').hidden = true; };

$('sc-post').onclick = async () => {
  const btn = $('sc-post');
  btn.disabled = true;
  try {
    const file = $('sc-file').files[0];
    const text = $('sc-text').value.trim();
    let kind = 'text', data = null;
    if (file) {
      data = await fileToStatusImage(file);
      kind = 'image';
    } else if (!text) {
      alert('Type something or pick a photo.');
      btn.disabled = false;
      return;
    }
    await api('/api/status', { method: 'POST', body: JSON.stringify({ kind, text, data, bg: scBg }) });
    $('status-create').hidden = true;
    loadStatus();
  } catch (err) { alert('Could not post: ' + err.message); }
  btn.disabled = false;
};

function fileToStatusImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const max = 1280;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      let q = 0.85, out = c.toDataURL('image/jpeg', q);
      while (out.length * 0.75 > 1024 * 1024 && q > 0.4) { q -= 0.15; out = c.toDataURL('image/jpeg', q); }
      if (out.length * 0.75 > 1024 * 1024) return reject(new Error('Photo is too large (1 MB max).'));
      resolve(out.split(',')[1]);
    };
    img.onerror = () => reject(new Error('Could not read that photo.'));
    img.src = url;
  });
}

// ---------------------------------------------------------------- profile / nav

$('btn-back').onclick = () => { state.active = null; show('view-chats'); loadChats(); };
$('btn-back-profile').onclick = () => show('view-chats');
$('btn-profile').onclick = () => show('view-profile');

// v7.0: chat export — download full DM history as text or JSON (server endpoint).
$('btn-export').onclick = () => {
  if (!state.active) return;
  const pick = prompt('Export chat as:\n1 — Text (.txt)\n2 — JSON (.json)', '1');
  if (pick === null) return;
  const format = String(pick).trim() === '2' ? 'json' : 'text';
  const a = document.createElement('a');
  a.href = `/api/export/chat/${state.active.partnerId}?format=${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
};

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

wireMicButton();
boot();
