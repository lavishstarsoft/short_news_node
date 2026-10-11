const mongoose = require('mongoose');

const withdrawalRequestSchema = new mongoose.Schema({
  adminId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
    required: true,
    index: true
  },
  amount: {
    type: Number,
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  paymentDetails: {
    type: String,
    required: true // e.g., UPI ID or Bank Details provided by the reporter
  },
  payoutMethodId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null
  },
  payoutType: {
    type: String,
    enum: ['upi', 'bank', 'phonepe'],
    default: null
  },
  processedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
    default: null
  },
  processedAt: {
    type: Date,
    default: null
  },
  remarks: {
    type: String,
    default: ''
  },
  // Bank/UPI transaction reference entered by admin when paying out
  utr: {
    type: String,
    default: ''
  },
  // Normalised payout destination ("upi:name@ybl" / "bank:<account no>") — lets the
  // system spot one UPI / bank account used by several reporter accounts.
  payoutKey: {
    type: String,
    default: null,
    index: true
  },
  // Reporter Security: same UPI / bank / mobile as another reporter account → the
  // request waits for Super Admin review. The reporter sees a normal pending request.
  fraudHold: {
    held: { type: Boolean, default: false },
    reasons: [{ kind: String, label: String, adminIds: [String] }],
    linkedAdminIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }],
    at: { type: Date, default: null },
    clearedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    clearedByName: { type: String, default: '' },
    clearedAt: { type: Date, default: null },
    clearNote: { type: String, default: '' }
  }
}, { timestamps: true });

module.exports = mongoose.model('WithdrawalRequest', withdrawalRequestSchema);
