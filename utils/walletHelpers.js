const crypto = require('crypto');
const Admin = require('../models/Admin');
const AdminWalletTransaction = require('../models/AdminWalletTransaction');
const mongoose = require('mongoose');
const News = require('../models/News');
const AppSettings = require('../models/AppSettings');

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
 * Checks today's approved news count for a reporter.
 * If they hit the target, credits the daily max reward.
 */
async function checkAndCreditWallet(reporterId) {
  try {
    const admin = await Admin.findById(reporterId);
    // Reporters app users are stored as editor/subeditor (not a 'reporter' role)
    if (!admin || !['editor', 'subeditor'].includes(admin.role)) return;

    const settings = await AppSettings.findOne({ key: 'update_flags' });
    const { enabled, targetNews, maxReward } = resolveWalletConfig(admin, settings);

    // Wallet OFF unna reporter ki daily reward credit avvadu
    if (!enabled) return;

    // Get today's start and end date (server local; IST hosts use IST)
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    // Count approved news for today
    const approvedCount = await News.countDocuments({
      authorId: reporterId,
      isActive: true,
      'approvalStatus.isApproved': true,
      'approvalStatus.approvedAt': { $gte: startOfDay, $lte: endOfDay }
    });

    if (approvedCount >= targetNews) {
      // Hit the daily target — credit once per day
      const dateString = startOfDay.toISOString().split('T')[0];
      const referenceId = `reward_${reporterId}_${dateString}`;

      // Check if already credited
      const existingTx = await AdminWalletTransaction.findOne({ referenceId });
      if (!existingTx) {
        await processWalletTransaction({
          adminId: reporterId,
          amount: maxReward,
          type: 'credit',
          description: `Daily Reward for ${targetNews} Approved News`,
          referenceId: referenceId
        });
        console.log(`✅ Credited ₹${maxReward} to reporter ${reporterId} for reaching daily target.`);
      }
    }
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
