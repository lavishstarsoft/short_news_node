'use strict';

/**
 * Validate frozen /v1/detect advisory response.
 * Does not log or store article body.
 */

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * @returns {{ ok: true, data: object } | { ok: false, error: string }}
 */
function validateAiDetectResponse(data) {
  if (!isPlainObject(data)) {
    return { ok: false, error: 'AI response is not an object' };
  }

  if (data.implemented !== true) {
    return { ok: false, error: 'AI response.implemented must be true' };
  }
  if (data.advisory !== true) {
    return { ok: false, error: 'AI response.advisory must be true' };
  }
  if (!isFiniteNumber(data.phase)) {
    return { ok: false, error: 'AI response.phase must be a number' };
  }
  if (typeof data.algorithm_version !== 'string' || !data.algorithm_version) {
    return { ok: false, error: 'AI response.algorithm_version missing' };
  }
  if (!isPlainObject(data.query) || typeof data.query.content_hash !== 'string') {
    return { ok: false, error: 'AI response.query.content_hash missing' };
  }
  if (!isPlainObject(data.exact) || typeof data.exact.matched !== 'boolean') {
    return { ok: false, error: 'AI response.exact invalid' };
  }
  if (!isPlainObject(data.near) || !Array.isArray(data.near.matches)) {
    return { ok: false, error: 'AI response.near.matches invalid' };
  }
  if (!isPlainObject(data.overall)) {
    return { ok: false, error: 'AI response.overall missing' };
  }
  if (!isFiniteNumber(data.overall.score)) {
    return { ok: false, error: 'AI response.overall.score invalid' };
  }
  if (typeof data.overall.label !== 'string') {
    return { ok: false, error: 'AI response.overall.label invalid' };
  }
  if (typeof data.overall.is_duplicate !== 'boolean') {
    return { ok: false, error: 'AI response.overall.is_duplicate invalid' };
  }
  if (typeof data.overall.is_suspicious !== 'boolean') {
    return { ok: false, error: 'AI response.overall.is_suspicious invalid' };
  }
  if (!isFiniteNumber(data.candidates_scored)) {
    return { ok: false, error: 'AI response.candidates_scored invalid' };
  }

  for (const m of data.near.matches) {
    if (!isPlainObject(m) || !isFiniteNumber(m.score)) {
      return { ok: false, error: 'AI response.near.matches entry invalid' };
    }
  }

  return { ok: true, data };
}

module.exports = {
  validateAiDetectResponse,
};
