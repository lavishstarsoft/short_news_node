const express = require('express');
const router = express.Router();
const Referral = require('../models/Referral');
const User = require('../models/User');
const AppSettings = require('../models/AppSettings');
const WalletTransaction = require('../models/WalletTransaction');
const PendingReferral = require('../models/PendingReferral');
const playIntegrityService = require('../services/playIntegrityService');
const hmacAuth = require('../middleware/hmacAuth');

// ============================================================
// 🔐 FRAUD CHECK CONSTANTS
// ============================================================
const MAX_IP_CLAIMS_PER_DAY = 3;
const MIN_APP_OPENS = 3;
const MIN_USAGE_MINUTES = 5;

// ============================================================
// POST /api/public/referral/claim
// Called by Flutter app after install + Google Sign-In
// ============================================================
router.post('/api/public/referral/claim', hmacAuth, async (req, res) => {
  try {
    const {
      referralCode,
      referredUserId,
      referredEmail,
      deviceFingerprint,
      installReferrerData,
      integrityToken
    } = req.body;

    // --- Basic validation ---
    if (!referralCode || !referredUserId || !deviceFingerprint || !integrityToken) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: referralCode, referredUserId, deviceFingerprint, integrityToken'
      });
    }

    // --- Fetch Dynamic App Settings ---
    const appSettings = await AppSettings.findOne({ key: 'update_flags' });
    const rewardAmount = appSettings?.referralRewardAmount || 5;
    const requiredDays = appSettings?.referralRequiredDays || 7;

    let fraudScore = 0;

    // --- Fraud Check 0: Play Integrity ---
    const integrityResult = await playIntegrityService.verifyToken(integrityToken);
    const integrityData = integrityResult.details || { verdict: integrityResult.reason };

    if (!integrityResult.isValid) {
      const referrer = await User.findOne({ referralCode: referralCode });
      if (referrer) {
        await Referral.create({
          referrerUserId: referrer.googleId,
          referrerEmail: referrer.email,
          referredUserId: referredUserId,
          referredEmail: referredEmail,
          referralCode: referralCode,
          deviceFingerprint: deviceFingerprint,
          status: 'rejected',
          rejectionReason: 'play_integrity_failed: ' + integrityResult.reason,
          integrityData: integrityData
        });
      }
      return res.status(403).json({ success: false, error: 'App Integrity Check Failed' });
    }

    // --- Fraud Check 1: Does the referral code exist? ---
    const referrer = await User.findOne({ referralCode: referralCode });
    if (!referrer) {
      return res.status(404).json({
        success: false,
        error: 'Invalid referral code'
      });
    }

    // --- Fraud Check 2: Self-referral block ---
    if (referrer.googleId === referredUserId) {
      return res.status(403).json({
        success: false,
        error: 'Self-referral is not allowed'
      });
    }

    // --- Fraud Check 3: Duplicate user check ---
    const existingUserReferral = await Referral.findOne({ referredUserId: referredUserId });
    if (existingUserReferral) {
      return res.status(409).json({
        success: false,
        error: 'This user has already used a referral code'
      });
    }

    // --- Fraud Check 4: Same device already claimed ---
    const existingDeviceReferral = await Referral.findOne({
      deviceFingerprint: deviceFingerprint,
      status: { $ne: 'rejected' }
    });
    if (existingDeviceReferral) {
      return res.status(409).json({
        success: false,
        error: 'A referral has already been claimed from this device'
      });
    }

    // --- Fraud Check 5: IP rate limiting ---
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentIpClaims = await Referral.countDocuments({
      installIp: clientIp,
      createdAt: { $gte: twentyFourHoursAgo },
      status: { $ne: 'rejected' }
    });
    if (recentIpClaims >= MAX_IP_CLAIMS_PER_DAY) {
      return res.status(429).json({
        success: false,
        error: 'Too many referral claims from this network. Please try again later.'
      });
    }

    // --- Fraud Check 6: Velocity Check (Prevent coordinated attacks) ---
    const tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000);
    const velocityIpClaims = await Referral.countDocuments({
      installIp: clientIp,
      createdAt: { $gte: tenMinsAgo }
    });
    if (velocityIpClaims >= 2) {
      // 2 claims from same IP in 10 mins is highly suspicious
      return res.status(429).json({
        success: false,
        error: 'Too many requests. Please slow down.'
      });
    }

    if (recentIpClaims == 1) fraudScore += 20;
    if (recentIpClaims == 2) fraudScore += 40;

    // --- All fraud checks passed! Create the referral ---
    const referral = new Referral({
      referrerUserId: referrer.googleId,
      referrerEmail: referrer.email,
      referredUserId: referredUserId,
      referredEmail: referredEmail || null,
      referralCode: referralCode,
      deviceFingerprint: deviceFingerprint,
      installIp: clientIp,
      installReferrerData: installReferrerData || null,
      status: fraudScore > 50 ? 'rejected' : 'pending',
      rejectionReason: fraudScore > 50 ? 'high_fraud_risk' : null,
      commissionAmount: rewardAmount,
      requiredUsageDays: requiredDays,
      fraudScore: fraudScore,
      integrityData: integrityData
    });

    await referral.save();

    // Update the referred user's record
    await User.findOneAndUpdate(
      { googleId: referredUserId },
      { $set: { referredBy: referralCode, deviceFingerprint: deviceFingerprint } }
    );

    console.log(`✅ [Referral] New claim: ${referredUserId} via ${referralCode} (referrer: ${referrer.googleId})`);

    return res.status(201).json({
      success: true,
      message: 'Referral claimed successfully! Commission will be released after 7-day verification.',
      referralId: referral._id,
      status: 'pending'
    });

  } catch (error) {
    // Handle MongoDB duplicate key error gracefully
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        error: 'This referral has already been processed'
      });
    }
    console.error('❌ [Referral] Claim error:', error);
    return res.status(500).json({ success: false, error: 'Server error processing referral' });
  }
});

// ============================================================
// GET /api/public/referral/my-stats/:userId
// Get user's referral stats and wallet info
// ============================================================
router.get('/api/public/referral/my-stats/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({ success: false, error: 'userId is required' });
    }

    const user = await User.findOne({ googleId: userId }).select(
      'referralCode walletBalance totalEarned totalReferrals'
    );

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Get referral breakdown
    const [pending, verified, rejected] = await Promise.all([
      Referral.countDocuments({ referrerUserId: userId, status: 'pending' }),
      Referral.countDocuments({ referrerUserId: userId, status: { $in: ['verified', 'paid'] } }),
      Referral.countDocuments({ referrerUserId: userId, status: 'rejected' })
    ]);

    // Get recent referrals
    const recentReferrals = await Referral.find({ referrerUserId: userId })
      .sort({ createdAt: -1 })
      .limit(20)
      .select('referredEmail status commissionAmount createdAt verifiedAt rejectionReason');

    // Get dynamic app settings
    const appSettings = await AppSettings.findOne({ key: 'update_flags' });

    return res.json({
      success: true,
      referralCode: user.referralCode,
      walletBalance: user.walletBalance || 0,
      totalEarned: user.totalEarned || 0,
      rewardAmount: appSettings?.referralRewardAmount || 5,
      requiredDays: appSettings?.referralRequiredDays || 7,
      shareUrl: appSettings?.referralShareUrl || 'https://play.google.com/store/apps/details?id=com.lavish.yellowsingam',
      stats: {
        total: pending + verified + rejected,
        pending,
        verified,
        rejected
      },
      recentReferrals: recentReferrals.map(r => ({
        email: r.referredEmail ? r.referredEmail.replace(/(.{2}).*(@.*)/, '$1***$2') : 'Unknown',
        status: r.status,
        amount: r.commissionAmount,
        date: r.createdAt,
        verifiedAt: r.verifiedAt,
        rejectionReason: r.rejectionReason
      }))
    });

  } catch (error) {
    console.error('❌ [Referral] Stats error:', error);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================
// POST /api/public/referral/track-usage
// Called periodically by Flutter app to report usage
// ============================================================
router.post('/api/public/referral/track-usage', async (req, res) => {
  try {
    const { userId, appOpenCount, sessionDurationMinutes } = req.body;

    if (!userId) {
      return res.status(400).json({ success: false, error: 'userId is required' });
    }

    // Find the pending referral for this user
    const referral = await Referral.findOne({
      referredUserId: userId,
      status: 'pending'
    });

    if (!referral) {
      return res.json({ success: true, message: 'No pending referral found' });
    }

    // Update usage stats
    referral.appOpenCount = Math.max(referral.appOpenCount, appOpenCount || 0);
    referral.totalUsageMinutes = Math.max(referral.totalUsageMinutes, sessionDurationMinutes || 0);
    referral.lastUsageUpdate = new Date();
    await referral.save();

    // Check if eligible for early verification
    const daysSinceInstall = (Date.now() - referral.createdAt.getTime()) / (1000 * 60 * 60 * 24);
    const requiredDays = referral.requiredUsageDays || 7;

    if (
      daysSinceInstall >= requiredDays &&
      referral.appOpenCount >= MIN_APP_OPENS &&
      referral.totalUsageMinutes >= MIN_USAGE_MINUTES
    ) {
      // --- Global Daily Limit (Budget) Check ---
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const payoutsToday = await WalletTransaction.aggregate([
        { $match: { createdAt: { $gte: todayStart }, type: 'credit' } },
        { $group: { _id: null, totalAmount: { $sum: '$amount' } } }
      ]);
      const totalDisbursedToday = payoutsToday.length > 0 ? payoutsToday[0].totalAmount : 0;

      const appSettings = await AppSettings.findOne({ key: 'update_flags' });
      const dailyBudget = appSettings?.maxDailyReferralBudget || 5000;

      if (totalDisbursedToday + referral.commissionAmount > dailyBudget) {
        // Exceeded budget, hold for manual review
        referral.status = 'manual_review';
        await referral.save();
        console.warn(`⚠️ [Referral] Budget Exceeded! Referral ${referral._id} put in manual_review`);
      } else {
        // Auto-verify and credit commission
        referral.status = 'verified';
        referral.verifiedAt = new Date();
        await referral.save();

        // 1. Create Wallet Transaction (Ledger)
        await WalletTransaction.create({
          userId: referral.referrerUserId,
          amount: referral.commissionAmount,
          type: 'credit',
          description: `Referral Bonus for inviting ${referral.referredEmail || referral.referredUserId}`,
          referenceId: referral._id
        });

        // 2. Credit the referrer's wallet
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

        console.log(`💰 [Referral] Commission ₹${referral.commissionAmount} credited to ${referral.referrerUserId}`);
      }
    }

    return res.json({
      success: true,
      status: referral.status,
      daysRemaining: Math.max(0, Math.ceil(requiredDays - daysSinceInstall))
    });

  } catch (error) {
    console.error('❌ [Referral] Track usage error:', error);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================
// GET /api/public/invite/:code
// Redirect endpoint: saves fingerprint, then sends user to Play Store
// ============================================================
router.get('/api/public/invite/:code', async (req, res) => {
  try {
    const { code } = req.params;
    if (!code || code.length < 4 || code.length > 20) {
      return res.status(400).send('Invalid referral code');
    }

    // Verify the referral code belongs to a real user
    const referrer = await User.findOne({ referralCode: code });
    if (!referrer) {
      // Even if invalid code, redirect to Play Store anyway
      console.log(`⚠️ [Invite] Invalid referral code: ${code}, redirecting anyway`);
      return res.redirect(`https://play.google.com/store/apps/details?id=com.lavish.yellowsingam`);
    }

    // Save fingerprint for fallback matching
    const ipAddress = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'] || 'unknown';

    await PendingReferral.create({
      referralCode: code,
      ipAddress,
      userAgent
    });

    console.log(`🔗 [Invite] Saved fingerprint for code ${code} | IP: ${ipAddress}`);

    // Redirect to Play Store with referrer parameter
    const playStoreUrl = `https://play.google.com/store/apps/details?id=com.lavish.yellowsingam&referrer=${code}`;
    return res.redirect(playStoreUrl);

  } catch (error) {
    console.error('❌ [Invite] Error:', error);
    // On error, still redirect to Play Store
    return res.redirect('https://play.google.com/store/apps/details?id=com.lavish.yellowsingam');
  }
});

// ============================================================
// GET /invite/:code  (CLEAN SHORT URL)
// Same as above but with a clean, shareable URL
// e.g. https://www.news.cbnyellowsingam.in/invite/E54F5FD8
// ============================================================
router.get('/invite/:code', async (req, res) => {
  try {
    const { code } = req.params;
    if (!code || code.length < 4 || code.length > 20) {
      return res.status(400).send('Invalid referral code');
    }

    const referrer = await User.findOne({ referralCode: code });
    if (!referrer) {
      console.log(`⚠️ [Invite] Invalid referral code: ${code}, redirecting anyway`);
      return res.redirect(`https://play.google.com/store/apps/details?id=com.lavish.yellowsingam`);
    }

    const ipAddress = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'] || 'unknown';

    await PendingReferral.create({
      referralCode: code,
      ipAddress,
      userAgent
    });

    console.log(`🔗 [Invite-Short] Saved fingerprint for code ${code} | IP: ${ipAddress}`);

    const playStoreUrl = `https://play.google.com/store/apps/details?id=com.lavish.yellowsingam&referrer=${code}`;
    return res.redirect(playStoreUrl);

  } catch (error) {
    console.error('❌ [Invite] Error:', error);
    return res.redirect('https://play.google.com/store/apps/details?id=com.lavish.yellowsingam');
  }
});

// ============================================================
// POST /api/public/referral/fallback-match
// Called by Flutter app when PlayInstallReferrer returns organic/null
// Matches device fingerprint to recover the lost referral code
// ============================================================
router.post('/api/public/referral/fallback-match', async (req, res) => {
  try {
    const { deviceInfo } = req.body;

    // Get the IP of the app making this request
    const ipAddress = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.connection.remoteAddress;

    // Find a PendingReferral created in the last 1 hour from this same IP
    const pending = await PendingReferral.findOne({
      ipAddress: ipAddress
    }).sort({ createdAt: -1 }); // Most recent first

    if (!pending) {
      return res.json({ success: false, referralCode: null, reason: 'no_match' });
    }

    console.log(`🎯 [Fallback] Matched IP ${ipAddress} to referral code ${pending.referralCode}`);

    // Delete the pending record so it can't be reused
    await PendingReferral.deleteOne({ _id: pending._id });

    return res.json({
      success: true,
      referralCode: pending.referralCode
    });

  } catch (error) {
    console.error('❌ [Fallback] Error:', error);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

module.exports = router;
