'use strict';

/**
 * DISTRICT IN-CHARGE — SEPTEMBER FRESH-START SETTLEMENT (READ-ONLY PDF)
 *
 * Purpose: the owner wants to pay every District In-Charge everything owed
 * (wallet balance + the Rs.10 August top-up), then reset wallets to 0 so
 * September starts fresh. DISTRICT IN-CHARGES ONLY.
 *
 * This script ONLY reads and produces a payout sheet. It writes NOTHING and does
 * NOT touch wallets. Zeroing is a separate, confirmed step.
 *
 * Pay Now (per DI) = current wallet Balance + Top-up(Due@10 - PaidInAug)
 *   = everything currently in their wallet, plus the correction to reach Rs.10/news.
 * After the owner pays this out offline, the wallet is set to 0 (separate script).
 *
 * Output: ~/Desktop/DI_Settlement_Sep2026_StateWise.pdf
 */

require('dotenv').config();
const path = require('path');
const os = require('os');
const fs = require('fs');
const mongoose = require('mongoose');
const PDFDocument = require('pdfkit');

const START = new Date('2026-07-31T18:30:00.000Z');
const END = new Date('2026-08-31T18:29:59.999Z');
const OUT = path.join(os.homedir(), 'Desktop', 'DI_Settlement_Sep2026_StateWise.pdf');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const Admins = db.collection('admins');
  const Tx = db.collection('adminwallettransactions');
  const Wd = db.collection('withdrawalrequests');
  const News = db.collection('news');
  const Roles = db.collection('roles');

  // State -> State In-Charge name(s)
  const sicRole = await Roles.findOne({ name: 'State In-Charge' });
  const sicByState = {};
  if (sicRole) {
    (await Admins.find({ roleIds: sicRole._id }).project({ name: 1, assignedState: 1, assignedStates: 1, isActive: 1 }).toArray())
      .forEach((s) => {
        const sts = (s.assignedStates && s.assignedStates.length) ? s.assignedStates : (s.assignedState ? [s.assignedState] : []);
        sts.forEach((st) => { (sicByState[st] = sicByState[st] || []).push(s.name + (s.isActive === false ? ' (inactive)' : '')); });
      });
  }

  const dis = await Admins.find({ reporterTier: 'district_incharge' })
    .project({ name: 1, username: 1, mobileNumber: 1, assignedDistricts: 1, assignedState: 1, assignedStates: 1, walletBalance: 1 }).toArray();

  const rows = [];
  for (const d of dis) {
    const aid = String(d._id);
    const idOr = { $or: [{ adminId: d._id }, { adminId: aid }] };
    const augApproved = await News.countDocuments({ authorId: aid, 'approvalStatus.isApproved': true, publishedAt: { $gte: START, $lte: END } });
    const due = augApproved * 10;
    const paidAgg = await Tx.aggregate([
      { $match: { ...idOr, type: 'credit', createdAt: { $gte: START, $lte: END } } },
      { $group: { _id: null, s: { $sum: '$amount' } } }]).toArray();
    const paid = (paidAgg[0] && paidAgg[0].s) || 0;
    const topup = Math.max(0, due - paid);
    const balance = d.walletBalance || 0;
    const payNow = balance + topup;
    const pendingReq = (await Wd.find({ ...idOr, status: 'pending' }).toArray()).reduce((s, w) => s + w.amount, 0);

    rows.push({
      state: ((d.assignedStates && d.assignedStates[0]) || d.assignedState || 'Unknown State'),
      name: d.name || d.username, district: (d.assignedDistricts || [])[0] || '',
      mobile: d.mobileNumber || '', due, paid, topup, balance, payNow, pendingReq,
    });
  }
  const states = {};
  rows.forEach((r) => { (states[r.state] = states[r.state] || []).push(r); });
  const stateNames = Object.keys(states).sort();

  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });
  doc.pipe(fs.createWriteStream(OUT));
  const W = doc.page.width - 72; const startX = 36;
  const money = (n) => 'Rs.' + Number(n || 0).toLocaleString('en-IN');

  const cols = [
    { k: 'rank', label: '#', w: 24, align: 'left' },
    { k: 'name', label: 'District In-Charge', w: 150, align: 'left' },
    { k: 'district', label: 'District', w: 95, align: 'left' },
    { k: 'mobile', label: 'Mobile', w: 90, align: 'left' },
    { k: 'due', label: 'Aug Due @10', w: 70, align: 'right' },
    { k: 'paid', label: 'Paid', w: 62, align: 'right' },
    { k: 'topup', label: 'Top-up', w: 60, align: 'right' },
    { k: 'balance', label: 'Wallet Bal', w: 66, align: 'right' },
    { k: 'payNow', label: 'PAY NOW', w: 78, align: 'right' },
    { k: 'pendingReq', label: 'Pending Wd', w: 66, align: 'right' },
  ];
  const moneyKeys = ['due', 'paid', 'topup', 'balance', 'payNow', 'pendingReq'];
  let y = 36;
  const pageBreak = (n) => { if (y + n > doc.page.height - 46) { doc.addPage({ size: 'A4', layout: 'landscape', margin: 36 }); y = 40; } };
  const header = () => {
    doc.rect(startX, y, W, 16).fill('#334155'); let x = startX + 6;
    doc.fill('#fff').font('Helvetica-Bold').fontSize(8);
    cols.forEach((c) => { doc.text(c.label, x, y + 4, { width: c.w - 8, align: c.align, lineBreak: false }); x += c.w; });
    y += 16;
  };

  doc.rect(startX, y, W, 50).fill('#065f46');
  doc.fill('#fff').font('Helvetica-Bold').fontSize(17).text('TAHELKA NEWS', startX + 12, y + 8);
  doc.fontSize(11).text('District In-Charge - Final Payout & Wallet Reset (September Fresh Start)', startX + 12, y + 28);
  doc.font('Helvetica').fontSize(8).text(`PAY NOW = current wallet + Aug top-up (Rs.10/news).  After payout, wallets are reset to 0.  Generated: ${new Date().toLocaleString('en-IN')}`, startX + 12, y + 40);
  y += 60;

  const drawRow = (r, rank, zebra) => {
    pageBreak(15);
    if (zebra) doc.rect(startX, y, W, 15).fill('#f6f7f9');
    let x = startX + 6; doc.font('Helvetica').fontSize(8);
    cols.forEach((c) => {
      let v = c.k === 'rank' ? String(rank) : (moneyKeys.includes(c.k) ? money(r[c.k]) : r[c.k]);
      const isPay = c.k === 'payNow';
      const isPend = c.k === 'pendingReq' && r.pendingReq > 0;
      doc.fill(isPay ? '#065f46' : isPend ? '#b45309' : '#111827');
      if (isPay || isPend) doc.font('Helvetica-Bold');
      doc.text(String(v ?? ''), x, y + 4, { width: c.w - 8, align: c.align, lineBreak: false });
      if (isPay || isPend) doc.font('Helvetica');
      x += c.w;
    });
    y += 15;
  };
  const drawTotals = (list, label, bg) => {
    pageBreak(18);
    const t = { due: 0, paid: 0, topup: 0, balance: 0, payNow: 0, pendingReq: 0 };
    list.forEach((r) => moneyKeys.forEach((k) => { t[k] += r[k]; }));
    doc.rect(startX, y, W, 18).fill(bg); let x = startX + 6;
    doc.fill('#111827').font('Helvetica-Bold').fontSize(8);
    cols.forEach((c) => {
      let v = '';
      if (c.k === 'name') v = label;
      else if (moneyKeys.includes(c.k)) v = money(t[c.k]);
      doc.text(v, x, y + 5, { width: c.w - 8, align: c.align, lineBreak: false }); x += c.w;
    });
    y += 18; return t;
  };

  // State sections
  let globalRank = 0;
  stateNames.forEach((st) => {
    const list = states[st].sort((a, b) => b.payNow - a.payNow);
    pageBreak(56);
    doc.rect(startX, y, W, 20).fill('#0f172a');
    doc.fill('#fff').font('Helvetica-Bold').fontSize(10)
      .text(st.toUpperCase(), startX + 8, y + 5, { continued: true })
      .font('Helvetica').fontSize(8.5)
      .text(`   |   State In-Charge: ${(sicByState[st] || ['-']).join(', ')}   |   District In-Charges: ${list.length}`);
    y += 20;
    header();
    list.forEach((r, i) => drawRow(r, ++globalRank, i % 2 === 0));
    drawTotals(list, `${st} TOTAL`, '#e0e7ff');
    y += 8;
  });

  y += 2;
  const tot = drawTotals(rows, `GRAND TOTAL (${rows.length} District In-Charges)`, '#fde68a');
  y += 10;

  doc.font('Helvetica-Bold').fontSize(9).fill('#111827').text('How the settlement works:', startX, y); y += 13;
  doc.font('Helvetica').fontSize(8).fill('#374151');
  [
    '1. PAY NOW = Wallet Balance + Top-up. This is the exact amount to hand over to each District In-Charge (bank/UPI).',
    '2. Top-up = the extra needed to settle August at Rs.10 per approved news (it was never added to the wallet).',
    '3. Wallet Balance = money already sitting in their wallet (their earnings, whenever earned).',
    '4. After you pay PAY NOW to everyone, run the reset script to set all District In-Charge wallets to 0.',
    '5. Pending Wd (orange) = a withdrawal request still open. Those requests will be CANCELLED during reset',
    '   (the money is already included in PAY NOW), so nobody is paid twice.',
    '6. This affects DISTRICT IN-CHARGES ONLY - stringers/editors are untouched. September then starts fresh.',
  ].forEach((t) => { doc.text(t, startX, y); y += 11; });

  doc.end();
  console.log(`DIs ${rows.length} | Due ${money(tot.due)} | Paid ${money(tot.paid)} | Top-up ${money(tot.topup)} | Wallet ${money(tot.balance)} | PAY NOW ${money(tot.payNow)} | pending-wd ${money(tot.pendingReq)}`);
  console.log('PDF: ' + OUT);
  await mongoose.disconnect();
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
