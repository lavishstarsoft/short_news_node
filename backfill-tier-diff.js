'use strict';

/**
 * One-time backfill for the ₹5 shortfall caused by stringerMigrationCron silently
 * demoting district_incharge reporters back to 'stringer' every hour. While demoted,
 * their approved news earned the stringer rate (₹5) instead of the district_incharge
 * rate (₹10). This tops up the ₹5 difference for each affected news.
 *
 * SAFE:
 *  - Only news whose reward transaction (newsreward_<id>) is ₹5 AND was created on/after
 *    the reporter's earliest approved district_incharge request are topped up, so news
 *    earned while genuinely a stringer (before promotion) is never touched.
 *  - Idempotent: one top-up per news via unique referenceId `tierdiff_<newsId>`.
 *  - Re-running is harmless (already-topped-up news are skipped).
 *
 * Run from the app root:  node backfill-tier-diff.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const Admin = require('./models/Admin');
  const AdminWalletTransaction = require('./models/AdminWalletTransaction');
  const DistrictAssignmentRequest = require('./models/DistrictAssignmentRequest');
  const { processWalletTransaction } = require('./utils/walletHelpers');

  // Earliest district_incharge approval time per reporter = when ₹10 should have started.
  const cutoff = {};
  const reqs = await DistrictAssignmentRequest.find({ tier: 'district_incharge', status: 'approved' }).lean();
  for (const r of reqs) {
    const k = String(r.reporterId);
    const t = r.reviewedAt || r.updatedAt || r.createdAt;
    if (t && (!cutoff[k] || t < cutoff[k])) cutoff[k] = t;
  }

  let credited = 0, money = 0, skipped = 0, errors = 0;

  for (const k of Object.keys(cutoff)) {
    let oid = null;
    try { oid = new mongoose.Types.ObjectId(k); } catch (_) {}

    const txns = await AdminWalletTransaction.find({
      referenceId: /^newsreward_/,
      amount: 5,
      type: 'credit',
      createdAt: { $gte: cutoff[k] },
      $or: [{ adminId: oid }, { adminId: k }],
    }).lean();

    for (const tx of txns) {
      const newsId = String(tx.referenceId).replace('newsreward_', '');
      const ref = 'tierdiff_' + newsId;
      if (await AdminWalletTransaction.exists({ referenceId: ref })) { skipped++; continue; }
      try {
        await processWalletTransaction({
          adminId: tx.adminId,
          amount: 5,
          type: 'credit',
          description: `Tier correction (stringer -> district_incharge, +₹5) for approved news ${newsId}`,
          referenceId: ref,
        });
        credited++;
        money += 5;
      } catch (e) {
        if (/duplicate key/i.test(e.message || '') || e.code === 11000) skipped++;
        else { errors++; console.error('  ERR', newsId, '-', e.message); }
      }
    }
  }

  console.log('\n==================== TIER-DIFF BACKFILL DONE ====================');
  console.log(`News topped up : ${credited}`);
  console.log(`Total paid     : ₹${money}`);
  console.log(`Skipped        : ${skipped} (already topped up)`);
  console.log(`Errors         : ${errors}`);
  console.log(`district_incharge count: ${await Admin.countDocuments({ reporterTier: 'district_incharge' })}`);

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
