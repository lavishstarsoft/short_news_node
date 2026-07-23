'use strict';

/**
 * Simple circuit breaker for AI detect calls.
 * When open → callers skip AI and use legacy fallback.
 */
function createCircuitBreaker(options = {}) {
  const failureThreshold = options.failureThreshold || 5;
  const resetTimeoutMs = options.resetTimeoutMs || 30000;
  const nowFn = options.now || (() => Date.now());

  let state = 'closed'; // closed | open | half_open
  let failures = 0;
  let openedAt = 0;

  function getState() {
    if (state === 'open') {
      if (nowFn() - openedAt >= resetTimeoutMs) {
        state = 'half_open';
      }
    }
    return state;
  }

  function allowRequest() {
    const s = getState();
    return s === 'closed' || s === 'half_open';
  }

  function recordSuccess() {
    failures = 0;
    state = 'closed';
    openedAt = 0;
  }

  function recordFailure() {
    failures += 1;
    if (state === 'half_open' || failures >= failureThreshold) {
      state = 'open';
      openedAt = nowFn();
    }
  }

  function snapshot() {
    return {
      state: getState(),
      failures,
      failureThreshold,
      resetTimeoutMs,
      openedAt,
    };
  }

  function reset() {
    state = 'closed';
    failures = 0;
    openedAt = 0;
  }

  return {
    allowRequest,
    recordSuccess,
    recordFailure,
    getState,
    snapshot,
    reset,
  };
}

module.exports = {
  createCircuitBreaker,
};
