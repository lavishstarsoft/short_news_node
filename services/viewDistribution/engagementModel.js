'use strict';

/**
 * engagementModel.js — natural synthetic LIKES / DISLIKES for the view engine.
 *
 * Design goals (owner: "nobody should ever find it's fake"):
 *   • Likes grow in PROPORTION to the synthetic views delivered this cycle, so
 *     the like-to-view ratio always stays believable as both climb together.
 *   • Each news has a STABLE hidden "personality" seeded from its id, so rates
 *     vary article-to-article (a bell curve across the feed), never a uniform
 *     ratio that a pattern-detector could spot:
 *        🏆 winner (~10%)        — higher likes, very low dislikes
 *        ⚡ controversial (~15%) — modest likes, elevated dislikes
 *        👍 normal (~75%)        — ordinary likes, low dislikes
 *   • Per-cycle CRYPTO jitter (crypto.randomBytes — not a seeded PRNG) means no
 *     two cycles ever share an exact ratio, and the stream can't be predicted.
 *   • Timing/rhythm is inherited for free: these deltas ride on the view
 *     allocator's adaptive curve (peak-hour weighting, gradual accrual), so
 *     likes also appear gradually through the day, never in a sudden jump.
 *
 * Band = CONSERVATIVE (option A): like-rate ~2–7.5% of views.
 */

const crypto = require('crypto');

// Deterministic [0,1) from a string — a news article's fixed "personality".
function hash01(str) {
  const h = crypto.createHash('sha256').update(String(str)).digest();
  return h.readUInt32BE(0) / 0x100000000;
}

// True-random multiplier in [1-spread, 1+spread] (fresh entropy every call).
function jitter(spread) {
  const r = crypto.randomBytes(2).readUInt16BE(0) / 0x10000;
  return 1 + (r * 2 - 1) * spread;
}

// Stochastic rounding: round 1.3 → 2 with 30% chance, else 1. Lets tiny
// per-cycle expectations (e.g. 0.16 dislikes/cycle) accrue naturally over many
// cycles instead of always rounding to 0 — the whole-number stream stays
// believable without ever showing a clean ratio.
function sround(x) {
  if (x <= 0) return 0;
  const f = Math.floor(x);
  const r = crypto.randomBytes(2).readUInt16BE(0) / 0x10000;
  return f + (r < (x - f) ? 1 : 0);
}

function profile(newsId) {
  // GENTLE band (owner spec): like rate 0.8%–3% of views, same as videos.
  // Personality variety is kept (winner/controversial/normal → a bell curve
  // across the feed, never a uniform ratio), only the magnitudes are lowered.
  const p = hash01(newsId + ':type');
  if (p < 0.10) {
    // 🏆 winner — top of the band, barely any dislikes
    return { likeRate: 0.022 + hash01(newsId + ':lr') * 0.008, dislikeRatio: 0.02 + hash01(newsId + ':dr') * 0.03 };
  }
  if (p < 0.25) {
    // ⚡ controversial — modest likes, but elevated dislike ratio (keeps debate feel)
    return { likeRate: 0.010 + hash01(newsId + ':lr') * 0.010, dislikeRatio: 0.20 + hash01(newsId + ':dr') * 0.25 };
  }
  // 👍 normal — bulk of the feed
  return { likeRate: 0.008 + hash01(newsId + ':lr') * 0.014, dislikeRatio: 0.05 + hash01(newsId + ':dr') * 0.08 };
}

/**
 * Synthetic like/dislike increments for [viewDelta] synthetic views just added
 * to [newsId] this cycle. Returns small, believable, jittered counts.
 */
function engagementDelta(newsId, viewDelta) {
  if (!viewDelta || viewDelta <= 0) return { likeDelta: 0, dislikeDelta: 0 };
  const { likeRate, dislikeRatio } = profile(newsId);
  let likeDelta = sround(viewDelta * likeRate * jitter(0.25));
  if (likeDelta > viewDelta) likeDelta = viewDelta; // can never like more than viewed
  const dislikeDelta = sround(likeDelta * dislikeRatio * jitter(0.3));
  return { likeDelta, dislikeDelta };
}

// Approach a target gradually: ~5% of the remaining gap per run + a small base,
// jittered & stochastically rounded → hearts climb toward the natural target
// over many runs (never a jump), and stop once reached.
function stepToward(current, target) {
  const gap = target - (current || 0);
  if (gap <= 0) return 0;
  return sround(Math.min(gap, gap * 0.05 * jitter(0.3) + 0.5));
}

/**
 * VIDEO-specific engagement band — GENTLER than news (owner spec for reels):
 *   • like rate 0.8%–3.0% of total views (news is 2–7.5%), per-video varied.
 *   • dislikes are absent on ~45% of videos; the rest carry only 5–15% of likes
 *     → most videos show 0 dislikes, a few show 1–3. (news profile() untouched)
 * Deterministic per-video (seeded by id) so the ratio is stable & not a pattern.
 * Targets (at total views): 100→~0-3, 500→~4-15, 1000→~8-30 likes.
 */
function videoProfile(videoId) {
  const likeRate = 0.008 + hash01(videoId + ':vlr') * 0.022; // 0.8% .. 3.0%
  const hasDislikes = hash01(videoId + ':vhd') > 0.45;       // ~55% of videos
  const dislikeRatio = hasDislikes ? 0.05 + hash01(videoId + ':vdr') * 0.10 : 0; // 5–15% of likes, else none
  return { likeRate, dislikeRatio };
}

/**
 * Viral-video HEARTS: unlike news (which rides the view ticker), videos have no
 * per-cycle view delta handy, so we target a natural share of TOTAL views and
 * walk toward it gradually. Uses the gentler video-only band + crypto jitter.
 */
function videoHeartStep(videoId, totalViews, currentLikes, currentDislikes) {
  const v = Number(totalViews) || 0;
  if (v <= 0) return { likeStep: 0, dislikeStep: 0 };
  const { likeRate, dislikeRatio } = videoProfile(videoId);
  const likeTarget = Math.round(v * likeRate * jitter(0.1));
  const dislikeTarget = Math.round(likeTarget * dislikeRatio);
  return {
    likeStep: stepToward(currentLikes, likeTarget),
    dislikeStep: stepToward(currentDislikes, dislikeTarget),
  };
}

module.exports = { engagementDelta, videoHeartStep, _profile: profile, _videoProfile: videoProfile };
