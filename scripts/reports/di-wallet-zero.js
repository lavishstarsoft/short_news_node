'use strict';

/**
 * DISTRICT IN-CHARGE — PER-PERSON WALLET SETTLEMENT & RESET (dynamic)
 *
 * Pay one District In-Charge at a time, then reset their wallet to 0 for a
 * September fresh start. Produces a printable STATEMENT (receipt) with the full
 * reason, which can be shared with the reporter as proof.
 *
 * Uses the hash-chained wallet helper (processWalletTransaction) so the ledger
 * stays valid. NEVER touches anyone except the one selected District In-Charge.
 *
 * USAGE:
 *   node scripts/reports/di-wallet-zero.js --who "Sanjeev"          → DRY RUN (statement only, no writes)
 *   node scripts/reports/di-wallet-zero.js --who 9876543210 --apply → settle + zero wallet + cancel pending
 *   node scripts/reports/di-wallet-zero.js --who <id> --rollback    → undo a settlement (re-credit + restore pending)
 *
 * --who matches by name / username / mobile / _id (District In-Charges only).
 * If more than one matches, it lists them and stops (no guessing).
 */

require('dotenv').config();
const path = require('path');
const os = require('os');
const fs = require('fs');
const mongoose = require('mongoose');
const PDFDocument = require('pdfkit');

const START = new Date('2026-07-31T18:30:00.000Z');
const END = new Date('2026-08-31T18:29:59.999Z');
const PAID = ['completed', 'paid', 'processed', 'approved'];

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] || '') : null;
}

async function main() {
  const who = arg('--who');
  const APPLY = process.argv.includes('--apply');
  const ROLLBACK = process.argv.includes('--rollback');
  if (!who) { console.error('Provide --who "<name | mobile | id>"'); process.exit(1); }

  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const Admins = db.collection('admins');
  const Tx = db.collection('adminwallettransactions');
  const Wd = db.collection('withdrawalrequests');
  const News = db.collection('news');
  const { processWalletTransaction } = require('../../utils/walletHelpers');

  // ── Resolve the person (District In-Charge only) ──────────────────────────
  const rx = new RegExp(who.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const orClauses = [{ name: rx }, { username: rx }, { mobileNumber: rx }];
  if (/^[a-f0-9]{24}$/i.test(who)) orClauses.push({ _id: new mongoose.Types.ObjectId(who) });
  const matches = await Admins.find({ reporterTier: 'district_incharge', $or: orClauses }).toArray();

  if (matches.length === 0) { console.error(`No District In-Charge matched "${who}".`); await mongoose.disconnect(); return; }
  if (matches.length > 1) {
    console.log(`Multiple matches for "${who}" — be more specific:`);
    matches.forEach((m) => console.log(`  - ${m.name} | ${m.mobileNumber || ''} | ${(m.assignedDistricts || [])[0] || ''} | id=${m._id}`));
    await mongoose.disconnect(); return;
  }
  const d = matches[0];
  const aid = String(d._id);
  const idOr = { $or: [{ adminId: d._id }, { adminId: aid }] };
  const REF = `sep_settlement_${aid}`;

  // ── ROLLBACK ──────────────────────────────────────────────────────────────
  if (ROLLBACK) {
    const debit = await Tx.findOne({ ...idOr, referenceId: new RegExp('^' + REF), type: 'debit' }, { sort: { createdAt: -1 } });
    if (!debit) { console.log('No settlement found to roll back for ' + d.name); await mongoose.disconnect(); return; }
    await processWalletTransaction({ adminId: aid, amount: debit.amount, type: 'credit', description: `Rollback of Sep settlement for ${d.name}`, referenceId: `${REF}_rollback_${Date.now()}` });
    const restored = await Wd.updateMany({ ...idOr, status: 'cancelled', settlementRef: REF }, { $set: { status: 'pending' }, $unset: { settlementRef: '' } });
    console.log(`Rolled back: re-credited Rs.${debit.amount} to ${d.name}; restored ${restored.modifiedCount} pending withdrawal(s).`);
    await mongoose.disconnect(); return;
  }

  // ── Compute settlement ────────────────────────────────────────────────────
  const augApproved = await News.countDocuments({ authorId: aid, 'approvalStatus.isApproved': true, publishedAt: { $gte: START, $lte: END } });
  const due = augApproved * 10;
  const paidAgg = await Tx.aggregate([{ $match: { ...idOr, type: 'credit', createdAt: { $gte: START, $lte: END } } }, { $group: { _id: null, s: { $sum: '$amount' } } }]).toArray();
  const paidAug = (paidAgg[0] && paidAgg[0].s) || 0;
  const topup = Math.max(0, due - paidAug);
  const balance = d.walletBalance || 0;
  const payNow = balance + topup;
  const pendings = await Wd.find({ ...idOr, status: 'pending' }).toArray();
  const pendingSum = pendings.reduce((s, w) => s + w.amount, 0);
  const already = await Tx.findOne({ ...idOr, referenceId: new RegExp('^' + REF), type: 'debit' });

  const info = {
    name: d.name || d.username, mobile: d.mobileNumber || '', district: (d.assignedDistricts || [])[0] || '',
    state: ((d.assignedStates && d.assignedStates[0]) || d.assignedState || ''),
    augApproved, due, paidAug, topup, balance, payNow, pendingSum, alreadySettled: !!already,
  };

  console.log('\n──────── SETTLEMENT STATEMENT ────────');
  console.log(`  ${info.name}  |  ${info.mobile}  |  ${info.district}, ${info.state}`);
  console.log(`  August approved news : ${info.augApproved}`);
  console.log(`  Due @ Rs.10          : Rs.${info.due}`);
  console.log(`  Already paid (Aug)   : Rs.${info.paidAug}`);
  console.log(`  Top-up (paid offline): Rs.${info.topup}`);
  console.log(`  Wallet balance       : Rs.${info.balance}`);
  console.log(`  ► PAY NOW (total)    : Rs.${info.payNow}`);
  console.log(`  Pending withdrawals  : Rs.${info.pendingSum}${pendings.length ? ' (' + pendings.length + ' request(s) - will be cancelled)' : ''}`);
  if (info.alreadySettled) console.log('  ⚠️ ALREADY SETTLED earlier (a settlement debit exists).');

  // ── Write (APPLY) ─────────────────────────────────────────────────────────
  if (APPLY) {
    if (info.alreadySettled) { console.log('\nRefusing to double-settle. Use --rollback first if this is intentional.'); await mongoose.disconnect(); return; }
    if (balance > 0) {
      await processWalletTransaction({
        adminId: aid, amount: balance, type: 'debit',
        description: `Sep settlement: paid Rs.${payNow} in full (wallet Rs.${balance} + top-up Rs.${topup}); wallet reset for September fresh start`,
        referenceId: `${REF}_${new Date().toISOString().slice(0, 10)}`,
      });
    }
    if (pendings.length) {
      await Wd.updateMany({ ...idOr, status: 'pending' }, { $set: { status: 'cancelled', settlementRef: REF, remarks: 'Cancelled in September settlement (paid in full)' } });
    }
    try {
      await db.collection('auditlogs').insertOne({
        actorName: 'script:di-wallet-zero', actorRole: 'system', action: 'di_wallet_settlement_reset',
        entityType: 'Admin', entityId: aid, targetId: d._id, targetName: info.name,
        description: `Settled Rs.${payNow} (wallet ${balance}+topup ${topup}); wallet -> 0; ${pendings.length} pending withdrawal(s) cancelled`,
        before: { walletBalance: balance }, after: { walletBalance: 0 }, ip: '', createdAt: new Date(),
      });
    } catch (e) { console.error('audit failed (non-blocking):', e.message); }
    console.log(`\n✅ APPLIED: ${info.name}'s wallet reset to 0. Total to hand over offline: Rs.${payNow}.`);
  } else {
    console.log('\nDRY RUN — no changes made. Add --apply to settle & reset.');
  }

  // ── Statement PDF (receipt) ──────────────────────────────────────────────
  const OUT = path.join(os.homedir(), 'Desktop', `Settlement_${info.name.replace(/[^\w]+/g, '_')}.pdf`);
  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  doc.pipe(fs.createWriteStream(OUT));
  const w = doc.page.width - 96; const money = (n) => 'Rs.' + Number(n || 0).toLocaleString('en-IN');
  doc.rect(48, 48, w, 58).fill('#065f46');
  doc.fill('#fff').font('Helvetica-Bold').fontSize(18).text('TAHELKA NEWS', 62, 60);
  doc.font('Helvetica').fontSize(11).text('Settlement Statement - District In-Charge', 62, 84);
  doc.fill('#111827'); let yy = 128;
  doc.font('Helvetica-Bold').fontSize(12).text(info.name, 48, yy);
  doc.font('Helvetica').fontSize(10).fill('#374151')
    .text(`Mobile: ${info.mobile}    District: ${info.district}, ${info.state}`, 48, yy + 18)
    .text(`Date: ${new Date().toLocaleString('en-IN')}`, 48, yy + 32);
  yy += 60;
  const line = (label, val, bold, color) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10).fill(color || '#111827');
    doc.text(label, 60, yy, { width: w - 140, continued: false });
    doc.text(val, 48, yy, { width: w, align: 'right' });
    yy += bold ? 22 : 17;
  };
  doc.moveTo(48, yy - 6).lineTo(48 + w, yy - 6).stroke('#e5e7eb');
  line('August approved news', String(info.augApproved));
  line('Rate', 'Rs.10 per approved news');
  line('Amount due for August (Due @10)', money(info.due));
  line('Already paid to wallet (August)', money(info.paidAug));
  line('Top-up (correction to Rs.10 rate)', money(info.topup), false, '#b45309');
  line('Wallet balance before settlement', money(info.balance));
  doc.moveTo(48, yy).lineTo(48 + w, yy).stroke('#9ca3af'); yy += 8;
  line('TOTAL PAID TO REPORTER (PAY NOW)', money(info.payNow), true, '#065f46');
  line('Wallet balance after (reset)', APPLY ? 'Rs.0' : '(after settlement: Rs.0)', true);
  if (info.pendingSum > 0) line('Pending withdrawal requests (cancelled - included above)', money(info.pendingSum), false, '#b45309');
  yy += 12;
  doc.font('Helvetica').fontSize(9).fill('#374151').text(
    `Reason: August earnings settled in full at the District In-Charge rate of Rs.10 per approved news. ` +
    `The total above was paid to the reporter, and the wallet has been reset to zero so that September starts fresh. ` +
    (info.pendingSum > 0 ? `Any pending withdrawal request has been cancelled because it is already included in the amount paid. ` : '') +
    `${APPLY ? '' : 'THIS IS A DRAFT PREVIEW - no payment or reset has been recorded yet.'}`,
    48, yy, { width: w, align: 'left' });
  yy += 70;
  doc.fill('#111827').fontSize(10)
    .text('Received by (reporter): ____________________', 48, yy)
    .text('Authorised by: ____________________', 48 + w / 2, yy);
  if (!APPLY) { doc.fontSize(40).fill('#e5e7eb').opacity(0.4).text('DRAFT', 0, 360, { align: 'center', width: doc.page.width }); doc.opacity(1); }
  doc.end();
  console.log('Statement PDF: ' + OUT);

  await mongoose.disconnect();
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
