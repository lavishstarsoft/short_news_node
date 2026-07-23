'use strict';

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Format ms delta as +HH:MM:SS (can exceed 24h). */
function formatTimeDiffLabel(ms) {
  const safe = Math.max(0, Number(ms) || 0);
  const totalSec = Math.floor(safe / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `+${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

function formatTimeDiffHuman(ms) {
  const safe = Math.max(0, Number(ms) || 0);
  const totalSec = Math.floor(safe / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (h) parts.push(`${h} Hour${h === 1 ? '' : 's'}`);
  if (m) parts.push(`${m} Minute${m === 1 ? '' : 's'}`);
  if (s || !parts.length) parts.push(`${s} Second${s === 1 ? '' : 's'}`);
  return parts.join(' ');
}

function formatPublishedParts(date, timeZone = 'Asia/Kolkata') {
  if (!date) {
    return { date: '—', time: '—', iso: null };
  }
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) {
    return { date: '—', time: '—', iso: null };
  }
  const dateStr = d.toLocaleDateString('en-IN', {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });
  const timeStr = d.toLocaleTimeString('en-IN', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
  return { date: dateStr, time: timeStr, iso: d.toISOString() };
}

/**
 * Stable original picker: earliest publishedAt, then smaller newsId string.
 */
function pickOriginalMember(members) {
  const sorted = [...members].sort((a, b) => {
    const ta = new Date(a.publishedAt).getTime();
    const tb = new Date(b.publishedAt).getTime();
    if (ta !== tb) return ta - tb;
    return String(a.newsId).localeCompare(String(b.newsId));
  });
  return sorted[0] || null;
}

module.exports = {
  formatTimeDiffLabel,
  formatTimeDiffHuman,
  formatPublishedParts,
  pickOriginalMember,
};
