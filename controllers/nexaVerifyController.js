'use strict';

/**
 * TEHELKA NEXA — Admin-initiated WhatsApp verification assistant (Option A).
 *
 * READ-ONLY w.r.t. production: it reads a News item + resolves its State
 * In-charge (existing resolveReporterStateIncharge), joins NEXA's shadow triage
 * recommendation (read-only), and on "initiate" writes ONLY a NexaTask audit
 * record. It NEVER changes News/approval/rejection/publish/reporter/wallet/tier,
 * and it is NOT a NEXA autonomous action — a human admin triggers it. wa.me deep
 * links only (no WhatsApp Business API; wa.me cannot auto-attach a binary image).
 *
 * Endpoints (all superadmin, route-gated):
 *   GET  /admin/api/nexa/verify/:newsId            → verification data (JSON)
 *   GET  /admin/api/nexa/verify/:newsId/summary    → branded HTML summary page
 *   GET  /admin/api/nexa/verify/:newsId/image?i=   → same-origin image proxy
 *   POST /admin/api/nexa/verify/:newsId/initiate   → audit only (no News write)
 */

const mongoose = require('mongoose');
const { resolveReporterStateIncharge } = require('../utils/editorCoverageHelper');

/** English labels for NEXA shadow recommendations (summary is sent in English). */
const REC_EN = {
  LOW_PRIORITY: 'Low priority — not urgent',
  REVIEW: 'Standard review',
  PRIORITY_REVIEW: 'Priority review — check soon',
  POSSIBLE_DUPLICATE: 'Possible duplicate',
  NEEDS_HUMAN_VERIFICATION: 'Needs human verification',
};

/** Pick the best single news image URL, or null. Pure. */
function pickImage(n) {
  if (!n) return null;
  if (Array.isArray(n.imageUrls) && n.imageUrls.length && n.imageUrls[0]) return n.imageUrls[0];
  if (n.mediaType === 'image' && n.mediaUrl) return n.mediaUrl;
  if (n.imageUrl) return n.imageUrl;
  if (n.thumbnailUrl) return n.thumbnailUrl;
  if (n.mediaUrl && /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(n.mediaUrl)) return n.mediaUrl;
  return null;
}

/** All distinct news image URLs, ordered. Pure. Never returns video files. */
function pickImages(n) {
  if (!n) return [];
  const out = [];
  const push = (u) => { if (u && typeof u === 'string' && !out.includes(u)) out.push(u); };
  if (Array.isArray(n.imageUrls)) n.imageUrls.forEach(push);
  if (n.mediaType === 'image') push(n.mediaUrl);
  push(n.imageUrl);
  if (!out.length && n.thumbnailUrl) push(n.thumbnailUrl);
  if (!out.length && n.mediaUrl && /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(n.mediaUrl)) push(n.mediaUrl);
  return out.filter((u) => /^https?:\/\//i.test(u));
}

/** Mask a phone for audit (store minimal PII): keep last 4 digits. Pure. */
function maskPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length <= 4) return '****';
  return '*'.repeat(Math.max(0, d.length - 4)) + d.slice(-4);
}

/** Normalise an Indian mobile number to wa.me form (digits, +91). Pure.
 *  Returns '' when it cannot form a plausible number. */
function normalizePhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 10) return '91' + d;
  if (d.length === 11 && d.charAt(0) === '0') return '91' + d.slice(1);
  if (d.length === 12 && d.startsWith('91')) return d;
  return d.length >= 10 ? d : '';
}

/** Human-friendly pending duration from a submission timestamp. Pure. */
function computePendingText(from, now) {
  const t0 = new Date(from).getTime();
  const t1 = now != null ? now : Date.now();
  let ms = t1 - t0;
  if (!isFinite(ms) || ms < 0) ms = 0;
  let mins = Math.floor(ms / 60000);
  const days = Math.floor(mins / 1440); mins -= days * 1440;
  const hrs = Math.floor(mins / 60); mins -= hrs * 60;
  const u = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  if (days > 0) return u(days, 'day') + ' ' + u(hrs, 'hour');
  if (hrs > 0) return u(hrs, 'hour') + ' ' + u(mins, 'minute');
  return u(mins, 'minute');
}

/** IST date / time formatters. Pure-ish (Intl). */
function fmtDateIST(d) {
  try { return new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }); }
  catch (_) { return ''; }
}
function fmtTimeIST(d) {
  try { return new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true }); }
  catch (_) { return ''; }
}

/** Absolute dashboard link that opens THIS exact news on the pending-news page.
 *  Honors DASHBOARD_BASE_URL env; otherwise derives from the request host. */
function buildDashboardUrl(req, newsId) {
  let base = (process.env.DASHBOARD_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!base) {
    const host = (req && req.get && req.get('host')) || '';
    const proto = (req && req.protocol) || 'https';
    base = host ? `${proto}://${host}` : '';
  }
  return `${base}/admin/pending-news#article-${newsId}`;
}

/** Read-only join of NEXA's latest shadow triage recommendation for a news id. */
async function resolveNexaForNews(newsId) {
  try {
    const NexaTask = require('../models/NexaTask');
    const t = await NexaTask.findOne({ workflow: 'pending_news_triage', entityId: String(newsId) })
      .sort({ createdAt: -1 })
      .select('action confidence reason createdAt')
      .lean();
    if (!t) return { analyzed: false };
    return {
      analyzed: true,
      recommendation: t.action || null,
      recommendationLabel: REC_EN[t.action] || t.action || null,
      confidence: t.confidence != null ? Math.round(t.confidence * 100) : null,
      reason: t.reason || null,
    };
  } catch (_) {
    return { analyzed: false };
  }
}

async function resolveInchargeForNews(Admin, news) {
  const out = { name: null, phone: null };
  if (!news || !news.authorId) return out;
  try {
    const reporter = await Admin.findById(news.authorId)
      .select('name username assignedStates assignedState assignedDistricts assignedConstituencies assignedLocations location constituency permissions role')
      .lean();
    if (reporter) {
      const r = await resolveReporterStateIncharge(Admin, reporter);
      if (r) { out.name = r.name || null; out.phone = r.mobileNumber || null; }
    }
  } catch (_) { /* leave nulls */ }
  return out;
}

/** GET /admin/api/nexa/verify/:newsId — read-only verification data. */
async function getVerifyData(req, res) {
  try {
    const { newsId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(newsId)) {
      return res.status(400).json({ success: false, error: 'invalid_id', te: 'వార్త ID సరైనది కాదు.' });
    }
    const News = require('../models/News');
    const Admin = require('../models/Admin');
    const news = await News.findById(newsId)
      .select('title author authorId location publishedAt mediaUrl mediaType imageUrl imageUrls thumbnailUrl isActive approvalStatus.isApproved rejectionStatus.isRejected')
      .lean();
    if (!news) return res.status(404).json({ success: false, error: 'news_not_found', te: 'వార్త కనబడలేదు.' });

    const title = news.title || '';
    const image = pickImage(news);
    const images = pickImages(news);
    const [incharge, nexa] = await Promise.all([
      resolveInchargeForNews(Admin, news),
      resolveNexaForNews(newsId),
    ]);
    const submittedAt = news.publishedAt || null;

    return res.json({
      success: true,
      newsId,
      title,
      titleAvailable: !!title,
      reporter: news.author || null,
      state: news.location || null,
      submittedAt,
      submittedDate: submittedAt ? fmtDateIST(submittedAt) : null,
      submittedTime: submittedAt ? fmtTimeIST(submittedAt) : null,
      pendingText: submittedAt ? computePendingText(submittedAt) : null,
      status: 'Pending Human Review',
      nexa,
      imageUrl: image || null,
      imageAvailable: !!image,
      imageCount: images.length,
      dashboardUrl: buildDashboardUrl(req, newsId),
      summaryUrl: `/admin/api/nexa/verify/${newsId}/summary`,
      incharge: {
        name: incharge.name || null,
        phone: incharge.phone || null,
        phoneMasked: maskPhone(incharge.phone),
        phoneAvailable: !!incharge.phone,
      },
    });
  } catch (e) {
    console.error('[NEXA][verify] getVerifyData failed:', e && e.message);
    return res.status(500).json({ success: false, error: 'server_error', te: 'లోపం జరిగింది. మళ్ళీ ప్రయత్నించండి.' });
  }
}

/** GET /admin/api/nexa/verify/:newsId/summary — branded, printable HTML summary. */
async function renderSummaryPage(req, res) {
  try {
    const { newsId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(newsId)) {
      return res.status(400).send('Invalid news id');
    }
    const News = require('../models/News');
    const Admin = require('../models/Admin');
    const news = await News.findById(newsId)
      .select('title author authorId location publishedAt mediaUrl mediaType imageUrl imageUrls thumbnailUrl')
      .lean();
    if (!news) return res.status(404).send('News not found');

    const images = pickImages(news);
    const [incharge, nexa] = await Promise.all([
      resolveInchargeForNews(Admin, news),
      resolveNexaForNews(newsId),
    ]);
    const submittedAt = news.publishedAt || null;

    return res.render('nexa-verify-summary', {
      layout: false,
      newsId: String(newsId),
      title: news.title || 'వార్త',
      reporter: news.author || '—',
      state: news.location || null,
      submittedDate: submittedAt ? fmtDateIST(submittedAt) : '—',
      submittedTime: submittedAt ? fmtTimeIST(submittedAt) : '',
      pendingText: submittedAt ? computePendingText(submittedAt) : '—',
      status: 'Pending Human Review',
      nexa,
      // same-origin proxied image URLs (so html2canvas can bake them into the PNG)
      imageProxyUrls: images.map((_, i) => `/admin/api/nexa/verify/${newsId}/image?i=${i}`),
      imageCount: images.length,
      dashboardUrl: buildDashboardUrl(req, newsId),
      inchargeName: incharge.name || null,
      // Normalised number for the fallback WhatsApp deep-link only (not shown in
      // the card). Empty when not configured → UI hides the chat-open step.
      inchargePhone: normalizePhone(incharge.phone),
      inchargePhoneAvailable: !!incharge.phone,
      generatedTime: fmtDateIST(Date.now()) + ', ' + fmtTimeIST(Date.now()),
    });
  } catch (e) {
    console.error('[NEXA][verify] renderSummaryPage failed:', e && e.message);
    return res.status(500).send('Could not generate verification summary.');
  }
}

/** GET /admin/api/nexa/verify/:newsId/image?i=N — same-origin proxy for THIS
 *  news's own image (SSRF-safe: the URL comes from the News doc, the query only
 *  chooses an index). Read-only; lets html2canvas render the real photo. */
async function streamNewsImage(req, res) {
  try {
    const { newsId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(newsId)) return res.status(400).end();
    const News = require('../models/News');
    const news = await News.findById(newsId)
      .select('mediaUrl mediaType imageUrl imageUrls thumbnailUrl')
      .lean();
    if (!news) return res.status(404).end();

    const imgs = pickImages(news);
    const i = Math.max(0, parseInt(req.query.i, 10) || 0);
    const url = imgs[i];
    if (!url || !/^https?:\/\//i.test(url)) return res.status(404).end();

    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 8000);
    let r;
    try { r = await fetch(url, { signal: ctrl.signal }); }
    finally { clearTimeout(to); }
    if (!r || !r.ok) return res.status(502).end();

    const ct = r.headers.get('content-type') || 'image/jpeg';
    if (!/^image\//i.test(ct)) return res.status(415).end();
    const buf = Buffer.from(await r.arrayBuffer());
    res.set('Content-Type', ct);
    res.set('Cache-Control', 'private, max-age=300');
    res.set('Cross-Origin-Resource-Policy', 'same-origin');
    return res.send(buf);
  } catch (e) {
    return res.status(502).end();
  }
}

/** POST /admin/api/nexa/verify/:newsId/initiate — audit only. NO News write. */
async function initiateVerify(req, res) {
  try {
    const { newsId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(newsId)) {
      return res.status(400).json({ success: false, error: 'invalid_id', te: 'వార్త ID సరైనది కాదు.' });
    }
    const News = require('../models/News');
    const Admin = require('../models/Admin');
    const NexaTask = require('../models/NexaTask');
    const news = await News.findById(newsId).select('title authorId location').lean();
    if (!news) return res.status(404).json({ success: false, error: 'news_not_found', te: 'వార్త కనబడలేదు.' });

    const incharge = await resolveInchargeForNews(Admin, news);

    await NexaTask.create({
      workflow: 'verification_request',
      action: 'whatsapp_verify_initiated',
      entityType: 'news',
      entityId: String(newsId),
      status: 'completed',
      mode: 'live', // a real, human-initiated event (not a shadow recommendation, not a NEXA decision)
      requiresApproval: false,
      reason: 'Admin initiated a WhatsApp verification request to the State In-charge.',
      aiDecision: {
        channel: 'whatsapp',
        newsTitle: news.title || null,
        state: news.location || null,
        recipientName: incharge.name || null,
        recipientMasked: maskPhone(incharge.phone), // minimal PII only
        initiatedById: (req.admin && req.admin.id) || null,
        initiatedByName: (req.admin && (req.admin.username || req.admin.name)) || null,
        status: 'initiated',
      },
    });

    return res.json({ success: true });
  } catch (e) {
    console.error('[NEXA][verify] initiateVerify failed:', e && e.message);
    return res.status(500).json({ success: false, error: 'server_error', te: 'లోపం జరిగింది.' });
  }
}

module.exports = {
  getVerifyData,
  renderSummaryPage,
  streamNewsImage,
  initiateVerify,
  // pure helpers (exported for tests)
  pickImage,
  pickImages,
  maskPhone,
  computePendingText,
  buildDashboardUrl,
  REC_EN,
};
