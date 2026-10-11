'use strict';

/**
 * videoHearts.js — synthetic HEARTS (likes) for Viral Videos.
 *
 * Viral videos aren't part of the News view-distribution campaigns, so this is a
 * light top-up run from the leader-only ticker (throttled). For each recent
 * video with real views it walks `syntheticLikes`/`syntheticDislikes` gradually
 * toward a natural per-video target (engagementModel). Organic likes/dislikes
 * are NEVER touched; the blend happens only in the GraphQL ViralVideo resolver.
 * Gated by the same `viewEngineEnabled` flag.
 */

const ViralVideo = require('../../models/ViralVideo');
const { isEnabledCached } = require('./config');
const { videoHeartStep } = require('./engagementModel');
const { displayViralViews } = require('../viralViews');
const { LOG_PREFIX } = require('./constants');

const RECENT_DAYS = 30;
const MAX_PER_RUN = 1000;

async function topUpVideoHearts() {
  if (!isEnabledCached()) return { skipped: 'flag_off' };
  try {
    const cutoff = new Date(Date.now() - RECENT_DAYS * 86400000);
    // Viral videos keep organic `views` = 0 (the shown count is synthetic via
    // displayViralViews ~200–800). So DON'T filter on views>0 (that excluded
    // every video); process recent active videos and base hearts on the
    // DISPLAYED view count, not the raw-0 field.
    const vids = await ViralVideo.find({
      isActive: { $ne: false },
      $or: [{ publishedAt: { $gte: cutoff } }, { createdAt: { $gte: cutoff } }],
    })
      .select('_id views publishedAt createdAt syntheticLikes syntheticDislikes')
      .sort({ publishedAt: -1 })
      .limit(MAX_PER_RUN)
      .lean();

    const ops = [];
    for (const v of vids) {
      const shownViews = displayViralViews(v); // organic(0) + synthetic 200–800
      const { likeStep, dislikeStep } = videoHeartStep(
        String(v._id), shownViews, v.syntheticLikes || 0, v.syntheticDislikes || 0
      );
      if (likeStep > 0 || dislikeStep > 0) {
        const inc = {};
        if (likeStep > 0) inc.syntheticLikes = likeStep;
        if (dislikeStep > 0) inc.syntheticDislikes = dislikeStep;
        ops.push({ updateOne: { filter: { _id: v._id }, update: { $inc: inc } } });
      }
    }
    if (ops.length) await ViralVideo.bulkWrite(ops, { ordered: false });
    return { scanned: vids.length, updated: ops.length };
  } catch (err) {
    console.error(`${LOG_PREFIX} videoHearts top-up error:`, err.message);
    return { error: err.message };
  }
}

module.exports = { topUpVideoHearts };
