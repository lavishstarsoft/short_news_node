'use strict';

/**
 * Move an APPROVED withdrawal back to PENDING — ledger-safe.
 *
 * Approving a withdrawal DEBITS the reporter's wallet (and writes a
 * hash-chained AdminWalletTransaction). So reverting is NOT just a status flip:
 * this script CREDITS the amount back through the same wallet helper (keeping
 * the tamper-evident ledger valid), then sets the request to pending and clears
 * the processed fields. Only ever touches a request whose status is 'approved'.
 *
 * Usage (run on the server, inside /var/www/yellowsingam):
 *   node scripts/revert_withdrawal.js "<withdrawalId | UPI/paymentDetails text>"            # DRY RUN — shows the record, changes nothing
 *   node scripts/revert_withdrawal.js "<withdrawalId | UPI/paymentDetails text>" --confirm   # applies the revert
 *
 * Example:
 *   node scripts/revert_withdrawal.js "sanjeev4sk-1@oksbi"
 *   node scripts/revert_withdrawal.js "sanjeev4sk-1@oksbi" --confirm
 */

require('dotenv').config();
const mongoose = require('mongoose');
const WithdrawalRequest = require('../models/WithdrawalRequest');
const Admin = require('../models/Admin');
const { processWalletTransaction } = require('../utils/walletHelpers');

(async () => {
  const arg = process.argv[2];
  const confirm = process.argv.includes('--confirm');
  if (!arg) {
    console.error('Usage: node scripts/revert_withdrawal.js "<withdrawalId | UPI text>" [--confirm]');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  try {
    // 1) Locate the request — by exact _id, else by paymentDetails text among APPROVED ones.
    let w;
    if (mongoose.isValidObjectId(arg)) {
      w = await WithdrawalRequest.findById(arg);
    } else {
      const matches = await WithdrawalRequest.find({
        paymentDetails: new RegExp(arg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
        status: 'approved',
      });
      if (matches.length === 0) {
        console.log(`No APPROVED withdrawal matches "${arg}". Nothing to do.`);
        return;
      }
      if (matches.length > 1) {
        console.log('Multiple APPROVED matches — re-run with the exact _id of the one you want:');
        matches.forEach((m) => {
          const req = m.createdAt ? new Date(m.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '?';
          const prc = m.processedAt ? new Date(m.processedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '?';
          console.log(`  ${m._id.toString()}  ₹${m.amount}  requested=${req}  processed=${prc}  utr="${m.utr || ''}"  remarks="${m.remarks || ''}"`);
        });
        return;
      }
      w = matches[0];
    }

    if (!w) { console.log('Withdrawal not found.'); return; }

    const admin = await Admin.findById(w.adminId).select('name username walletBalance').lean();
    console.log('── Withdrawal found ─────────────────────────────');
    console.log('  id        :', w._id.toString());
    console.log('  reporter  :', (admin && (admin.name || admin.username)) || String(w.adminId));
    console.log('  amount    : ₹' + w.amount);
    console.log('  status    :', w.status);
    console.log('  payment   :', w.paymentDetails);
    console.log('  walletBal : ₹' + ((admin && admin.walletBalance) ?? '?'));
    console.log('─────────────────────────────────────────────────');

    if (w.status !== 'approved') {
      console.log(`Status is "${w.status}", not "approved" — nothing to revert.`);
      return;
    }

    if (!confirm) {
      console.log('\nDRY RUN (no changes made). Applying would:');
      console.log(`  1. CREDIT ₹${w.amount} back to this reporter's wallet (ledger-safe).`);
      console.log('  2. Set the request status → pending, clear UTR/remarks/processed fields.');
      console.log('\nRe-run with --confirm to apply.');
      return;
    }

    // 2) Ledger-safe credit back (reverses the approve-time debit).
    const tx = await processWalletTransaction({
      adminId: w.adminId,
      amount: w.amount,
      type: 'credit',
      description: `Reversal — withdrawal ${w._id} moved back to pending (approved by mistake)`.slice(0, 200),
    });
    console.log(`✅ Wallet credited ₹${w.amount}. New balance: ₹${tx.balanceAfter}`);

    // 3) Reset the request to pending.
    w.status = 'pending';
    w.processedBy = null;
    w.processedAt = null;
    w.utr = '';
    w.remarks = '';
    await w.save();
    console.log('✅ Withdrawal reset to PENDING. Done.');
  } finally {
    await mongoose.disconnect();
  }
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
