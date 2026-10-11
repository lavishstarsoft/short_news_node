'use strict';

/**
 * Sub-Editor Work Report — data collection + PDF rendering.
 *
 * Read-only over News/Admin. Everything is computed in IST (Asia/Kolkata):
 *   - "Posted"      = article created by the sub editor inside the period
 *                     (ObjectId timestamp; publishedAt is refreshed on approval so
 *                     it is NOT the submission time).
 *   - "Published"   = an 'approved' actionHistory entry inside the period, OR a
 *                     posted-in-period article that is live (sub editors self-publish).
 *   - "AI flagged"  = HELD by the AI gate: aiStatus review_required, published anyway,
 *                     or deleted/rejected while flagged (see classifyArticle).
 *   - "Publish anyway" = approved while AI-flagged (metadata.aiOverride, or legacy:
 *                     approved + duplicateCheck flag).
 *   - "Edited"/"Deleted"/"Rejected"/"Sent back"/"Resubmitted" = matching
 *                     actionHistory entries inside the period.
 *
 * PDF: pdfkit, A4 landscape, Noto Sans Telugu for Telugu text. Other Indic
 * scripts use a font from assets/fonts if present (see FONT_FILES), else the
 * title is replaced with a printable marker so the PDF never breaks.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 62;

const TRACKED_ACTIONS = ['approved', 'rejected', 'updated', 'deleted', 'needs_revision', 'resubmitted'];

const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
const FONT_FILES = {
  telugu: { regular: 'NotoSansTelugu-Regular.ttf', bold: 'NotoSansTelugu-Bold.ttf', re: /[ఀ-౿]/ },
  devanagari: { regular: 'NotoSansDevanagari-Regular.ttf', bold: 'NotoSansDevanagari-Bold.ttf', re: /[ऀ-ॿ]/ },
  tamil: { regular: 'NotoSansTamil-Regular.ttf', bold: 'NotoSansTamil-Bold.ttf', re: /[஀-௿]/ },
  kannada: { regular: 'NotoSansKannada-Regular.ttf', bold: 'NotoSansKannada-Bold.ttf', re: /[ಀ-೿]/ },
  malayalam: { regular: 'NotoSansMalayalam-Regular.ttf', bold: 'NotoSansMalayalam-Bold.ttf', re: /[ഀ-ൿ]/ },
  bengali: { regular: 'NotoSansBengali-Regular.ttf', bold: 'NotoSansBengali-Bold.ttf', re: /[ঀ-৿]/ },
  gujarati: { regular: 'NotoSansGujarati-Regular.ttf', bold: 'NotoSansGujarati-Bold.ttf', re: /[઀-૿]/ },
  gurmukhi: { regular: 'NotoSansGurmukhi-Regular.ttf', bold: 'NotoSansGurmukhi-Bold.ttf', re: /[਀-੿]/ },
  odia: { regular: 'NotoSansOriya-Regular.ttf', bold: 'NotoSansOriya-Bold.ttf', re: /[଀-୿]/ },
};

// ---------------------------------------------------------------------------
// Period helpers (IST)
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function istDayStart(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - IST_OFFSET_MS);
}

function istDateStr(date) {
  return new Date(new Date(date).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function istHour(date) {
  return new Date(new Date(date).getTime() + IST_OFFSET_MS).getUTCHours();
}

function fmtIST(d, withTime = true) {
  if (!d) return '—';
  const opts = { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' };
  if (withTime) Object.assign(opts, { hour: '2-digit', minute: '2-digit', hour12: true });
  try { return new Date(d).toLocaleString('en-IN', opts); } catch (_) { return String(d); }
}

/**
 * { date } → that IST day. { from, to } → inclusive IST range (≤ 62 days).
 * Nothing → today (IST). Throws on invalid input.
 */
function resolvePeriod({ date, from, to, now = new Date() } = {}) {
  let start; let end; let label; let days;
  if (from || to) {
    if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) throw new Error('from/to must be YYYY-MM-DD');
    start = istDayStart(from);
    end = new Date(istDayStart(to).getTime() + DAY_MS);
    if (end <= start) throw new Error('to must be on/after from');
    days = Math.round((end - start) / DAY_MS);
    if (days > MAX_RANGE_DAYS) throw new Error(`range too long (max ${MAX_RANGE_DAYS} days)`);
    label = days === 1 ? fmtIST(start, false) : `${fmtIST(start, false)} – ${fmtIST(end - 1, false)}`;
  } else {
    const d = date || istDateStr(now);
    if (!DATE_RE.test(d)) throw new Error('date must be YYYY-MM-DD');
    start = istDayStart(d);
    end = new Date(start.getTime() + DAY_MS);
    days = 1;
    label = fmtIST(start, false);
  }
  return { start, end, label, days, fromStr: istDateStr(start), toStr: istDateStr(end - 1) };
}

// ---------------------------------------------------------------------------
// Classification (pure)
// ---------------------------------------------------------------------------

function createdAtOf(a) {
  if (a && a._id && typeof a._id.getTimestamp === 'function') return a._id.getTimestamp();
  if (a && a.createdAt) return new Date(a.createdAt);
  return a && a.publishedAt ? new Date(a.publishedAt) : null;
}

function statusOf(a) {
  if (a.isDeactivated === true) return 'deleted';
  if (a.isActive === true) return 'published';
  if (a.rejectionStatus && a.rejectionStatus.isRejected) return 'rejected';
  if (a.revisionStatus && a.revisionStatus.needsRevision) return 'sent_back';
  if (a.aiStatus === 'review_required') return 'ai_review';
  if (a.aiStatus === 'processing') return 'ai_processing';
  if (a.aiStatus === 'failed') return 'ai_failed';
  return 'pending';
}

function classifyArticle(a, { start, end }) {
  const createdAt = createdAtOf(a);
  const postedInPeriod = !!createdAt && createdAt >= start && createdAt < end;
  const hist = Array.isArray(a.actionHistory) ? a.actionHistory : [];
  const inRange = (h) => {
    if (!h || !h.performedAt) return false;
    const t = new Date(h.performedAt);
    return t >= start && t < end;
  };
  const pick = (action) => hist.filter((h) => h && h.action === action && inRange(h));
  const approvedH = pick('approved');
  const updatedH = pick('updated');
  const deletedH = pick('deleted');
  const rejectedH = pick('rejected');
  const sentBackH = pick('needs_revision');
  const resubH = pick('resubmitted');

  const dc = a.duplicateCheck || {};
  const dcFlag = dc.isDuplicate === true || dc.isSuspicious === true;
  const overrideH = approvedH.find((h) => h.metadata && h.metadata.aiOverride === true);
  // "AI flagged" = the article was HELD by the AI duplicate gate: still waiting,
  // published anyway, or deleted/rejected while flagged. A duplicateCheck flag on
  // an auto-published article is legacy local-detector noise and is NOT counted.
  const publishedAnyway = !!overrideH || (approvedH.length > 0 && dcFlag);
  const aiFlagged = !!(a.aiStatus === 'review_required' || publishedAnyway ||
    (dcFlag && (a.isDeactivated === true || (a.rejectionStatus && a.rejectionStatus.isRejected === true))));
  // Sub editors self-publish (no 'approved' entry when the AI gate passes), so a
  // posted article that is live also counts as published in this period.
  const publishedInPeriod = approvedH.length > 0 || (postedInPeriod && a.isActive === true);
  const autoRejected = rejectedH.some((h) => h.performedByRole === 'system');
  // Legacy deletes (before history was recorded) have no 'deleted' entry.
  const deletedInPeriod = deletedH.length > 0 || (a.isDeactivated === true && postedInPeriod && deletedH.length === 0);
  const approvedAt = approvedH.length ? new Date(approvedH[approvedH.length - 1].performedAt) : null;
  const minutesToPublish = postedInPeriod && approvedAt && createdAt ? Math.max(0, Math.round((approvedAt - createdAt) / 60000)) : null;

  const firstMatch = Array.isArray(dc.similarArticles) && dc.similarArticles.length ? dc.similarArticles[0] : null;

  return {
    id: String(a._id),
    title: a.title || '',
    language: (a.language || 'te').toLowerCase(),
    category: a.category || 'Uncategorized',
    authorId: String(a.authorId || ''),
    author: a.author || '',
    createdAt,
    hour: createdAt ? istHour(createdAt) : null,
    postedInPeriod,
    status: statusOf(a),
    views: Number(a.views) || 0,
    isVideo: a.mediaType === 'video',
    aiFlagged,
    aiScore: Number(dc.score) || 0,
    matchedTitle: firstMatch ? (firstMatch.articleTitle || firstMatch.title || '') : '',
    matchedAuthor: firstMatch ? (firstMatch.author || firstMatch.authorEmail || firstMatch.authorName || '') : '',
    publishedInPeriod,
    publishedAnyway,
    publishedBy: approvedH.length ? (approvedH[approvedH.length - 1].performedByName || '') : '',
    approvedAt,
    minutesToPublish,
    edits: updatedH.map((h) => ({ by: h.performedByName || '', at: h.performedAt, fields: (h.metadata && h.metadata.changedFields) || [] })),
    deleted: deletedInPeriod,
    deletedBy: deletedH.length ? (deletedH[deletedH.length - 1].performedByName || '') : (deletedInPeriod ? 'Not recorded' : ''),
    deletedAt: deletedH.length ? deletedH[deletedH.length - 1].performedAt : null,
    rejected: rejectedH.length > 0,
    autoRejected,
    rejectedBy: rejectedH.length ? (rejectedH[rejectedH.length - 1].performedByName || '') : '',
    rejectReason: (a.rejectionStatus && a.rejectionStatus.reason) || '',
    sentBack: sentBackH.length > 0,
    resubmitted: resubH.length > 0,
  };
}

function emptyRow(editor) {
  return {
    authorId: String(editor._id),
    name: editor.name || editor.username || 'Unknown',
    username: editor.username || '',
    isActive: editor.isActive !== false,
    languages: new Set(),
    posted: 0, video: 0, published: 0, pendingNow: 0, aiFlagged: 0, publishedAnyway: 0,
    rejected: 0, autoRejected: 0, sentBack: 0, resubmitted: 0, edited: 0, deleted: 0,
    views: 0, byLanguage: {}, byCategory: {}, hours: new Array(24).fill(0),
    publishMinutes: [], firstPost: null, lastPost: null,
  };
}

/** Aggregate classified articles per sub editor + totals + detail lists. */
function aggregate(classified, editors) {
  const rows = new Map();
  editors.forEach((e) => rows.set(String(e._id), emptyRow(e)));
  const totals = { posted: 0, video: 0, published: 0, pendingNow: 0, aiFlagged: 0, publishedAnyway: 0, rejected: 0, autoRejected: 0, sentBack: 0, resubmitted: 0, edited: 0, deleted: 0, views: 0, byLanguage: {}, byCategory: {}, hours: new Array(24).fill(0) };
  const duplicates = []; const edits = []; const deletes = []; const rejects = []; const published = [];

  for (const c of classified) {
    const r = rows.get(c.authorId);
    if (!r) continue;
    const bump = (k, n = 1) => { r[k] += n; totals[k] += n; };
    if (c.postedInPeriod) {
      bump('posted');
      r.languages.add(c.language);
      r.byLanguage[c.language] = (r.byLanguage[c.language] || 0) + 1;
      totals.byLanguage[c.language] = (totals.byLanguage[c.language] || 0) + 1;
      r.byCategory[c.category] = (r.byCategory[c.category] || 0) + 1;
      totals.byCategory[c.category] = (totals.byCategory[c.category] || 0) + 1;
      if (c.hour != null) { r.hours[c.hour] += 1; totals.hours[c.hour] += 1; }
      bump('views', c.views);
      if (c.isVideo) bump('video');
      if (['pending', 'ai_review', 'ai_processing', 'ai_failed', 'sent_back'].includes(c.status)) bump('pendingNow');
      if (c.aiFlagged) { bump('aiFlagged'); duplicates.push(c); }
      if (!r.firstPost || c.createdAt < r.firstPost) r.firstPost = c.createdAt;
      if (!r.lastPost || c.createdAt > r.lastPost) r.lastPost = c.createdAt;
      if (c.minutesToPublish != null) r.publishMinutes.push(c.minutesToPublish);
      if (c.status === 'published') published.push(c);
    }
    if (c.publishedInPeriod) bump('published');
    if (c.publishedAnyway) bump('publishedAnyway');
    if (c.rejected) { bump('rejected'); rejects.push(c); }
    if (c.autoRejected) bump('autoRejected');
    if (c.sentBack) bump('sentBack');
    if (c.resubmitted) bump('resubmitted');
    if (c.edits.length) { bump('edited'); edits.push(c); }
    if (c.deleted) { bump('deleted'); deletes.push(c); }
  }

  const list = [...rows.values()].map((r) => ({
    ...r,
    languages: [...r.languages].sort(),
    duplicateRate: r.posted ? Math.round((r.aiFlagged / r.posted) * 100) : 0,
    avgPublishMinutes: r.publishMinutes.length ? Math.round(r.publishMinutes.reduce((s, x) => s + x, 0) / r.publishMinutes.length) : null,
  }));
  list.sort((a, b) => b.posted - a.posted || b.published - a.published || a.name.localeCompare(b.name));
  list.forEach((r, i) => { r.rank = r.posted > 0 ? i + 1 : null; });

  const topViewed = published.sort((a, b) => b.views - a.views).slice(0, 5);
  const zeroActivity = list.filter((r) => r.isActive && r.posted === 0);
  return { rows: list, totals, duplicates, edits, deletes, rejects, topViewed, zeroActivity };
}

// ---------------------------------------------------------------------------
// Data collection (Mongo)
// ---------------------------------------------------------------------------

const SELECT = '_id title language category authorId author isActive isDeactivated aiStatus publishedAt views mediaType ' +
  'duplicateCheck.isDuplicate duplicateCheck.isSuspicious duplicateCheck.score duplicateCheck.matchCount duplicateCheck.similarArticles ' +
  'rejectionStatus.isRejected rejectionStatus.reason revisionStatus.needsRevision actionHistory';

async function collectData({ News, Admin, mongoose, period, language, authorId, authorIds } = {}) {
  News = News || require('../../models/News');
  Admin = Admin || require('../../models/Admin');
  mongoose = mongoose || require('mongoose');
  const { start, end } = period;

  const editorQuery = { role: 'subeditor' };
  if (authorId) editorQuery._id = authorId;
  else if (Array.isArray(authorIds) && authorIds.length) editorQuery._id = { $in: authorIds };
  const editors = await Admin.find(editorQuery).select('_id name username email isActive workingLanguage allowedLanguages assignedState').sort({ name: 1 }).lean();
  const ids = editors.map((e) => String(e._id));
  if (!ids.length) return { editors, articles: [], ...aggregate([], []), repeatOffenders: [] };

  const oidStart = mongoose.Types.ObjectId.createFromTime(Math.floor(start.getTime() / 1000));
  const oidEnd = mongoose.Types.ObjectId.createFromTime(Math.floor(end.getTime() / 1000));
  const langFilter = language ? { language: String(language).toLowerCase() } : {};

  const posted = await News.find({ authorId: { $in: ids }, _id: { $gte: oidStart, $lt: oidEnd }, ...langFilter })
    .select(SELECT).slice('duplicateCheck.similarArticles', 1).lean();
  const acted = await News.find({
    authorId: { $in: ids }, ...langFilter,
    actionHistory: { $elemMatch: { performedAt: { $gte: start, $lt: end }, action: { $in: TRACKED_ACTIONS } } },
  }).select(SELECT).slice('duplicateCheck.similarArticles', 1).lean();

  const byId = new Map();
  for (const a of [...posted, ...acted]) byId.set(String(a._id), a);
  const classified = [...byId.values()].map((a) => classifyArticle(a, period));
  const agg = aggregate(classified, editors);

  // Repeat offenders: AI-flagged on each of the last 3 IST days ending with the period.
  const lookStart = new Date(end.getTime() - 3 * DAY_MS);
  const lookPeriod = { start: lookStart, end };
  const flagged = (await News.find({
    authorId: { $in: ids },
    _id: { $gte: mongoose.Types.ObjectId.createFromTime(Math.floor(lookStart.getTime() / 1000)), $lt: oidEnd },
    $or: [{ aiStatus: 'review_required' }, { 'duplicateCheck.isDuplicate': true }, { 'duplicateCheck.isSuspicious': true }],
  }).select('_id authorId aiStatus isActive isDeactivated duplicateCheck.isDuplicate duplicateCheck.isSuspicious rejectionStatus.isRejected actionHistory.action actionHistory.performedAt actionHistory.metadata').lean())
    // same strict "held by the AI gate" rule as the main report
    .filter((a) => classifyArticle(a, lookPeriod).aiFlagged);
  const daysByAuthor = new Map();
  for (const f of flagged) {
    const day = istDateStr(f._id.getTimestamp());
    const k = String(f.authorId);
    if (!daysByAuthor.has(k)) daysByAuthor.set(k, new Set());
    daysByAuthor.get(k).add(day);
  }
  const nameOf = new Map(editors.map((e) => [String(e._id), e.name || e.username || 'Unknown']));
  const repeatOffenders = [...daysByAuthor.entries()].filter(([, s]) => s.size >= 3).map(([id, s]) => ({ authorId: id, name: nameOf.get(id) || id, days: s.size }));

  return { editors, articles: classified, ...agg, repeatOffenders };
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

const RED = '#E31E24'; const INK = '#15181C'; const GREY = '#6B7280'; const LINE = '#E5E7EB'; const SOFT = '#F7F7F8';
const PAGE = { w: 841.89, h: 595.28, m: 36 }; // A4 landscape

function registerFonts(doc) {
  const have = {};
  for (const [script, f] of Object.entries(FONT_FILES)) {
    const reg = path.join(FONT_DIR, f.regular); const bold = path.join(FONT_DIR, f.bold);
    if (fs.existsSync(reg)) {
      doc.registerFont(`F_${script}`, reg);
      doc.registerFont(`F_${script}_B`, fs.existsSync(bold) ? bold : reg);
      have[script] = true;
    }
  }
  return have;
}

// Unicode format characters (ZWJ, ZWSP, BOM, bidi marks, soft hyphen…) make
// fontkit's Indic shaper crash ("xCoordinate of null"). ZWNJ (U+200C) is safe
// and meaningful in Telugu, so it is kept.
const FORMAT_CHARS_RE = /[­​‍-‏‪-‮⁠-⁤﻿]/g;

/** Choose a font that can draw `text`; sanitize glyphs no font can draw. */
function fontFor(text, bold, have) {
  const s = String(text || '').replace(FORMAT_CHARS_RE, '');
  for (const [script, f] of Object.entries(FONT_FILES)) {
    if (f.re.test(s)) {
      if (have[script]) return { font: bold ? `F_${script}_B` : `F_${script}`, text: s };
      return { font: bold ? 'Helvetica-Bold' : 'Helvetica', text: `[${script} text — see dashboard]` };
    }
  }
  // Any other non-Latin-1 char would break the standard fonts.
  return { font: bold ? 'Helvetica-Bold' : 'Helvetica', text: s.replace(/₹/g, 'Rs.').replace(/[^\x09\x0A\x0D\x20-\x7E -ÿ–—‘’“”…•→₹]/g, '?') };
}

// Every Indic virama (halant). fontkit's Indic shaper crashes on a few
// conjunct clusters (e.g. Telugu "బ్రిక్స్"); inserting ZWNJ after each virama
// of ONLY the offending word keeps the rest of the title perfectly shaped.
const VIRAMA_RE = /([्্્੍୍்్್്])/g;

/** Returns text that the current doc font can shape without throwing. */
function makeShapeSafe(doc) {
  const ok = (s) => { try { doc.widthOfString(s); return true; } catch (_) { return false; } };
  return (text) => {
    const s = String(text || '');
    if (ok(s)) return s;
    return s.split(/(\s+)/).map((w) => {
      if (!w.trim() || ok(w)) return w;
      const patched = w.replace(VIRAMA_RE, '$1‌');
      if (ok(patched)) return patched;
      return '□'.repeat(Math.min(3, w.length));
    }).join('');
  };
}

function makeReportId(now) {
  const t = new Date(now.getTime() + IST_OFFSET_MS).toISOString().replace(/[-:T]/g, '').slice(0, 12);
  return `SEWR-${t}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

function buildPdf(data, { PDFDocument = require('pdfkit'), period, generatedBy = 'Super Admin', filters = {}, now = new Date() } = {}) {
  // bottom margin 0: pdfkit must NEVER auto-break pages (it would desync our
  // own y-cursor and page headers) — ensure() below owns every page break.
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margins: { top: PAGE.m, left: PAGE.m, right: PAGE.m, bottom: 0 }, bufferPages: true, info: { Title: 'Sub-Editor Work Report', Author: 'Tehelka News' } });
  const have = registerFonts(doc);
  const reportId = makeReportId(now);
  const W = PAGE.w - PAGE.m * 2;
  let y = 0;

  const shapeSafe = makeShapeSafe(doc);
  const wsafe = (s) => { try { return doc.widthOfString(s); } catch (_) { return Infinity; } };

  /** Truncate `s` (font already set) so it fits `w`, appending an ellipsis. Word-wise
   *  so we never slice inside an Indic cluster (which can crash the shaper). */
  const fit = (s, w) => {
    if (wsafe(s) <= w) return s;
    const words = s.split(/(\s+)/);
    let out = '';
    for (const part of words) {
      if (wsafe(out + part + '…') > w) break;
      out += part;
    }
    if (!out.trim()) { // single very long word: fall back to char slicing
      let lo = 0; let hi = s.length;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (wsafe(s.slice(0, mid) + '…') <= w) lo = mid; else hi = mid - 1; }
      out = s.slice(0, lo);
    }
    return out.replace(/\s+$/, '') + '…';
  };

  /** Single-line text that never wraps and never triggers a pdfkit page break. */
  const txt = (text, x, yy, opts = {}, bold = false, size = 9, color = INK) => {
    const f = fontFor(text, bold, have);
    const width = opts.width || (PAGE.w - PAGE.m - x);
    try {
      doc.font(f.font).fontSize(size).fillColor(color);
      doc.text(fit(shapeSafe(f.text), width), x, yy, { width, align: opts.align || 'left', lineBreak: false });
    } catch (e) {
      // A shaping failure must never kill the whole report: draw a safe marker.
      const safe = String(f.text).replace(/[^\x20-\x7E]/g, '?').slice(0, 80) || '[unprintable]';
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(GREY).text(fit(safe, width), x, yy, { width, align: opts.align || 'left', lineBreak: false });
    }
  };

  const header = () => {
    doc.rect(0, 0, PAGE.w, 54).fill(RED);
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(16).text('TEHELKA NEWS', PAGE.m, 14);
    doc.font('Helvetica').fontSize(9.5).fillColor('#ffe3e4').text('Sub-Editor Work Report  •  ' + period.label, PAGE.m, 34);
    doc.font('Helvetica').fontSize(8).fillColor('#ffe3e4').text(reportId, PAGE.w - PAGE.m - 200, 20, { width: 200, align: 'right' });
    doc.fillColor(INK);
    y = 70;
  };
  const ensure = (need) => { if (y + need > PAGE.h - 40) { doc.addPage(); header(); } };
  const h2 = (t) => { ensure(30); doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text(t, PAGE.m, y); y += 18; doc.moveTo(PAGE.m, y).lineTo(PAGE.m + W, y).strokeColor(LINE).lineWidth(0.8).stroke(); y += 8; };
  const note = (t) => {
    const f = fontFor(t, false, have);
    doc.font(f.font).fontSize(8.5);
    const s = shapeSafe(f.text);
    const h = doc.heightOfString(s, { width: W });
    ensure(h + 8);
    doc.fillColor(GREY).text(s, PAGE.m, y, { width: W });
    y += h + 6;
  };

  /** Simple table with single-line ellipsised cells. */
  const table = (columns, rows, { rowH = 15, headBg = '#F3F4F6', fontSize = 8, zebra = true, totalRow = null } = {}) => {
    const totalW = columns.reduce((s, c) => s + c.w, 0);
    const scale = totalW > W ? W / totalW : 1;
    const cols = columns.map((c) => ({ ...c, w: Math.floor(c.w * scale) }));
    const drawHead = () => {
      doc.rect(PAGE.m, y, W, rowH + 2).fill(headBg);
      let x = PAGE.m + 3;
      for (const c of cols) { txt(c.label, x, y + 4, { width: c.w - 6, align: c.align || 'left' }, true, fontSize); x += c.w; }
      y += rowH + 2;
    };
    ensure(rowH * 3);
    drawHead();
    rows.forEach((r, i) => {
      if (y + rowH > PAGE.h - 40) { doc.addPage(); header(); drawHead(); }
      if (zebra && i % 2 === 1) doc.rect(PAGE.m, y, W, rowH).fill(SOFT);
      if (r.__bg) doc.rect(PAGE.m, y, W, rowH).fill(r.__bg);
      let x = PAGE.m + 3;
      for (const c of cols) {
        const v = r[c.key]; const s = v == null ? '—' : String(v);
        txt(s, x, y + 3.5, { width: c.w - 6, align: c.align || 'left' }, !!r.__bold || !!c.bold, fontSize, c.color && c.color(r) ? c.color(r) : INK);
        x += c.w;
      }
      y += rowH;
    });
    if (totalRow) {
      doc.moveTo(PAGE.m, y).lineTo(PAGE.m + W, y).strokeColor(LINE).stroke();
      let x = PAGE.m + 3;
      for (const c of cols) { const v = totalRow[c.key]; if (v != null) txt(String(v), x, y + 4, { width: c.w - 6, align: c.align || 'left' }, true, fontSize); x += c.w; }
      y += rowH + 2;
    }
    y += 8;
  };

  const kpi = (items) => {
    const gap = 8; const bw = (W - gap * (items.length - 1)) / items.length; const bh = 44;
    ensure(bh + 10);
    items.forEach((it, i) => {
      const x = PAGE.m + i * (bw + gap);
      doc.roundedRect(x, y, bw, bh, 6).fill(it.bg || '#FFF4F4');
      doc.font('Helvetica-Bold').fontSize(16).fillColor(it.color || RED).text(String(it.value), x + 8, y + 7, { width: bw - 16 });
      txt(it.label, x + 8, y + 28, { width: bw - 16 }, false, 7.5, GREY);
    });
    y += bh + 12;
  };

  const { rows, totals, duplicates, edits, deletes, rejects, topViewed, zeroActivity, repeatOffenders, editors } = data;
  const langs = Object.keys(totals.byLanguage).sort();
  const langLabel = (c) => c.toUpperCase();

  // ---- Page 1: cover + summary
  header();
  doc.font('Helvetica-Bold').fontSize(18).fillColor(INK).text('Sub-Editor Daily Work Report', PAGE.m, y); y += 24;
  const meta = [
    ['Report period', period.label + (period.days > 1 ? ` (${period.days} days)` : '')],
    ['Generated on', fmtIST(now)],
    ['Generated by', generatedBy],
    ['Filters', [filters.language ? 'Language: ' + langLabel(filters.language) : 'All languages', filters.authorName ? 'Sub editor: ' + filters.authorName : `All sub editors (${editors.length})`].join('  •  ')],
    ['Report ID', reportId],
  ];
  meta.forEach(([k, v]) => { doc.font('Helvetica-Bold').fontSize(9).fillColor(GREY).text(k + ':', PAGE.m, y, { width: 110 }); txt(v, PAGE.m + 110, y, { width: W - 110 }, false, 9); y += 14; });
  y += 6;

  h2('1. Summary (all sub editors)');
  kpi([
    { label: 'News posted', value: totals.posted },
    { label: 'Published', value: totals.published, bg: '#EEF9F1', color: '#15803D' },
    { label: 'Pending now', value: totals.pendingNow, bg: '#FFF8E6', color: '#B45309' },
    { label: 'AI dup flagged', value: totals.aiFlagged, bg: '#FDF2F8', color: '#BE185D' },
    { label: 'Publish anyway', value: totals.publishedAnyway, bg: '#FDF2F8', color: '#BE185D' },
    { label: 'Rejected (auto)', value: `${totals.rejected} (${totals.autoRejected})`, bg: '#FEF2F2', color: '#B91C1C' },
    { label: 'Sent back/Resub', value: `${totals.sentBack}/${totals.resubmitted}` },
    { label: 'Edited (desk)', value: totals.edited, bg: '#EFF6FF', color: '#1D4ED8' },
    { label: 'Deleted', value: totals.deleted, bg: '#FEF2F2', color: '#B91C1C' },
    { label: 'Views (posted)', value: totals.views, bg: '#F3F4F6', color: INK },
  ]);
  const activeCount = rows.filter((r) => r.isActive).length;
  note(`Sub editors: ${activeCount} active • ${rows.filter((r) => r.posted > 0).length} posted at least once • ${zeroActivity.length} posted nothing in this period.`);
  if (langs.length) {
    table(
      [{ key: 'lang', label: 'Language', w: 120 }, { key: 'posted', label: 'Posted', w: 80, align: 'right' }, { key: 'share', label: 'Share', w: 80, align: 'right' }, { key: 'editors', label: 'Sub editors who posted', w: 160, align: 'right' }],
      langs.map((l) => ({ lang: langLabel(l), posted: totals.byLanguage[l], share: Math.round((totals.byLanguage[l] / Math.max(1, totals.posted)) * 100) + '%', editors: rows.filter((r) => r.byLanguage[l]).length })),
      { zebra: true }
    );
  }

  // ---- 2. Per sub editor
  h2('2. Sub editor wise performance');
  const perEditorCols = [
    { key: 'rank', label: '#', w: 22, align: 'right' },
    { key: 'name', label: 'Sub editor', w: 130, bold: true },
    { key: 'langs', label: 'Langs', w: 48 },
    { key: 'posted', label: 'Posted', w: 42, align: 'right' },
    { key: 'published', label: 'Publ.', w: 40, align: 'right' },
    { key: 'pendingNow', label: 'Pend.', w: 40, align: 'right' },
    { key: 'aiFlagged', label: 'AI dup', w: 42, align: 'right', color: (r) => (r.aiFlagged > 0 ? '#BE185D' : null) },
    { key: 'dupRate', label: 'Dup %', w: 42, align: 'right', color: (r) => (parseInt(r.dupRate, 10) >= 30 ? '#B91C1C' : null) },
    { key: 'publishedAnyway', label: 'Pub.any', w: 46, align: 'right' },
    { key: 'rejected', label: 'Rej.', w: 38, align: 'right' },
    { key: 'sentBack', label: 'Sent bk', w: 44, align: 'right' },
    { key: 'edited', label: 'Edited', w: 42, align: 'right' },
    { key: 'deleted', label: 'Deleted', w: 44, align: 'right', color: (r) => (r.deleted > 0 ? '#B91C1C' : null) },
    { key: 'views', label: 'Views', w: 48, align: 'right' },
    { key: 'avgPub', label: 'Avg→pub', w: 50, align: 'right' },
    { key: 'first', label: 'First post', w: 58 },
    { key: 'last', label: 'Last post', w: 58 },
  ];
  const timeOnly = (d) => (d ? new Date(d).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true }) : '—');
  table(perEditorCols, rows.map((r) => ({
    rank: r.rank == null ? '' : r.rank, name: r.name, langs: r.languages.map(langLabel).join(',') || '—',
    posted: r.posted, published: r.published, pendingNow: r.pendingNow, aiFlagged: r.aiFlagged, dupRate: r.posted ? r.duplicateRate + '%' : '—',
    publishedAnyway: r.publishedAnyway, rejected: r.rejected, sentBack: r.sentBack, edited: r.edited, deleted: r.deleted, views: r.views,
    avgPub: r.avgPublishMinutes == null ? '—' : r.avgPublishMinutes + 'm', first: period.days > 1 ? fmtIST(r.firstPost, false) : timeOnly(r.firstPost), last: period.days > 1 ? fmtIST(r.lastPost, false) : timeOnly(r.lastPost),
    __bg: r.posted === 0 && r.isActive ? '#FFF7ED' : null,
  })), { totalRow: { name: 'TOTAL', posted: totals.posted, published: totals.published, pendingNow: totals.pendingNow, aiFlagged: totals.aiFlagged, publishedAnyway: totals.publishedAnyway, rejected: totals.rejected, sentBack: totals.sentBack, edited: totals.edited, deleted: totals.deleted, views: totals.views } });
  note('Posted = submitted in the period (IST). Publ. = approved in the period. AI dup = flagged by the duplicate check. Pub.any = published even though AI flagged it. Avg→pub = average minutes from submission to publish. Rows shaded orange = active sub editor with zero posts.');

  // ---- 3. Language wise
  if (langs.length) {
    h2('3. Language wise — who posted how many');
    const cols = [{ key: 'name', label: 'Sub editor', w: 160, bold: true }, ...langs.map((l) => ({ key: 'L_' + l, label: langLabel(l), w: 60, align: 'right' })), { key: 'total', label: 'Total', w: 60, align: 'right', bold: true }];
    const r2 = rows.filter((r) => r.posted > 0).map((r) => { const o = { name: r.name, total: r.posted }; langs.forEach((l) => { o['L_' + l] = r.byLanguage[l] || 0; }); return o; });
    const tot = { name: 'TOTAL', total: totals.posted }; langs.forEach((l) => { tot['L_' + l] = totals.byLanguage[l] || 0; });
    table(cols, r2, { totalRow: tot });
  }

  // ---- 4. Duplicate details
  h2(`4. AI duplicate flagged articles (${duplicates.length})`);
  if (!duplicates.length) note('No article was flagged by the AI duplicate check in this period.');
  else {
    const decision = (c) => (c.status === 'deleted' ? 'DELETED' : c.publishedAnyway ? 'PUBLISHED ANYWAY' : c.status === 'published' ? 'Published' : c.status === 'rejected' ? 'Rejected' : c.status === 'ai_review' ? 'Waiting review' : c.status.replace('_', ' '));
    table([
      { key: 'time', label: 'Time', w: 62 }, { key: 'name', label: 'Sub editor', w: 100, bold: true }, { key: 'lang', label: 'Lang', w: 32 },
      { key: 'title', label: 'Article title', w: 240 }, { key: 'score', label: 'Score', w: 38, align: 'right' },
      { key: 'matched', label: 'Matched article', w: 190 }, { key: 'mAuthor', label: 'Matched author', w: 110 },
      { key: 'decision', label: 'Decision', w: 90, color: (r) => (r.decision === 'PUBLISHED ANYWAY' ? '#BE185D' : r.decision === 'DELETED' ? '#B91C1C' : null) },
      { key: 'by', label: 'By', w: 80 },
    ], duplicates.map((c) => ({
      time: period.days > 1 ? fmtIST(c.createdAt) : timeOnly(c.createdAt), name: rowName(rows, c.authorId), lang: langLabel(c.language), title: c.title, score: c.aiScore ? c.aiScore + '%' : '—',
      matched: c.matchedTitle || '—', mAuthor: c.matchedAuthor || '—', decision: decision(c), by: c.publishedAnyway ? c.publishedBy : c.status === 'deleted' ? c.deletedBy : c.status === 'rejected' ? c.rejectedBy : '—',
    })), { rowH: 16 });
  }

  // ---- 5. Edits & deletes
  h2(`5. Edited by desk (${edits.length}) and deleted (${deletes.length})`);
  if (!edits.length && !deletes.length) note('No article was edited or deleted in this period.');
  if (edits.length) {
    table([
      { key: 'time', label: 'Edited at', w: 80 }, { key: 'name', label: 'Sub editor (author)', w: 120, bold: true }, { key: 'title', label: 'Article title', w: 300 },
      { key: 'fields', label: 'What changed', w: 140 }, { key: 'by', label: 'Edited by', w: 120 },
    ], edits.flatMap((c) => c.edits.map((e) => ({ time: fmtIST(e.at), name: rowName(rows, c.authorId), title: c.title, fields: e.fields.length ? e.fields.join(', ') : 'saved (no field change)', by: e.by || '—' }))), { rowH: 16 });
  }
  if (deletes.length) {
    table([
      { key: 'time', label: 'Deleted at', w: 80 }, { key: 'name', label: 'Sub editor (author)', w: 120, bold: true }, { key: 'title', label: 'Article title', w: 320 },
      { key: 'why', label: 'State when deleted', w: 120 }, { key: 'by', label: 'Deleted by', w: 120 },
    ], deletes.map((c) => ({ time: c.deletedAt ? fmtIST(c.deletedAt) : '— (not recorded)', name: rowName(rows, c.authorId), title: c.title, why: c.aiFlagged ? 'AI duplicate flagged' : 'Pending', by: c.deletedBy || '—' })), { rowH: 16 });
  }

  // ---- 6. Rejected
  h2(`6. Rejected articles (${rejects.length}; auto-rejected: ${totals.autoRejected})`);
  if (!rejects.length) note('No article was rejected in this period.');
  else table([
    { key: 'name', label: 'Sub editor', w: 120, bold: true }, { key: 'lang', label: 'Lang', w: 34 }, { key: 'title', label: 'Article title', w: 300 },
    { key: 'reason', label: 'Reason', w: 200 }, { key: 'by', label: 'Rejected by', w: 110 },
  ], rejects.map((c) => ({ name: rowName(rows, c.authorId), lang: langLabel(c.language), title: c.title, reason: c.rejectReason || '—', by: c.autoRejected ? 'System (Auto)' : c.rejectedBy || '—' })), { rowH: 16 });

  // ---- 7. Zero activity + repeat offenders
  h2('7. Attention list');
  if (zeroActivity.length) { note('Posted NOTHING in this period (' + zeroActivity.length + '): ' + zeroActivity.map((r) => r.name).join(', ')); } else note('Every active sub editor posted at least one article.');
  if (repeatOffenders.length) note('REPEAT DUPLICATE OFFENDERS — AI flagged on each of the last 3 days: ' + repeatOffenders.map((r) => r.name).join(', '));
  else note('No repeat duplicate offenders (nobody was flagged on all of the last 3 days).');

  // ---- 8. Hour-wise + categories + top viewed
  h2('8. Activity by hour (IST) and categories');
  const maxH = Math.max(1, ...totals.hours);
  const bw = W / 24; const bh = 60; ensure(bh + 30);
  for (let hh = 0; hh < 24; hh++) {
    const v = totals.hours[hh]; const hgt = Math.round((v / maxH) * bh);
    doc.rect(PAGE.m + hh * bw + 2, y + bh - hgt, bw - 4, hgt).fill(v ? RED : LINE);
    doc.font('Helvetica').fontSize(6.5).fillColor(GREY).text(String(hh), PAGE.m + hh * bw, y + bh + 3, { width: bw, align: 'center' });
    if (v) doc.font('Helvetica-Bold').fontSize(6.5).fillColor(INK).text(String(v), PAGE.m + hh * bw, y + bh - hgt - 9, { width: bw, align: 'center' });
  }
  y += bh + 18;
  const cats = Object.entries(totals.byCategory).sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (cats.length) table([{ key: 'cat', label: 'Category', w: 200 }, { key: 'n', label: 'Posted', w: 70, align: 'right' }, { key: 'top', label: 'Top sub editor in this category', w: 260 }], cats.map(([cat, n]) => {
    const top = rows.filter((r) => r.byCategory[cat]).sort((a, b) => b.byCategory[cat] - a.byCategory[cat])[0];
    return { cat, n, top: top ? `${top.name} (${top.byCategory[cat]})` : '—' };
  }));
  if (topViewed.length) {
    h2('9. Top viewed articles posted in this period');
    table([{ key: 'views', label: 'Views', w: 60, align: 'right', bold: true }, { key: 'name', label: 'Sub editor', w: 130, bold: true }, { key: 'lang', label: 'Lang', w: 34 }, { key: 'title', label: 'Article title', w: 520 }],
      topViewed.map((c) => ({ views: c.views, name: rowName(rows, c.authorId), lang: langLabel(c.language), title: c.title })), { rowH: 16 });
  }

  // ---- Filing block
  ensure(90);
  y += 6;
  doc.roundedRect(PAGE.m, y, W, 70, 6).strokeColor(LINE).lineWidth(1).stroke();
  doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text('For office record', PAGE.m + 10, y + 8);
  const sig = ['Prepared by', 'Verified by (Admin Dept)', 'Filed on (date)'];
  sig.forEach((s, i) => { const x = PAGE.m + 10 + i * (W / 3); doc.moveTo(x, y + 50).lineTo(x + W / 3 - 30, y + 50).strokeColor('#9CA3AF').stroke(); doc.font('Helvetica').fontSize(8).fillColor(GREY).text(s, x, y + 54); });
  y += 80;

  // Page numbers
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    txt(`Tehelka News • Sub-Editor Work Report • ${period.label} • ${reportId} • Confidential — internal record`, PAGE.m, PAGE.h - 26, { width: W - 80 }, false, 7.5, GREY);
    txt(`Page ${i - range.start + 1} of ${range.count}`, PAGE.w - PAGE.m - 80, PAGE.h - 26, { width: 80, align: 'right' }, false, 7.5, GREY);
  }
  return { doc, reportId };
}

function rowName(rows, authorId) {
  const r = rows.find((x) => x.authorId === authorId);
  return r ? r.name : authorId;
}

/** Plain JSON summary for the dashboard preview. */
function toSummaryJson(data, period) {
  return {
    period: { label: period.label, from: period.fromStr, to: period.toStr, days: period.days },
    totals: { ...data.totals, hours: undefined },
    rows: data.rows.map((r) => ({ authorId: r.authorId, name: r.name, languages: r.languages, posted: r.posted, published: r.published, pendingNow: r.pendingNow, aiFlagged: r.aiFlagged, duplicateRate: r.duplicateRate, publishedAnyway: r.publishedAnyway, rejected: r.rejected, sentBack: r.sentBack, edited: r.edited, deleted: r.deleted, views: r.views, avgPublishMinutes: r.avgPublishMinutes, isActive: r.isActive })),
    zeroActivity: data.zeroActivity.map((r) => r.name),
    repeatOffenders: data.repeatOffenders,
    counts: { duplicates: data.duplicates.length, edits: data.edits.length, deletes: data.deletes.length, rejects: data.rejects.length },
  };
}

module.exports = {
  resolvePeriod, istDayStart, istDateStr, istHour, fmtIST,
  classifyArticle, aggregate, collectData, buildPdf, toSummaryJson, fontFor, makeShapeSafe, registerFonts, makeReportId,
  FONT_FILES, MAX_RANGE_DAYS, IST_OFFSET_MS,
};
