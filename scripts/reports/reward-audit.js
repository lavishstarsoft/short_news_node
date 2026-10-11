'use strict';

/**
 * REPORTER REWARD AUDIT (READ-ONLY)
 *
 * Scans every reporter (editor/subeditor role or reporterTier set) and flags two
 * problems:
 *   A) Wallet NOT enabled — they publish news but earn nothing (walletConfig.enabled != true).
 *   B) Amount mismatch — approved news exist but the per-news reward (newsreward_<id>)
 *      was not credited for all of them (like Shubham Awasthi). owed = missing x rate.
 *
 * Rate: district_incharge = Rs.10/news, everyone else = Rs.5/news.
 * Reporters who earned via the OLD daily model (reward_ credits) are marked so their
 * "missing" is reviewed, not blindly paid. Nothing is written. Output: PDF on Desktop.
 */

require('dotenv').config();
const path = require('path');
const os = require('os');
const fs = require('fs');
const mongoose = require('mongoose');
const PDFDocument = require('pdfkit');

const OUT = path.join(os.homedir(), 'Desktop', 'Reporter_Reward_Audit.pdf');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const Admins = db.collection('admins');
  const Tx = db.collection('adminwallettransactions');
  const News = db.collection('news');

  // approved news count per author
  const appr = await News.aggregate([
    { $match: { 'approvalStatus.isApproved': true } },
    { $project: { aid: { $toString: '$authorId' } } },
    { $group: { _id: '$aid', c: { $sum: 1 } } },
  ]).toArray();
  const approvedBy = Object.fromEntries(appr.map((a) => [a._id, a.c]));

  // credit sums per admin, split by referenceId prefix
  const cr = await Tx.aggregate([
    { $match: { type: 'credit' } },
    { $project: { aid: { $toString: '$adminId' }, amount: 1, p: { $arrayElemAt: [{ $split: ['$referenceId', '_'] }, 0] } } },
    { $group: { _id: { aid: '$aid', p: '$p' }, c: { $sum: 1 }, s: { $sum: '$amount' } } },
  ]).toArray();
  const credit = {}; // aid -> { newsrewardCount, newsrewardSum, dailySum, tierdiffSum, totalSum }
  for (const r of cr) {
    const a = (credit[r._id.aid] = credit[r._id.aid] || { newsrewardCount: 0, newsrewardSum: 0, dailySum: 0, tierdiffSum: 0, totalSum: 0 });
    a.totalSum += r.s;
    if (r._id.p === 'newsreward') { a.newsrewardCount += r.c; a.newsrewardSum += r.s; }
    else if (r._id.p === 'reward') a.dailySum += r.s;
    else if (r._id.p === 'tierdiff') a.tierdiffSum += r.s;
  }

  // all reporters
  const reporters = await Admins.find({
    $or: [{ role: { $in: ['editor', 'subeditor'] } }, { reporterTier: { $in: ['stringer', 'district_incharge'] } }],
  }).project({ name: 1, username: 1, mobileNumber: 1, role: 1, reporterTier: 1, walletBalance: 1, 'walletConfig.enabled': 1, assignedStates: 1, assignedState: 1 }).toArray();

  const rows = reporters.map((d) => {
    const aid = String(d._id);
    const rate = d.reporterTier === 'district_incharge' ? 10 : 5;
    const approved = approvedBy[aid] || 0;
    const c = credit[aid] || { newsrewardCount: 0, dailySum: 0, totalSum: 0 };
    const missing = Math.max(0, approved - c.newsrewardCount);
    const owed = missing * rate;
    const enabled = d.walletConfig && d.walletConfig.enabled === true;
    return {
      name: d.name || d.username || '(no name)', mobile: d.mobileNumber || '',
      tier: d.reporterTier || (d.role || ''), rate, enabled,
      state: (d.assignedStates && d.assignedStates[0]) || d.assignedState || '',
      approved, rewarded: c.newsrewardCount, missing, owed,
      daily: Math.round(c.dailySum || 0), balance: Math.round(d.walletBalance || 0),
      hasDaily: (c.dailySum || 0) > 0,
    };
  });

  const walletOff = rows.filter((r) => !r.enabled && r.approved > 0).sort((a, b) => b.approved - a.approved);
  const mismatch = rows.filter((r) => r.missing > 0).sort((a, b) => b.owed - a.owed);
  const owedTotal = mismatch.reduce((s, r) => s + r.owed, 0);

  // ── PDF ──
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 32 });
  doc.pipe(fs.createWriteStream(OUT));
  const W = doc.page.width - 64; const X = 32; let y = 32;
  const money = (n) => 'Rs.' + Number(n || 0).toLocaleString('en-IN');
  const ensure = (h) => { if (y + h > doc.page.height - 36) { doc.addPage({ size: 'A4', layout: 'landscape', margin: 32 }); y = 32; } };

  doc.rect(X, y, W, 46).fill('#b91c1c');
  doc.fill('#fff').font('Helvetica-Bold').fontSize(15).text('TAHELKA NEWS — Reporter Reward Audit', X + 12, y + 8);
  doc.font('Helvetica').fontSize(9).text(`Total reporters: ${reporters.length}   |   Wallet NOT enabled (with news): ${walletOff.length}   |   Amount mismatch: ${mismatch.length}   |   Total owed: ${money(owedTotal)}   |   ${new Date().toLocaleString('en-IN')}`, X + 12, y + 28);
  y += 56;

  const cols = [
    { k: 'i', label: '#', w: 22 }, { k: 'name', label: 'Reporter', w: 130 }, { k: 'mobile', label: 'Mobile', w: 78 },
    { k: 'tier', label: 'Tier', w: 90 }, { k: 'state', label: 'State', w: 90 }, { k: 'approved', label: 'Approved', w: 55, r: 1 },
    { k: 'rewarded', label: 'Rewarded', w: 55, r: 1 }, { k: 'missing', label: 'Missing', w: 50, r: 1 },
    { k: 'owed', label: 'Owed', w: 60, r: 1, m: 1 }, { k: 'daily', label: 'DailyRwd', w: 60, r: 1, m: 1 }, { k: 'balance', label: 'Balance', w: 60, r: 1, m: 1 },
  ];
  const rowH = 14;
  const header = () => {
    ensure(rowH); doc.rect(X, y, W, rowH).fill('#334155');
    let x = X + 4; doc.fill('#fff').font('Helvetica-Bold').fontSize(7.5);
    cols.forEach((c) => { doc.text(c.label, x, y + 3.5, { width: c.w - 6, align: c.r ? 'right' : 'left', lineBreak: false }); x += c.w; });
    y += rowH;
  };
  const row = (r, i, zebra) => {
    ensure(rowH); if (zebra) doc.rect(X, y, W, rowH).fill('#f6f7f9');
    let x = X + 4; doc.font('Helvetica').fontSize(7.5);
    const v = { i: String(i + 1), name: r.name, mobile: r.mobile, tier: r.tier + (r.hasDaily ? ' *' : ''), state: r.state, approved: String(r.approved), rewarded: String(r.rewarded), missing: String(r.missing), owed: r.owed ? money(r.owed) : '-', daily: r.daily ? money(r.daily) : '-', balance: money(r.balance) };
    cols.forEach((c) => {
      const red = c.k === 'owed' && r.owed > 0; doc.fill(red ? '#b91c1c' : '#111827'); if (red) doc.font('Helvetica-Bold');
      doc.text(String(v[c.k]), x, y + 3.5, { width: c.w - 6, align: c.r ? 'right' : 'left', lineBreak: false });
      if (red) doc.font('Helvetica'); x += c.w;
    });
    y += rowH;
  };
  const section = (title, list, bg) => {
    ensure(24); doc.rect(X, y, W, 20).fill(bg);
    doc.fill('#111827').font('Helvetica-Bold').fontSize(10).text(title, X + 8, y + 5); y += 24;
    if (!list.length) { doc.font('Helvetica-Oblique').fontSize(9).fill('#16a34a').text('None — all good here.', X + 8, y); y += 16; return; }
    header(); list.forEach((r, i) => row(r, i, i % 2 === 0)); y += 6;
  };

  section(`A) WALLET NOT ENABLED — ${walletOff.length} reporters have approved news but earn nothing`, walletOff, '#fecaca');
  section(`B) AMOUNT MISMATCH — ${mismatch.length} reporters missing per-news reward (owed ${money(owedTotal)})`, mismatch, '#fde68a');
  ensure(24);
  doc.font('Helvetica').fontSize(7.5).fill('#6b7280').text('* = this reporter also received OLD daily rewards (reward_). Their "Missing/Owed" may be covered by daily pay — review before paying. Rate: District In-Charge Rs.10/news, others Rs.5/news.', X + 4, y);

  doc.end();
  console.log(`Reporters: ${reporters.length} | Wallet OFF (with news): ${walletOff.length} | Amount mismatch: ${mismatch.length} | Owed total: ${money(owedTotal)}`);
  console.log('PDF: ' + OUT);
  await mongoose.disconnect();
}
main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
