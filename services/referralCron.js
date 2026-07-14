const Referral = require('../models/Referral');
const User = require('../models/User');

// ============================================================
// 🕐 Referral Verification Cron Job
// Runs every hour to check pending referrals that are > 7 days old
// ============================================================

const RETENTION_DAYS = 7;
const MIN_APP_OPENS = 3;
const MIN_USAGE_MINUTES = 5;

async function processExpiredReferrals() {
  try {
    const cutoffDate = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

    // Find all pending referrals older than 7 days
    const expiredReferrals = await Referral.find({
      status: 'pending',
      createdAt: { $lte: cutoffDate }
    });

    if (expiredReferrals.length === 0) return;

    console.log(`🔍 [ReferralCron] Processing ${expiredReferrals.length} expired pending referrals...`);

    for (const referral of expiredReferrals) {
      const meetsUsage =
        referral.appOpenCount >= MIN_APP_OPENS &&
        referral.totalUsageMinutes >= MIN_USAGE_MINUTES;

      if (meetsUsage) {
        // ✅ Verified — credit commission
        referral.status = 'verified';
        referral.verifiedAt = new Date();
        await referral.save();

        await User.findOneAndUpdate(
          { googleId: referral.referrerUserId },
          {
            $inc: {
              walletBalance: referral.commissionAmount,
              totalEarned: referral.commissionAmount,
              totalReferrals: 1
            }
          }
        );

        console.log(`💰 [ReferralCron] Verified & credited ₹${referral.commissionAmount} for referral ${referral._id}`);
      } else {
        // ❌ Rejected — insufficient usage
        referral.status = 'rejected';
        referral.rejectionReason = 'insufficient_usage';
        await referral.save();

        console.log(`❌ [ReferralCron] Rejected referral ${referral._id} (opens: ${referral.appOpenCount}, mins: ${referral.totalUsageMinutes})`);
      }
    }

    console.log(`✅ [ReferralCron] Finished processing ${expiredReferrals.length} referrals`);
  } catch (error) {
    console.error('❌ [ReferralCron] Error:', error);
  }
}

// Start the cron job (runs every hour)
function startReferralCron() {
  // Run immediately once on server start
  processExpiredReferrals();

  // Then run every hour
  const INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  setInterval(processExpiredReferrals, INTERVAL_MS);

  console.log('🕐 [ReferralCron] Started — runs every hour to verify pending referrals');
}

module.exports = { startReferralCron, processExpiredReferrals };
