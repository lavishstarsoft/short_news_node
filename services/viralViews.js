'use strict';
/**
 * Synthetic display views for VIRAL VIDEOS (consumer display layer only).
 *
 * Mirrors the News philosophy: the stored `views` field stays a pristine organic
 * counter (real user views). This module adds a natural-looking, slowly-growing
 * synthetic number ON TOP of it, computed on read from the video's age — no DB
 * writes, no cron, no model change. Deterministic per video (same id → same
 * curve), so the number is stable between reads and only creeps up as real time
 * passes, exactly like an organic view count.
 *
 * Target band: 200–800 per video. New videos start around half their target and
 * grow slowly (front-loaded, ~2–3 weeks to approach target). Never below 200,
 * synthetic never above 800.
 */

const FLOOR = 200;         // display never below this for an active video
const CAP = 800;           // synthetic never above this
const SPAN = CAP - FLOOR;  // 600
const TAU_DAYS = 4;        // growth time-constant (higher = slower). ~63% by 4d, ~95% by ~12d
const START_FRAC = 0.5;    // a brand-new video shows ~50% of its target, then grows

// Small, fast, stable 32-bit string hash (FNV-1a style).
function hash32(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * Synthetic view count for one viral video (stable + slowly growing).
 * @param {{_id?:any, id?:any, publishedAt?:any, createdAt?:any}} v
 * @returns {number}
 */
function syntheticViralViews(v) {
  if (!v) return FLOOR;
  const id = String(v._id || v.id || '');
  const h = hash32(id);
  const target = FLOOR + (h % (SPAN + 1)); // 200..800, stable per video

  const ts = new Date(v.publishedAt || v.createdAt || Date.now()).getTime();
  const ageDays = Math.max(0, (Date.now() - ts) / 86400000);
  const grow = 1 - Math.exp(-ageDays / TAU_DAYS);        // 0 → 1 (slow)
  let n = Math.round(target * (START_FRAC + (1 - START_FRAC) * grow));

  // Gentle deterministic wobble (changes ~daily) so it isn't a perfectly smooth curve.
  const wob = (hash32(id + ':' + Math.floor(ageDays)) % 7) - 3; // -3..+3
  n += wob;

  if (n < FLOOR) n = FLOOR;
  if (n > target) n = target; // cap at this video's target (≤ 800)
  return n;
}

/** Display views = pristine organic views + synthetic. */
function displayViralViews(v) {
  const organic = Number((v && (v.views)) || 0);
  return organic + syntheticViralViews(v);
}

module.exports = { syntheticViralViews, displayViralViews, FLOOR, CAP, TAU_DAYS };
