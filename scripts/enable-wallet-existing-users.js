/**
 * One-time migration for per-reporter wallet config.
 *
 * Existing reporters already using the wallet (balance > 0, or any wallet
 * transaction, or any withdrawal request) get walletConfig.enabled = true
 * so their app experience doesn't break. Everyone else stays disabled
 * (admin can turn them on individually from the Editors page).
 *
 * Target/reward are left as null = global AppSettings defaults apply.
 *
 * Run: node scripts/enable-wallet-existing-users.js
 * Dry run (no writes): node scripts/enable-wallet-existing-users.js --dry
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Admin = require('../models/Admin');
const AdminWalletTransaction = require('../models/AdminWalletTransaction');
const WithdrawalRequest = require('../models/WithdrawalRequest');

const DRY_RUN = process.argv.includes('--dry');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  const [txAdminIds, wdAdminIds] = await Promise.all([
    AdminWalletTransaction.distinct('adminId'),
    WithdrawalRequest.distinct('adminId')
  ]);

  const activeWalletIds = new Set([
    ...txAdminIds.map(String),
    ...wdAdminIds.map(String)
  ]);

  const reporters = await Admin.find({ role: { $in: ['editor', 'subeditor'] } })
    .select('name username role walletBalance walletConfig')
    .lean();

  let enabled = 0;
  let alreadyEnabled = 0;
  let leftDisabled = 0;

  for (const r of reporters) {
    const hasWalletHistory =
      (r.walletBalance || 0) > 0 || activeWalletIds.has(String(r._id));

    if (r.walletConfig?.enabled === true) {
      alreadyEnabled++;
      continue;
    }

    if (!hasWalletHistory) {
      leftDisabled++;
      continue;
    }

    console.log(`ENABLE: ${r.name || r.username} (${r.role}) — balance ₹${r.walletBalance || 0}`);
    if (!DRY_RUN) {
      await Admin.updateOne(
        { _id: r._id },
        { $set: { 'walletConfig.enabled': true } }
      );
    }
    enabled++;
  }

  console.log('\n--- Summary ---');
  console.log(`Total editors/subeditors : ${reporters.length}`);
  console.log(`Newly enabled            : ${enabled}${DRY_RUN ? ' (dry run, not saved)' : ''}`);
  console.log(`Already enabled          : ${alreadyEnabled}`);
  console.log(`Left disabled            : ${leftDisabled}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
