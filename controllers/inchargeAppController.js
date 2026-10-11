'use strict';

/**
 * API for the "Tehelka Incharge" app (the separate Flutter app State In-Charges
 * install from WhatsApp). Additive — nothing existing calls these.
 *
 * The queue is built from the SAME filter the dashboard's pending page uses
 * (baseTeamQuery + buildPendingNewsFilterForSubEditor), so an In-Charge sees in
 * the app exactly what they see on the web: never more, never less. It returns
 * only the few fields a list needs — no phone/GPS/IP (`postedFrom` is super
 * admin only and is not even selected here).
 */
const mongoose = require('mongoose');
const Admin = require('../models/Admin');
const News = require('../models/News');
const StaffPresence = require('../models/StaffPresence');
const { StaffPresenceLog } = require('../models/StaffPresence');
const {
  buildPendingNewsFilterForSubEditor,
  getManagedReporterIds,
  subEditorHasTeamScope,
  resolveSubEditorNewsTab,
  buildSubEditorTabQuery,
} = require('../utils/editorCoverageHelper');
const { deviceContext } = require('../services/security/deviceContext');
const esc = require('../services/incharge/escalation');
const { isPlaceholderValue } = require('../utils/placeholderValue');
const lateSvc = require('../services/earning/lateApprovalService');
const {
  getDisplayConfigForCode,
  buildNewsLanguageFilter,
  getActiveLanguages,
  getEditorAllowedLanguages,
} = require('../services/languageRegistry');

/**
 * Who may use the app: the people who approve news — Bureau, State In-Charges
 * and Sub-Editors — plus admins who oversee them.
 *
 * Kept in step with AuthService.isAllowed in the app; a test pins the two
 * together. Letting a Sub-Editor in is safe because the queue is scoped by
 * pendingQueryFor(), which is the dashboard's own filter: each person sees
 * exactly what their web page shows them, no more.
 */
function canUseInchargeApp(doc) {
  if (!doc) return false;
  if (doc.role === 'admin' || doc.role === 'superadmin') return true;
  if (doc.role === 'subeditor') return true;
  const d = String(doc.displayRole || '').toLowerCase();
  return d.includes('in-charge') || d.includes('incharge') || d.includes('bureau');
}

/**
 * Every picture on an item, in the order the web preview shows them, with no
 * blanks and no repeats. A video contributes its thumbnail only — the app
 * plays the video itself.
 */
const imagesOf = (n) => {
  const list = [];
  if (n.mediaType === 'video') {
    if (n.thumbnailUrl) list.push(n.thumbnailUrl);
  } else if (n.mediaUrl) {
    list.push(n.mediaUrl);
  }
  if (n.imageUrl) list.push(n.imageUrl);
  if (Array.isArray(n.imageUrls)) list.push(...n.imageUrls);
  return [...new Set(list.map((u) => String(u || '').trim()).filter(Boolean))];
};

const firstImage = (n) => (
  n.mediaType === 'video'
    ? (n.thumbnailUrl || n.imageUrl || '')
    : (n.mediaUrl || n.imageUrl || (Array.isArray(n.imageUrls) ? n.imageUrls[0] : '') || '')
);

/**
 * The fields every queue read needs so the queue clock can be applied.
 */
const CLOCK_SELECT = 'publishedAt revisionStatus.needsRevision revisionStatus.revisionCount revisionStatus.resubmittedAt';

/**
 * Whose turn an item is, and how long it has been THIS person's turn.
 *
 * Two corrections to "minutes since publishedAt", both from live queues:
 *
 *  - An item the In-Charge SENT BACK stays in the pending query (the web shows
 *    it there with a "Needs Revision" badge) but it is waiting on the reporter.
 *    Counting it rang the alarm — and told the office — for work that was not
 *    theirs. It is `waitingOnReporter` and never counts as late.
 *  - A RESENT item keeps its original publishedAt (resubmitNews sets only
 *    resubmittedAt), so the moment a reporter sent a fix back it showed as
 *    hours late and the alarm fired at once. Its clock starts at resubmittedAt:
 *    that is when it became the In-Charge's turn again.
 *
 * The server's own 30-minute late-approval REASON rule is untouched — it still
 * counts from filing (lateApprovalService, on the ObjectId), and the app says
 * so when it asks for the reason.
 */
function queueClock(n, now = new Date()) {
  const rs = n.revisionStatus || {};
  const waitingOnReporter = rs.needsRevision === true;
  const resent = !waitingOnReporter && Number(rs.revisionCount) > 0 && !!rs.resubmittedAt;
  const since = resent ? new Date(rs.resubmittedAt) : (n.publishedAt ? new Date(n.publishedAt) : null);
  return {
    waitingOnReporter,
    resent,
    since,
    minutes: waitingOnReporter || !since ? 0 : esc.minutesWaiting(since, now),
  };
}

/**
 * The queue's numbers for one person — the single source for the alarm
 * (heartbeat), the office monitor and the analytics home, so none of the
 * three can disagree with the others or with the list.
 */
async function queueFigures(adminDoc, selfId) {
  const q = await pendingQueryFor(adminDoc, selfId);
  const rows = await News.find(q).select(CLOCK_SELECT).sort({ publishedAt: 1 }).limit(1000).lean();
  const now = new Date();
  const ages = { under15: 0, from15to30: 0, from30to40: 0, over40: 0 };
  let oldest = 0;
  let count = 0;
  let onReporter = 0;
  for (const r of rows) {
    const c = queueClock(r, now);
    if (c.waitingOnReporter) { onReporter += 1; continue; }
    count += 1;
    if (c.minutes > oldest) oldest = c.minutes;
    if (c.minutes < esc.SOON_MINUTES) ages.under15 += 1;
    else if (c.minutes < esc.ALARM_MINUTES) ages.from15to30 += 1;
    else if (c.minutes < esc.ESCALATE_MINUTES) ages.from30to40 += 1;
    else ages.over40 += 1;
  }
  return { minutes: oldest, count, onReporter, ages };
}

/** The web's duplicate badge label: reasonLabel, else by what matched. */
function duplicateLabel(dc) {
  if (dc.reasonLabel) return String(dc.reasonLabel);
  const src = dc.matchSource || 'content';
  return src === 'image' ? 'Image' : src === 'both' ? 'Image + Content' : 'Content';
}

/**
 * The web's duplicate badge rule: flagged AND there is something to compare
 * against. A flag with no matches is noise and is not shown there either.
 */
function duplicateBadge(dc, lang) {
  const d = dc || {};
  const want = String(lang || '').toLowerCase();
  const all = Array.isArray(d.similarArticles) ? d.similarArticles : [];
  // Same-language only (te↔te, hi↔hi, ta↔ta). A match whose language is unknown
  // (older posts before language was stamped) is kept so nothing regresses.
  const sameLang = want
    ? all.filter((r) => {
        const ml = String((r && r.language) || '').toLowerCase();
        return ml === '' || ml === want;
      })
    : all;
  const matches = sameLang.length;
  const flagged = (d.isDuplicate === true || d.isSuspicious === true) && matches > 0;
  return {
    flagged,
    isDuplicate: flagged && d.isDuplicate === true,
    score: Number(d.score) || 0,
    label: flagged ? duplicateLabel(d) : '',
    matchCount: matches,
  };
}

/**
 * The lateness the SERVER will apply on approval, from the filing time:
 * on_time · same_day_late (reason needed) · day_late (reason needed, and the
 * reporter's earning is held for Super Admin review).
 */
function lateTypeOf(n, now = new Date()) {
  try { return lateSvc.classifyLateness(n._id.getTimestamp(), now).type; } catch (_) { return 'on_time'; }
}

/** What a resubmission changed, as plain field names, from the stored summary. */
function changedFieldsOf(rs) {
  const summary = rs && rs.lastChangeSummary;
  if (summary && typeof summary === 'object' && Array.isArray(summary.changedFields)) {
    return summary.changedFields.map(String);
  }
  return [];
}

/**
 * Which language a given request should be filtered to, copying
 * renderPendingNewsPage exactly.
 *
 * This is NOT cosmetic. A Sub-Editor's dashboard defaults to their own
 * `workingLanguage`, and leaving it out let a Telangana Bureau's phone show 168
 * items — Hindi, Punjabi, Tamil, Gujarati — where their web page showed 29
 * Telugu ones. The extra rows are real (the geography clause in
 * buildPendingNewsFilterForSubEditor matches on `location` as well as author,
 * and it is broad), but they are not this person's work, and an app that
 * disagrees with the dashboard is worse than useless.
 *
 * `'all'` clears the filter, the same word the web page's dropdown uses.
 */
function languageFor(adminDoc, requested) {
  if (requested === undefined || requested === null || requested === '') {
    return adminDoc.role === 'subeditor' && adminDoc.workingLanguage
      ? adminDoc.workingLanguage
      : '';
  }
  return requested === 'all' ? '' : String(requested);
}

/**
 * The pending-news query for one person — identical to renderPendingNewsPage's
 * team query. Shared by the list and by the alarm check, because the app must
 * never ring for something the list does not show.
 *
 * [options.language] follows the dashboard: omitted means the person's own
 * working language, `'all'` means every language, a code means that one.
 * Language is a VIEW filter, not a permission — a Sub-Editor may switch it on
 * the web — so reading ONE item deliberately passes `'all'` (see newsDetail):
 * the team and geography scope still decides what they may open.
 */
async function pendingQueryFor(adminDoc, selfId, options = {}) {
  const privileged = adminDoc.role === 'admin' || adminDoc.role === 'superadmin';
  const baseTeamQuery = {
    isActive: false,
    aiStatus: { $in: privileged ? ['none', 'processing', 'review_required', 'failed'] : ['none'] },
    authorId: { $ne: String(selfId) },
    isDeactivated: { $ne: true },
    $or: [
      { 'rejectionStatus.isRejected': { $ne: true } },
      { rejectionStatus: { $exists: false } },
    ],
  };

  // No cache refresh here, deliberately: the registry is primed at boot
  // (server.js → languageRegistry.refreshCache) and renderPendingNewsPage does
  // not refresh either. Adding one would put a database round trip on every
  // queue load and still not match the page this is meant to mirror.
  const language = languageFor(adminDoc, options.language);
  const query = language
    ? { $and: [baseTeamQuery, buildNewsLanguageFilter(language)] }
    : baseTeamQuery;
  return buildPendingNewsFilterForSubEditor(Admin, adminDoc, query);
}

/** GET /admin/api/incharge/pending — the news waiting for this In-Charge, oldest first. */
exports.pending = async (req, res) => {
  try {
    const adminDoc = await Admin.findById(req.admin.id)
      .select('role workingLanguage permissions displayRole assignedState assignedStates assignedDistricts isActive')
      .lean();
    if (!adminDoc || adminDoc.isActive === false) return res.status(401).json({ error: 'Signed out.' });
    // Enforced HERE, not in the app: the client check only spares a reporter a
    // pointless sign-in.
    if (!canUseInchargeApp(adminDoc)) return res.status(403).json({ error: 'This app is for Bureau, State In-Charges and Sub-Editors.' });

    const query = await pendingQueryFor(adminDoc, req.admin.id, {
      language: req.query && req.query.language,
    });

    const rows = await News.find(query)
      .select('_id title content category location language author authorId publishedAt mediaUrl mediaType thumbnailUrl imageUrl imageUrls ' +
              'revisionStatus.needsRevision revisionStatus.revisionCount revisionStatus.resubmittedAt revisionStatus.remarks ' +
              'duplicateCheck.isDuplicate duplicateCheck.isSuspicious duplicateCheck.score duplicateCheck.matchSource ' +
              'duplicateCheck.reasonLabel duplicateCheck.similarArticles.articleId duplicateCheck.similarArticles.language')
      .sort({ publishedAt: 1 })
      .limit(300)
      .lean();
    const now = new Date();

    const authorIds = [...new Set(rows.map((n) => n.authorId).filter(Boolean).map(String))];
    const authors = authorIds.length
      ? await Admin.find({ _id: { $in: authorIds } }).select('name username').lean()
      : [];
    const nameOf = new Map(authors.map((a) => [String(a._id), a.name || a.username || '']));

    res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      news: rows.map((n) => ({
        id: String(n._id),
        title: n.title || '',
        content: String(n.content || '').slice(0, 280),
        category: n.category || '',
        location: n.location || '',
        language: n.language || '',
        authorName: nameOf.get(String(n.authorId)) || n.author || '',
        authorId: String(n.authorId || ''),
        postedAt: n.publishedAt,
        imageUrl: firstImage(n),
        isVideo: n.mediaType === 'video',
        // The tags on each card — the web's own badge rules — and the queue
        // clock (see queueClock) so the list colours match the alarm.
        ...(() => {
          const c = queueClock(n, now);
          const rs = n.revisionStatus || {};
          return {
            waitingSince: c.since,
            waitingOnReporter: c.waitingOnReporter,
            resent: c.resent,
            revisionCount: Number(rs.revisionCount) || 0,
            // The In-Charge's own send-back note. Sent for BOTH states now: while
            // it is with the reporter ("You asked: …") and after they resend it
            // ("You had asked: …"), so a resent card shows what the fix was for.
            sentBackRemarks: String(rs.remarks || ''),
          };
        })(),
        filedAt: (() => { try { return n._id.getTimestamp(); } catch (_) { return null; } })(),
        lateType: lateTypeOf(n, now),
        duplicate: duplicateBadge(n.duplicateCheck, n.language),
        noCategory: isPlaceholderValue(n.category),
        noLocation: isPlaceholderValue(n.location),
      })),
    });
  } catch (e) {
    console.error('incharge pending failed:', e.message);
    res.status(500).json({ error: 'Could not load the queue.' });
  }
};

/**
 * What THIS person is allowed to do — the app asks once after signing in and
 * hides the buttons they do not have.
 *
 * The buttons are a convenience, never the gate: every action the app offers
 * goes to an endpoint that checks the same permission again server-side. The
 * flags mirror the dashboard's pending page exactly — there, Approve, Save,
 * Reject and Send-back are all gated by the SINGLE `canApproveNews` flag
 * (views/pending-news.ejs, `canApproveNewsJs`), not by canEditNews, so a
 * person sees the same buttons in both places.
 */
function capabilitiesFor(doc) {
  const privileged = doc.role === 'admin' || doc.role === 'superadmin';
  const p = doc.permissions || {};
  return {
    // Approve / Save changes / Reject / Send back on a PENDING item.
    canApprove: privileged || p.canApproveNews === true,
    // Editing an already-published item (the News List page, a later phase).
    canEditPublished: privileged || p.canEditNews === true,
    canSendNotifications: privileged || p.canSendNotifications === true,
  };
}

/**
 * Title/content limits for one language, matching what updatePendingNews
 * enforces (getDisplayConfigForCode). Falls back to generous numbers rather
 * than blocking an edit if the registry is unavailable.
 */
function limitsFor(language) {
  try {
    const c = getDisplayConfigForCode(language || 'te') || {};
    return {
      titleMax: Number(c.titleMax) || 0,
      contentMax: Number(c.contentMax) || 0,
      contentMin: Number(c.contentMin) || 0,
    };
  } catch (_) {
    return { titleMax: 0, contentMax: 0, contentMin: 0 };
  }
}

/**
 * Every section of the dashboard, in sidebar order, with the app's own name
 * for it and whether this build can open it.
 *
 * `inApp: false` is not a placeholder to be quietly dropped — the owner asked
 * that the phone show the SAME options a person gets at news.tehelkanews.in,
 * so a section they have on the web is listed here even when the app can only
 * point at the website. Hiding it would be the app deciding what they may do.
 */
const MENU = [
  { key: 'dashboard', label: 'Home', icon: 'home', inApp: true, path: '' },
  { key: 'pendingNews', label: 'Pending news', icon: 'inbox', inApp: true, path: '' },
  { key: 'assignReporters', label: 'Assign reporters', icon: 'person_add', inApp: true, path: '/admin/my-district-assignments' },
  { key: 'reporterAccess', label: 'Reporter access', icon: 'key', inApp: true, path: '/admin/reporter-access' },
  { key: 'coverageMap', label: 'Coverage map', icon: 'map', inApp: true, path: '/admin/coverage-map' },
  { key: 'addNews', label: 'Add news', icon: 'add_circle', inApp: true, path: '/admin/add-news' },
  { key: 'newsList', label: 'News list', icon: 'list', inApp: true, path: '/news-list' },
  { key: 'rejectedNews', label: 'Rejected news', icon: 'block', inApp: true, path: '/admin/rejected-news' },
  { key: 'plagiarismReport', label: 'Plagiarism report', icon: 'copy', inApp: true, path: '/admin/plagiarism-report' },
  { key: 'viralVideos', label: 'Viral videos', icon: 'movie', inApp: true, path: '/admin/viral-videos' },
  { key: 'longVideos', label: 'Long videos', icon: 'video', inApp: false, path: '/admin/long-videos' },
  { key: 'polls', label: 'Polls', icon: 'poll', inApp: false, path: '/admin/polls' },
  { key: 'zodiac', label: 'Zodiac', icon: 'star', inApp: false, path: '/admin/zodiac' },
  { key: 'categories', label: 'Categories', icon: 'category', inApp: false, path: '/admin/categories' },
  { key: 'programCategories', label: 'Program categories', icon: 'category', inApp: false, path: '/admin/program-categories' },
  { key: 'locations', label: 'Locations', icon: 'place', inApp: false, path: '/admin/locations' },
  { key: 'reports', label: 'Reports', icon: 'chart', inApp: false, path: '/admin/reports' },
  // Not a sidebar switch on the web: "Send Notification" appears there for an
  // admin, or for a Sub-Editor with permissions.canSendNotifications
  // (views/partials/sidebar.ejs, `canSendNotif`). menuFor applies that rule.
  { key: 'sendNotification', label: 'Send notification', icon: 'campaign', inApp: true, path: '/admin/notifications' },
];

/**
 * The headings the web sidebar files each section under, in the web's order,
 * so a person finds things in the same place on both.
 */
const MENU_GROUPS = [
  ['Main', ['dashboard', 'assignReporters', 'reporterAccess', 'coverageMap']],
  ['News & Content', ['addNews', 'newsList', 'pendingNews', 'rejectedNews', 'plagiarismReport']],
  ['Media', ['viralVideos', 'longVideos', 'polls', 'zodiac']],
  ['Categories & Regions', ['categories', 'programCategories', 'locations']],
  ['Reports', ['reports']],
  ['Tools', ['sendNotification']],
];
const GROUP_OF = new Map(MENU_GROUPS.flatMap(([g, keys]) => keys.map((k) => [k, g])));
const GROUP_ORDER = MENU_GROUPS.map(([g]) => g);

/**
 * The sidebar rule from views/partials/sidebar.ejs, copied exactly.
 *
 * An admin sees everything. For a Sub-Editor an unset flag means VISIBLE — the
 * switches were added later, so existing people must not lose menu entries by
 * default — except `zodiac`, which is off unless explicitly turned on.
 */
function canSeeMenu(doc, key) {
  if (!doc) return false;
  if (doc.role !== 'subeditor') return true;
  const sidebar = doc.permissions && doc.permissions.sidebar;
  if (!sidebar) return key !== 'zodiac';
  if (key === 'zodiac') return sidebar.zodiac === true;
  return sidebar[key] !== false;
}

/**
 * "Assign reporters" is the one entry with a second condition on the web: it
 * appears only for someone who actually holds a state.
 */
function isStateIncharge(doc) {
  if (!doc) return false;
  if (doc.displayRole === 'State In-Charge') return true;
  if (Array.isArray(doc.assignedStates) && doc.assignedStates.length) return true;
  return !!doc.assignedState;
}

/** This server's public origin, for the menu entries that open the website. */
function publicWebBase(req) {
  const env = String(process.env.PUBLIC_BASE_URL || process.env.DASHBOARD_BASE_URL || '').trim();
  if (env) return env.replace(/\/+$/, '');
  const host = (req && req.get && req.get('host')) || '';
  return host ? `${(req && req.protocol) || 'https'}://${host}` : '';
}

function menuFor(doc) {
  const canNotify = capabilitiesFor(doc).canSendNotifications;
  return MENU.filter((m) => {
    if (m.key === 'sendNotification') return canNotify;
    if (m.key === 'assignReporters' && !isStateIncharge(doc)) return false;
    return canSeeMenu(doc, m.key);
  })
    .map((m) => ({ key: m.key, label: m.label, icon: m.icon, inApp: m.inApp, path: m.path, group: GROUP_OF.get(m.key) || 'Main' }))
    // Grouped in the web sidebar's order; within a group, the MENU order.
    .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
}

/** GET /admin/api/incharge/me — who am I, and which buttons should I see? */
exports.me = async (req, res) => {
  try {
    const doc = await Admin.findById(req.admin.id)
      .select('name username role displayRole permissions workingLanguage isActive ' +
              'assignedState assignedStates assignedDistricts mobileNumber')
      .lean();
    if (!doc || doc.isActive === false) return res.status(401).json({ error: 'Signed out.' });
    if (!canUseInchargeApp(doc)) {
      return res.status(403).json({ error: 'This app is for Bureau, State In-Charges and Sub-Editors.' });
    }
    res.json({
      ok: true,
      id: String(doc._id),
      name: doc.name || doc.username || '',
      role: doc.role,
      displayRole: doc.displayRole || '',
      language: doc.workingLanguage || '',
      ...capabilitiesFor(doc),
      // The same sections this person gets at news.tehelkanews.in.
      menu: menuFor(doc),
      // Where a web-only section lives. Same derivation as the notification
      // studio's publicBaseUrl: the environment wins, otherwise the host this
      // very request arrived on — which IS the host the app is talking to.
      webBase: publicWebBase(req),
    });
  } catch (e) {
    console.error('incharge me failed:', e.message);
    res.status(500).json({ error: 'Could not load your profile.' });
  }
};

/**
 * GET /admin/api/incharge/news/:id — everything needed to judge ONE item.
 *
 * The list deliberately carries a 280-character teaser and one picture; nobody
 * should approve on that. This returns the full text, every picture, the AI
 * duplicate verdict and whether the reporter has revised it — so the decision
 * is made on the whole story, exactly as on the web preview.
 *
 * Scoped the same way as the list: the item must still be IN this person's
 * queue. Someone else's news, or news already approved, is a 404 rather than a
 * peek. `postedFrom` (phone / GPS / IP) is never selected — super admin only.
 */
exports.newsDetail = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Bad id.' });

    const adminDoc = await Admin.findById(req.admin.id)
      .select('role workingLanguage permissions displayRole assignedState assignedStates assignedDistricts isActive')
      .lean();
    if (!adminDoc || adminDoc.isActive === false) return res.status(401).json({ error: 'Signed out.' });
    if (!canUseInchargeApp(adminDoc)) {
      return res.status(403).json({ error: 'This app is for Bureau, State In-Charges and Sub-Editors.' });
    }

    const scope = await pendingQueryFor(adminDoc, req.admin.id, { language: 'all' });
    const n = await News.findOne({ ...scope, _id: id })
      .select('_id title content category location language author authorId publishedAt ' +
              'mediaUrl mediaType thumbnailUrl imageUrl imageUrls videoUrl ' +
              'readFullLink ePaperLink duplicateCheck revisionStatus aiStatus postedPlace')
      .lean();
    // Gone from the queue is the common case, not an error: somebody else
    // approved it while this phone was showing the list.
    if (!n) return res.status(404).json({ error: 'This news is no longer in your queue.' });

    let authorName = n.author || '';
    if (n.authorId) {
      const a = await Admin.findById(n.authorId).select('name username mobileNumber').lean();
      if (a) authorName = a.name || a.username || authorName;
    }

    const dc = n.duplicateCheck || {};
    // Same-language only (te↔te, hi↔hi, ta↔ta), matching duplicateBadge — a flag
    // with no SAME-LANGUAGE match to show is not a flag.
    const detailLang = String(n.language || '').toLowerCase();
    const matches = (Array.isArray(dc.similarArticles) ? dc.similarArticles : []).filter((r) => {
      const ml = String((r && r.language) || '').toLowerCase();
      return !detailLang || ml === '' || ml === detailLang;
    });
    const flagged = (dc.isDuplicate === true || dc.isSuspicious === true) && matches.length > 0;

    res.json({
      ok: true,
      news: {
        id: String(n._id),
        title: n.title || '',
        content: n.content || '',                 // FULL text, not the teaser
        category: n.category || '',
        location: n.location || '',
        // The full place the reporter searched and picked (village → district),
        // display-only. Absent on web posts / older app versions.
        postedPlace: (() => {
          const p = n.postedPlace || {};
          const parts = [p.name, p.mandal, p.district, p.state].map((x) => String(x || '').trim()).filter(Boolean);
          const seen = new Set(); const clean = [];
          for (const x of parts) { const k = x.toLowerCase(); if (!seen.has(k)) { seen.add(k); clean.push(x); } }
          return { name: p.name || '', mandal: p.mandal || '', district: p.district || '', state: p.state || '', type: p.type || '', full: clean.join(' · ') };
        })(),
        language: n.language || '',
        authorName,
        postedAt: n.publishedAt,
        minutesWaiting: esc.minutesWaiting(n.publishedAt),
        images: imagesOf(n),
        // The separate fields behind that merged list. An edit has to put the
        // new picture back in the field it came from: update-pending accepts
        // `mediaUrl` and `imageUrls` but NOT the legacy singular `imageUrl`, so
        // the app needs to see which is which rather than guess.
        mediaUrl: n.mediaType === 'video' ? '' : String(n.mediaUrl || ''),
        legacyImageUrl: String(n.imageUrl || ''),
        imageUrls: Array.isArray(n.imageUrls)
          ? n.imageUrls.map((u) => String(u || '').trim()).filter(Boolean)
          : [],
        videoUrl: n.mediaType === 'video' ? (n.mediaUrl || n.videoUrl || '') : '',
        isVideo: n.mediaType === 'video',
        readFullLink: n.readFullLink || '',
        ePaperLink: n.ePaperLink || '',
        duplicate: {
          flagged,
          isDuplicate: dc.isDuplicate === true,
          score: Number(dc.score) || 0,
          matchCount: matches.length,
        },
        revisionCount: Number(n.revisionStatus && n.revisionStatus.revisionCount) || 0,
        // lastChangeSummary is an OBJECT ({round, changedFields, fields}); the
        // first version sent it raw and the app printed it as text. Now: the
        // field names, and a readable line for older app builds.
        changedFields: changedFieldsOf(n.revisionStatus),
        lastChangeSummary: changedFieldsOf(n.revisionStatus).length
          ? `Changed: ${changedFieldsOf(n.revisionStatus).join(', ')}`
          : '',
        authorId: String(n.authorId || ''),
        filedAt: (() => { try { return n._id.getTimestamp(); } catch (_) { return null; } })(),
        lateType: lateTypeOf(n),
        ...(() => {
          const c = queueClock(n);
          const rs = n.revisionStatus || {};
          return {
            waitingSince: c.since,
            waitingOnReporter: c.waitingOnReporter,
            resent: c.resent,
            sentBackRemarks: String(rs.remarks || ''),
            sentBackBy: String(rs.sentBackBy || ''),
            resubmittedAt: rs.resubmittedAt || null,
          };
        })(),
        duplicateLabel: duplicateBadge(n.duplicateCheck).label,
        // The same per-language limits update-pending enforces. Sent so the
        // app can stop the typing at the limit instead of letting somebody
        // write a long correction and only then be refused.
        limits: limitsFor(n.language),
      },
    });
  } catch (e) {
    console.error('incharge news detail failed:', e.message);
    res.status(500).json({ error: 'Could not load this news.' });
  }
};

/**
 * The scope the dashboard's Rejected News and Plagiarism pages use —
 * adminController.buildAnalyticsScopeFilter, copied here line for line.
 *
 * Copied rather than required: adminController pulls in node-fetch (ESM),
 * which stops this controller's test suite from loading at all. A test reads
 * the original from adminController.js and asserts the two still agree.
 */
async function analyticsScopeFor(adminDoc) {
  const role = adminDoc && adminDoc.role;
  if (role === 'superadmin' || role === 'admin') return {};
  const selfId = String(adminDoc._id || adminDoc.id);
  if (role === 'editor') return { authorId: selfId };
  const perms = adminDoc.permissions || {};
  if (perms.canViewAllNews) return {};
  const orClauses = [{ authorId: selfId }];
  const reporterIds = await getManagedReporterIds(Admin, adminDoc);
  if (reporterIds && reporterIds.length) orClauses.push({ authorId: { $in: reporterIds } });
  return { $or: orClauses };
}

/**
 * Combines a person's scope with a page's own condition WITHOUT letting one
 * `$or` overwrite the other. `{ ...scope, $or: [...] }` looks harmless and
 * silently drops the scope whenever the scope is itself an `$or` — which for a
 * Sub-Editor it always is. A test caught exactly that on the plagiarism list:
 * every flagged article in the system, not just their team's.
 */
function withinScope(scope, condition) {
  if (!scope || !Object.keys(scope).length) return condition;
  return { $and: [scope, condition] };
}

/** Loads the caller, refusing the signed-out and anyone the app is not for. */
async function loadCaller(req, res, select) {
  const doc = await Admin.findById(req.admin.id).select(select).lean();
  if (!doc || doc.isActive === false) { res.status(401).json({ error: 'Signed out.' }); return null; }
  if (!canUseInchargeApp(doc)) {
    res.status(403).json({ error: 'This app is for Bureau, State In-Charges and Sub-Editors.' });
    return null;
  }
  return doc;
}

const NEWS_CARD_SELECT = '_id title content category location language author authorId publishedAt ' +
  'mediaUrl mediaType thumbnailUrl imageUrl imageUrls isActive isDeactivated views likes ' +
  'rejectionStatus approvalStatus revisionStatus aiStatus duplicateCheck readFullLink ePaperLink sourceLink scope';

function newsCard(n, nameOf) {
  const rs = n.rejectionStatus || {};
  const dc = n.duplicateCheck || {};
  return {
    id: String(n._id),
    title: n.title || '',
    teaser: String(n.content || '').slice(0, 200),
    category: n.category || '',
    location: n.location || '',
    language: n.language || '',
    scope: n.scope || 'state',
    authorId: String(n.authorId || ''),
    authorName: (nameOf && nameOf.get(String(n.authorId))) || n.author || '',
    postedAt: n.publishedAt,
    imageUrl: firstImage(n),
    isVideo: n.mediaType === 'video',
    // The same four states the web list distinguishes.
    status: rs.isRejected ? 'rejected'
      : n.isActive ? 'active'
        : n.isDeactivated ? 'inactive'
          : 'pending',
    views: Number(n.views) || 0,
    likes: Number(n.likes) || 0,
    aiStatus: n.aiStatus || 'none',
    duplicateFlagged: dc.isDuplicate === true || dc.isSuspicious === true,
    rejection: rs.isRejected ? {
      reason: rs.reason || '',
      feedback: rs.feedback || '',
      by: rs.rejectedBy || '',
      at: rs.rejectedAt || null,
    } : null,
    readFullLink: n.readFullLink || '',
    ePaperLink: n.ePaperLink || '',
    sourceLink: n.sourceLink || '',
  };
}

async function namesFor(rows) {
  const ids = [...new Set(rows.map((n) => n.authorId).filter(Boolean).map(String))];
  const authors = ids.length ? await Admin.find({ _id: { $in: ids } }).select('name username').lean() : [];
  return new Map(authors.map((a) => [String(a._id), a.name || a.username || '']));
}

/**
 * GET /admin/api/incharge/news-list
 *
 * The News List page as JSON — the web page is server-rendered and the only
 * JSON route (`/news/api/news`) returns a person's OWN articles, never the
 * team's. Mirrors renderNewsListPage: the same two tabs ("My articles" /
 * "Team reporters"), the same status meanings, the same 21 per page, and the
 * same rule for which tab opens first.
 */
exports.newsList = async (req, res) => {
  try {
    const doc = await loadCaller(req, res, 'name username role displayRole workingLanguage permissions isActive');
    if (!doc) return;
    const q = req.query || {};
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const limit = 21;
    const selfId = String(doc._id);

    let query = {};
    const search = String(q.search || '').trim();
    if (search) query.title = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const status = String(q.status || '');
    if (status === 'active') query.isActive = true;
    else if (status === 'inactive') { query.isActive = false; query['rejectionStatus.isRejected'] = { $ne: true }; query.isDeactivated = true; }
    else if (status === 'pending') { query.isActive = false; query['rejectionStatus.isRejected'] = { $ne: true }; query.isDeactivated = { $ne: true }; }
    else if (status === 'rejected') query['rejectionStatus.isRejected'] = true;

    let tab = String(q.tab || '');
    let hasTeamScope = false;
    let counts = null;
    const privileged = doc.role === 'admin' || doc.role === 'superadmin';

    if (!privileged && !(doc.permissions && doc.permissions.canViewAllNews)) {
      hasTeamScope = subEditorHasTeamScope(doc);
      const reporterIds = await getManagedReporterIds(Admin, doc);
      tab = await resolveSubEditorNewsTab(Admin, News, doc, tab || undefined);
      if (!hasTeamScope && tab === 'team-list') tab = 'my-list';
      const tabQuery = buildSubEditorTabQuery(tab, selfId, reporterIds);
      query = Object.keys(query).length ? { $and: [query, tabQuery] } : tabQuery;
      const [mine, team] = await Promise.all([
        News.countDocuments({ authorId: selfId }),
        reporterIds === null
          ? News.countDocuments({ authorId: { $ne: selfId } })
          : (reporterIds.length ? News.countDocuments({ authorId: { $in: reporterIds.filter((id) => id !== selfId) } }) : 0),
      ]);
      counts = { myList: mine, teamList: team };
    } else {
      tab = tab === 'team-list' ? 'team-list' : 'my-list';
      if (tab === 'my-list') query.authorId = selfId;
      hasTeamScope = true;
    }

    const language = String(q.language || '');
    if (language && language !== 'all') {
      const lf = buildNewsLanguageFilter(language);
      query = Object.keys(query).length ? { $and: [query, lf] } : lf;
    }

    const [total, rows] = await Promise.all([
      News.countDocuments(query),
      News.find(query).select(NEWS_CARD_SELECT).sort({ publishedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ]);
    const nameOf = await namesFor(rows);
    const caps = capabilitiesFor(doc);

    res.json({
      ok: true,
      tab,
      hasTeamScope,
      counts,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      total,
      // The same rule the web page applies to its Edit button: admins and
      // canEditNews may edit anything; everyone may edit their OWN unless it
      // was rejected. Sent per row so the app draws the button only when the
      // server would honour it.
      news: rows.map((n) => {
        const card = newsCard(n, nameOf);
        const own = String(n.authorId) === selfId;
        card.canEdit = caps.canEditPublished || (own && card.status !== 'rejected');
        return card;
      }),
    });
  } catch (e) {
    console.error('incharge news-list failed:', e.message);
    res.status(500).json({ error: 'Could not load the news list.' });
  }
};

/**
 * GET /admin/api/incharge/rejected
 *
 * Rejected news for this person's scope, with the reason and the feedback the
 * reporter was given. Read-only here on purpose: on the web, reverting is
 * Super Admin only and deleting needs a shared password, so a Bureau's phone
 * offers exactly what their browser does — a look, not a lever.
 */
exports.rejected = async (req, res) => {
  try {
    const doc = await loadCaller(req, res, 'role displayRole permissions isActive');
    if (!doc) return;
    const q = req.query || {};
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const limit = 20;
    const scope = await analyticsScopeFor(doc);
    let query = withinScope(scope, { 'rejectionStatus.isRejected': true });
    const search = String(q.search || '').trim();
    if (search) {
      const rx = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      query = { $and: [query, { $or: [{ title: rx }, { author: rx }] }] };
    }
    const [total, rows] = await Promise.all([
      News.countDocuments(query),
      News.find(query).select(NEWS_CARD_SELECT).sort({ 'rejectionStatus.rejectedAt': -1, publishedAt: -1 })
        .skip((page - 1) * limit).limit(limit).lean(),
    ]);
    const nameOf = await namesFor(rows);
    res.json({ ok: true, page, totalPages: Math.max(1, Math.ceil(total / limit)), total, news: rows.map((n) => newsCard(n, nameOf)) });
  } catch (e) {
    console.error('incharge rejected failed:', e.message);
    res.status(500).json({ error: 'Could not load rejected news.' });
  }
};

/**
 * GET /admin/api/incharge/plagiarism
 *
 * The Plagiarism Report: every article in scope the AI flagged, most recent
 * first, with the verdict alongside. The web's per-article
 * `/api/duplicate-details/:id` is NOT scoped — any signed-in account can read
 * any article's verdict by id — so the app does not use it; the stored
 * matches are returned here, inside the same scope as the list.
 */
exports.plagiarism = async (req, res) => {
  try {
    const doc = await loadCaller(req, res, 'role displayRole permissions isActive');
    if (!doc) return;
    const scope = await analyticsScopeFor(doc);
    const rows = await News.find(withinScope(scope, {
      $or: [{ 'duplicateCheck.isDuplicate': true }, { 'duplicateCheck.isSuspicious': true }],
    })).select(NEWS_CARD_SELECT).sort({ publishedAt: -1 }).limit(300).lean();
    const nameOf = await namesFor(rows);
    res.json({
      ok: true,
      news: rows.map((n) => {
        const dc = n.duplicateCheck || {};
        const matches = Array.isArray(dc.similarArticles) ? dc.similarArticles : [];
        return {
          ...newsCard(n, nameOf),
          verdict: dc.isDuplicate ? 'duplicate' : 'similar',
          score: Number(dc.score) || 0,
          reasonLabel: dc.reasonLabel || '',
          matchCount: matches.length,
          matches: matches.slice(0, 5).map((m) => ({
            title: String(m.articleTitle || ''),
            author: String(m.author || ''),
            publishedAt: m.publishedAt || null,
            overallPct: Number((m.similarity && m.similarity.overall) || 0),
          })),
        };
      }),
      duplicates: rows.filter((n) => n.duplicateCheck && n.duplicateCheck.isDuplicate).length,
      similar: rows.filter((n) => n.duplicateCheck && n.duplicateCheck.isSuspicious && !n.duplicateCheck.isDuplicate).length,
    });
  } catch (e) {
    console.error('incharge plagiarism failed:', e.message);
    res.status(500).json({ error: 'Could not load the plagiarism report.' });
  }
};

/**
 * GET /admin/api/incharge/news-form
 *
 * Everything the Add / Edit News form needs to offer the SAME choices the web
 * form offers this person: their allowed languages, allowed scopes, posting
 * states and districts, whether a source link is compulsory, the per-language
 * length limits, the categories, and the state → district → constituency tree.
 * The tree is 3,000+ rows, so it is cached for five minutes.
 */
const FORM_CACHE_MS = 5 * 60e3;
let formTreeCache = null;

exports.newsForm = async (req, res) => {
  try {
    const doc = await loadCaller(req, res,
      'role displayRole workingLanguage allowedLanguages allowedScopes permissions isActive assignedState assignedStates assignedDistricts');
    if (!doc) return;

    if (!formTreeCache || Date.now() - formTreeCache.at > FORM_CACHE_MS) {
      const Category = require('../models/Category');
      const Location = require('../models/Location');
      const [cats, tree] = await Promise.all([
        Category.find({ type: { $ne: 'program' }, isActive: { $ne: false } }).select('name order').sort({ order: 1, name: 1 }).lean(),
        Location.getHierarchy(),
      ]);
      formTreeCache = {
        at: Date.now(),
        categories: [...new Set(cats.map((c) => String(c.name || '').trim()).filter(Boolean))],
        states: tree.map((st) => ({
          name: st.name,
          districts: (st.districts || []).map((d) => ({
            name: d.name,
            constituencies: (d.constituencies || []).map((c) => c.name),
          })),
        })),
      };
    }

    const active = getActiveLanguages();
    const allowedCodes = getEditorAllowedLanguages(doc, active);
    const languages = active
      .filter((l) => allowedCodes.includes(String(l.code).toLowerCase()))
      .map((l) => ({ code: l.code, name: l.name }));
    const limits = {};
    for (const l of languages) limits[l.code] = limitsFor(l.code);

    res.json({
      ok: true,
      languages,
      defaultLanguage: doc.workingLanguage || (languages[0] && languages[0].code) || 'te',
      allowedScopes: (doc.allowedScopes && doc.allowedScopes.length)
        ? doc.allowedScopes
        : ['state', 'district', 'national', 'international'],
      postingStates: [...new Set([...(doc.assignedStates || []), doc.assignedState].filter(Boolean))],
      postingDistricts: doc.assignedDistricts || [],
      requiresSourceLink: !!(doc.permissions && doc.permissions.requiresSourceLink),
      // A Sub-Editor's post goes through the AI gate unless it was switched
      // off for them; the form says which so nobody wonders where it went.
      aiGate: doc.role === 'subeditor' && !(doc.permissions && doc.permissions.aiCheckEnabled === false),
      limits,
      categories: formTreeCache.categories,
      states: formTreeCache.states,
    });
  } catch (e) {
    console.error('incharge news-form failed:', e.message);
    res.status(500).json({ error: 'Could not load the form.' });
  }
};

/**
 * GET /admin/api/incharge/my-work?days=N
 *
 * What THIS person has actually done — approved, rejected, sent back, edited —
 * and how long they kept news waiting on average.
 *
 * The equivalent web report is Super Admin only, which means the people being
 * measured cannot see their own numbers. That is the wrong way round: the
 * whole point of the 30-minute alarm is that it should rarely fire, and
 * somebody can only work at that if they can see how they are doing.
 *
 * Bounded by `publishedAt`, which is indexed, and then filtered in memory on
 * actionHistory — the same shape services/reports/subEditorWorkReport uses,
 * because `actionHistory.performedById` has no index of its own and a scan
 * would be a heavy thing to hang off a phone.
 */
const MAX_REPORT_DAYS = 31;

/**
 * Every article on which THIS person took an action since [since], read with
 * the filter pushed into MongoDB so only their documents travel.
 *
 * Two branches, each on an index:
 *  - their team's articles (`authorId` is indexed) — catches rejections and
 *    send-backs, which leave `publishedAt` alone;
 *  - anything published since [since] — catches every approval, because
 *    approveNews RESETS `publishedAt` to the moment of approval ("so it
 *    becomes latest"), which also catches approvals of location-matched news
 *    whose author is outside the team.
 * The first version scanned an arbitrary 8,000 of ~35,000 recent articles and
 * reported a floor as a total; this one needs no cap.
 */
async function articlesActedOnBy(doc, me, since) {
  const acted = { actionHistory: { $elemMatch: { performedById: me, performedAt: { $gte: since } } } };
  const privileged = doc.role === 'admin' || doc.role === 'superadmin';
  let teamIds = null;
  if (!privileged) {
    try { teamIds = await getManagedReporterIds(Admin, doc); } catch (_) { teamIds = []; }
  }
  const branches = [{ publishedAt: { $gte: since } }];
  if (Array.isArray(teamIds) && teamIds.length) branches.push({ authorId: { $in: [...teamIds, me] } });
  const query = { $and: [{ $or: branches }, acted] };
  return News.find(query).select('_id authorId category location actionHistory rejectionStatus').lean();
}

/**
 * When the reporter actually filed the article. NOT `publishedAt`: approval
 * overwrites that with the approval time, which is how the first version of
 * this report showed an average wait of 0 minutes for 284 approvals. The
 * ObjectId's own timestamp is the filing moment — the same clock
 * lateApprovalService uses to decide whether a delay reason is required, so
 * the app's numbers and the server's 30-minute rule agree.
 */
function filedAt(n) {
  try { return n._id.getTimestamp(); } catch (_) { return null; }
}

/** One person's decisions, bucketed; shared by my-work and the analytics home. */
function tallyDecisions(rows, me, since) {
  const counts = { approved: 0, rejected: 0, sentBack: 0, edited: 0 };
  const waits = [];
  const perDay = new Map();   // 'YYYY-MM-DD' (IST) → { approved, rejected, sentBack, waitTotal, waitCount }
  const day = (d) => istDay(d);
  for (const n of rows) {
    const history = Array.isArray(n.actionHistory) ? n.actionHistory : [];
    for (const h of history) {
      if (String(h.performedById || '') !== me) continue;
      const at = h.performedAt ? new Date(h.performedAt) : null;
      if (!at || at < since) continue;
      const key = day(at);
      const bucket = perDay.get(key) || { approved: 0, rejected: 0, sentBack: 0, waitTotal: 0, waitCount: 0 };
      switch (h.action) {
        case 'approved': {
          counts.approved += 1;
          bucket.approved += 1;
          const filed = filedAt(n);
          if (filed && at > filed) {
            const mins = Math.round((at - filed) / 60000);
            waits.push(mins);
            bucket.waitTotal += mins;
            bucket.waitCount += 1;
          }
          break;
        }
        case 'rejected': counts.rejected += 1; bucket.rejected += 1; break;
        case 'needs_revision': counts.sentBack += 1; bucket.sentBack += 1; break;
        case 'updated': counts.edited += 1; break;
        default: break;
      }
      perDay.set(key, bucket);
    }
  }
  waits.sort((a, b) => a - b);
  const avg = waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : 0;
  const median = waits.length ? waits[Math.floor(waits.length / 2)] : 0;
  return { counts, averageMinutes: avg, medianMinutes: median, slowestMinutes: waits.length ? waits[waits.length - 1] : 0, perDay };
}

/** 'YYYY-MM-DD' in India time — a "day" means the reporter's day, not UTC's. */
function istDay(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
}

/** Midnight today in India time, as a Date. */
function istMidnight(offsetDays = 0) {
  const ymd = istDay(new Date(Date.now() - offsetDays * 864e5));
  return new Date(`${ymd}T00:00:00.000+05:30`);
}

/**
 * GET /admin/api/incharge/analytics?days=7|30
 *
 * The home screen as an analytics dashboard. The web dashboard gives a
 * Sub-Editor number cards only (total / live / pending / rejected / today /
 * views); the charts there are Super Admin only. This returns those same
 * cards plus the series and breakdowns the app draws:
 *
 *  - right now: the queue and how much of it is late (same query as the
 *    queue and the alarm, so the three can never disagree);
 *  - today and the chosen range: my approvals / rejections / send-backs and
 *    the real wait (filing time from the ObjectId — see filedAt);
 *  - per day: team news filed, my decisions, my average wait;
 *  - breakdowns of team news by category and district, top reporters,
 *    reporters who have gone silent for 7 days, and rejection reasons.
 *
 * Every read is scoped (team author ids, or the web's own analytics scope for
 * the status cards) and sits on an index (`authorId`, `_id`, `publishedAt`).
 * One person's answer is cached for three minutes: the home screen is opened
 * often and the numbers move in minutes, not seconds.
 */
const ANALYTICS_CACHE_MS = 3 * 60e3;
const analyticsCache = new Map(); // `${id}:${days}` → { at, payload }

function resetAnalyticsCache() { analyticsCache.clear(); }

/** Every IST day from [since] to today, oldest first, as 'YYYY-MM-DD'. */
function istDaysSince(since) {
  const out = [];
  const today = istDay(new Date());
  for (let t = since.getTime(); ; t += 864e5) {
    const d = istDay(new Date(t));
    if (!out.includes(d)) out.push(d);
    if (d === today || out.length > 40) break;
  }
  return out;
}

exports.analytics = async (req, res) => {
  try {
    const doc = await loadCaller(req, res,
      'name username role displayRole workingLanguage permissions isActive assignedState assignedStates assignedDistricts');
    if (!doc) return;
    const days = Number(req.query && req.query.days) === 30 ? 30 : 7;
    const me = String(doc._id);
    const key = `${me}:${days}`;
    const hit = analyticsCache.get(key);
    if (hit && Date.now() - hit.at < ANALYTICS_CACHE_MS) return res.json(hit.payload);

    const privileged = doc.role === 'admin' || doc.role === 'superadmin';
    let teamIds = null;
    if (!privileged) {
      try { teamIds = await getManagedReporterIds(Admin, doc); } catch (_) { teamIds = []; }
    }
    const teamMatch = teamIds === null ? {} : { authorId: { $in: teamIds } };
    const since = istMidnight(days - 1);
    const sinceOid = mongoose.Types.ObjectId.createFromTime(Math.floor(since.getTime() / 1000));
    const weekOid = mongoose.Types.ObjectId.createFromTime(Math.floor((Date.now() - 7 * 864e5) / 1000));
    const todayKey = istDay(new Date());
    const hasTeam = teamIds === null || teamIds.length > 0;

    const [statusAgg, teamAgg, acted, queueNow, rejectAgg, activeAuthors] = await Promise.all([
      // The web home's own cards, over the web's own analytics scope.
      analyticsScopeFor(doc).then((scope) => News.aggregate([
        { $match: scope },
        { $group: {
          _id: null,
          total: { $sum: 1 },
          live: { $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] } },
          rejected: { $sum: { $cond: [{ $eq: ['$rejectionStatus.isRejected', true] }, 1, 0] } },
          hidden: { $sum: { $cond: [{ $and: [{ $ne: ['$isActive', true] }, { $eq: ['$isDeactivated', true] }, { $ne: ['$rejectionStatus.isRejected', true] }] }, 1, 0] } },
          pending: { $sum: { $cond: [{ $and: [{ $ne: ['$isActive', true] }, { $ne: ['$isDeactivated', true] }, { $ne: ['$rejectionStatus.isRejected', true] }] }, 1, 0] } },
          views: { $sum: { $ifNull: ['$views', 0] } },
        } },
      ])),
      // Team news FILED in the range — bucketed by filing time (the ObjectId),
      // because approval overwrites publishedAt.
      hasTeam ? News.aggregate([
        { $match: { ...teamMatch, _id: { $gte: sinceOid } } },
        { $facet: {
          perDay: [{ $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: { $toDate: '$_id' }, timezone: 'Asia/Kolkata' } }, n: { $sum: 1 } } }],
          byCategory: [{ $group: { _id: '$category', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 8 }],
          byLocation: [{ $group: { _id: '$location', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 8 }],
          byAuthor: [{ $group: { _id: '$authorId', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 5 }],
        } },
      ]) : Promise.resolve([{ perDay: [], byCategory: [], byLocation: [], byAuthor: [] }]),
      articlesActedOnBy(doc, me, since),
      // The queue itself, on the same clock as the list and the alarm.
      queueFigures(doc, me),
      hasTeam ? News.aggregate([
        { $match: {
          ...teamMatch,
          // Rejected articles keep their filing publishedAt; bound on it so the
          // match rides the index, then keep only rejections inside the range.
          publishedAt: { $gte: new Date(since.getTime() - 60 * 864e5) },
          'rejectionStatus.isRejected': true,
          'rejectionStatus.rejectedAt': { $gte: since },
        } },
        { $group: { _id: '$rejectionStatus.reason', n: { $sum: 1 } } },
        { $sort: { n: -1 } },
        { $limit: 8 },
      ]) : Promise.resolve([]),
      // Who in the team has filed anything this week — the rest have gone quiet.
      Array.isArray(teamIds) && teamIds.length
        ? News.distinct('authorId', { authorId: { $in: teamIds }, _id: { $gte: weekOid } })
        : Promise.resolve([]),
    ]);

    const st = (statusAgg && statusAgg[0]) || {};
    const team = (teamAgg && teamAgg[0]) || { perDay: [], byCategory: [], byLocation: [], byAuthor: [] };
    const decisions = tallyDecisions(acted, me, since);

    // Pending right now, on the shared queue clock.
    const ages = queueNow.ages;
    const oldest = queueNow.minutes;

    const teamPerDay = new Map(team.perDay.map((d) => [d._id, d.n]));
    const series = istDaysSince(since).map((d) => {
      const b = decisions.perDay.get(d) || { approved: 0, rejected: 0, sentBack: 0, waitTotal: 0, waitCount: 0 };
      return {
        day: d,
        teamNews: teamPerDay.get(d) || 0,
        approved: b.approved,
        rejected: b.rejected,
        sentBack: b.sentBack,
        avgWait: b.waitCount ? Math.round(b.waitTotal / b.waitCount) : 0,
      };
    });
    const today = series.find((x) => x.day === todayKey) || { teamNews: 0, approved: 0, rejected: 0, sentBack: 0, avgWait: 0 };

    // Names for the top reporters and the quiet ones — one read.
    const active = new Set((activeAuthors || []).map(String));
    const silentIds = Array.isArray(teamIds) ? teamIds.filter((id) => !active.has(String(id))) : [];
    const nameIds = [...new Set([...team.byAuthor.map((a) => String(a._id)), ...silentIds.slice(0, 12)])];
    const people = nameIds.length
      ? await Admin.find({ _id: { $in: nameIds } }).select('name username assignedDistricts').lean()
      : [];
    const personOf = new Map(people.map((p) => [String(p._id), {
      name: p.name || p.username || '',
      district: (Array.isArray(p.assignedDistricts) && p.assignedDistricts[0]) || '',
    }]));

    // Blank values are dropped. A UI placeholder saved as a real value
    // ("Loading...") is NOT dropped: those stories are invisible in district
    // feeds, and an In-Charge seeing the bar is the quickest way they get fixed.
    const clean = (rows) => rows
      .filter((r) => r._id !== null && r._id !== undefined && String(r._id).trim())
      .map((r) => ({ name: String(r._id), n: r.n, placeholder: isPlaceholderValue(r._id) }));

    const payload = {
      ok: true,
      days,
      generatedAt: new Date().toISOString(),
      now: {
        pending: queueNow.count,
        late: ages.from30to40 + ages.over40,
        oldestMinutes: oldest,
        // Sent back and waiting on the reporter — shown, never counted late.
        waitingOnReporter: queueNow.onReporter,
      },
      today: {
        approved: today.approved,
        rejected: today.rejected,
        sentBack: today.sentBack,
        averageWait: today.avgWait,
        teamNews: today.teamNews,
      },
      range: {
        approved: decisions.counts.approved,
        rejected: decisions.counts.rejected,
        sentBack: decisions.counts.sentBack,
        edited: decisions.counts.edited,
        averageWait: decisions.averageMinutes,
        medianWait: decisions.medianMinutes,
        slowestWait: decisions.slowestMinutes,
        teamNews: series.reduce((a, x) => a + x.teamNews, 0),
      },
      status: {
        total: st.total || 0,
        live: st.live || 0,
        pending: st.pending || 0,
        hidden: st.hidden || 0,
        rejected: st.rejected || 0,
        views: st.views || 0,
      },
      series,
      pendingAges: ages,
      byCategory: clean(team.byCategory),
      byLocation: clean(team.byLocation),
      topReporters: team.byAuthor.map((a) => ({
        id: String(a._id),
        name: (personOf.get(String(a._id)) || {}).name || '',
        district: (personOf.get(String(a._id)) || {}).district || '',
        n: a.n,
      })),
      silentReporters: {
        teamSize: Array.isArray(teamIds) ? teamIds.length : -1,
        count: silentIds.length,
        sample: silentIds.slice(0, 12).map((id) => ({ id: String(id), ...(personOf.get(String(id)) || { name: '', district: '' }) })),
      },
      rejectReasons: clean(rejectAgg || []),
    };

    if (analyticsCache.size > 300) analyticsCache.clear();
    analyticsCache.set(key, { at: Date.now(), payload });
    res.json(payload);
  } catch (e) {
    console.error('incharge analytics failed:', e.message);
    res.status(500).json({ error: 'Could not load your dashboard.' });
  }
};

exports.myWork = async (req, res) => {
  try {
    const doc = await Admin.findById(req.admin.id)
      .select('name username role displayRole isActive permissions')
      .lean();
    if (!doc || doc.isActive === false) return res.status(401).json({ error: 'Signed out.' });
    if (!canUseInchargeApp(doc)) {
      return res.status(403).json({ error: 'This app is for Bureau, State In-Charges and Sub-Editors.' });
    }

    const asked = Number((req.query && req.query.days) || 1);
    const days = Number.isFinite(asked) ? Math.min(MAX_REPORT_DAYS, Math.max(1, Math.round(asked))) : 1;
    // Whole Indian calendar days — "today" is today, "7 days" is today plus
    // the six before it — the same window the analytics home uses, so the
    // two screens can never show different numbers for the same period.
    const since = istMidnight(days - 1);
    const me = String(req.admin.id);

    const rows = await articlesActedOnBy(doc, me, since);
    const t = tallyDecisions(rows, me, since);

    res.json({
      ok: true,
      days,
      ...t.counts,
      total: t.counts.approved + t.counts.rejected + t.counts.sentBack,
      averageMinutes: t.averageMinutes,
      medianMinutes: t.medianMinutes,
      slowestMinutes: t.slowestMinutes,
      capped: false,
    });
  } catch (e) {
    console.error('incharge my-work failed:', e.message);
    res.status(500).json({ error: 'Could not load your work report.' });
  }
};

/**
 * GET /admin/api/incharge/coverage
 *
 * "Which reporters and which districts are mine?" — the question the owner
 * asked for, and one nobody could answer from the phone before.
 *
 * It matters beyond curiosity. The queue is built from exactly this coverage,
 * so when an In-Charge says "I never get that district's news", this is the
 * page that settles it: either the district is listed or it is not. Several
 * accounts turn out to hold no districts at all, which is why their queue is
 * always empty — and they should be able to see that for themselves rather
 * than assume the app is broken.
 *
 * Read-only, and scoped to the caller: nobody can ask about anyone else.
 */
exports.coverage = async (req, res) => {
  try {
    const doc = await Admin.findById(req.admin.id)
      .select('name username role displayRole workingLanguage permissions ' +
              'assignedState assignedStates assignedDistricts isActive')
      .lean();
    if (!doc || doc.isActive === false) return res.status(401).json({ error: 'Signed out.' });
    if (!canUseInchargeApp(doc)) {
      return res.status(403).json({ error: 'This app is for Bureau, State In-Charges and Sub-Editors.' });
    }

    const perms = doc.permissions || {};
    const uniq = (a) => [...new Set((Array.isArray(a) ? a : []).map((v) => String(v || '').trim()).filter(Boolean))];

    // The APPROVAL coverage — permissions.managed*, which is what the queue
    // actually uses. Deliberately not the assigned* posting areas: those decide
    // where this person may POST, not whose news they approve, and confusing
    // the two is how "why don't I see that district" arguments start.
    const states = uniq(perms.managedStates);
    const districts = uniq(perms.managedDistricts);
    const constituencies = uniq(perms.managedConstituencies);
    const locations = uniq(perms.managedLocations);
    const handPicked = uniq(perms.managedReporterIds);

    let reporters = [];
    let reporterCount = 0;
    try {
      const ids = await getManagedReporterIds(Admin, doc);
      if (ids === null) {
        reporterCount = -1;                 // -1 means "everyone" (canViewAllNews)
      } else {
        reporterCount = ids.length;
        const rows = ids.length
          ? await Admin.find({ _id: { $in: ids } })
              .select('name username assignedState assignedStates assignedDistricts reporterTier')
              .sort({ name: 1 })
              .limit(400)
              .lean()
          : [];
        reporters = rows.map((r) => ({
          id: String(r._id),
          name: r.name || r.username || '',
          district: uniq(r.assignedDistricts)[0] || '',
          state: uniq([...(r.assignedStates || []), r.assignedState])[0] || '',
          tier: r.reporterTier || '',
        }));
      }
    } catch (e) {
      console.error('incharge coverage reporters failed:', e.message);
    }

    res.json({
      ok: true,
      name: doc.name || doc.username || '',
      displayRole: doc.displayRole || doc.role || '',
      language: doc.workingLanguage || '',
      approvalScope: perms.approvalScope || 'geography',
      canApprove: perms.canApproveNews === true || doc.role === 'admin' || doc.role === 'superadmin',
      states,
      districts,
      constituencies,
      locations,
      handPickedCount: handPicked.length,
      reporterCount,
      reporters,
      // Posting areas, shown separately and labelled as such.
      postingStates: uniq([...(doc.assignedStates || []), doc.assignedState]),
      postingDistricts: uniq(doc.assignedDistricts),
    });
  } catch (e) {
    console.error('incharge coverage failed:', e.message);
    res.status(500).json({ error: 'Could not load your coverage.' });
  }
};

/**
 * GET /admin/api/incharge/reporter/:id — one of MY reporters, for the pop-up
 * on "My reporters & districts".
 *
 * Scoped: the reporter must be one this person manages (the same
 * getManagedReporterIds that builds their queue). Anyone else is a 404, not a
 * peek, so the id cannot be used to browse the whole staff list.
 *
 * What is shown follows what the website already shows this person:
 *  - the phone number — the web Coverage Map gives every Sub-Editor the mobile
 *    of each reporter in their coverage (coverageMapController, REPORTER_SEL);
 *  - the email — only with permissions.canViewReporterDetails, the web's own
 *    switch for "reporter details" on the pending / news-list / rejected pages
 *    (2 of 31 Sub-Editors have it);
 *  - postedFrom (the reporter's phone / GPS / IP) — never; Super Admin only.
 */
exports.reporterDetail = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Bad id.' });
    const doc = await loadCaller(req, res, 'role displayRole workingLanguage permissions isActive assignedState assignedStates assignedDistricts');
    if (!doc) return;

    const privileged = doc.role === 'admin' || doc.role === 'superadmin';
    if (!privileged) {
      let team = [];
      try { team = await getManagedReporterIds(Admin, doc); } catch (_) { team = []; }
      const inTeam = team === null || team.map(String).includes(String(id));
      // Some queue items arrive by LOCATION match (the pending filter's $or),
      // so their author is not on the team list. Tapping ⓘ on such an item
      // must still work: the author of something in MY queue is someone I
      // am entitled to look up. Anyone else stays a 404.
      let authorOfMine = false;
      if (!inTeam) {
        const scope = await pendingQueryFor(doc, String(doc._id), { language: 'all' });
        authorOfMine = !!(await News.exists(withinScope(scope, { authorId: String(id) })));
      }
      if (!inTeam && !authorOfMine) {
        return res.status(404).json({ error: 'This reporter is not in your team.' });
      }
    }

    const r = await Admin.findOne({ _id: id, role: 'editor' })
      .select('name username mobileNumber email reporterTier assignedState assignedStates ' +
              'assignedDistricts assignedConstituencies constituency location isActive createdAt workingLanguage')
      .lean();
    if (!r) return res.status(404).json({ error: 'This reporter is not in your team.' });

    const todayOid = mongoose.Types.ObjectId.createFromTime(Math.floor(istMidnight(0).getTime() / 1000));
    const weekOid = mongoose.Types.ObjectId.createFromTime(Math.floor(istMidnight(6).getTime() / 1000));
    const [agg] = await News.aggregate([
      { $match: { authorId: String(r._id) } },
      { $group: {
        _id: null,
        total: { $sum: 1 },
        today: { $sum: { $cond: [{ $gte: ['$_id', todayOid] }, 1, 0] } },
        week: { $sum: { $cond: [{ $gte: ['$_id', weekOid] }, 1, 0] } },
        live: { $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] } },
        rejected: { $sum: { $cond: [{ $eq: ['$rejectionStatus.isRejected', true] }, 1, 0] } },
        pending: { $sum: { $cond: [{ $and: [{ $ne: ['$isActive', true] }, { $ne: ['$isDeactivated', true] }, { $ne: ['$rejectionStatus.isRejected', true] }] }, 1, 0] } },
        lastId: { $max: '$_id' },
      } },
    ]);

    const uniq = (a) => [...new Set((Array.isArray(a) ? a : []).map((v) => String(v || '').trim()).filter(Boolean))];
    const seeDetails = privileged || (doc.permissions && doc.permissions.canViewReporterDetails === true);
    const tier = r.reporterTier === 'stringer' ? 'Stringer'
      : r.reporterTier === 'district_incharge' ? 'District In-Charge' : 'Reporter';

    res.json({
      ok: true,
      reporter: {
        id: String(r._id),
        name: r.name || r.username || '',
        phone: r.mobileNumber || '',
        email: seeDetails ? (r.email || '') : '',
        emailHidden: !seeDetails && !!r.email,
        tier,
        states: uniq([...(r.assignedStates || []), r.assignedState]),
        districts: uniq(r.assignedDistricts),
        constituencies: uniq([...(r.assignedConstituencies || []), r.constituency]),
        language: r.workingLanguage || '',
        active: r.isActive !== false,
        joinedAt: r.createdAt || null,
        lastFiledAt: agg && agg.lastId ? agg.lastId.getTimestamp() : null,
        news: {
          today: (agg && agg.today) || 0,
          week: (agg && agg.week) || 0,
          total: (agg && agg.total) || 0,
          live: (agg && agg.live) || 0,
          pending: (agg && agg.pending) || 0,
          rejected: (agg && agg.rejected) || 0,
        },
      },
    });
  } catch (e) {
    console.error('incharge reporter detail failed:', e.message);
    res.status(500).json({ error: 'Could not load this reporter.' });
  }
};

/**
 * GET /admin/api/incharge/news/:id/versions — "what did the reporter change?"
 *
 * The web's Compare Versions (adminController.getNewsRevisionDiff) answers this
 * for any pending id to anyone with approval rights; this answers it only for
 * an item in the caller's own queue, like every other read in this file. Same
 * data: the snapshot taken when it was sent back, the current text, the
 * per-field change summary (computed if it was never stored), the remarks the
 * In-Charge wrote, and the send-back / resubmit trail.
 */
exports.newsVersions = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Bad id.' });
    const doc = await loadCaller(req, res,
      'role workingLanguage permissions displayRole assignedState assignedStates assignedDistricts isActive');
    if (!doc) return;

    const scope = await pendingQueryFor(doc, String(doc._id), { language: 'all' });
    const n = await News.findOne({ ...scope, _id: id })
      .select('title content category location language mediaUrl mediaType thumbnailUrl imageUrl imageUrls videoUrl revisionStatus actionHistory')
      .lean();
    if (!n) return res.status(404).json({ error: 'This news is no longer in your queue.' });

    const rs = n.revisionStatus || {};
    const snapshot = rs.revisionSnapshot || null;
    let summary = rs.lastChangeSummary && typeof rs.lastChangeSummary === 'object' ? rs.lastChangeSummary : null;
    if (!summary && snapshot) {
      const { buildChangeSummary } = require('../services/newsRevision/revisionHelpers');
      summary = buildChangeSummary(snapshot, n, Number(rs.lastResubmitRound) || Number(rs.lastRevisionRound) || 1);
    }
    const f = (summary && summary.fields) || {};
    const side = (x) => ({
      title: String((x && x.title) || ''),
      content: String((x && x.content) || ''),
      category: String((x && x.category) || ''),
      location: String((x && x.location) || ''),
      images: imagesOf(x || {}),
    });

    res.json({
      ok: true,
      hasPrevious: !!snapshot,
      previous: snapshot ? side(snapshot) : null,
      current: side(n),
      changedFields: (summary && Array.isArray(summary.changedFields)) ? summary.changedFields.map(String) : [],
      imageChanged: !!(f.image && f.image.changed),
      remarks: String(rs.remarks || ''),
      sentBackBy: String(rs.sentBackBy || ''),
      sentAt: rs.sentAt || null,
      resubmittedAt: rs.resubmittedAt || null,
      revisionCount: Number(rs.revisionCount) || 0,
      waitingOnReporter: rs.needsRevision === true,
      history: (Array.isArray(n.actionHistory) ? n.actionHistory : [])
        .filter((h) => h && ['created', 'needs_revision', 'resubmitted', 'updated'].includes(h.action))
        .map((h) => ({
          action: h.action,
          by: String(h.performedByName || ''),
          role: String(h.performedByRole || ''),
          at: h.performedAt || null,
          details: String(h.details || ''),
        })),
    });
  } catch (e) {
    console.error('incharge versions failed:', e.message);
    res.status(500).json({ error: 'Could not load the versions.' });
  }
};

/**
 * GET /admin/api/incharge/news/:id/duplicates
 *
 * The articles the AI thinks this one repeats, so the In-Charge can look at
 * both and judge for themselves. This is the difference between "the AI says
 * 91%" and being able to see WHY — and an image reused on an unrelated story
 * is exactly the false positive that needs a human eye.
 *
 * Read-only on purpose. The dashboard's own duplicate-matches endpoint re-runs
 * the (expensive) duplicate gateway and writes the enriched result back; doing
 * that from a phone would put an algorithm run behind a tap on a weak signal.
 * The stored verdict is what the badge was based on, so it is what gets shown;
 * the enrichment only fills in titles and pictures from the database.
 */
exports.newsDuplicates = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Bad id.' });

    const adminDoc = await Admin.findById(req.admin.id)
      .select('role workingLanguage permissions displayRole assignedState assignedStates assignedDistricts isActive')
      .lean();
    if (!adminDoc || adminDoc.isActive === false) return res.status(401).json({ error: 'Signed out.' });
    if (!canUseInchargeApp(adminDoc)) {
      return res.status(403).json({ error: 'This app is for Bureau, State In-Charges and Sub-Editors.' });
    }

    // Scoped by team and geography like the queue, but NOT by language:
    // language is a view filter the person can change, so an item they were
    // just shown must always open.
    const scope = await pendingQueryFor(adminDoc, req.admin.id, { language: 'all' });
    const mine = await News.findOne({ ...scope, _id: id })
      .select('_id title content language duplicateCheck')
      .lean();
    if (!mine) return res.status(404).json({ error: 'This news is no longer in your queue.' });

    const dc = mine.duplicateCheck || {};
    const stored = Array.isArray(dc.similarArticles) ? dc.similarArticles : [];

    let enriched = [];
    if (stored.length) {
      const { enrichSimilarArticlesFromDb } = require('../services/aiDuplicate/enrichSimilarArticles');
      const rows = await enrichSimilarArticlesFromDb(stored);
      // SAME-LANGUAGE ONLY (owner's rule: te↔te, hi↔hi, ta↔ta). A different-
      // language match — text OR a reused photo on another language's story — is
      // not a duplicate for this desk, so it is dropped. The badge applies the
      // same rule (duplicateBadge), so a flag and its compare screen always
      // agree: nothing cross-language is flagged, so none can show empty.
      const lang = String(mine.language || 'te').toLowerCase();
      enriched = rows.filter((m) => {
        const ml = String((m && m.language) || '').toLowerCase();
        return ml === '' || ml === lang;
      });
    }

    res.json({
      ok: true,
      mine: {
        id: String(mine._id),
        title: mine.title || '',
        content: mine.content || '',
      },
      reasonLabel: dc.reasonLabel || '',
      reasonMessage: dc.reasonMessage || '',
      score: Number(dc.score) || 0,
      matches: enriched.map((m) => ({
        id: String(m.articleId || ''),
        title: String(m.articleTitle || ''),
        content: String(m.content || ''),
        author: String(m.author || ''),
        location: String(m.location || ''),
        category: String(m.category || ''),
        publishedAt: m.publishedAt || null,
        imageUrl: String(m.mediaUrl || ''),
        // published · not_published · rejected — a "duplicate" of something
        // that was itself rejected is not a reason to reject this one.
        status: String(m.publishStatus || ''),
        titlePct: Number((m.similarity && m.similarity.title) || 0),
        contentPct: Number((m.similarity && m.similarity.content) || 0),
        overallPct: Number((m.similarity && m.similarity.overall) || 0),
      })),
    });
  } catch (e) {
    console.error('incharge duplicates failed:', e.message);
    res.status(500).json({ error: 'Could not load the comparison.' });
  }
};

/**
 * GET /admin/api/incharge/lists
 *
 * The category and location names an edit may choose from. Typed text is not
 * good enough here: `location` is matched against these names by the reader
 * feed and by every In-Charge's own coverage filter, so one typo silently
 * takes an article out of the feed it belongs to.
 *
 * Cached in memory for a few minutes — these change perhaps monthly, and every
 * app opening an edit would otherwise read two collections.
 */
const LISTS_CACHE_MS = 5 * 60e3;
let listsCache = null; // { at, payload }

exports.lists = async (req, res) => {
  try {
    const adminDoc = await Admin.findById(req.admin.id).select('role displayRole isActive').lean();
    if (!adminDoc || adminDoc.isActive === false) return res.status(401).json({ error: 'Signed out.' });
    if (!canUseInchargeApp(adminDoc)) {
      return res.status(403).json({ error: 'This app is for Bureau, State In-Charges and Sub-Editors.' });
    }

    if (listsCache && Date.now() - listsCache.at < LISTS_CACHE_MS) {
      return res.json(listsCache.payload);
    }

    const Category = require('../models/Category');
    const Location = require('../models/Location');
    const [cats, locs] = await Promise.all([
      Category.find({ type: { $ne: 'program' } }).select('name order').sort({ order: 1, name: 1 }).lean(),
      Location.find({}).select('name type parentName').sort({ name: 1 }).lean(),
    ]);

    const payload = {
      ok: true,
      categories: [...new Set(cats.map((c) => String(c.name || '').trim()).filter(Boolean))],
      locations: locs
        .map((l) => ({
          name: String(l.name || '').trim(),
          type: String(l.type || ''),
          parent: String(l.parentName || ''),
        }))
        .filter((l) => l.name),
    };
    listsCache = { at: Date.now(), payload };
    res.json(payload);
  } catch (e) {
    console.error('incharge lists failed:', e.message);
    res.status(500).json({ error: 'Could not load the lists.' });
  }
};

/** Small helpers that keep a stray value out of the database. */
const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const pct = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? Math.min(100, Math.max(0, Math.round(x))) : null;
};
const bars = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? Math.min(4, Math.max(0, Math.round(x))) : null;
};

/**
 * POST /admin/api/incharge/heartbeat
 *
 * The app calls this every few minutes while signed in: where the phone is (on
 * duty only), how strong the signal is, battery, and whether Android is letting
 * the background service run. The answer tells the app what it must do right
 * now — above all, whether to start the loud alarm.
 *
 * Deliberately forgiving: a phone with no GPS fix, no signal reading or an old
 * app version still gets a useful answer. The one thing that is refused is a
 * caller who is not an In-Charge.
 */
exports.heartbeat = async (req, res) => {
  try {
    const adminDoc = await Admin.findById(req.admin.id)
      .select('role displayRole name username isActive workingLanguage permissions assignedState assignedStates assignedDistricts')
      .lean();
    if (!adminDoc || adminDoc.isActive === false) return res.status(401).json({ error: 'Signed out.' });
    if (!canUseInchargeApp(adminDoc)) return res.status(403).json({ error: 'This app is for Bureau, State In-Charges and Sub-Editors.' });

    const b = req.body || {};
    const ctx = deviceContext(req);          // reuses the reporter-security parsing, incl. mock-GPS
    const duty = b.duty === 'on' ? 'on' : 'off';

    // Location is only kept while on duty — that is what the In-Charges agreed
    // to, and it is also what keeps the battery alive.
    const gps = duty === 'on' && ctx.gps
      ? { lat: ctx.gps.lat, lng: ctx.gps.lng, accuracy: ctx.gps.accuracy, mock: ctx.gps.mock, at: ctx.gps.at }
      : {};

    const signal = {
      bars: bars(b.signalBars),
      dbm: Number.isFinite(Number(b.signalDbm)) ? Number(b.signalDbm) : null,
      network: clip(b.network, 10).toLowerCase(),
      carrier: clip(b.carrier, 40),
      wifi: b.wifi === true,
    };

    const setupWarnings = (Array.isArray(b.setupWarnings) ? b.setupWarnings : [])
      .map((w) => clip(w, 40)).filter(Boolean).slice(0, 6);

    const doc = {
      staffId: adminDoc._id,
      staffName: adminDoc.name || adminDoc.username || '',
      duty,
      appState: clip(b.appState, 20),
      gps,
      signal,
      batteryPercent: pct(b.batteryPercent),
      batteryCharging: b.batteryCharging === true,
      powerSaveMode: b.powerSaveMode === true,
      deviceId: ctx.deviceId || '',
      deviceModel: ctx.deviceModel || '',
      appVersion: ctx.appVersion || '',
      ip: ctx.ip || '',
      setupWarnings,
      at: new Date(),
    };

    const previous = await StaffPresence.findOne({ staffId: adminDoc._id }).select('duty').lean();
    await StaffPresence.updateOne(
      { staffId: adminDoc._id },
      {
        $set: {
          ...doc,
          lastSeenAt: doc.at,
          ...(previous && previous.duty === duty ? {} : { dutyChangedAt: doc.at }),
        },
      },
      { upsert: true },
    );
    // Fire-and-forget: the history must never hold up the phone's reply.
    StaffPresenceLog.create(doc).catch((e) => console.error('presence log failed:', e.message));

    // What the app needs back: is anything late enough to ring for?
    const oldest = await oldestPendingMinutes(adminDoc, req.admin.id);
    res.json({
      ok: true,
      serverTime: new Date().toISOString(),
      pendingOldestMinutes: oldest.minutes,
      pendingCount: oldest.count,
      alarm: esc.shouldAlarm(oldest.minutes),
      level: esc.levelFor(oldest.minutes),
      alarmAfterMinutes: esc.ALARM_MINUTES,
      // How long until the desk is told — shown in the app so nobody is surprised.
      escalateAfterMinutes: esc.ESCALATE_MINUTES,
    });
  } catch (e) {
    console.error('incharge heartbeat failed:', e.message);
    res.status(500).json({ error: 'Could not record.' });
  }
};

/** The longest-waiting pending item for this person, in minutes (0 when none). */
async function oldestPendingMinutes(adminDoc, selfId) {
  try {
    // The shared clock: sent-back items are the reporter's turn and never ring;
    // resent items count from when they came back (see queueClock).
    const f = await queueFigures(adminDoc, selfId);
    return { minutes: f.minutes, count: f.count, onReporter: f.onReporter };
  } catch (e) {
    console.error('oldest pending lookup failed:', e.message);
    return { minutes: 0, count: 0 };
  }
}

/** Online means "the phone reported in within the last 12 minutes" (heartbeat is ~5). */
const ONLINE_WINDOW_MS = 12 * 60e3;

/** GET /admin/monitor — the desk's live view of every In-Charge. */
exports.renderMonitorPage = (req, res) => {
  res.render('incharge-monitor', {
    title: 'In-Charge Monitor',
    admin: req.admin,
    activePage: 'incharge-monitor',
  });
};

/**
 * Runs [work] over [items] at most [limit] at a time.
 *
 * The monitor asks the database two questions per person. Widening the app to
 * Bureau and Sub-Editors took that list from a handful to about thirty, so an
 * unbounded Promise.all would fire ~60 scoped queries at the live database in
 * one burst every time an admin opens the page. The page is no slower for the
 * cap — the queries simply queue — and the database is not hit in a spike.
 */
async function mapLimited(items, limit, work) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * The monitor page auto-refreshes every 60 s and more than one admin may have it
 * open, so the same expensive answer can be asked for repeatedly. Holding it for
 * a few seconds costs the desk nothing — the numbers move in minutes, not
 * seconds — and stops duplicate refreshes stacking up on the database.
 */
const MONITOR_CACHE_MS = 10000;
let monitorCache = null; // { at, payload }

/**
 * GET /admin/api/incharge/monitor
 *
 * One row per State In-Charge: online or not, on or off duty, where they are,
 * signal, battery — and how long their oldest pending item has waited, which is
 * the number the desk actually argues about.
 */
exports.monitor = async (req, res) => {
  try {
    if (monitorCache && Date.now() - monitorCache.at < MONITOR_CACHE_MS) {
      return res.json(monitorCache.payload);
    }

    const staff = await Admin.find({
      isActive: { $ne: false },
      $or: [
        { displayRole: /in-?charge|bureau/i },
        { role: { $in: ['admin', 'superadmin', 'subeditor'] } },
      ],
    }).select('name username displayRole role workingLanguage permissions assignedState assignedStates assignedDistricts').lean();

    const ids = staff.map((s) => s._id);
    const presences = await StaffPresence.find({ staffId: { $in: ids } }).lean();
    const byStaff = new Map(presences.map((p) => [String(p.staffId), p]));

    const now = Date.now();
    const rows = await mapLimited(staff, 8, async (person) => {
      const p = byStaff.get(String(person._id)) || null;
      const lastSeen = p && p.lastSeenAt ? new Date(p.lastSeenAt) : null;
      const online = !!lastSeen && now - lastSeen.getTime() < ONLINE_WINDOW_MS;

      let oldestMinutes = 0;
      let pendingCount = 0;
      try {
        // The same clock as the phone's alarm, so the office never reports
        // someone late for an item that is waiting on a reporter.
        const f = await queueFigures(person, String(person._id));
        pendingCount = f.count;
        oldestMinutes = f.minutes;
      } catch (_) { /* one person's scope failing must not blank the whole page */ }

      return {
        id: String(person._id),
        name: person.name || person.username || '',
        displayRole: person.displayRole || person.role || '',
        installed: !!p,
        online,
        lastSeenAt: lastSeen,
        duty: p ? p.duty : 'off',
        appState: p ? p.appState : '',
        gps: p && p.gps && p.gps.lat != null ? p.gps : null,
        signal: p ? p.signal : null,
        batteryPercent: p ? p.batteryPercent : null,
        batteryCharging: p ? p.batteryCharging === true : false,
        powerSaveMode: p ? p.powerSaveMode === true : false,
        deviceModel: p ? p.deviceModel : '',
        appVersion: p ? p.appVersion : '',
        setupWarnings: p ? (p.setupWarnings || []) : [],
        pendingCount,
        oldestMinutes,
        level: esc.levelFor(oldestMinutes),
      };
    });

    // Worst first: whoever is keeping news waiting longest is at the top.
    rows.sort((a, b) => b.oldestMinutes - a.oldestMinutes);
    const payload = {
      ok: true,
      generatedAt: new Date().toISOString(),
      thresholds: {
        alarm: esc.ALARM_MINUTES,
        escalate: esc.ESCALATE_MINUTES,
        escalate2: esc.SECOND_ESCALATE_MINUTES,
      },
      staff: rows,
    };
    monitorCache = { at: Date.now(), payload };
    res.json(payload);
  } catch (e) {
    console.error('incharge monitor failed:', e.message);
    res.status(500).json({ error: 'Could not load the monitor.' });
  }
};

/**
 * GET /admin/api/incharge/monitor/:id/history
 *
 * The signal / battery / duty trail for one person. This is what settles
 * "I could not approve, my signal was weak" — the desk can look at the hour in
 * question instead of taking anyone's word.
 */
exports.history = async (req, res) => {
  try {
    const hours = Math.min(72, Math.max(1, Number(req.query.hours) || 12));
    const since = new Date(Date.now() - hours * 3600e3);
    const rows = await StaffPresenceLog.find({ staffId: req.params.id, at: { $gte: since } })
      .select('at duty appState signal batteryPercent batteryCharging powerSaveMode gps setupWarnings')
      .sort({ at: 1 })
      .limit(1000)
      .lean();
    res.json({ ok: true, hours, points: rows });
  } catch (e) {
    res.status(500).json({ error: 'Could not load the history.' });
  }
};

/**
 * GET /api/public/incharge/app-version
 *
 * The app asks this on every start. There is no Play Store to push updates, and
 * these are staff whose alarm has to keep working, so the app updates itself.
 *
 * Public on purpose: it carries no data, only "which version is current", and
 * the app must be able to ask BEFORE anyone signs in. The APK itself is a
 * static file under /downloads.
 *
 * Driven by a JSON file on disk (public/downloads/incharge-version.json) so a
 * new build is published by dropping two files in — no deploy, no restart.
 */
exports.appVersion = (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(__dirname, '..', 'public', 'downloads', 'incharge-version.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    res.set('Cache-Control', 'no-store');   // an update must never be served stale
    res.json({
      ok: true,
      versionCode: Number(raw.versionCode) || 0,
      versionName: String(raw.versionName || ''),
      apkUrl: String(raw.apkUrl || ''),
      notes: String(raw.notes || ''),
      // When true the app blocks until updated — for a build that fixes the alarm.
      mandatory: raw.mandatory === true,
    });
  } catch (_) {
    // No manifest yet = nothing to update to. Never an error: a failed check
    // must not stop an In-Charge from using the app.
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, versionCode: 0, versionName: '', apkUrl: '', notes: '', mandatory: false });
  }
};

/** Test seam: the cache is module state, so tests must be able to clear it. */
function resetMonitorCache() { monitorCache = null; }

/** Test seam: the lists cache is module state too. */
function resetListsCache() { listsCache = null; }

exports._test = { canUseInchargeApp, MENU_GROUPS, queueClock, queueFigures, duplicateBadge, lateTypeOf, changedFieldsOf, capabilitiesFor, analyticsScopeFor, withinScope, newsCard, resetAnalyticsCache, istDaysSince, filedAt, tallyDecisions, istDay, istMidnight, articlesActedOnBy, canSeeMenu, menuFor, isStateIncharge, MENU, imagesOf, limitsFor, languageFor, mapLimited, resetMonitorCache, resetListsCache, firstImage, clip, pct, bars, pendingQueryFor, ONLINE_WINDOW_MS };
