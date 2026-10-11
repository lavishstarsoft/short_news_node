'use strict';

/**
 * TEHELKA NEXA — read-only pending-news list provider for the Command Center.
 *
 * Returns the COMPLETE current "not yet decided" News queue (paginated),
 * ordered OLD → NEW, joined with NEXA's shadow triage recommendation where one
 * already exists. This is DISPLAY ONLY:
 *   - It NEVER writes News/approval/rejection/publish/reporter/wallet/tier.
 *   - It NEVER creates a NexaTask and NEVER triggers triage on unanalyzed items.
 *   - It only READS the existing pending definition (same as the backlog query)
 *     and the existing pending_news_triage NexaTasks.
 *
 * "Pending / not decided" uses the SAME definition already used elsewhere
 * (commandCenterData backlog): isActive:false, not deactivated, not rejected.
 */

const HARD_MAX = 200; // per-page safety cap (never returns the whole DB at once)

/** Pending / undecided News filter — identical to the existing backlog query. */
function pendingFilter() {
  return {
    isActive: false,
    isDeactivated: { $ne: true },
    $or: [
      { 'rejectionStatus.isRejected': { $ne: true } },
      { rejectionStatus: { $exists: false } },
    ],
  };
}

/**
 * Fetch one page of the pending queue (old→new) + total, with triage join.
 * @param {Object} opts { skip, limit, News, NexaTask }
 * @returns {Promise<{total:number, skip:number, limit:number, items:Array}>}
 */
async function fetchPendingPage(opts = {}) {
  const News = opts.News || require('../models/News');
  const NexaTask = opts.NexaTask || require('../models/NexaTask');

  const skip = Math.max(0, parseInt(opts.skip, 10) || 0);
  let limit = parseInt(opts.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 50;
  limit = Math.min(limit, HARD_MAX);

  const base = pendingFilter();

  const [total, rows] = await Promise.all([
    News.countDocuments(base),
    News.find(base)
      .select('_id title location publishedAt')
      .sort({ publishedAt: 1 }) // OLD → NEW
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);

  const ids = rows.map((r) => String(r._id));

  // Join the latest shadow triage recommendation per news id (if any).
  const recById = {};
  if (ids.length) {
    try {
      const tasks = await NexaTask.find({
        workflow: 'pending_news_triage',
        entityId: { $in: ids },
      })
        .select('entityId action confidence reason aiDecision createdAt')
        .sort({ createdAt: -1 })
        .lean();
      tasks.forEach((t) => {
        const key = String(t.entityId);
        if (recById[key]) return; // keep the most recent only
        const sig = (t.aiDecision && t.aiDecision.signals) || {};
        recById[key] = {
          recommendation: t.action || null,
          confidence: t.confidence != null ? t.confidence : null,
          reason: t.reason || null,
          duplicate: sig.duplicate || null,
          reliability: sig.reliability || null,
        };
      });
    } catch (_) {
      /* triage optional — display still works without it */
    }
  }

  const items = rows.map((r) => {
    const id = String(r._id);
    const rc = recById[id] || {};
    return {
      id,
      title: r.title || 'వార్త',
      state: r.location || null,
      publishedAt: r.publishedAt || null,
      analyzed: !!rc.recommendation,
      recommendation: rc.recommendation || null,
      confidence: rc.confidence != null ? rc.confidence : null,
      reason: rc.reason || null,
      duplicate: rc.duplicate || null,
      reliability: rc.reliability || null,
    };
  });

  return { total, skip, limit, items };
}

module.exports = { fetchPendingPage, pendingFilter, HARD_MAX };
