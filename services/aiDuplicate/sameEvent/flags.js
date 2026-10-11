'use strict';

/**
 * Phase-0 Same-Event SHADOW flags. ALL default OFF / safe.
 *
 * When DUP_SAMEEVENT_SHADOW_ENABLED is false (default) the whole subsystem is a
 * no-op: no candidate reads, no writes, no logs, zero production impact.
 * Nothing here ever changes news status / rejectionStatus / isActive / aiStatus
 * or the production duplicateCheck decision.
 */

function parseBool(raw) {
  return raw === 'true' || raw === '1' || raw === 'yes';
}
function parseNum(raw, fb) {
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fb;
}
function parseInt10(raw, fb) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fb;
}

function loadShadowFlags(env = process.env) {
  return {
    // Master switch — OFF by default. Nothing runs unless explicitly enabled.
    enabled: parseBool(env.DUP_SAMEEVENT_SHADOW_ENABLED),
    // Additionally mirror a compact summary onto News.duplicateCheck.shadow
    // (additive sub-field only). OFF by default → the metrics collection is the
    // sole store and News is never written by the shadow.
    writeNews: parseBool(env.DUP_SAMEEVENT_SHADOW_WRITE_NEWS),
    // Bounded historical window (days) for BOTH candidate sources.
    windowDays: parseInt10(env.DUP_SAMEEVENT_SHADOW_WINDOW_DAYS, 14),
    // Date-proximity full-credit window (days) for the dateProximity signal.
    dateWindowDays: parseNum(env.DUP_SAMEEVENT_SHADOW_DATE_WINDOW_DAYS, 3),
    // Caps — keep retrieval bounded; never an unbounded scan.
    maxVectorCandidates: parseInt10(env.DUP_SAMEEVENT_SHADOW_MAX_VECTOR, 6000),
    maxEventCandidates: parseInt10(env.DUP_SAMEEVENT_SHADOW_MAX_EVENT, 300),
    maxTotalCandidates: parseInt10(env.DUP_SAMEEVENT_SHADOW_MAX_TOTAL, 800),
    topK: parseInt10(env.DUP_SAMEEVENT_SHADOW_TOPK, 5),
    // Precision-guard minimums for the *guarded* verdict variant (only ever
    // DOWNGRADE a duplicate → suspicious; never upgrade, never lower the
    // reused semantic thresholds). Recorded for calibration comparison.
    geoGuardMin: parseNum(env.DUP_SAMEEVENT_SHADOW_GEO_MIN, 0.34),
    dateGuardMin: parseNum(env.DUP_SAMEEVENT_SHADOW_DATE_MIN, 0.5),
  };
}

function isShadowEnabled(env = process.env) {
  return loadShadowFlags(env).enabled;
}

module.exports = { loadShadowFlags, isShadowEnabled, parseBool, parseNum, parseInt10 };
