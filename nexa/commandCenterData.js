'use strict';

/**
 * TEHELKA NEXA — read-only data provider for the unified Command Center.
 *
 * Pure monitoring: reads only, never writes, never performs actions. Safe to
 * call whether NEXA is enabled or disabled. Any failure returns partial/empty
 * data (never throws) so the existing Command Center can never break.
 */

const mongoose = require('mongoose');

function safeStatus() {
  try {
    return require('./index').getStatus();
  } catch (e) {
    return {
      name: 'TEHELKA NEXA',
      enabled: false,
      killSwitch: false,
      active: false,
      shadowMode: true,
      maxAutonomy: 1,
      queueAvailable: false,
      tools: [],
    };
  }
}

async function gather() {
  const status = safeStatus();

  const out = {
    status,
    stats: { total: 0, byStatus: {} },
    split: { live: 0, shadow: 0, blocked: 0 },
    automationPercent: 0,
    accuracy: { compared: 0, matched: 0, percent: null },
    backlog: { total: 0, olderThan24h: 0, oldestPendingAt: null },
    queue: null,
    pending: [],
    recent: [],
    tools: status.tools || [],
    dbConnected: mongoose.connection.readyState === 1,
  };

  // NexaTask stats (empty until NEXA has run).
  try {
    const NexaTask = require('../models/NexaTask');
    const [statusAgg, modeAgg, matchAgg, pendingRows, recentRows, total] =
      await Promise.all([
        NexaTask.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
        NexaTask.aggregate([{ $group: { _id: '$mode', n: { $sum: 1 } } }]),
        NexaTask.aggregate([
          { $match: { matchedHuman: { $ne: null } } },
          { $group: { _id: '$matchedHuman', n: { $sum: 1 } } },
        ]),
        NexaTask.find({ status: 'awaiting_approval' }).sort({ createdAt: 1 }).limit(20).lean(),
        NexaTask.find({}).sort({ createdAt: -1 }).limit(20).lean(),
        NexaTask.countDocuments({}),
      ]);
    const byStatus = {};
    statusAgg.forEach((r) => (byStatus[r._id || 'unknown'] = r.n));
    const byMode = {};
    modeAgg.forEach((r) => (byMode[r._id || 'unknown'] = r.n));
    out.stats = { total, byStatus };
    out.split = { live: byMode.live || 0, shadow: byMode.shadow || 0, blocked: byMode.blocked || 0 };
    out.pending = pendingRows;
    out.recent = recentRows;
    let compared = 0;
    let matched = 0;
    matchAgg.forEach((r) => {
      compared += r.n;
      if (r._id === true) matched += r.n;
    });
    out.accuracy = { compared, matched, percent: compared ? Math.round((matched / compared) * 100) : null };
    const decided = out.split.live + out.split.shadow + out.split.blocked;
    out.automationPercent = decided ? Math.round((out.split.live / decided) * 100) : 0;
  } catch (e) {
    /* NexaTask may not exist yet — fine */
  }

  // Backlog (read-only, independent of NEXA state).
  try {
    const News = require('../models/News');
    const base = {
      isActive: false,
      isDeactivated: { $ne: true },
      $or: [
        { 'rejectionStatus.isRejected': { $ne: true } },
        { rejectionStatus: { $exists: false } },
      ],
    };
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [t, older, oldest] = await Promise.all([
      News.countDocuments(base),
      News.countDocuments({ ...base, publishedAt: { $lt: dayAgo } }),
      News.findOne(base).sort({ publishedAt: 1 }).select('publishedAt').lean(),
    ]);
    out.backlog = { total: t, olderThan24h: older, oldestPendingAt: oldest && oldest.publishedAt };
  } catch (e) {
    /* ignore */
  }

  // Queue counts (only if BullMQ available; null otherwise).
  try {
    out.queue = await require('./index').queue.counts('default');
  } catch (e) {
    out.queue = null;
  }

  // Pending News Triage (shadow workflow) summary — read-only aggregation.
  out.triage = null;
  try {
    const NexaTask = require('../models/NexaTask');
    const wf = 'pending_news_triage';
    const [byRec, agg, recentTriage] = await Promise.all([
      NexaTask.aggregate([{ $match: { workflow: wf } }, { $group: { _id: '$action', n: { $sum: 1 } } }]),
      NexaTask.aggregate([{ $match: { workflow: wf } }, { $group: { _id: null, total: { $sum: 1 }, avgConf: { $avg: '$confidence' } } }]),
      NexaTask.find({ workflow: wf }).sort({ createdAt: -1 }).limit(10).lean(),
    ]);
    const byRecommendation = {};
    byRec.forEach((r) => (byRecommendation[r._id || 'UNKNOWN'] = r.n));
    const a = agg[0] || {};
    out.triage = {
      total: a.total || 0,
      avgConfidence: a.avgConf != null ? Math.round(a.avgConf * 100) / 100 : null,
      byRecommendation,
      possibleDuplicate: byRecommendation.POSSIBLE_DUPLICATE || 0,
      priorityReview: byRecommendation.PRIORITY_REVIEW || 0,
      humanVerification: byRecommendation.NEEDS_HUMAN_VERIFICATION || 0,
      lowPriority: byRecommendation.LOW_PRIORITY || 0,
      review: byRecommendation.REVIEW || 0,
      recent: recentTriage,
    };
  } catch (e) {
    out.triage = null;
  }

  // Accuracy / Evaluation — compare NEXA shadow recommendations with the eventual
  // HUMAN outcome of the same news (read from News state; set by the existing
  // approval workflow, never by NEXA). Read-only join, no writes.
  out.evaluation = null;
  try {
    const NexaTask = require('../models/NexaTask');
    const News = require('../models/News');
    const { deriveOutcome, buildEvaluation } = require('./evaluation');
    const wf = 'pending_news_triage';
    const tasks = await NexaTask.find({ workflow: wf })
      .sort({ createdAt: -1 })
      .limit(500)
      .select('entityId action confidence createdAt reason')
      .lean();
    const ids = [...new Set(tasks.map((t) => t.entityId).filter(Boolean))];
    const newsDocs = ids.length
      ? await News.find({ _id: { $in: ids } })
          .select('_id isActive isDeactivated approvalStatus.isApproved rejectionStatus.isRejected')
          .lean()
      : [];
    const outcomeById = {};
    newsDocs.forEach((n) => { outcomeById[String(n._id)] = deriveOutcome(n); });
    out.evaluation = buildEvaluation(tasks, outcomeById);
  } catch (e) {
    out.evaluation = null;
  }

  // Pending-news list (complete current queue, old→new) — first page only for
  // the initial render; the UI pages the rest via /admin/api/nexa/pending-news.
  // Read-only; never triggers triage, never writes.
  out.pendingList = { total: 0, skip: 0, limit: 50, items: [] };
  try {
    const { fetchPendingPage } = require('./pendingNewsList');
    out.pendingList = await fetchPendingPage({ skip: 0, limit: 50 });
  } catch (e) {
    /* display-only; keep empty on failure */
  }

  return out;
}

module.exports = { gather };
