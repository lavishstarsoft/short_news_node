'use strict';

/**
 * Phase-4.3 — Queue depth metrics from news_vectors (read-only).
 */

const { STATUS } = require('./statuses');

function createNewsVectorQueueMetrics(deps = {}) {
  const getNewsVector = () =>
    deps.NewsVector || require('../../../models/NewsVector');
  const now = deps.now || (() => Date.now());

  async function countByStatus(status) {
    const NewsVector = getNewsVector();
    if (!NewsVector || typeof NewsVector.countDocuments !== 'function') {
      return 0;
    }
    return NewsVector.countDocuments({ status });
  }

  /**
   * @returns {Promise<object>}
   */
  async function snapshot() {
    const NewsVector = getNewsVector();
    const t0 = now();

    let pending = 0;
    let ready = 0;
    let failed = 0;
    let stale = 0;
    let oldestPendingAt = null;
    let oldestPendingAgeMs = null;
    let error = null;

    try {
      if (NewsVector && typeof NewsVector.countDocuments === 'function') {
        [pending, ready, failed, stale] = await Promise.all([
          countByStatus(STATUS.PENDING),
          countByStatus(STATUS.READY),
          countByStatus(STATUS.FAILED),
          countByStatus(STATUS.STALE),
        ]);
      }

      if (NewsVector && typeof NewsVector.findOne === 'function') {
        const q = NewsVector.findOne({ status: STATUS.PENDING }).sort({
          createdAt: 1,
          updatedAt: 1,
        });
        const oldest =
          q && typeof q.lean === 'function' ? await q.lean() : await q;
        if (oldest) {
          const ts = oldest.createdAt || oldest.updatedAt || null;
          if (ts) {
            oldestPendingAt = new Date(ts).toISOString();
            oldestPendingAgeMs = Math.max(0, now() - new Date(ts).getTime());
          }
        }
      }
    } catch (err) {
      error = err && err.message ? err.message : 'queue_metrics_failed';
    }

    return {
      pending,
      ready,
      failed,
      stale,
      queueDepth: pending,
      oldestPendingAt,
      oldestPendingAgeMs,
      collectedAt: new Date(now()).toISOString(),
      collectLatencyMs: now() - t0,
      error,
    };
  }

  return {
    snapshot,
    countByStatus,
  };
}

module.exports = {
  createNewsVectorQueueMetrics,
};
