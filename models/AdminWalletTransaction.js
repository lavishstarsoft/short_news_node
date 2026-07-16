const mongoose = require('mongoose');

const adminWalletTransactionSchema = new mongoose.Schema({
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
  type: {
    type: String,
    enum: ['credit', 'debit'],
    required: true
  },
  description: {
    type: String,
    required: true
  },
  balanceBefore: {
    type: Number,
    required: true
  },
  balanceAfter: {
    type: Number,
    required: true
  },
  referenceId: {
    type: String,
    unique: true, // Prevents double credits like reward_ID_DATE
    sparse: true
  },
  hash: {
    type: String,
    required: true // Cryptographic hash of prevHash + adminId + amount + balanceAfter + type + timestamp
  }
}, { timestamps: true });

module.exports = mongoose.model('AdminWalletTransaction', adminWalletTransactionSchema);
