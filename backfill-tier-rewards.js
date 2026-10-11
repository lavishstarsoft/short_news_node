'use strict';

/**
 * One-time backfill for per-news tier rewards that were MISSED while the
 * self-hosted MongoDB was a standalone (multi-document transactions require a
 * replica set). Crediting silently failed with:
 *   "Transaction numbers are only allowed on a replica set member or mongos"
 * from 2026-08-29T04:06:18Z (last successful reward) until the DB was converted
 * to a single-node replica set (rs0).
 *
 * SAFE:
 *  - Only news APPROVED strictly after the break cutoff are considered, so a
 *    reporter's pre-tier-conversion history is never retro-paid (no double pay
 *    on top of the old daily-bonus they already earned).
 *  - Reuses creditApprovedNewsReward → idempotent (unique referenceId, skips
 *    already-credited) and daily-cap aware (first 10 approved news/IST day).
 *  - Re-running is harmless: everything already paid is skipped.
 *
 * Run from the app root:  node backfill-tier-rewards.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

// Last successful per-news reward before the standalone-DB break. Only approvals
// after this instant are backfilled.
const BREAK = new Date('2026-08-29T04:06:18.082Z');

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI not set (.env not loaded?)'); process.exit(1); }
  await mongoose.connect(uri);
  console.log('Connected. Break cutoff (approvedAt >):', BREAK.toISOString());

  const Admin = require('./models/Admin');
  const News = require('./models/News');
  const { creditApprovedNewsReward } = require('./utils/tierRewardService');

  const tiered = await Admin.find({ reporterTier: { $in: ['stringer', 'district_incharge'] } })
    .select('name reporterTier').lean();
  console.log('Tiered reporters:', tiered.length);

  let credited = 0, money = 0, skipped = 0, errors = 0, reportersPaid = 0;

  for (const rep of tiered) {
    const list = await News.find({
      authorId: String(rep._id),
      isActive: true,
      'approvalStatus.isApproved': true,
      'rejectionStatus.isRejected': { $ne: true },
      'approvalStatus.approvedAt': { $gt: BREAK },
    }).sort({ _id: 1 });

    if (!list.length) continue;
    let repCredited = 0, repMoney = 0;

    for (const news of list) {
      try {
        const r = await creditApprovedNewsReward({ news, reporterAdmin: rep });
        if (r.action === 'credited') { credited++; money += r.amount; repCredited++; repMoney += r.amount; }
        else skipped++;
      } catch (e) {
        errors++;
        console.error('  ERR', String(news._id), '-', e.message);
      }
    }

    if (repCredited > 0) {
      reportersPaid++;
      console.log(`  ${rep.name} (${rep.reporterTier}): +${repCredited} news = +₹${repMoney}`);
    }
  }

  console.log('\n==================== BACKFILL DONE ====================');
  console.log(`Reporters paid : ${reportersPaid}`);
  console.log(`News credited  : ${credited}`);
  console.log(`Total paid     : ₹${money}`);
  console.log(`Skipped        : ${skipped} (already-credited / over daily cap / zero-rate)`);
  console.log(`Errors         : ${errors}`);

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
