'use strict';

/**
 * Random 10 quiz participants of a week → PDF (name, mobile, email, location).
 * Default week = the latest week that has entries. READ-ONLY.
 * Usage: node scripts/reports/quiz-random10.js [weekId] [count]
 */
require('dotenv').config();
const path = require('path');
const os = require('os');
const fs = require('fs');
const mongoose = require('mongoose');
const PDFDocument = require('pdfkit');

async function main() {
  const argWeek = process.argv[2] && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[2]) ? process.argv[2] : null;
  const COUNT = Math.max(1, parseInt(process.argv[3], 10) || 10);
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const QE = db.collection('quizentries');
  const Users = db.collection('users');

  // Pick the week.
  let weekId = argWeek;
  if (!weekId) {
    const w = await QE.aggregate([{ $group: { _id: '$weekId', c: { $sum: 1 } } }, { $sort: { _id: -1 } }, { $limit: 1 }]).toArray();
    weekId = w[0] && w[0]._id;
  }
  if (!weekId) { console.log('No quiz weeks found.'); return process.exit(0); }

  // Distinct participants (submitted at least once that week).
  const ids = await QE.distinct('userId', { weekId, submittedAt: { $ne: null } });
  console.log(`Week ${weekId}: ${ids.length} participants.`);
  if (!ids.length) { console.log('No participants.'); return process.exit(0); }

  const users = await Users.find({ googleId: { $in: ids } })
    .project({ displayName: 1, email: 1, mobileNumber: 1, locationProfile: 1, googleId: 1 }).toArray();

  const loc = (u) => {
    const lp = u.locationProfile || {};
    const parts = [lp.primaryDistrict || lp.district || lp.city, lp.primaryState || lp.state].filter(Boolean);
    return parts.join(', ');
  };

  // Prefer members who HAVE a mobile number (so the PDF has real phone numbers).
  const withMobile = users.filter((u) => (u.mobileNumber || '').trim());
  const without = users.filter((u) => !(u.mobileNumber || '').trim());
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const pool = [...shuffle(withMobile), ...shuffle(without)];
  const picked = pool.slice(0, COUNT);

  // ── PDF ──
  const OUT = path.join(os.homedir(), 'Desktop', `Quiz_Random10_${weekId}.pdf`);
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(fs.createWriteStream(OUT));
  const W = doc.page.width - 80; const X = 40; let y = 40;

  doc.rect(X, y, W, 48).fill('#5E35B1');
  doc.fill('#fff').font('Helvetica-Bold').fontSize(16).text('TAHELKA NEWS — Daily Quiz', X + 12, y + 8);
  doc.font('Helvetica').fontSize(9).text(`Random ${picked.length} participants  |  Week ${weekId}  |  Total played: ${ids.length}  |  ${new Date().toLocaleDateString('en-IN')}`, X + 12, y + 30);
  y += 60;

  const cols = [
    { k: 'i', label: '#', w: 26 },
    { k: 'name', label: 'Name', w: 130 },
    { k: 'mobile', label: 'Mobile', w: 90 },
    { k: 'email', label: 'Email', w: 165 },
    { k: 'loc', label: 'Location', w: 104 },
  ];
  const rowH = 22;
  const header = () => {
    doc.rect(X, y, W, 20).fill('#334155');
    let x = X + 6; doc.fill('#fff').font('Helvetica-Bold').fontSize(9);
    cols.forEach((c) => { doc.text(c.label, x, y + 6, { width: c.w - 6, lineBreak: false }); x += c.w; });
    y += 20;
  };
  header();
  picked.forEach((u, i) => {
    if (y + rowH > doc.page.height - 40) { doc.addPage(); y = 40; header(); }
    if (i % 2 === 0) doc.rect(X, y, W, rowH).fill('#f4f2fb');
    const v = { i: String(i + 1), name: u.displayName || '-', mobile: u.mobileNumber || '-', email: u.email || '-', loc: loc(u) || '-' };
    let x = X + 6; doc.fill('#111827').font('Helvetica').fontSize(9);
    cols.forEach((c) => { doc.text(String(v[c.k]), x, y + 6, { width: c.w - 6, lineBreak: false, ellipsis: true }); x += c.w; });
    y += rowH;
  });

  doc.end();
  console.log(`Picked ${picked.length} (with mobile: ${picked.filter((u) => (u.mobileNumber || '').trim()).length}).`);
  console.log('PDF: ' + OUT);
  await mongoose.disconnect();
}
main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
