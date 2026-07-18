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
    enum: ['upi', 'bank'],
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
  }
}, { timestamps: true });

module.exports = mongoose.model('WithdrawalRequest', withdrawalRequestSchema);
