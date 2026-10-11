/**
 * One-off read-only report: a reporter's news activity → PDF.
 * Run on the server (has the production .env + models + pdfkit).
 *   node scripts/reporter-news-report.js "<reporter name>" [outPath.pdf]
 * No writes to the DB.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const PDFDocument = require('pdfkit');

const NAME = process.argv[2] || 'Raju Nirala';
const OUT = process.argv[3] || `/tmp/${NAME.replace(/\s+/g, '_').toLowerCase()}_news_report.pdf`;

const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const fmtDate = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—');
const fmtDay = (d) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 9000 });
  const Admin = require('../models/Admin');
  const News = require('../models/News');

  // Exact, anchored name match (case-insensitive) so we never grab a different
  // "Raju". Optional --id=<adminId> pins it exactly.
  const idArg = process.argv.find((a) => a.startsWith('--id='));
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let reporter;
  if (idArg) {
    reporter = await Admin.findById(idArg.split('=')[1]).lean();
  } else {
    const exact = new RegExp('^\\s*' + esc(NAME) + '\\s*$', 'i');
    const matches = await Admin.find({ name: exact }).lean();
    reporter = matches.find((a) => /chhat/i.test(a.assignedState || (a.assignedStates || []).join(''))) || matches[0];
  }
  if (!reporter) throw new Error(`Reporter "${NAME}" not found`);

  const id = String(reporter._id);
  const q = { $or: [{ authorId: id }, { author: reporter.name }] };

  const total = await News.countDocuments(q);
  const monthly = await News.aggregate([
    { $match: q },
    { $group: { _id: { y: { $year: '$publishedAt' }, m: { $month: '$publishedAt' } }, n: { $sum: 1 } } },
    { $sort: { '_id.y': 1, '_id.m': 1 } },
  ]);
  // September, date-wise (every year that has September data)
  const sept = await News.aggregate([
    { $match: q },
    { $match: { $expr: { $eq: [{ $month: '$publishedAt' }, 9] } } },
    { $group: { _id: { y: { $year: '$publishedAt' }, d: { $dayOfMonth: '$publishedAt' } }, n: { $sum: 1 } } },
    { $sort: { '_id.y': 1, '_id.d': 1 } },
  ]);
  const septTotal = sept.reduce((s, r) => s + r.n, 0);

  await mongoose.disconnect();

  // ---- PDF ----
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(fs.createWriteStream(OUT));
  const RED = '#E31E24';
  const INK = '#15181C';
  const GREY = '#6B7280';

  // Header
  doc.rect(0, 0, doc.page.width, 70).fill(RED);
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(20).text('TEHELKA NEWS', 50, 22);
  doc.font('Helvetica').fontSize(11).fillColor('#ffe3e4').text('Reporter News Activity Report', 50, 46);
  doc.fillColor(INK);

  let y = 95;
  doc.font('Helvetica-Bold').fontSize(15).fillColor(INK).text(reporter.name, 50, y);
  y += 24;
  const meta = [
    ['State', reporter.assignedState || (reporter.assignedStates || []).join(', ') || '—'],
    ['Email / Username', reporter.email || reporter.username || '—'],
    ['Role', `${reporter.role || '—'}${reporter.reporterTier ? ' (' + reporter.reporterTier + ')' : ''}`],
    ['Joined on', fmtDate(reporter.createdAt)],
    ['Report generated', fmtDate(new Date())],
  ];
  doc.fontSize(10.5);
  meta.forEach(([k, v]) => {
    doc.font('Helvetica-Bold').fillColor(GREY).text(k + ':', 50, y, { continued: true, width: 500 });
    doc.font('Helvetica').fillColor(INK).text('  ' + v);
    y += 17;
  });

  // Total highlight
  y += 8;
  doc.roundedRect(50, y, doc.page.width - 100, 46, 8).fill('#FFF4F4');
  doc.fillColor(RED).font('Helvetica-Bold').fontSize(26).text(String(total), 66, y + 8, { continued: true });
  doc.fillColor(INK).font('Helvetica').fontSize(12).text('   total news posted (all time)');
  y += 66;

  // Month-wise summary
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(13).text('Month-wise summary', 50, y);
  y += 20;
  doc.fontSize(10.5);
  monthly.forEach((r) => {
    const label = `${MONTHS[r._id.m]} ${r._id.y}`;
    doc.font('Helvetica').fillColor(INK).text(label, 60, y, { width: 200, continued: true });
    doc.font('Helvetica-Bold').fillColor(RED).text(`   ${r.n} news`);
    y += 16;
  });

  // September detail
  y += 14;
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(13).text('September — date-wise detail', 50, y);
  y += 20;
  doc.font('Helvetica').fontSize(9.5).fillColor(GREY).text(`(${septTotal} news in September)`, 50, y);
  y += 20;

  // table header
  const x1 = 60, x2 = 300;
  doc.roundedRect(50, y - 4, doc.page.width - 100, 22, 4).fill('#F3F4F6');
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(10.5).text('Date', x1, y);
  doc.text('News posted', x2, y);
  y += 22;
  doc.font('Helvetica').fontSize(10.5);
  if (sept.length === 0) {
    doc.fillColor(GREY).text('No news posted in September.', x1, y);
    y += 18;
  } else {
    sept.forEach((r, i) => {
      if (i % 2 === 1) doc.rect(50, y - 3, doc.page.width - 100, 18).fill('#FAFAFA').fillColor(INK);
      const dstr = `${String(r._id.d).padStart(2, '0')} Sep ${r._id.y}`;
      doc.fillColor(INK).text(dstr, x1, y);
      doc.fillColor(INK).text(String(r.n), x2, y);
      y += 18;
    });
    // total row
    doc.moveTo(50, y).lineTo(doc.page.width - 50, y).strokeColor('#E5E7EB').stroke();
    y += 6;
    doc.font('Helvetica-Bold').fillColor(INK).text('Total', x1, y);
    doc.fillColor(RED).text(String(septTotal), x2, y);
    y += 20;
  }

  doc.font('Helvetica').fontSize(8).fillColor(GREY).text(
    'Auto-generated from Tehelka News production data. Counts are based on the article published date (IST).',
    50, doc.page.height - 60, { width: doc.page.width - 100 }
  );

  doc.end();
  await new Promise((res) => doc.on('end', res));
  console.log('PDF_WRITTEN:' + OUT);
  console.log(JSON.stringify({ reporter: reporter.name, joined: reporter.createdAt, total, monthly: monthly.map((r) => `${r._id.y}-${r._id.m}:${r.n}`), septTotal }));
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
