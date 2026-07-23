/**
 * Enable wallet for ALL Reporters (role: editor) on the Editors page.
 *
 * - Does NOT touch admin / superadmin / subeditor
 * - Sets walletConfig.enabled = true
 * - Leaves dailyTargetNews / dailyRewardAmount as-is (null = AppSettings defaults)
 *
 * Run from Node folder:
 *   node scripts/enable-wallet-all-reporters.js
 *
 * Dry run (no writes):
 *   node scripts/enable-wallet-all-reporters.js --dry
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Admin = require('../models/Admin');

const DRY_RUN = process.argv.includes('--dry');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  console.log('Connected to MongoDB');
  console.log(DRY_RUN ? 'Mode: DRY RUN (no writes)\n' : 'Mode: LIVE update\n');

  const reporters = await Admin.find({ role: 'editor' })
    .select('name username walletConfig isActive')
    .lean();

  let newlyEnabled = 0;
  let alreadyEnabled = 0;

  for (const r of reporters) {
    if (r.walletConfig?.enabled === true) {
      alreadyEnabled++;
      continue;
    }

    console.log(`ENABLE: ${r.name || r.username} (${r.username})`);
    if (!DRY_RUN) {
      await Admin.updateOne(
        { _id: r._id },
        {
          $set: {
            'walletConfig.enabled': true
          }
        }
      );
    }
    newlyEnabled++;
  }

  console.log('\n--- Summary ---');
  console.log(`Total reporters (role=editor): ${reporters.length}`);
  console.log(`Newly enabled               : ${newlyEnabled}${DRY_RUN ? ' (dry run, not saved)' : ''}`);
  console.log(`Already enabled             : ${alreadyEnabled}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
