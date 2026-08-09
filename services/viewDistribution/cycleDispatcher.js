'use strict';

/**
 * cycleDispatcher.js — routes a cycle job to the correct handler by campaign.mode.
 *   - 'per_news_window' => windowApplier (per-news frozen-target window growth)
 *   - anything else (incl. undefined/'production') => applier (existing engine, unchanged)
 *
 * One tiny projected read per cycle; production behavior is byte-for-byte the same.
 */

const applier = require('./applier');
const windowApplier = require('./windowApplier');
const ViewCampaign = require('./models/ViewCampaign');

async function processCycle(job) {
  if (!job || !job.campaignId) return applier.processCycle(job);
  let mode;
  try {
    const c = await ViewCampaign.findById(job.campaignId).select('mode').lean();
    mode = c && c.mode;
  } catch (_) {
    mode = undefined; // fail safe => production path
  }
  if (mode === 'per_news_window') return windowApplier.processCycle(job);
  return applier.processCycle(job);
}

module.exports = { processCycle };
