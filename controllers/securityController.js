const Admin = require('../models/Admin');
const Referral = require('../models/Referral');
const PendingReferral = require('../models/PendingReferral');
const FraudBlocklist = require('../models/FraudBlocklist');

const renderSecurityPage = async (req, res) => {
  try {
    const admin = await Admin.findById(req.session.adminId);
    if (!admin) {
      return res.redirect('/admin/login');
    }

    // Aggregate Pending Referrals by IP (to find IP spam)
    const ipAggregations = await PendingReferral.aggregate([
      { $group: { _id: "$ipAddress", clickCount: { $sum: 1 }, latestClick: { $max: "$createdAt" } } },
      { $match: { clickCount: { $gt: 1 } } },
      { $sort: { clickCount: -1 } },
      { $limit: 50 }
    ]);

    // Aggregate Referrals by Device Fingerprint (to find Device spam)
    const deviceAggregations = await Referral.aggregate([
      { $match: { deviceFingerprint: { $ne: null } } },
      { $group: { _id: "$deviceFingerprint", claimCount: { $sum: 1 }, latestClaim: { $max: "$createdAt" } } },
      { $match: { claimCount: { $gt: 1 } } },
      { $sort: { claimCount: -1 } },
      { $limit: 50 }
    ]);

    // Fetch Blocklist
    const blocklist = await FraudBlocklist.find().sort({ blockedAt: -1 }).populate('blockedBy', 'username');

    res.render('security', {
      admin,
      activePage: 'security',
      title: 'Security & Fraud Control',
      ipAggregations,
      deviceAggregations,
      blocklist,
      isImpersonating: !!req.session.originalAdminId
    });
  } catch (error) {
    console.error('Error rendering security page:', error);
    res.status(500).send('Server Error');
  }
};

const blockIdentifier = async (req, res) => {
  try {
    const { identifier, type, reason } = req.body;
    
    if (!identifier || !type) {
      return res.status(400).json({ success: false, message: 'Missing identifier or type' });
    }

    // Check if already blocked
    const existing = await FraudBlocklist.findOne({ identifier });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Already blocked' });
    }

    const newBlock = new FraudBlocklist({
      identifier,
      type,
      reason: reason || 'Suspicious activity flagged by admin',
      blockedBy: req.session.adminId
    });

    await newBlock.save();
    return res.json({ success: true, message: 'Successfully blocked' });

  } catch (error) {
    console.error('Error blocking identifier:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

const clearDeviceLogs = async (req, res) => {
  try {
    const { identifier, type, password } = req.body;
    
    // Check .env password
    const envPassword = process.env.USER_DELETE_PASSWORD || process.env.REJECTED_NEWS_DELETE_PASSWORD;
    if (!password || password !== envPassword) {
      return res.status(401).json({ success: false, message: 'Invalid admin password' });
    }

    if (!identifier) {
      return res.status(400).json({ success: false, message: 'Missing identifier' });
    }

    // 1. Remove from Blocklist
    await FraudBlocklist.deleteMany({ identifier });

    // 2. Clear from PendingReferral (if IP)
    await PendingReferral.deleteMany({ ipAddress: identifier });

    // 3. Clear from Referral (if Device Fingerprint)
    await Referral.deleteMany({ deviceFingerprint: identifier });

    return res.json({ success: true, message: 'Successfully cleared logs and unblocked device/IP' });
  } catch (error) {
    console.error('Error clearing device logs:', error);
    return res.status(500).json({ success: false, message: 'Server error while clearing logs' });
  }
};

module.exports = {
  renderSecurityPage,
  blockIdentifier,
  clearDeviceLogs
};
