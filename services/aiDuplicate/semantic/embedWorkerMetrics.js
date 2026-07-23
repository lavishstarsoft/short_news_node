'use strict';

/**
 * Phase-4.3 — Embed worker / pipeline operational metrics (in-process).
 * No article text. Safe to log / scrape / include in health payloads.
 */

function createEmbedWorkerMetrics(deps = {}) {
  const now = deps.now || (() => Date.now());
  const state = {
    claimed: 0,
    completed: 0,
    success: 0, // READY
    failure: 0, // FAILED
    retry: 0,
    skipped: 0,
    skippedUnchanged: 0,
    leaseExpirations: 0,
    reclaims: 0,
    batches: 0,
    recentErrors: [],

    claimLatencySumMs: 0,
    claimLatencyCount: 0,
    embedLatencySumMs: 0,
    embedLatencyCount: 0,
    e2eLatencySumMs: 0,
    e2eLatencyCount: 0,
    // backward-compat alias totals
    latencySumMs: 0,
    latencyCount: 0,

    lastSuccessAt: null,
    lastFailureAt: null,
    lastClaimAt: null,
    lastErrorCode: null,
  };

  function pushError(code) {
    state.lastErrorCode = code || 'unknown';
    state.recentErrors.push({
      code: state.lastErrorCode,
      at: new Date(now()).toISOString(),
    });
    if (state.recentErrors.length > 20) {
      state.recentErrors.shift();
    }
  }

  function addLatency(bucketSum, bucketCount, ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return;
    state[bucketSum] += ms;
    state[bucketCount] += 1;
  }

  function avg(sum, count) {
    return count > 0 ? Math.round(sum / count) : null;
  }

  function recordClaimed(count = 1) {
    const n = Number(count) || 0;
    if (n > 0) {
      state.claimed += n;
      state.lastClaimAt = new Date(now()).toISOString();
    }
  }

  function recordReclaim(count = 1) {
    const n = Number(count) || 0;
    if (n > 0) {
      state.reclaims += n;
      state.leaseExpirations += n;
    }
  }

  function recordLeaseExpiration(count = 1) {
    recordReclaim(count);
  }

  function recordSuccess(latencyMs) {
    state.success += 1;
    state.completed += 1;
    state.lastSuccessAt = new Date(now()).toISOString();
    addLatency('latencySumMs', 'latencyCount', latencyMs);
    addLatency('e2eLatencySumMs', 'e2eLatencyCount', latencyMs);
  }

  function recordReady(latencyMs) {
    recordSuccess(latencyMs);
  }

  function recordFailure(errorCode, latencyMs) {
    state.failure += 1;
    state.completed += 1;
    state.lastFailureAt = new Date(now()).toISOString();
    pushError(errorCode);
    addLatency('latencySumMs', 'latencyCount', latencyMs);
    addLatency('e2eLatencySumMs', 'e2eLatencyCount', latencyMs);
  }

  function recordRetry(errorCode) {
    state.retry += 1;
    state.completed += 1;
    pushError(errorCode || 'retry');
  }

  function recordSkipped(reason) {
    state.skipped += 1;
    state.completed += 1;
    if (reason === 'already_ready' || reason === 'unchanged_content' || reason === 'already_ready_race' || reason === 'skipped_unchanged') {
      state.skippedUnchanged += 1;
    }
    state.lastErrorCode = reason || 'skipped';
  }

  function recordSkippedUnchanged() {
    recordSkipped('skipped_unchanged');
  }

  function recordBatch() {
    state.batches += 1;
  }

  function recordClaimLatency(ms) {
    addLatency('claimLatencySumMs', 'claimLatencyCount', ms);
  }

  function recordEmbedLatency(ms) {
    addLatency('embedLatencySumMs', 'embedLatencyCount', ms);
  }

  function recordE2eLatency(ms) {
    addLatency('e2eLatencySumMs', 'e2eLatencyCount', ms);
  }

  function snapshot() {
    return {
      claimed: state.claimed,
      completed: state.completed,
      ready: state.success,
      success: state.success,
      failed: state.failure,
      failure: state.failure,
      retry: state.retry,
      skipped: state.skipped,
      skippedUnchanged: state.skippedUnchanged,
      leaseExpirations: state.leaseExpirations,
      reclaims: state.reclaims,
      batches: state.batches,
      avgLatencyMs: avg(state.latencySumMs, state.latencyCount),
      avgClaimLatencyMs: avg(state.claimLatencySumMs, state.claimLatencyCount),
      avgEmbedLatencyMs: avg(state.embedLatencySumMs, state.embedLatencyCount),
      avgE2eLatencyMs: avg(state.e2eLatencySumMs, state.e2eLatencyCount),
      lastSuccessAt: state.lastSuccessAt,
      lastFailureAt: state.lastFailureAt,
      lastClaimAt: state.lastClaimAt,
      lastErrorCode: state.lastErrorCode,
      recentErrors: state.recentErrors.slice(),
    };
  }

  function reset() {
    state.claimed = 0;
    state.completed = 0;
    state.success = 0;
    state.failure = 0;
    state.retry = 0;
    state.skipped = 0;
    state.skippedUnchanged = 0;
    state.leaseExpirations = 0;
    state.reclaims = 0;
    state.batches = 0;
    state.recentErrors = [];
    state.claimLatencySumMs = 0;
    state.claimLatencyCount = 0;
    state.embedLatencySumMs = 0;
    state.embedLatencyCount = 0;
    state.e2eLatencySumMs = 0;
    state.e2eLatencyCount = 0;
    state.latencySumMs = 0;
    state.latencyCount = 0;
    state.lastSuccessAt = null;
    state.lastFailureAt = null;
    state.lastClaimAt = null;
    state.lastErrorCode = null;
  }

  return {
    recordClaimed,
    recordReclaim,
    recordLeaseExpiration,
    recordSuccess,
    recordReady,
    recordFailure,
    recordRetry,
    recordSkipped,
    recordSkippedUnchanged,
    recordBatch,
    recordClaimLatency,
    recordEmbedLatency,
    recordE2eLatency,
    snapshot,
    reset,
  };
}

module.exports = {
  createEmbedWorkerMetrics,
};
