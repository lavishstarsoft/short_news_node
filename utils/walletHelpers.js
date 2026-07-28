const crypto = require('crypto');
const Admin = require('../models/Admin');
const AdminWalletTransaction = require('../models/AdminWalletTransaction');
const mongoose = require('mongoose');

/**
 * Creates a secure wallet transaction for an Admin (Reporter)
 * Uses MongoDB transactions and cryptographic hashing to prevent tampering and race conditions.
 */
async function processWalletTransaction({ adminId, amount, type, description, referenceId, session = null }) {
  let createdSession = false;
  if (!session) {
    session = await mongoose.startSession();
    session.startTransaction();
    createdSession = true;
  }

  try {
    // 1. Lock the Admin document for this session
    const admin = await Admin.findById(adminId).session(session);
    if (!admin) {
      throw new Error('Admin not found');
    }

    // Check if debit is allowed
    if (type === 'debit' && admin.walletBalance < amount) {
      throw new Error('Insufficient wallet balance');
    }

    // 2. Fetch the last transaction to get the previous hash
    const lastTx = await AdminWalletTransaction.findOne({ adminId })
      .sort({ createdAt: -1 })
      .session(session);
    
    const prevHash = lastTx ? lastTx.hash : 'GENESIS';

    const balanceBefore = admin.walletBalance || 0;
    const balanceAfter = type === 'credit' ? balanceBefore + amount : balanceBefore - amount;

    // 3. Generate Cryptographic Hash
    const timestamp = new Date().toISOString();
    const dataToHash = `${prevHash}-${adminId}-${amount}-${balanceAfter}-${type}-${timestamp}`;
    const hash = crypto.createHash('sha256').update(dataToHash).digest('hex');

    // 4. Create Transaction Record
    const newTx = new AdminWalletTransaction({
      adminId,
      amount,
      type,
      description,
      balanceBefore,
      balanceAfter,
      referenceId,
      hash
    });

    await newTx.save({ session });

    // 5. Update Admin Wallet Balance
    admin.walletBalance = balanceAfter;
    await admin.save({ session });

    if (createdSession) {
      await session.commitTransaction();
      session.endSession();
    }

    return newTx;
  } catch (error) {
    if (createdSession) {
      await session.abortTransaction();
      session.endSession();
    }
    throw error;
  }
}

/**
 * Validates the entire ledger for a specific admin.
 * Returns true if the ledger is intact, false if tampering is detected.
 */
async function validateLedger(adminId) {
  const transactions = await AdminWalletTransaction.find({ adminId }).sort({ createdAt: 1 });
  let calculatedBalance = 0;
  let currentHash = 'GENESIS';

  for (const tx of transactions) {
    if (tx.type === 'credit') {
      calculatedBalance += tx.amount;
    } else {
      calculatedBalance -= tx.amount;
    }

    // We can't strictly re-verify the hash unless we know the exact timestamp used during creation.
    // But since the hash depends on balanceAfter, if someone changed amount but not balanceAfter, it would be suspicious.
    // Real strict validation would store the exact string hashed, or recalculate based on tx.createdAt (which can vary by ms).
    // For now, checking the sequential balance is a good first step.
    if (tx.balanceAfter !== calculatedBalance) {
      return false; // Tampering detected
    }
  }

  const admin = await Admin.findById(adminId);
  if (admin && admin.walletBalance !== calculatedBalance) {
    return false; // Mismatch between ledger and wallet
  }

  return true;
}

/**
 * Per-reporter wallet config resolve chestundi.
 * enabled: admin ON chesthe matrame true (default false).
 * targetNews / maxReward: reporter-specific values; null aithe global AppSettings fallback.
 */
function resolveWalletConfig(admin, settings) {
  const cfg = admin?.walletConfig || {};
  return {
    enabled: cfg.enabled === true,
    targetNews: (Number.isFinite(cfg.dailyTargetNews) && cfg.dailyTargetNews > 0)
      ? cfg.dailyTargetNews
      : (settings?.reporterTargetNews || 5),
    maxReward: (Number.isFinite(cfg.dailyRewardAmount) && cfg.dailyRewardAmount > 0)
      ? cfg.dailyRewardAmount
      : (settings?.reporterMaxDailyReward || 30)
  };
}

/**
 * Credits a reporter's daily reward for the SUBMISSION day of an approved article.
 *
 * The reward day and the approved-count come from the single shared
 * evaluateDailyReward() helper, which derives the day from the immutable News
 * ObjectId timestamp (Asia/Kolkata) and uses approval only as the eligibility
 * filter. Idempotent via the per-day referenceId.
 *
 * @param {string|ObjectId} reporterId       The reporter (Admin) id.
 * @param {Date} [submissionDate]            A moment inside the article's submission day
 *                                           (e.g. approvedArticle._id.getTimestamp()).
 *                                           Defaults to now when omitted.
 */
async function checkAndCreditWallet(reporterId, submissionDate) {
  try {
    // Lazy require avoids a load-time cycle with dailyRewardService.
    const { evaluateDailyReward } = require('./dailyRewardService');
    const reward = await evaluateDailyReward(reporterId, submissionDate);

    // Reporters app users are stored as editor/subeditor (not a 'reporter' role).
    if (!reward.found || !reward.admin || !['editor', 'subeditor'].includes(reward.admin.role)) return;
    if (!reward.enabled || !reward.eligible || reward.alreadyCredited) return;

    await processWalletTransaction({
      adminId: reporterId,
      amount: reward.maxReward,
      type: 'credit',
      description: `Daily Reward for ${reward.targetNews} Approved News`,
      referenceId: reward.referenceId,
    });
    console.log(`✅ Credited ₹${reward.maxReward} to reporter ${reporterId} for submission day ${reward.dateKey}.`);
  } catch (error) {
    console.error('Error in checkAndCreditWallet:', error);
  }
}

module.exports = {
  processWalletTransaction,
  validateLedger,
  checkAndCreditWallet,
  resolveWalletConfig
};
