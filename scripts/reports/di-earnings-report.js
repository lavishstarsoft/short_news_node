'use strict';

/**
 * DISTRICT IN-CHARGE EARNINGS REPORT (PDF) — 29 Aug → 1 Sep 2026
 *
 * READ-ONLY: only reads the DB and writes a local PDF. Nothing in production
 * is modified.
 *
 * For every district_incharge reporter it shows, for the window:
 *   - Approved (rewarded) news count
 *   - DUE at Rs.10/news  (the boss's requirement: DI rate, not stringer rate)
 *   - CREDITED (news rewards + Rs.5 tier corrections actually paid)
 *   - SHORTFALL (due - credited → still to be topped up, if any)
 *   - Withdrawn (completed withdrawals in the window)
 *   - Pending withdrawal requests (awaiting payment)
 *   - Current wallet balance
 *
 * Output: ~/Desktop/DI_Earnings_Report_Aug29-Sep01.pdf
 */

require('dotenv').config();
const path = require('path');
const os = require('os');
const fs = require('fs');
const mongoose = require('mongoose');
const PDFDocument = require('pdfkit');

const START = new Date('2026-08-28T18:30:00.000Z'); // 29 Aug 00:00 IST
const END = new Date();                              // now (1 Sep)
const OUT = path.join(os.homedir(), 'Desktop', 'DI_Earnings_Report_Aug29-Sep01.pdf');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const Admins = db.collection('admins');
  const Tx = db.collection('adminwallettransactions');
  const Wd = db.collection('withdrawalrequests');

  const dis = await Admins.find({ reporterTier: 'district_incharge' })
    .project({ name: 1, username: 1, assignedDistricts: 1, walletBalance: 1, mobileNumber: 1 })
    .sort({ name: 1 }).toArray();

  const rows = [];
  for (const d of dis) {
    const idOr = { $or: [{ adminId: d._id }, { adminId: String(d._id) }] };
    const credits = await Tx.find({ ...idOr, type: 'credit', createdAt: { $gte: START, $lte: END }, referenceId: /^(newsreward_|tierdiff_)/ }).toArray();
    let news = 0, credited = 0;
    credits.forEach((t) => { credited += t.amount; if (/^newsreward_/.test(t.referenceId)) news++; });
    const due = news * 10;
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

    rows.push({
      name: d.name || d.username,
      district: (d.assignedDistricts || [])[0] || '',
      news, due, credited, shortfall, withdrawn, pendingReq,
      balance: d.walletBalance || 0,
    });
  }

  // Sort: biggest earners first
  rows.sort((a, b) => b.due - a.due);
  const tot = rows.reduce((t, r) => ({
    news: t.news + r.news, due: t.due + r.due, credited: t.credited + r.credited,
    shortfall: t.shortfall + r.shortfall, withdrawn: t.withdrawn + r.withdrawn,
    pendingReq: t.pendingReq + r.pendingReq, balance: t.balance + r.balance,
  }), { news: 0, due: 0, credited: 0, shortfall: 0, withdrawn: 0, pendingReq: 0, balance: 0 });

  // ── PDF (A4 landscape, clean table) ──────────────────────────────────────
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });
  doc.pipe(fs.createWriteStream(OUT));
  const W = doc.page.width - 72;

  // Header band
  doc.rect(36, 36, W, 54).fill('#b91c1c');
  doc.fill('#ffffff').font('Helvetica-Bold').fontSize(18).text('TAHELKA NEWS', 48, 46);
  doc.fontSize(12).text('District In-Charge Earnings Report', 48, 68);
  doc.font('Helvetica').fontSize(9).text(`Period: 29 Aug 2026 - 01 Sep 2026 (IST)   |   Rate: Rs.10 per approved news   |   Generated: ${new Date().toLocaleString('en-IN')}`, 48, 84, { width: W - 24 });

  // Column layout
  const cols = [
    { k: 'i', label: '#', w: 22, align: 'left' },
    { k: 'name', label: 'District In-Charge', w: 150, align: 'left' },
    { k: 'district', label: 'District', w: 92, align: 'left' },
    { k: 'news', label: 'News', w: 40, align: 'right' },
    { k: 'due', label: 'Due @Rs.10', w: 62, align: 'right' },
    { k: 'credited', label: 'Credited', w: 58, align: 'right' },
    { k: 'shortfall', label: 'To Top-up', w: 58, align: 'right' },
    { k: 'withdrawn', label: 'Withdrawn', w: 62, align: 'right' },
    { k: 'pendingReq', label: 'Withdraw Pending', w: 78, align: 'right' },
    { k: 'balance', label: 'Wallet Balance', w: 72, align: 'right' },
  ];
  const startX = 36;
  let y = 106;

  const drawHeader = () => {
    doc.rect(startX, y, W, 18).fill('#0f172a');
    let x = startX + 6;
    doc.fill('#ffffff').font('Helvetica-Bold').fontSize(8);
    cols.forEach((c) => { doc.text(c.label, x, y + 5, { width: c.w - 8, align: c.align }); x += c.w; });
    y += 18;
  };
  const money = (n) => 'Rs.' + Number(n || 0).toLocaleString('en-IN');

  drawHeader();
  rows.forEach((r, i) => {
    if (y > doc.page.height - 60) { doc.addPage({ size: 'A4', layout: 'landscape', margin: 36 }); y = 40; drawHeader(); }
    if (i % 2 === 0) doc.rect(startX, y, W, 16).fill('#f6f7f9');
    let x = startX + 6;
    doc.font('Helvetica').fontSize(8);
    cols.forEach((c) => {
      let v = c.k === 'i' ? String(i + 1) : r[c.k];
      if (['due', 'credited', 'shortfall', 'withdrawn', 'pendingReq', 'balance'].includes(c.k)) v = money(v);
      if (c.k === 'news') v = String(v);
      const isShort = c.k === 'shortfall' && r.shortfall > 0;
      doc.fill(isShort ? '#b91c1c' : '#111827');
      if (isShort) doc.font('Helvetica-Bold');
      doc.text(String(v || ''), x, y + 4, { width: c.w - 8, align: c.align, lineBreak: false });
      if (isShort) doc.font('Helvetica');
      x += c.w;
    });
    y += 16;
  });

  // Totals row
  doc.rect(startX, y, W, 18).fill('#fde68a');
  let x = startX + 6;
  doc.fill('#111827').font('Helvetica-Bold').fontSize(8);
  cols.forEach((c) => {
    let v = '';
    if (c.k === 'name') v = 'TOTAL (' + rows.length + ' District In-Charges)';
    if (c.k === 'news') v = String(tot.news);
    if (['due', 'credited', 'shortfall', 'withdrawn', 'pendingReq', 'balance'].includes(c.k)) v = money(tot[c.k]);
    doc.text(v, x, y + 5, { width: c.w - 8, align: c.align, lineBreak: false });
    x += c.w;
  });
  y += 30;

  // Notes
  doc.font('Helvetica-Bold').fontSize(9).fill('#111827').text('How to read this report:', startX, y);
  y += 14;
  doc.font('Helvetica').fontSize(8).fill('#374151');
  [
    'Due @Rs.10  = approved news x Rs.10 (District In-Charge rate - NOT the Rs.5 stringer rate).',
    'Credited    = amount actually added to their wallet in this period (news rewards + Rs.5 tier corrections).',
    'To Top-up   = Due minus Credited. RED amounts are still to be paid to reach the full Rs.10 rate.',
    'Withdrawn   = withdrawals PAID to them during this period.  |  Withdraw Pending = requests waiting for payment.',
    'Wallet Balance = their current total balance (includes earnings from before this period too).',
  ].forEach((t) => { doc.text('*  ' + t, startX, y); y += 11; });

  doc.end();
  console.log(`Rows: ${rows.length} DIs | news ${tot.news} | due ${money(tot.due)} | credited ${money(tot.credited)} | TO TOP-UP ${money(tot.shortfall)} | withdrawn ${money(tot.withdrawn)} | pending ${money(tot.pendingReq)}`);
  console.log('PDF: ' + OUT);
  await mongoose.disconnect();
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
