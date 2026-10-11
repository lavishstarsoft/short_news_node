'use strict';

/**
 * Auto-reject stale "Send back for edit" revisions.
 *
 * When a Sub Editor / State Incharge sends an article back for edit, the
 * reporter must resubmit within a deadline (default 30 minutes). If they do not
 * resubmit in time, the article is automatically rejected with a clear English
 * reason — so a sent-back article never lingers unanswered.
 *
 * Mirrors the manual reject controller exactly (rejectionStatus shape,
 * actionHistory 'rejected' entry, workflow emit), and is safe/idempotent:
 *   - only touches articles that are still `revisionStatus.needsRevision === true`,
 *     past the deadline, not already rejected, and not published;
 *   - the update is atomic and fingerprinted on revisionCount, so a resubmit
 *     landing at the same moment always wins (the article is skipped).
 *
 * Flags (env): REVISION_AUTO_REJECT_ENABLED (default 'true'),
 *              REVISION_AUTO_REJECT_MINUTES (default 30),
 *              REVISION_AUTO_REJECT_INTERVAL_MS (default 60000),
 *              REVISION_AUTO_REJECT_BATCH (default 200).
 */

const AUTO_ACTOR = 'System (Auto)';
const AUTO_ROLE = 'system';
const AUTO_REASON = 'No Response to Revision Request';

function isEnabled(env = process.env) {
  const raw = env.REVISION_AUTO_REJECT_ENABLED;
  // Default ON: only 'false'/'0'/'no' disables it.
  return !(raw === 'false' || raw === '0' || raw === 'no');
}

function deadlineMinutes(env = process.env) {
  const n = parseInt(env.REVISION_AUTO_REJECT_MINUTES, 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function fmtIST(d) {
  try {
    return new Date(d).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch (_) {
    return '';
  }
}

/** The solid English reason + feedback shown to the reporter. */
function buildAutoRejectReason(sentAt, minutes) {
  const when = sentAt ? fmtIST(sentAt) : 'earlier';
  return {
    reason: AUTO_REASON,
    feedback:
      `This article was sent back for revision on ${when} and required the ` +
      `requested edits to be resubmitted within ${minutes} minutes. No ` +
      `resubmission was received within that window, so the system has ` +
      `automatically rejected it to keep the review queue clear. Please make ` +
      `the requested changes and submit the article again as a fresh entry.`,
  };
}

/**
 * Articles whose revision deadline has passed and are still awaiting a resubmit.
 * `maxAgeMs` bounds it to RECENT send-backs so activating the feature never
 * mass-rejects a pre-existing backlog of weeks-old abandoned revisions. Going
 * forward the cron runs every minute, so live send-backs are always caught ~1
 * minute past the deadline — well inside the window.
 */
function staleQuery(now, deadlineMs, maxAgeMs) {
  const sentAt = { $lte: new Date(now - deadlineMs) };
  if (maxAgeMs && maxAgeMs > deadlineMs) {
    sentAt.$gte = new Date(now - maxAgeMs);
  }
  return {
    isActive: { $ne: true },
    isDeactivated: { $ne: true },
    'revisionStatus.needsRevision': true,
    'revisionStatus.sentAt': sentAt,
    'rejectionStatus.isRejected': { $ne: true },
  };
}

function maxAgeHours(env = process.env) {
  const n = parseInt(env.REVISION_AUTO_REJECT_MAX_AGE_HOURS, 10);
  return Number.isFinite(n) && n > 0 ? n : 24; // ignore backlog older than this
}

function buildHistoryEntry(details, metadata) {
  return {
    action: 'rejected',
    performedById: null,
    performedByName: AUTO_ACTOR,
    performedByRole: AUTO_ROLE,
    details,
    metadata,
    performedAt: new Date(),
  };
}

/**
 * Atomically reject one stale article. Returns the updated doc or null if it
 * was already resubmitted / rejected / published in the meantime.
 */
async function autoRejectOne(News, doc, minutes) {
  const rev = doc.revisionStatus || {};
  const revisionCount = Number(rev.revisionCount) || 0;
  const { reason, feedback } = buildAutoRejectReason(rev.sentAt, minutes);
  const history = Array.isArray(doc.actionHistory) ? [...doc.actionHistory] : [];
  history.push(
    buildHistoryEntry(`Auto-rejected: no resubmission within ${minutes} minutes of send-back`, {
      auto: true,
      reason,
      feedback,
      revisionCount,
      sentAt: rev.sentAt || null,
      deadlineMinutes: minutes,
    })
  );

  // Atomic + fingerprinted on revisionCount: if a resubmit landed first,
  // needsRevision is now false (or the count changed) → filter misses → skip.
  return News.findOneAndUpdate(
    {
      _id: doc._id,
      isActive: { $ne: true },
      'rejectionStatus.isRejected': { $ne: true },
      'revisionStatus.needsRevision': true,
      'revisionStatus.revisionCount': revisionCount,
    },
    {
      isActive: false,
      rejectionStatus: {
        isRejected: true,
        reason,
        feedback,
        rejectedBy: AUTO_ACTOR,
        rejectedByRole: AUTO_ROLE,
        rejectedAt: new Date(),
      },
      'revisionStatus.needsRevision': false,
      actionHistory: history,
    },
    { new: true }
  );
}

function emitRejected(io, news) {
  if (!io || !news) return;
  try {
    const { emitWorkflowPair } = require('./realtime/workflowEmit');
    emitWorkflowPair(
      io,
      news.authorId,
      {
        id: news._id,
        authorId: news.authorId,
        status: 'rejected',
        rejectionStatus: news.rejectionStatus,
      },
      {
        id: news._id,
        authorId: news.authorId,
        status: 'rejected',
        title: news.title,
      }
    );
  } catch (_) {
    /* emit is best-effort; never blocks the reject */
  }
}

/**
 * Main pass. Injectable for tests. `dryRun` reports what WOULD be rejected
 * without writing.
 */
async function runAutoRejectStaleRevisions(opts = {}) {
  const News = opts.News || require('../models/News');
  const io = opts.io || null;
  const env = opts.env || process.env;
  const now = opts.now || Date.now();
  const minutes = opts.minutes || deadlineMinutes(env);
  const deadlineMs = opts.deadlineMs != null ? opts.deadlineMs : minutes * 60 * 1000;
  const maxAgeMs = opts.maxAgeMs != null ? opts.maxAgeMs : maxAgeHours(env) * 60 * 60 * 1000;
  const limit = opts.limit || parseInt(env.REVISION_AUTO_REJECT_BATCH, 10) || 200;
  const dryRun = opts.dryRun === true;

  const candidates = await News.find(staleQuery(now, deadlineMs, maxAgeMs))
    .select('_id title authorId revisionStatus actionHistory')
    .sort({ 'revisionStatus.sentAt': 1 })
    .limit(limit)
    .lean();

  if (dryRun) {
    return {
      dryRun: true,
      candidates: candidates.length,
      ids: candidates.map((c) => String(c._id)),
      sample: candidates.slice(0, 8).map((c) => ({
        id: String(c._id),
        title: (c.title || '').slice(0, 50),
        sentAt: c.revisionStatus && c.revisionStatus.sentAt,
      })),
    };
  }

  let rejected = 0;
  let skipped = 0;
  for (const doc of candidates) {
    try {
      const updated = await autoRejectOne(News, doc, minutes);
      if (updated) {
        rejected += 1;
        emitRejected(io, updated);
        // Strict rule: auto-rejected → clear every feed/item cache at once.
        try {
          const { bustNewsCaches } = require('./newsCacheBust');
          await bustNewsCaches(updated._id, 'auto-reject');
        } catch (_) { /* cache bust is best-effort; never blocks the pass */ }
      } else {
        skipped += 1; // resubmitted/changed in the meantime
      }
    } catch (err) {
      skipped += 1;
      console.error('[auto-reject] failed for', String(doc._id), err && err.message);
    }
  }
  if (rejected > 0) {
    console.log(`[auto-reject] rejected ${rejected} stale revision(s) (>${minutes}m), skipped ${skipped}`);
  }
  return { dryRun: false, candidates: candidates.length, rejected, skipped };
}

/** Start the recurring cron. No-op when disabled. */
function startRevisionAutoRejectCron(io, env = process.env) {
  if (!isEnabled(env)) {
    console.log('[auto-reject] disabled (REVISION_AUTO_REJECT_ENABLED=false)');
    return null;
  }
  const intervalMs = parseInt(env.REVISION_AUTO_REJECT_INTERVAL_MS, 10) || 60 * 1000;
  const minutes = deadlineMinutes(env);
  console.log(`[auto-reject] enabled — deadline ${minutes}m, window ${maxAgeHours(env)}h, checking every ${Math.round(intervalMs / 1000)}s`);
  const tick = () => {
    runAutoRejectStaleRevisions({ io, env }).catch((err) =>
      console.error('[auto-reject] pass failed:', err && err.message)
    );
  };
  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  setTimeout(tick, 15 * 1000); // first pass shortly after boot
  return timer;
}

module.exports = {
  isEnabled,
  deadlineMinutes,
  maxAgeHours,
  buildAutoRejectReason,
  staleQuery,
  autoRejectOne,
  runAutoRejectStaleRevisions,
  startRevisionAutoRejectCron,
  AUTO_REASON,
  AUTO_ACTOR,
};
