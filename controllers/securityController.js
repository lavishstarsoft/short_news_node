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

const unblockIdentifier = async (req, res) => {
  try {
    const { id } = req.params;
    await FraudBlocklist.findByIdAndDelete(id);
    return res.json({ success: true, message: 'Successfully unblocked' });
  } catch (error) {
    console.error('Error unblocking identifier:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

module.exports = {
  renderSecurityPage,
  blockIdentifier,
  unblockIdentifier
};
