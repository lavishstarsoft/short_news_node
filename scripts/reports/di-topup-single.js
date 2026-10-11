'use strict';

/**
 * PER-PERSON DI RATE TOP-UP — bring a District In-Charge's past per-news rewards
 * from the stringer rate (Rs.5) up to the DI rate (Rs.10).
 *
 * For each existing `newsreward_<newsId>` credit that was paid BELOW the DI rate,
 * it adds the difference as a `tierdiff_<newsId>` credit (idempotent — never double
 * applies). Uses the hash-chained wallet helper so the ledger stays valid.
 *
 * USAGE:
 *   node scripts/reports/di-topup-single.js --who "razran26"          → DRY RUN
 *   node scripts/reports/di-topup-single.js --who "razran26" --apply  → apply top-up
 */

require('dotenv').config();
const mongoose = require('mongoose');

function arg(n) { const i = process.argv.indexOf(n); return i >= 0 ? (process.argv[i + 1] || '') : null; }

async function main() {
  const who = arg('--who'); const APPLY = process.argv.includes('--apply');
  if (!who) { console.error('Provide --who "<name|mobile|email|id>"'); process.exit(1); }

  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const Admins = db.collection('admins');
  const Tx = db.collection('adminwallettransactions');
  const { processWalletTransaction } = require('../../utils/walletHelpers');

  const rx = new RegExp(who.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const or = [{ name: rx }, { username: rx }, { mobileNumber: rx }, { email: rx }];
  if (/^[a-f0-9]{24}$/i.test(who)) or.push({ _id: new mongoose.Types.ObjectId(who) });
  const matches = await Admins.find({ reporterTier: 'district_incharge', $or: or }).toArray();
  if (matches.length !== 1) {
    console.log(matches.length === 0 ? `No District In-Charge matched "${who}".` : `Multiple matched "${who}" — be specific.`);
    matches.forEach((m) => console.log(`  - ${m.name} | ${m.mobileNumber} | ${m.email} | id=${m._id}`));
    await mongoose.disconnect(); return;
  }
  const d = matches[0]; const aid = String(d._id);
  const idOr = { $or: [{ adminId: d._id }, { adminId: aid }] };

  // DI rate (configurable; default 10)
  const settings = await db.collection('appsettings').findOne({ key: 'update_flags' });
  const DI_RATE = Number(settings && settings.districtInchargeRatePerNews) || 10;

  // All per-news reward credits
  const rewards = await Tx.find({ ...idOr, type: 'credit', referenceId: /^newsreward_/ }).toArray();
  const plan = [];
  for (const r of rewards) {
    const newsId = String(r.referenceId).replace(/^newsreward_/, '');
    const diff = DI_RATE - (r.amount || 0);
    if (diff <= 0) continue;
    const already = await Tx.findOne({ ...idOr, referenceId: `tierdiff_${newsId}` });
    if (already) continue;
    plan.push({ newsId, diff, origAmount: r.amount });
  }

  const before = d.walletBalance || 0;
  const total = plan.reduce((s, p) => s + p.diff, 0);
  console.log(`\n── ${d.name} (${d.mobileNumber || d.email}) — DI rate top-up ──`);
  console.log(`  rewarded news paid below DI rate: ${plan.length}`);
  console.log(`  DI rate: Rs.${DI_RATE}  |  top-up total: Rs.${total}`);
  console.log(`  wallet: Rs.${before}  ->  Rs.${before + total}`);

  if (!APPLY) { console.log('\nDRY RUN — no changes. Add --apply to top-up.'); await mongoose.disconnect(); return; }

  let done = 0, added = 0;
  for (const p of plan) {
    await processWalletTransaction({
      adminId: aid, amount: p.diff, type: 'credit',
      description: `Tier correction: district_incharge rate Rs.${DI_RATE} for news ${p.newsId} (was Rs.${p.origAmount})`,
      referenceId: `tierdiff_${p.newsId}`,
    });
    done++; added += p.diff;
  }
  const after = await Admins.findOne({ _id: d._id }, { projection: { walletBalance: 1 } });
  try {
    await db.collection('auditlogs').insertOne({
      actorName: 'script:di-topup-single', actorRole: 'system', action: 'di_rate_topup',
      entityType: 'Admin', entityId: aid, targetId: d._id, targetName: d.name,
      description: `Topped up ${done} news to DI rate Rs.${DI_RATE}; added Rs.${added}; balance ${before} -> ${after.walletBalance}`,
      before: { walletBalance: before }, after: { walletBalance: after.walletBalance }, ip: '', createdAt: new Date(),
    });
  } catch (e) { console.error('audit failed (non-blocking):', e.message); }
  console.log(`\n✅ APPLIED: ${done} corrections, +Rs.${added}. New balance: Rs.${after.walletBalance}.`);
  await mongoose.disconnect();
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
