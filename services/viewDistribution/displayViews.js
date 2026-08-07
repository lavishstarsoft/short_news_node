'use strict';

/**
 * displayViews.js — the ONE centralized helper for combined view display.
 *
 * Contract (locked in Phase 1):
 *   organic   = News.views          (pristine; the ONLY value analytics/fraud/ML/reco use)
 *   synthetic = News.syntheticViews  (engine-owned; read ONLY here)
 *   display   = organic + synthetic  (consumer app only)
 *
 * Rules:
 *   - When the flag is OFF (or engine killed), returns organic UNCHANGED
 *     => consumer responses are byte-identical to today.
 *   - Missing/undefined synthetic is treated as 0 (backward compatible with
 *     documents created before this field existed).
 *   - No endpoint should ever add `views + syntheticViews` inline — always call
 *     this helper so display logic lives in exactly one place.
 */

const { isEnabledCached } = require('./config');

function toInt(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

/**
 * Combined display view count for a news-like source that carries `views`
 * (and, when present, `syntheticViews`).
 * @param {object} source - a News document, lean object, or serialized payload.
 * @returns {number}
 */
function displayViews(source) {
  const organic = toInt(source && source.views);
  if (!isEnabledCached()) return organic; // OFF => exactly today's value
  return organic + toInt(source && source.syntheticViews);
}

/**
 * Overwrite the outgoing `views` field with the combined display value.
 * Keeps the `views` key name => existing consumer APIs stay shape-compatible.
 * @param {object} target - the payload object whose `views` should be displayed.
 * @param {object} [source=target] - the doc carrying organic + synthetic counts.
 * @returns {object} the same target (mutated).
 */
function applyDisplayViews(target, source = target) {
  if (target && typeof target === 'object') {
    target.views = displayViews(source);
  }
  return target;
}

module.exports = { displayViews, applyDisplayViews };
