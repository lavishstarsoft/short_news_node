'use strict';

/**
 * Reporter Reliability computation (compute-only).
 *
 * Reads News (aggregate, read-only) and writes one ReporterReliability doc per
 * reporter. NEVER modifies News and NEVER applies a restriction. Enforcement is
 * a separate, human-gated action.
 *
 * Scoring philosophy (per product decision):
 *  - EXACT duplicates and HUMAN rejections are strong, objective signals.
 *  - AI-only "suspicious" is a WEAK signal (small weight) so no reporter is
 *    punished on an AI hunch alone.
 */

const MIN_SUBMISSIONS = (() => {
  const n = parseInt(process.env.RELIABILITY_MIN_SUBMISSIONS, 10);
  return Number.isFinite(n) && n > 0 ? n : 5;
})();

// Penalty weights = points lost per 1% of submissions in that bucket, + an
// approval bonus. ONLY objective signals penalise a reporter:
//   - exact  = TRUE identical-text repost (contentHash collision of an earlier,
//     different article). This is unambiguous copy behaviour.
//   - rejected = a human editor rejected the article.
// AI near/suspicious carry ZERO weight: the stored duplicateCheck flag is known
// to be liberally set (score=100 with no real match), so an AI hunch must never
// sink a reporter. They are still stored for transparency, just not penalised.
//   100% true reposts → −120 (score 0); 100% rejected → −80.
const W = {
  exact: 1.2, // TRUE contentHash repost            → strongest
  rejected: 0.8, // human editor rejection          → strong
  nearDup: 0, // AI/near flagged duplicate          → NOT penalised (noisy)
  suspicious: 0, // AI-only suspicious              → NOT penalised (noisy)
  approveBonusCap: 8,
};

function tierFor(score) {
  if (score == null) return 'insufficient_data';
  if (score >= 80) return 'trusted';
  if (score >= 50) return 'watch';
  if (score >= 30) return 'review';
  return 'high_risk';
}

function computeScore(c) {
  if (!c.totalSubmissions || c.totalSubmissions < MIN_SUBMISSIONS) return null;
  const pct = (n) => (n / c.totalSubmissions) * 100;
  const exactRate = pct(c.exactDuplicates);
  const rejectedRate = pct(c.rejected);
  const nearRate = pct(Math.max(0, c.nearDuplicates - c.exactDuplicates));
  const suspiciousRate = pct(c.suspiciousCount);
  const approvedRate = pct(c.approved);

  let score = 100;
  score -= W.exact * exactRate;
  score -= W.rejected * rejectedRate;
  score -= W.nearDup * nearRate;
  score -= W.suspicious * suspiciousRate;
  score += Math.min(W.approveBonusCap, (approvedRate / 100) * W.approveBonusCap);

  score = Math.max(0, Math.min(100, Math.round(score)));
  return score;
}

/**
 * Count TRUE exact reposts per author in the window: a contentHash that occurs
 * more than once — every occurrence AFTER the earliest is a repost, attributed
 * to whoever posted it. One aggregation, index-backed. Read-only.
 */
async function buildExactRepostMap(News, since) {
  const groups = await News.aggregate([
    { $match: { publishedAt: { $gte: since }, isDeactivated: { $ne: true }, contentHash: { $nin: [null, ''] } } },
    { $group: { _id: '$contentHash', docs: { $push: { authorId: '$authorId', publishedAt: '$publishedAt' } }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]);
  const repostByAuthor = {};
  for (const g of groups) {
    const docs = g.docs.slice().sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt));
    for (let i = 1; i < docs.length; i++) {
      const a = String(docs[i].authorId || '');
      if (!a) continue;
      repostByAuthor[a] = (repostByAuthor[a] || 0) + 1;
    }
  }
  return repostByAuthor;
}

/**
 * Per-author totals/approved/rejected + AI counts (AI counts stored only for
 * transparency; they carry zero penalty weight). One aggregation.
 */
async function buildPerAuthorCounts(News, since) {
  const rows = await News.aggregate([
    { $match: { publishedAt: { $gte: since }, isDeactivated: { $ne: true } } },
    {
      $group: {
        _id: '$authorId',
        totalSubmissions: { $sum: 1 },
        approved: { $sum: { $cond: [{ $eq: ['$approvalStatus.isApproved', true] }, 1, 0] } },
        rejected: { $sum: { $cond: [{ $eq: ['$rejectionStatus.isRejected', true] }, 1, 0] } },
        nearDuplicates: { $sum: { $cond: [{ $eq: ['$duplicateCheck.isDuplicate', true] }, 1, 0] } },
        suspiciousCount: { $sum: { $cond: [{ $eq: ['$duplicateCheck.isSuspicious', true] }, 1, 0] } },
      },
    },
  ]);
  const map = {};
  for (const r of rows) map[String(r._id || '')] = r;
  return map;
}

/**
 * Compute + upsert reliability for all reporters (editor role) with activity.
 * Uses two aggregations total (no per-reporter query loop). Read-only on News.
 * @returns {Promise<{processed:number, windowDays:number}>}
 */
async function computeAllReporters(deps = {}) {
  const News = deps.News || require('../../models/News');
  const Admin = deps.Admin || require('../../models/Admin');
  const ReporterReliability = deps.ReporterReliability || require('../../models/ReporterReliability');
  const windowDays = deps.windowDays || 30;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const [repostMap, countsMap] = await Promise.all([
    buildExactRepostMap(News, since),
    buildPerAuthorCounts(News, since),
  ]);

  const authorIds = Object.keys(countsMap).filter(Boolean);
  // Only score reporter/stringer (editor) accounts.
  const admins = await Admin.find({ _id: { $in: authorIds.filter((id) => /^[a-f0-9]{24}$/i.test(id)) } })
    .select('name username email role')
    .lean();
  const adminMap = {};
  admins.forEach((a) => { adminMap[String(a._id)] = a; });

  let processed = 0;
  for (const reporterId of authorIds) {
    const a = adminMap[reporterId];
    if (!a || a.role !== 'editor') continue; // reporters/stringers only

    const c = countsMap[reporterId] || {};
    const counts = {
      totalSubmissions: c.totalSubmissions || 0,
      approved: c.approved || 0,
      rejected: c.rejected || 0,
      exactDuplicates: repostMap[reporterId] || 0, // TRUE reposts
      nearDuplicates: c.nearDuplicates || 0, // stored only, not penalised
      suspiciousCount: c.suspiciousCount || 0, // stored only, not penalised
    };
    const score = computeScore(counts);
    const tier = tierFor(score);

    await ReporterReliability.updateOne(
      { reporterId, windowDays },
      {
        $set: {
          reporterName: a.name || a.username || null,
          reporterEmail: a.email || null,
          ...counts,
          score,
          tier,
          lastComputedAt: new Date(),
        },
      },
      { upsert: true },
    );
    processed++;
  }
  return { processed, windowDays };
}

/**
 * Nightly compute cron. OFF by default — enable with
 * REPORTER_RELIABILITY_ENABLED=true. Compute-only: it never restricts anyone.
 */
function startReporterReliabilityCron(env = process.env) {
  const enabled = env.REPORTER_RELIABILITY_ENABLED === 'true' || env.REPORTER_RELIABILITY_ENABLED === '1';
  if (!enabled) {
    console.log('[reliability] disabled (set REPORTER_RELIABILITY_ENABLED=true to compute)');
    return null;
  }
  const intervalMs = parseInt(env.REPORTER_RELIABILITY_INTERVAL_MS, 10) || 6 * 60 * 60 * 1000; // 6h
  const tick = () => {
    computeAllReporters({})
      .then((r) => console.log(`[reliability] computed ${r.processed} reporters (window ${r.windowDays}d)`))
      .catch((err) => console.error('[reliability] pass failed:', err && err.message));
  };
  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  setTimeout(tick, 30 * 1000); // first pass shortly after boot
  console.log(`[reliability] enabled — compute-only, every ${Math.round(intervalMs / 3600000)}h`);
  return timer;
}

module.exports = {
  computeScore,
  tierFor,
  buildExactRepostMap,
  buildPerAuthorCounts,
  computeAllReporters,
  startReporterReliabilityCron,
  MIN_SUBMISSIONS,
  WEIGHTS: W,
};
