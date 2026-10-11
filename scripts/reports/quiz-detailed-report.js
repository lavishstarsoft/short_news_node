'use strict';

/**
 * Detailed weekly quiz report (PDF), grouped per user: name / mobile / location +
 * every question they got that week, their answer, and Right/Wrong.
 *
 * Renders via HTML → Google Chrome headless (--print-to-pdf) because Telugu is a
 * complex script that PDFKit/fontkit cannot shape correctly (garbled glyphs). The
 * browser shapes Telugu perfectly.
 *
 * Usage: node scripts/reports/quiz-detailed-report.js [weekId] [minDays] [topN]
 *   minDays: days answered to include (default 6 = full week; 1 = everyone).
 *   topN:    keep only the best N members by correct-count (default 0 = all). READ-ONLY.
 */
require('dotenv').config();
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');
const mongoose = require('mongoose');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FONT = path.join(__dirname, '../../assets/fonts/NotoSansTelugu-Regular.ttf');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function main() {
  const argWeek = process.argv[2] && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[2]) ? process.argv[2] : null;
  const minDays = Math.max(1, parseInt(process.argv[3], 10) || 6);
  const topN = Math.max(0, parseInt(process.argv[4], 10) || 0);
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const QE = db.collection('quizentries');
  const QQ = db.collection('quizquestions');
  const Users = db.collection('users');

  let weekId = argWeek;
  if (!weekId) {
    const w = await QE.aggregate([{ $group: { _id: '$weekId', c: { $sum: 1 } } }, { $sort: { _id: -1 } }, { $limit: 1 }]).toArray();
    weekId = w[0] && w[0]._id;
  }
  if (!weekId) { console.log('No quiz weeks.'); return process.exit(0); }

  const entries = await QE.find({ weekId, submittedAt: { $ne: null } }).toArray();
  const byUser = {};
  entries.forEach((e) => { (byUser[e.userId] = byUser[e.userId] || []).push(e); });
  let members = Object.keys(byUser).map((uid) => {
    const es = byUser[uid].sort((a, b) => (a.dayKey || '').localeCompare(b.dayKey || ''));
    const correct = es.filter((e) => e.isCorrect).length;
    const last = es.reduce((m, e) => (e.submittedAt && (!m || e.submittedAt > m) ? e.submittedAt : m), null);
    return { uid, es, answered: es.length, correct, last };
  }).filter((m) => m.answered >= minDays);
  members.sort((a, b) => (b.correct - a.correct) || (new Date(a.last) - new Date(b.last)));
  const totalMatched = members.length;
  if (topN > 0) members = members.slice(0, topN);

  console.log(`Week ${weekId}: ${totalMatched} members (answered >= ${minDays} days)${topN ? `, showing top ${members.length}` : ''}.`);
  if (!members.length) { console.log('None match.'); return process.exit(0); }

  const qIds = [...new Set(entries.map((e) => e.questionId).filter(Boolean))].map((id) => { try { return new mongoose.Types.ObjectId(String(id)); } catch (_) { return null; } }).filter(Boolean);
  const qDocs = await QQ.find({ _id: { $in: qIds } }).toArray();
  const qMap = {}; qDocs.forEach((q) => { qMap[String(q._id)] = q; });
  const uDocs = await Users.find({ googleId: { $in: members.map((m) => m.uid) } }).project({ displayName: 1, email: 1, mobileNumber: 1, locationProfile: 1, googleId: 1 }).toArray();
  const uMap = {}; uDocs.forEach((u) => { uMap[u.googleId] = u; });
  const optText = (q, key) => { const o = (q && q.options || []).find((x) => x.key === key); return o ? o.text : (key || '-'); };
  const loc = (u) => { const lp = (u && u.locationProfile) || {}; return [lp.primaryDistrict || lp.district || lp.city, lp.primaryState || lp.state].filter(Boolean).join(', '); };

  // ── Build HTML ──
  const blocks = members.map((m, idx) => {
    const u = uMap[m.uid] || {};
    const rows = m.es.map((e, i) => {
      const q = qMap[String(e.questionId)];
      const qText = (q && q.text) || '(question unavailable)';
      const ok = e.isCorrect;
      const yourAns = optText(q, e.selectedOption);
      const correctAns = optText(q, q && q.correctOption);
      return `<div class="q"><div class="qt">Q${i + 1}. ${esc(qText)}</div>
        <div class="ans ${ok ? 'ok' : 'no'}">[${ok ? 'RIGHT' : 'WRONG'}] Your answer: ${esc(yourAns)}${ok ? '' : ` &nbsp;|&nbsp; Correct: ${esc(correctAns)}`}</div></div>`;
    }).join('');
    return `<div class="user">
      <div class="uhead">
        <div><div class="uname">${idx + 1}. ${esc(u.displayName || '(no name)')}</div>
          <div class="umeta">Mobile: ${esc(u.mobileNumber || '-')} &nbsp;•&nbsp; Email: ${esc(u.email || '-')}</div>
          <div class="umeta">Location: ${esc(loc(u) || '-')}</div></div>
        <div class="score">${m.correct}/${m.answered}<br><span>correct</span></div>
      </div>${rows}</div>`;
  }).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    @font-face { font-family:'NotoTe'; src:url('file://${FONT}'); }
    *{ box-sizing:border-box; }
    body{ font-family:'NotoTe','Noto Sans Telugu',sans-serif; margin:0; color:#111827; }
    .hdr{ background:#5E35B1; color:#fff; padding:18px 22px; }
    .hdr h1{ margin:0; font-size:20px; } .hdr p{ margin:4px 0 0; font-size:12px; opacity:.85; }
    .wrap{ padding:16px 22px; }
    .user{ border:1px solid #e7e2f3; border-radius:10px; margin-bottom:14px; overflow:hidden; page-break-inside:avoid; }
    .uhead{ background:#EDE7FA; padding:12px 14px; display:flex; justify-content:space-between; align-items:flex-start; }
    .uname{ font-weight:700; font-size:15px; color:#3A2A5A; }
    .umeta{ font-size:12px; color:#5b4b7a; margin-top:2px; }
    .score{ font-weight:800; font-size:18px; color:#1FA363; text-align:right; } .score span{ font-size:10px; font-weight:600; }
    .q{ padding:8px 14px; border-top:1px solid #f0edf8; }
    .qt{ font-weight:700; font-size:13px; }
    .ans{ font-size:13px; margin-top:3px; } .ans.ok{ color:#1FA363; } .ans.no{ color:#D91649; }
  </style></head><body>
    <div class="hdr"><h1>TAHELKA NEWS — Weekly Quiz Report</h1>
      <p>Week ${weekId} &nbsp;•&nbsp; ${topN ? `Top ${members.length} of ${totalMatched}` : `${members.length}`} members (answered ${minDays}+ days) &nbsp;•&nbsp; ${new Date().toLocaleDateString('en-IN')}</p></div>
    <div class="wrap">${blocks}</div></body></html>`;

  const htmlPath = path.join(os.tmpdir(), `quiz_report_${Date.now()}.html`);
  const OUT = path.join(os.homedir(), 'Desktop', `Quiz_Detailed_${weekId}${topN ? `_top${topN}` : ''}.pdf`);
  fs.writeFileSync(htmlPath, html, 'utf8');

  await mongoose.disconnect();

  // Render with headless Chrome (correct Telugu shaping).
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${OUT}`, `file://${htmlPath}`], { stdio: 'ignore' });
  try { fs.unlinkSync(htmlPath); } catch (_) {}
  console.log('PDF: ' + OUT);
}
main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
