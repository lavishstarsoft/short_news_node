'use strict';

/**
 * MADHYA PRADESH — State In-Charge → District In-Charge directory + AUGUST earnings.
 * Grouped by State In-Charge (via district division). Per DI: name / mobile / email /
 * district + Aug (1–31) approved news, Due @Rs.10, Paid, Top-up. READ-ONLY.
 * Output: ~/Desktop/MP_Incharge_Directory.pdf
 */

require('dotenv').config();
const path = require('path');
const os = require('os');
const fs = require('fs');
const mongoose = require('mongoose');
const PDFDocument = require('pdfkit');

// Pass the state as an argument: node mp-hierarchy-report.js "Bihar"
// Add --tier stringer for a stringer (Rs.5/news) list; default is district_incharge (Rs.10/news).
const STATE = process.argv.slice(2).filter((a) => !a.startsWith('--')).join(' ').trim() || 'Madhya Pradesh';
const TIER = process.argv.includes('--tier') ? (process.argv[process.argv.indexOf('--tier') + 1] || 'district_incharge') : 'district_incharge';
const RATE = TIER === 'stringer' ? 5 : 10;
const OUT = path.join(os.homedir(), 'Desktop', STATE.replace(/[^\w]+/g, '_') + (TIER === 'stringer' ? '_Stringers' : '_Incharge') + '_Directory.pdf');
const START = new Date('2026-07-31T18:30:00.000Z'); // 01 Aug IST
const END = new Date('2026-08-31T18:29:59.999Z');    // 31 Aug IST

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const Admins = db.collection('admins');
  const Roles = db.collection('roles');
  const Tx = db.collection('adminwallettransactions');
  const News = db.collection('news');

  const sicRole = await Roles.findOne({ name: 'State In-Charge' });
  const sics = await Admins.find({
    roleIds: sicRole._id, $or: [{ assignedStates: STATE }, { assignedState: STATE }],
  }).project({ name: 1, mobileNumber: 1, email: 1, 'permissions.managedDistricts': 1 }).sort({ name: 1 }).toArray();

  const owner = {};
  sics.forEach((s) => ((s.permissions && s.permissions.managedDistricts) || []).forEach((d) => { owner[String(d).trim().toLowerCase()] = s.name; }));

  const dis = await Admins.find({
    reporterTier: TIER, $or: [{ assignedStates: STATE }, { assignedState: STATE }],
  }).project({ name: 1, mobileNumber: 1, email: 1, assignedDistricts: 1 }).sort({ name: 1 }).toArray();

  // August earnings per reporter (Rs.RATE/news)
  for (const d of dis) {
    const aid = String(d._id);
    const idOr = { $or: [{ adminId: d._id }, { adminId: aid }] };
    d._news = await News.countDocuments({ authorId: aid, 'approvalStatus.isApproved': true, publishedAt: { $gte: START, $lte: END } });
    d._due = d._news * RATE;
    const paidAgg = await Tx.aggregate([{ $match: { ...idOr, type: 'credit', createdAt: { $gte: START, $lte: END } } }, { $group: { _id: null, s: { $sum: '$amount' } } }]).toArray();
    d._paid = (paidAgg[0] && paidAgg[0].s) || 0;
    d._topup = Math.max(0, d._due - d._paid);
  }

  const groups = {}; const unassigned = [];
  if (sics.length === 1) {
    // Only one State In-Charge → every District In-Charge is under them.
    groups[sics[0].name] = dis.slice();
  } else {
    dis.forEach((d) => {
      const dist = String((d.assignedDistricts || [])[0] || '').trim().toLowerCase();
      const o = owner[dist];
      if (o) (groups[o] = groups[o] || []).push(d); else unassigned.push(d);
    });
  }

  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });
  doc.pipe(fs.createWriteStream(OUT));
  const W = doc.page.width - 72;
  const X = 36;
  let y = 36;
  const money = (n) => 'Rs.' + Number(n || 0).toLocaleString('en-IN');
  const ensure = (need) => { if (y + need > doc.page.height - 44) { doc.addPage({ size: 'A4', layout: 'landscape', margin: 36 }); y = 36; } };

  doc.rect(X, y, W, 44).fill('#b91c1c');
  doc.fill('#fff').font('Helvetica-Bold').fontSize(15).text('TAHELKA NEWS', X + 12, y + 7);
  doc.font('Helvetica').fontSize(9).text(`${STATE} — In-Charge Directory + August (01–31) Earnings  |  Rate Rs.10/news  |  ${new Date().toLocaleDateString('en-IN')}`, X + 12, y + 26);
  y += 54;

  const cols = [
    { k: 'i', label: '#', w: 22, a: 'left' },
    { k: 'name', label: 'District In-Charge', w: 120, a: 'left' },
    { k: 'mobileNumber', label: 'Mobile', w: 78, a: 'left' },
    { k: 'email', label: 'Email', w: 168, a: 'left' },
    { k: 'district', label: 'District', w: 72, a: 'left' },
    { k: '_news', label: 'News', w: 42, a: 'right' },
    { k: '_due', label: 'Due @10', w: 60, a: 'right' },
    { k: '_paid', label: 'Paid', w: 58, a: 'right' },
    { k: '_topup', label: 'Top-up', w: 58, a: 'right' },
  ];
  const money_k = ['_due', '_paid', '_topup'];
  const rowH = 15;

  const header = () => {
    ensure(rowH);
    doc.rect(X, y, W, rowH).fill('#334155');
    let x = X + 4; doc.fill('#fff').font('Helvetica-Bold').fontSize(7.5);
    cols.forEach((c) => { doc.text(c.label, x, y + 4, { width: c.w - 6, align: c.a, lineBreak: false }); x += c.w; });
    y += rowH;
  };
  const row = (d, i, zebra) => {
    ensure(rowH);
    if (zebra) doc.rect(X, y, W, rowH).fill('#f6f7f9');
    let x = X + 4; doc.font('Helvetica').fontSize(7.5);
    const vals = { i: String(i + 1), name: d.name || '', mobileNumber: d.mobileNumber || '-', email: d.email || '-', district: (d.assignedDistricts || [])[0] || '', _news: String(d._news), _due: money(d._due), _paid: money(d._paid), _topup: money(d._topup) };
    cols.forEach((c) => {
      const red = c.k === '_topup' && d._topup > 0;
      doc.fill(red ? '#b91c1c' : '#111827'); if (red) doc.font('Helvetica-Bold');
      doc.text(String(vals[c.k]), x, y + 4, { width: c.w - 6, align: c.a, lineBreak: false });
      if (red) doc.font('Helvetica');
      x += c.w;
    });
    y += rowH;
  };
  const totals = (list, label, bg) => {
    ensure(rowH + 2);
    const t = list.reduce((a, d) => ({ news: a.news + d._news, due: a.due + d._due, paid: a.paid + d._paid, topup: a.topup + d._topup }), { news: 0, due: 0, paid: 0, topup: 0 });
    doc.rect(X, y, W, rowH + 1).fill(bg);
    let x = X + 4; doc.fill('#111827').font('Helvetica-Bold').fontSize(7.5);
    cols.forEach((c) => {
      let v = '';
      if (c.k === 'name') v = label;
      else if (c.k === '_news') v = String(t.news);
      else if (c.k === '_due') v = money(t.due);
      else if (c.k === '_paid') v = money(t.paid);
      else if (c.k === '_topup') v = money(t.topup);
      doc.text(v, x, y + 4, { width: c.w - 6, align: c.a, lineBreak: false }); x += c.w;
    });
    y += rowH + 5;
  };

  const section = (sic, list) => {
    ensure(40);
    doc.rect(X, y, W, 28).fill('#0f172a');
    doc.fill('#fff').font('Helvetica-Bold').fontSize(10.5).text('STATE IN-CHARGE: ' + sic.name, X + 8, y + 4);
    doc.font('Helvetica').fontSize(8).fill('#e5e7eb').text(`Mobile: ${sic.mobileNumber || '-'}    Email: ${sic.email || '-'}    District In-Charges: ${list.length}`, X + 8, y + 17);
    doc.fill('#111827'); y += 32;
    if (!list.length) { doc.font('Helvetica-Oblique').fontSize(9).fill('#9a3412').text('No districts assigned yet — assign on the District Division page.', X + 8, y); y += 18; return; }
    header();
    list.forEach((d, i) => row(d, i, i % 2 === 0));
    totals(list, sic.name + ' TOTAL', '#e0e7ff');
  };

  sics.forEach((s) => section(s, (groups[s.name] || []).sort((a, b) => (a.name || '').localeCompare(b.name || ''))));

  if (unassigned.length > 0) {
    ensure(40);
    doc.rect(X, y, W, 26).fill('#fde68a');
    doc.fill('#111827').font('Helvetica-Bold').fontSize(10.5).text(`NOT ASSIGNED to any State In-Charge — ${unassigned.length} District In-Charges`, X + 8, y + 7);
    y += 30;
    doc.font('Helvetica').fontSize(7.5).fill('#7c2d12').text(`Districts not yet divided among the State In-Charges (District Division → ${STATE}).`, X + 8, y); y += 15;
    header();
    const un = unassigned.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    un.forEach((d, i) => row(d, i, i % 2 === 0));
    totals(un, 'UNASSIGNED TOTAL', '#fde68a');
  }

  y += 4; totals(dis, `GRAND TOTAL (${dis.length} District In-Charges)`, '#fbcfe8');

  doc.end();
  const g = dis.reduce((a, d) => ({ due: a.due + d._due, paid: a.paid + d._paid, topup: a.topup + d._topup }), { due: 0, paid: 0, topup: 0 });
  console.log(`SICs ${sics.length} | DIs ${dis.length} | unassigned ${unassigned.length} | Due ${money(g.due)} | Paid ${money(g.paid)} | Top-up ${money(g.topup)}`);
  console.log('PDF: ' + OUT);
  await mongoose.disconnect();
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
