'use strict';

/**
 * DISTRICT IN-CHARGE MONTHLY EARNINGS REPORT — STATE-WISE (PDF)
 * Period: 01 Aug 2026 → 31 Aug 2026 (IST). READ-ONLY (writes only a local PDF).
 *
 * Layout: one section per STATE, headed by that state's State In-Charge name(s),
 * then a table of the District In-Charges under that state:
 *   Posted  = approved news published in the month (News collection)
 *   Rewarded= news that received a per-news reward (system live from 25 Aug)
 *   Due@10  = Rewarded x Rs.10 (District In-Charge rate)
 *   Credited= rewards + Rs.5 tier corrections actually credited in the month
 *   Top-up  = Due - Credited (red = still to pay at the Rs.10 rate)
 *   Withdrawn / Pending withdrawals / Current balance
 *
 * Output: ~/Desktop/DI_Earnings_Aug2026_StateWise.pdf
 */

require('dotenv').config();
const path = require('path');
const os = require('os');
const fs = require('fs');
const mongoose = require('mongoose');
const PDFDocument = require('pdfkit');

const START = new Date('2026-07-31T18:30:00.000Z'); // 01 Aug 00:00 IST
const END = new Date('2026-08-31T18:29:59.999Z');   // 31 Aug 23:59 IST
const OUT = path.join(os.homedir(), 'Desktop', 'DI_Earnings_Aug2026_StateWise.pdf');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const Admins = db.collection('admins');
  const Tx = db.collection('adminwallettransactions');
  const Wd = db.collection('withdrawalrequests');
  const News = db.collection('news');
  const Roles = db.collection('roles');

  // State → State In-Charge name(s)
  const sicRole = await Roles.findOne({ name: 'State In-Charge' });
  const sicByState = {};
  if (sicRole) {
    (await Admins.find({ roleIds: sicRole._id }).project({ name: 1, assignedState: 1, assignedStates: 1, isActive: 1 }).toArray())
      .forEach((s) => {
        const states = (s.assignedStates && s.assignedStates.length) ? s.assignedStates : (s.assignedState ? [s.assignedState] : []);
        states.forEach((st) => { (sicByState[st] = sicByState[st] || []).push(s.name + (s.isActive === false ? ' (inactive)' : '')); });
      });
  }

  const dis = await Admins.find({ reporterTier: 'district_incharge' })
    .project({ name: 1, username: 1, assignedDistricts: 1, assignedState: 1, assignedStates: 1, walletBalance: 1 })
    .toArray();

  const rows = [];
  for (const d of dis) {
    const idOr = { $or: [{ adminId: d._id }, { adminId: String(d._id) }] };
    const posted = await News.countDocuments({
      authorId: String(d._id), isActive: true, 'approvalStatus.isApproved': true,
      publishedAt: { $gte: START, $lte: END },
    });
    const credits = await Tx.find({ ...idOr, type: 'credit', createdAt: { $gte: START, $lte: END }, referenceId: /^(newsreward_|tierdiff_)/ }).toArray();
    let rewarded = 0, credited = 0;
    credits.forEach((t) => { credited += t.amount; if (/^newsreward_/.test(t.referenceId)) rewarded++; });
    const due = rewarded * 10;
    const shortfall = Math.max(0, due - credited);

    const wds = await Wd.find({ ...idOr }).toArray();
    let withdrawn = 0, pendingReq = 0;
    wds.forEach((w) => {
      const st = String(w.status || '').toLowerCase();
      if (['completed', 'paid', 'processed', 'approved'].includes(st)) {
        const when = w.processedAt || w.updatedAt || w.createdAt;
        if (when >= START && when <= END) withdrawn += w.amount;
      } else if (st === 'pending') pendingReq += w.amount;
    });

    const state = ((d.assignedStates && d.assignedStates[0]) || d.assignedState || 'Unknown State');
    rows.push({
      state, name: d.name || d.username, district: (d.assignedDistricts || [])[0] || '',
      posted, rewarded, due, credited, shortfall, withdrawn, pendingReq, balance: d.walletBalance || 0,
    });
  }

  // Group by state
  const states = {};
  rows.forEach((r) => { (states[r.state] = states[r.state] || []).push(r); });
  const stateNames = Object.keys(states).sort();

  // ── PDF ──────────────────────────────────────────────────────────────────
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });
  doc.pipe(fs.createWriteStream(OUT));
  const W = doc.page.width - 72;
  const startX = 36;
  const money = (n) => 'Rs.' + Number(n || 0).toLocaleString('en-IN');

  const cols = [
    { k: 'i', label: '#', w: 20, align: 'left' },
    { k: 'name', label: 'District In-Charge', w: 138, align: 'left' },
    { k: 'district', label: 'District', w: 86, align: 'left' },
    { k: 'posted', label: 'Posted', w: 44, align: 'right' },
    { k: 'rewarded', label: 'Rewarded', w: 52, align: 'right' },
    { k: 'due', label: 'Due @10', w: 54, align: 'right' },
    { k: 'credited', label: 'Credited', w: 56, align: 'right' },
    { k: 'shortfall', label: 'Top-up', w: 50, align: 'right' },
    { k: 'withdrawn', label: 'Withdrawn', w: 58, align: 'right' },
    { k: 'pendingReq', label: 'Wd Pending', w: 60, align: 'right' },
    { k: 'balance', label: 'Balance', w: 58, align: 'right' },
  ];
  let y = 36;

  const pageBreak = (need) => {
    if (y + need > doc.page.height - 46) { doc.addPage({ size: 'A4', layout: 'landscape', margin: 36 }); y = 40; }
  };
  const drawTableHeader = () => {
    doc.rect(startX, y, W, 16).fill('#334155');
    let x = startX + 6;
    doc.fill('#ffffff').font('Helvetica-Bold').fontSize(7.5);
    cols.forEach((c) => { doc.text(c.label, x, y + 4, { width: c.w - 8, align: c.align, lineBreak: false }); x += c.w; });
    y += 16;
  };
  const drawRow = (r, i, zebra) => {
    pageBreak(16);
    if (zebra) doc.rect(startX, y, W, 15).fill('#f6f7f9');
    let x = startX + 6;
    doc.font('Helvetica').fontSize(7.5);
    cols.forEach((c) => {
      let v = c.k === 'i' ? String(i + 1) : r[c.k];
      if (['due', 'credited', 'shortfall', 'withdrawn', 'pendingReq', 'balance'].includes(c.k)) v = money(v);
      const red = c.k === 'shortfall' && r.shortfall > 0;
      doc.fill(red ? '#b91c1c' : '#111827');
      if (red) doc.font('Helvetica-Bold');
      doc.text(String(v ?? ''), x, y + 4, { width: c.w - 8, align: c.align, lineBreak: false });
      if (red) doc.font('Helvetica');
      x += c.w;
    });
    y += 15;
  };
  const drawTotals = (list, label, bg) => {
    pageBreak(18);
    const t = list.reduce((a, r) => ({
      posted: a.posted + r.posted, rewarded: a.rewarded + r.rewarded, due: a.due + r.due,
      credited: a.credited + r.credited, shortfall: a.shortfall + r.shortfall,
      withdrawn: a.withdrawn + r.withdrawn, pendingReq: a.pendingReq + r.pendingReq, balance: a.balance + r.balance,
    }), { posted: 0, rewarded: 0, due: 0, credited: 0, shortfall: 0, withdrawn: 0, pendingReq: 0, balance: 0 });
    doc.rect(startX, y, W, 17).fill(bg);
    let x = startX + 6;
    doc.fill('#111827').font('Helvetica-Bold').fontSize(7.5);
    cols.forEach((c) => {
      let v = '';
      if (c.k === 'name') v = label;
      else if (c.k === 'posted') v = String(t.posted);
      else if (c.k === 'rewarded') v = String(t.rewarded);
      else if (['due', 'credited', 'shortfall', 'withdrawn', 'pendingReq', 'balance'].includes(c.k)) v = money(t[c.k]);
      doc.text(v, x, y + 5, { width: c.w - 8, align: c.align, lineBreak: false });
      x += c.w;
    });
    y += 17;
    return t;
  };

  // Title band
  doc.rect(startX, y, W, 52).fill('#b91c1c');
  doc.fill('#ffffff').font('Helvetica-Bold').fontSize(17).text('TAHELKA NEWS', startX + 12, y + 8);
  doc.fontSize(11).text('District In-Charge Earnings - State Wise Report', startX + 12, y + 28);
  doc.font('Helvetica').fontSize(8).text(`Period: 01 Aug 2026 - 31 Aug 2026 (IST)  |  DI Rate: Rs.10/news  |  Generated: ${new Date().toLocaleString('en-IN')}`, startX + 12, y + 41);
  y += 62;

  // State sections
  stateNames.forEach((st) => {
    const list = states[st].sort((a, b) => b.due - a.due);
    pageBreak(60);
    // State header: state + SIC name(s)
    doc.rect(startX, y, W, 20).fill('#0f172a');
    doc.fill('#ffffff').font('Helvetica-Bold').fontSize(10)
      .text(`${st.toUpperCase()}`, startX + 8, y + 5, { continued: true })
      .font('Helvetica').fontSize(8.5)
      .text(`   |   State In-Charge: ${(sicByState[st] || ['-']).join(', ')}   |   District In-Charges: ${list.length}`);
    y += 20;
    drawTableHeader();
    list.forEach((r, i) => drawRow(r, i, i % 2 === 0));
    drawTotals(list, `${st} TOTAL`, '#e0e7ff');
    y += 8;
  });

  // Grand total + notes
  y += 4;
  const grand = drawTotals(rows, `GRAND TOTAL (${rows.length} District In-Charges)`, '#fde68a');
  y += 10;
  pageBreak(80);
  doc.font('Helvetica-Bold').fontSize(9).fill('#111827').text('Notes:', startX, y); y += 12;
  doc.font('Helvetica').fontSize(7.5).fill('#374151');
  [
    'Posted    = approved news published in August (full month).',
    'Rewarded  = news that earned the per-news reward. The per-news reward system went LIVE on 25 Aug 2026;',
    '            before that date reporters were on the daily-target reward system, so early-August news shows in Posted but not Rewarded.',
    'Due @10   = Rewarded x Rs.10 (District In-Charge rate, not the Rs.5 stringer rate).',
    'Top-up    = Due - Credited. RED amounts are still payable to reach the full Rs.10 rate.',
    'Withdrawn = withdrawals PAID in August.  |  Wd Pending = withdrawal requests currently awaiting payment.',
    'Balance   = current wallet balance (lifetime, includes earlier earnings).',
  ].forEach((t) => { doc.text(t, startX, y); y += 10; });

  doc.end();
  console.log(`States: ${stateNames.length} | DIs: ${rows.length} | posted ${grand.posted} | rewarded ${grand.rewarded} | due ${money(grand.due)} | credited ${money(grand.credited)} | TOP-UP ${money(grand.shortfall)} | wd-pending ${money(grand.pendingReq)}`);
  console.log('PDF: ' + OUT);
  await mongoose.disconnect();
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
