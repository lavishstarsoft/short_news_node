'use strict';

// In-memory live presence for the admin "Live Analytics" dashboard. Keyed by
// socket.id. Fed from the existing Socket.IO connection (connect / screen_view /
// disconnect). Purely additive — never touches the news/notification sockets.
// No DB, no persistence: it's a real-time snapshot of who is online right now.

const presence = new Map(); // socketId -> { userId, screen, language, state, district, newsId, connectedAt, lastSeen }
const minuteSeries = [];    // [{ t: minuteEpochMs, online: n }] — last 60 minutes

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

function connect(socketId) {
  presence.set(socketId, {
    userId: null, screen: '', language: '', state: '', district: '', newsId: '',
    connectedAt: Date.now(), lastSeen: Date.now(),
  });
}

function setUser(socketId, userId) {
  const p = presence.get(socketId);
  if (p) p.userId = userId;
}

// The app sends this on every screen change: { screen, language, state, district, newsId }.
function update(socketId, data = {}) {
  let p = presence.get(socketId);
  if (!p) { connect(socketId); p = presence.get(socketId); }
  if (data.screen != null) p.screen = clip(data.screen, 40);
  if (data.language != null) p.language = clip(data.language, 8).toLowerCase();
  if (data.state != null) p.state = clip(data.state, 40);
  if (data.district != null) p.district = clip(data.district, 40);
  p.newsId = clip(data.newsId, 30);
  p.lastSeen = Date.now();
}

function disconnect(socketId) { presence.delete(socketId); }

function top(obj, n) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ k, v }));
}

function snapshot() {
  const now = Date.now();
  const byScreen = {}, byLang = {}, byState = {}, byDistrict = {}, byNews = {};
  let totalSession = 0, withScreen = 0;
  for (const p of presence.values()) {
    if (p.screen) { byScreen[p.screen] = (byScreen[p.screen] || 0) + 1; withScreen++; }
    if (p.language) byLang[p.language] = (byLang[p.language] || 0) + 1;
    if (p.state) byState[p.state] = (byState[p.state] || 0) + 1;
    if (p.district) byDistrict[p.district] = (byDistrict[p.district] || 0) + 1;
    if (p.newsId && p.screen === 'news') byNews[p.newsId] = (byNews[p.newsId] || 0) + 1;
    totalSession += (now - p.connectedAt);
  }
  const online = presence.size;
  return {
    ok: true,
    now,
    online,
    withScreen,          // how many reported a screen (app updated vs older builds)
    avgSessionSec: online ? Math.round(totalSession / online / 1000) : 0,
    byScreen: top(byScreen, 14),
    byLang: top(byLang, 8),
    byState: top(byState, 15),
    byDistrict: top(byDistrict, 15),
    hotNews: top(byNews, 10),
    minuteSeries: minuteSeries.slice(-60),
  };
}

// Compact per-user rows for the advanced dashboard. The dashboard does ALL the
// cross-filtering / drill-down / cross-tabs client-side from these rows, so the
// server stays dumb and cheap. No userId / PII — only coarse screen+geo+session.
// Keys kept short to keep the payload small: s=screen l=lang st=state d=district n=newsId t=sessionSec
function detail(limit = 6000) {
  const now = Date.now();
  const rows = [];
  const newsIdSet = new Set();
  let capped = false;
  for (const p of presence.values()) {
    if (rows.length >= limit) { capped = true; break; }
    rows.push({
      s: p.screen || '',
      l: p.language || '',
      st: p.state || '',
      d: p.district || '',
      n: p.newsId || '',
      t: Math.max(0, Math.round((now - p.connectedAt) / 1000)),
    });
    if (p.newsId) newsIdSet.add(p.newsId);
  }
  return {
    ok: true,
    now,
    online: presence.size,
    capped,
    rows,
    newsIds: Array.from(newsIdSet).slice(0, 60),
    minuteSeries: minuteSeries.slice(-60),
  };
}

// Record the current online count once a minute (for the live graph).
setInterval(() => {
  const t = Math.floor(Date.now() / 60000) * 60000;
  minuteSeries.push({ t, online: presence.size });
  while (minuteSeries.length > 60) minuteSeries.shift();
}, 60000).unref?.();

module.exports = { connect, setUser, update, disconnect, snapshot, detail };
