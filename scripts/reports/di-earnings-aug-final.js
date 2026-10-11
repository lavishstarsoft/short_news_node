'use strict';

/**
 * DISTRICT IN-CHARGE — AUGUST SETTLEMENT REPORT (STATE-WISE PDF)
 *
 * Owner decisions baked in:
 *  - Rate = Rs.10 per APPROVED news, for EVERY approved news (NO per-day-10 cap).
 *  - Show each reporter's total news posted (all-time) + how many approved + approval %.
 *  - Show current wallet balance and rank (sorted by earnings).
 *  - HIGHLIGHT (green row) any District In-Charge who has completed a withdrawal.
 *
 * Columns:
 *   Posted(all) = total news the reporter ever posted
 *   Approved(all)/Appr% = how many were approved / approval percentage
 *   Aug Appr = approved news in August (the money basis)
 *   Due@10 = Aug Appr x Rs.10 (no cap)
 *   Paid = credited in August (all schemes) | Top-up = Due - Paid (red)
 *   Withdrawn = withdrawals ever completed | Balance = current wallet
 *
 * READ-ONLY. Output: ~/Desktop/DI_Earnings_Aug2026_Final.pdf
 */

require('dotenv').config();
const path = require('path');
const os = require('os');
const fs = require('fs');
const mongoose = require('mongoose');
const PDFDocument = require('pdfkit');

const START = new Date('2026-07-31T18:30:00.000Z');
const END = new Date('2026-08-31T18:29:59.999Z');
const OUT = path.join(os.homedir(), 'Desktop', 'DI_Earnings_Aug2026_Final.pdf');
const PAID = ['completed', 'paid', 'processed', 'approved']; // "approved" = money sent in this system

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const Admins = db.collection('admins');
  const Tx = db.collection('adminwallettransactions');
  const Wd = db.collection('withdrawalrequests');
  const News = db.collection('news');
  const Roles = db.collection('roles');

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
    .project({ name: 1, username: 1, assignedDistricts: 1, assignedState: 1, assignedStates: 1, walletBalance: 1 }).toArray();

  const rows = [];
  for (const d of dis) {
    const aid = String(d._id);
    const idOr = { $or: [{ adminId: d._id }, { adminId: aid }] };

    // Lifetime news (all-time) — "epativaraku petina news"
    const postedAll = await News.countDocuments({ authorId: aid });
    const approvedAll = await News.countDocuments({ authorId: aid, 'approvalStatus.isApproved': true });
    const apprPct = postedAll > 0 ? Math.round((approvedAll / postedAll) * 100) : 0;

    // August approved (money basis) — every approved news x Rs.10, NO daily cap
    const augApproved = await News.countDocuments({ authorId: aid, 'approvalStatus.isApproved': true, publishedAt: { $gte: START, $lte: END } });
    const due = augApproved * 10;

    // Everything already credited in August (all schemes) — prevents double pay
    const paidAgg = await Tx.aggregate([
      { $match: { ...idOr, type: 'credit', createdAt: { $gte: START, $lte: END } } },
      { $group: { _id: null, s: { $sum: '$amount' } } },
    ]).toArray();
    const paid = (paidAgg[0] && paidAgg[0].s) || 0;
    const shortfall = Math.max(0, due - paid);

    // Withdrawals
    const wds = await Wd.find({ ...idOr }).sort({ createdAt: 1 }).toArray();
    let withdrawnPaid = 0, pendingReq = 0;
    const wdDetail = [];
    wds.forEach((w) => {
      const st = String(w.status || '').toLowerCase();
      if (PAID.includes(st)) withdrawnPaid += w.amount;
      else if (st === 'pending') pendingReq += w.amount;
      wdDetail.push({ date: w.createdAt, amount: w.amount, status: st || '-', utr: w.utr || '', remarks: w.remarks || '', payoutType: w.payoutType || '' });
    });

    rows.push({
      state: ((d.assignedStates && d.assignedStates[0]) || d.assignedState || 'Unknown State'),
      name: d.name || d.username, district: (d.assignedDistricts || [])[0] || '',
      postedAll, approvedAll, apprPct, augApproved, due, paid, shortfall,
      withdrawnPaid, pendingReq, balance: d.walletBalance || 0, wdDetail,
      didWithdraw: withdrawnPaid > 0,
    });
  }

  const states = {};
  rows.forEach((r) => { (states[r.state] = states[r.state] || []).push(r); });
  const stateNames = Object.keys(states).sort();

  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });
  doc.pipe(fs.createWriteStream(OUT));
  const W = doc.page.width - 72;
  const startX = 36;
  const money = (n) => 'Rs.' + Number(n || 0).toLocaleString('en-IN');

  const cols = [
    { k: 'rank', label: '#', w: 22, align: 'left' },
    { k: 'name', label: 'District In-Charge', w: 128, align: 'left' },
    { k: 'district', label: 'District', w: 78, align: 'left' },
    { k: 'postedAll', label: 'Posted', w: 42, align: 'right' },
    { k: 'approvedAll', label: 'Approved', w: 50, align: 'right' },
    { k: 'apprPct', label: 'Appr%', w: 40, align: 'right' },
    { k: 'augApproved', label: 'Aug Appr', w: 50, align: 'right' },
    { k: 'due', label: 'Due @10', w: 54, align: 'right' },
    { k: 'paid', label: 'Paid', w: 52, align: 'right' },
    { k: 'shortfall', label: 'Top-up', w: 50, align: 'right' },
    { k: 'withdrawnPaid', label: 'Withdrawn', w: 56, align: 'right' },
    { k: 'balance', label: 'Balance', w: 54, align: 'right' },
  ];
  const moneyKeys = ['due', 'paid', 'shortfall', 'withdrawnPaid', 'balance'];
  let y = 36;

  const pageBreak = (need) => { if (y + need > doc.page.height - 46) { doc.addPage({ size: 'A4', layout: 'landscape', margin: 36 }); y = 40; } };
  const header = () => {
    doc.rect(startX, y, W, 16).fill('#334155');
    let x = startX + 6; doc.fill('#fff').font('Helvetica-Bold').fontSize(7.5);
    cols.forEach((c) => { doc.text(c.label, x, y + 4, { width: c.w - 8, align: c.align, lineBreak: false }); x += c.w; });
    y += 16;
  };
  const row = (r, rank, zebra) => {
    pageBreak(16);
    // Highlight: green row if this In-Charge has completed a withdrawal.
    if (r.didWithdraw) doc.rect(startX, y, W, 15).fill('#dcfce7');
    else if (zebra) doc.rect(startX, y, W, 15).fill('#f6f7f9');
    let x = startX + 6; doc.font('Helvetica').fontSize(7.5);
    cols.forEach((c) => {
      let v;
      if (c.k === 'rank') v = String(rank);
      else if (c.k === 'apprPct') v = r.apprPct + '%';
      else if (moneyKeys.includes(c.k)) v = money(r[c.k]);
      else v = r[c.k];
      const red = c.k === 'shortfall' && r.shortfall > 0;
      const grn = c.k === 'withdrawnPaid' && r.withdrawnPaid > 0;
      doc.fill(red ? '#b91c1c' : grn ? '#15803d' : '#111827');
      if (red || grn) doc.font('Helvetica-Bold');
      doc.text(String(v ?? ''), x, y + 4, { width: c.w - 8, align: c.align, lineBreak: false });
      if (red || grn) doc.font('Helvetica');
      x += c.w;
    });
    y += 15;
  };
  const totals = (list, label, bg) => {
    pageBreak(18);
    const t = list.reduce((a, r) => ({
      postedAll: a.postedAll + r.postedAll, approvedAll: a.approvedAll + r.approvedAll, augApproved: a.augApproved + r.augApproved,
      due: a.due + r.due, paid: a.paid + r.paid, shortfall: a.shortfall + r.shortfall,
      withdrawnPaid: a.withdrawnPaid + r.withdrawnPaid, balance: a.balance + r.balance,
    }), { postedAll: 0, approvedAll: 0, augApproved: 0, due: 0, paid: 0, shortfall: 0, withdrawnPaid: 0, balance: 0 });
    doc.rect(startX, y, W, 17).fill(bg);
    let x = startX + 6; doc.fill('#111827').font('Helvetica-Bold').fontSize(7.5);
    cols.forEach((c) => {
      let v = '';
      if (c.k === 'name') v = label;
      else if (['postedAll', 'approvedAll', 'augApproved'].includes(c.k)) v = String(t[c.k]);
      else if (moneyKeys.includes(c.k)) v = money(t[c.k]);
      doc.text(v, x, y + 5, { width: c.w - 8, align: c.align, lineBreak: false }); x += c.w;
    });
    y += 17; return t;
  };

  doc.rect(startX, y, W, 52).fill('#b91c1c');
  doc.fill('#fff').font('Helvetica-Bold').fontSize(17).text('TAHELKA NEWS', startX + 12, y + 8);
  doc.fontSize(11).text('District In-Charge - August Settlement (State Wise)', startX + 12, y + 28);
  doc.font('Helvetica').fontSize(8).text(`Period: 01 - 31 Aug 2026 (IST)  |  Rate: Rs.10 per approved news (every approved news, no daily cap)  |  Generated: ${new Date().toLocaleString('en-IN')}`, startX + 12, y + 41);
  y += 60;
  // Legend
  doc.rect(startX, y, 12, 9).fill('#dcfce7'); doc.fill('#111827').font('Helvetica').fontSize(7.5).text('= has completed a withdrawal', startX + 16, y + 1);
  doc.fill('#b91c1c').font('Helvetica-Bold').fontSize(7.5).text('Red Top-up = still to be paid', startX + 170, y + 1);
  doc.fill('#111827').font('Helvetica'); y += 16;

  let globalRank = 0;
  stateNames.forEach((st) => {
    const list = states[st].sort((a, b) => b.due - a.due);
    pageBreak(60);
    doc.rect(startX, y, W, 20).fill('#0f172a');
    doc.fill('#fff').font('Helvetica-Bold').fontSize(10)
      .text(st.toUpperCase(), startX + 8, y + 5, { continued: true })
      .font('Helvetica').fontSize(8.5)
      .text(`   |   State In-Charge: ${(sicByState[st] || ['-']).join(', ')}   |   District In-Charges: ${list.length}`);
    y += 20;
    header();
    list.forEach((r, i) => row(r, ++globalRank, i % 2 === 0));
    totals(list, `${st} TOTAL`, '#e0e7ff');
    y += 8;
  });

  y += 4;
  const g = totals(rows, `GRAND TOTAL (${rows.length} District In-Charges)`, '#fde68a');
  y += 10; pageBreak(80);
  doc.font('Helvetica-Bold').fontSize(9).fill('#111827').text('Notes:', startX, y); y += 12;
  doc.font('Helvetica').fontSize(7.5).fill('#374151');
  [
    'Posted    = total news the reporter has ever posted.  |  Approved = how many were approved.  |  Appr% = approved / posted.',
    'Aug Appr  = news approved in August. This is the money basis - EVERY approved news counts (no per-day-10 cap).',
    'Due @10   = Aug Appr x Rs.10 (District In-Charge rate).',
    'Paid      = everything already credited in August (all reward schemes + corrections) - so Top-up never double-pays.',
    'Top-up    = Due - Paid.  RED = still payable.',
    'Withdrawn = withdrawals already completed (paid).  GREEN ROW = this In-Charge has taken a withdrawal.',
    'Balance   = current wallet balance (money still with them, not withdrawn).',
  ].forEach((t) => { doc.text(t, startX, y); y += 10; });

  // ── ANNEXURE: every withdrawal request ────────────────────────────────────
  doc.addPage({ size: 'A4', layout: 'landscape', margin: 36 }); y = 40;
  doc.rect(startX, y, W, 30).fill('#0f172a');
  doc.fill('#fff').font('Helvetica-Bold').fontSize(13).text('ANNEXURE - Withdrawal Details (District In-Charges)', startX + 12, y + 9);
  y += 40;
  const wCols = [
    { label: '#', w: 24 }, { label: 'District In-Charge', w: 150 }, { label: 'District', w: 95 },
    { label: 'Request Date', w: 90 }, { label: 'Amount', w: 65, align: 'right' }, { label: 'Mode', w: 50 },
    { label: 'Status', w: 75 }, { label: 'UTR / Remarks', w: 200 },
  ];
  const wHeader = () => {
    doc.rect(startX, y, W, 16).fill('#334155'); let x = startX + 6;
    doc.fill('#fff').font('Helvetica-Bold').fontSize(7.5);
    wCols.forEach((c) => { doc.text(c.label, x, y + 4, { width: c.w - 8, align: c.align || 'left', lineBreak: false }); x += c.w; });
    y += 16;
  };
  const withWd = rows.filter((r) => r.wdDetail.length > 0).sort((a, b) => a.name.localeCompare(b.name));
  if (!withWd.length) {
    doc.fill('#374151').font('Helvetica').fontSize(10).text('No District In-Charge has made any withdrawal request so far.', startX, y);
  } else {
    wHeader(); let n = 0;
    withWd.forEach((r) => r.wdDetail.forEach((w) => {
      pageBreak(16); if (y === 40) wHeader(); n++;
      const isPaid = PAID.includes(w.status);
      if (n % 2 === 0) doc.rect(startX, y, W, 15).fill('#f6f7f9');
      const vals = [String(n), r.name, r.district, w.date ? new Date(w.date).toLocaleDateString('en-IN') : '',
        money(w.amount), (w.payoutType || '').toUpperCase(), isPaid ? 'PAID' : w.status.toUpperCase(),
        [w.utr, w.remarks].filter(Boolean).join(' | ')];
      let x = startX + 6;
      wCols.forEach((c, ci) => {
        const isStatus = ci === 6;
        doc.font(isStatus ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5)
          .fill(isStatus ? (isPaid ? '#15803d' : (w.status === 'pending' ? '#b45309' : '#b91c1c')) : '#111827');
        doc.text(String(vals[ci] ?? ''), x, y + 4, { width: c.w - 8, align: c.align || 'left', lineBreak: false }); x += c.w;
      });
      y += 15;
    }));
    y += 6; pageBreak(20);
    doc.font('Helvetica-Bold').fontSize(8.5).fill('#111827')
      .text(`Summary: ${withWd.length} In-Charges made ${withWd.reduce((s, r) => s + r.wdDetail.length, 0)} requests  |  PAID: ${money(g.withdrawnPaid)}  |  PENDING: ${money(rows.reduce((s, r) => s + r.pendingReq, 0))}`, startX, y);
  }

  doc.end();
  const withdrawers = rows.filter((r) => r.didWithdraw).length;
  console.log(`DIs ${rows.length} | posted ${g.postedAll} | approvedAll ${g.approvedAll} | augAppr ${g.augApproved} | due ${money(g.due)} | paid ${money(g.paid)} | TOP-UP ${money(g.shortfall)} | withdrew(paid) ${money(g.withdrawnPaid)} by ${withdrawers} DIs`);
  console.log('PDF: ' + OUT);
  await mongoose.disconnect();
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
