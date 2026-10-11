'use strict';

/**
 * Manual / custom weekly winners — lets an admin publish the app's winners list even
 * when fewer than 10 people qualified. The admin ticks any of the real eligible
 * members AND/OR types extra members (name + mobile) by hand; the combined list (1..10)
 * becomes the week's QuizWinner set shown in the app on Sunday after the release time.
 *
 * Payouts are manual/offline (QuizWinner is a record only, no wallet integration), so
 * REPLACING an existing set has no financial side effects. This is separate from the
 * strict, immutable 10-winner selectWinners() flow and does not touch it.
 */

const QuizWinner = require('../models/QuizWinner');
const QuizWeek = require('../models/QuizWeek');
const User = require('../models/User');
const { computeWeekStats } = require('../services/quizWinnerService');
const { screenPastWinners, loadPastWinnerIndex, matchPastWinner } = require('../services/quizPastWinnerService');
const { dayInfo, weekMeta, QUIZ_DAYS } = require('../utils/quizWeek');
const { logAudit } = require('../utils/auditLogger');
const { avatarUrlFor } = require('../utils/avatarUrl');

const currentWeekId = (req) => String((req.query && req.query.weekId) || (req.body && req.body.weekId) || dayInfo().weekId);
const MAX_WINNERS = 10;

// GET /admin/quiz/manual-winners (page)
exports.renderPage = (req, res) => res.render('quiz-manual-winners', { admin: req.admin, activePage: 'quiz-manual-winners' });

// GET /admin/quiz/api/manual-winners?weekId=... — eligible members + any winners already saved.
exports.getData = async (req, res) => {
  try {
    const weekId = currentWeekId(req);
    const { eligible } = await computeWeekStats(weekId);
    const ids = eligible.map((e) => e.userId);
    const [users, screen] = await Promise.all([
      User.find({ googleId: { $in: ids } }).select('googleId displayName mobileNumber photoUrl locationProfile').lean(),
      screenPastWinners(weekId, ids),
    ]);
    const uMap = {}; users.forEach((u) => { uMap[u.googleId] = u; });
    const eligibleOut = eligible.map((e, i) => {
      const u = uMap[e.userId] || {};
      const loc = u.locationProfile || {};
      const s = screen.get(e.userId) || {};
      return {
        rankIfSorted: i + 1, userId: e.userId,
        name: u.displayName || '(unknown)',
        mobile: u.mobileNumber || '',
        location: [loc.primaryState, loc.primaryDistrict].filter(Boolean).join(' - ') || '',
        photo: u.photoUrl || '',
        correct: e.correct, answered: e.answered,
        perfect: e.correct >= QUIZ_DAYS, pastWin: s.pastWin || null, nameMatch: s.nameMatch || null,
      };
    });
    const saved = await QuizWinner.find({ weekId }).sort({ rank: 1 }).lean();
    const savedOut = saved.map((w) => ({
      rank: w.rank, userId: w.userId, name: w.displayName, mobile: w.mobileNumber || '',
      photo: w.profileImage || '', score: w.score, manual: String(w.userId || '').startsWith('manual_'),
    }));
    res.json({ weekId, eligible: eligibleOut, saved: savedOut, max: MAX_WINNERS });
  } catch (e) { console.error('manual-winners getData:', e.message); res.status(500).json({ error: 'Failed to load data.' }); }
};

// POST /admin/quiz/api/manual-winners  { weekId?, winners: [{ name, mobile?, userId?, photo?, score? }] }
// Replaces the app-visible winner set for the week with exactly this ordered list.
exports.save = async (req, res) => {
  try {
    const weekId = currentWeekId(req);
    const list = Array.isArray(req.body.winners) ? req.body.winners : [];
    if (!list.length) return res.status(400).json({ error: 'Add at least one winner.' });
    if (list.length > MAX_WINNERS) return res.status(400).json({ error: `Maximum ${MAX_WINNERS} winners allowed.` });

    // Build the frozen rows in the admin's order. Real members keep their googleId;
    // hand-typed members get a unique synthetic id so the unique {weekId,userId} holds.
    const seen = new Set();
    const docs = [];
    for (let i = 0; i < list.length; i++) {
      const w = list[i] || {};
      const name = String(w.name || '').trim();
      if (!name) return res.status(400).json({ error: `Row ${i + 1}: name is required.` });
      let userId = String(w.userId || '').trim();
      if (!userId) userId = `manual_${weekId}_${i + 1}_${Math.random().toString(36).slice(2, 8)}`;
      if (seen.has(userId)) return res.status(400).json({ error: `Row ${i + 1}: "${name}" is selected twice.` });
      seen.add(userId);
      // Real members keep their Google photo; anyone without one gets a colourful
      // generated letter-avatar so the app never shows the plain pale circle.
      const photo = String(w.photo || '').trim() || avatarUrlFor(name);
      docs.push({
        weekId, rank: i + 1, userId,
        displayName: name,
        mobileNumber: String(w.mobile || '').trim(),
        profileImage: photo,
        score: Number.isFinite(+w.score) ? +w.score : 0,
        answered: Number.isFinite(+w.answered) ? +w.answered : 0,
        mode: 'admin_select',
        selectedById: (req.admin && (req.admin.id || req.admin._id)) || null,
        selectedByName: (req.admin && (req.admin.name || req.admin.username)) || 'admin',
        selectedAt: new Date(),
      });
    }

    // Ensure the week doc exists, then REPLACE the current app-visible set.
    const m = weekMeta(weekId);
    await QuizWeek.updateOne(
      { weekId },
      { $setOnInsert: { weekId, startDate: m.startDate, endDate: m.endDate, sundayDate: m.sundayDate }, $set: { status: 'winners_selected' } },
      { upsert: true }
    );
    const prev = await QuizWinner.countDocuments({ weekId });
    await QuizWinner.deleteMany({ weekId });
    await QuizWinner.insertMany(docs, { ordered: true });

    // Saved as asked — a human choice is not blocked — but say who has won before
    // (same account / phone / name), so it is never a surprise.
    let repeats = [];
    try {
      const index = await loadPastWinnerIndex(weekId);
      repeats = docs.map((d) => {
        const m = matchPastWinner({ userId: d.userId, name: d.displayName, mobile: d.mobileNumber }, index);
        const hit = m.pastWin || (m.nameMatch && { reason: 'name', ...m.nameMatch });
        return hit ? { rank: d.rank, name: d.displayName, reason: hit.reason, weekId: hit.weekId } : null;
      }).filter(Boolean);
    } catch (e) { console.error('manual-winners repeat check:', e.message); }

    logAudit({ req, action: 'quiz_manual_winners_save', entityType: 'QuizWeek', entityId: weekId,
      description: `Manual winners set for ${weekId}: ${docs.length} (replaced ${prev})${repeats.length ? `, ${repeats.length} won before` : ''}`,
      after: { winners: docs.map((d) => ({ rank: d.rank, name: d.displayName, userId: d.userId })), repeats } });
    res.json({ ok: true, weekId, count: docs.length, replaced: prev, repeats });
  } catch (e) {
    if (e && e.code === 11000) return res.status(400).json({ error: 'Duplicate winner (same member twice).' });
    console.error('manual-winners save:', e.message);
    res.status(500).json({ error: 'Failed to save winners.' });
  }
};

// DELETE /admin/quiz/api/manual-winners?weekId=... — remove the week's winner list.
exports.clear = async (req, res) => {
  try {
    const weekId = currentWeekId(req);
    const r = await QuizWinner.deleteMany({ weekId });
    await QuizWeek.updateOne({ weekId }, { $set: { status: 'closed' } });
    logAudit({ req, action: 'quiz_manual_winners_clear', entityType: 'QuizWeek', entityId: weekId,
      description: `Cleared ${r.deletedCount || 0} winner(s) for ${weekId}` });
    res.json({ ok: true, deleted: r.deletedCount || 0 });
  } catch (e) { console.error('manual-winners clear:', e.message); res.status(500).json({ error: 'Failed to clear winners.' }); }
};

// GET /admin/quiz/api/manual-winners/pdf?weekId=... — winners as a printable PDF
// (Rank, Name, Mobile, Location). Location comes from each winner's trusted DB
// locationProfile; hand-typed winners have no location.
exports.winnersPdf = async (req, res) => {
  try {
    const weekId = currentWeekId(req);
    const winners = await QuizWinner.find({ weekId }).sort({ rank: 1 }).lean();
    if (!winners.length) return res.status(404).send('No winners have been set for this week yet.');

    const realIds = winners.map((w) => w.userId).filter((id) => id && !String(id).startsWith('manual_'));
    const users = realIds.length
      ? await User.find({ googleId: { $in: realIds } }).select('googleId mobileNumber locationProfile').lean()
      : [];
    const uMap = {}; users.forEach((u) => { uMap[u.googleId] = u; });

    const rows = winners.map((w) => {
      const u = uMap[w.userId] || {};
      const loc = (u.locationProfile) || {};
      const location = [loc.primaryState, loc.primaryDistrict].filter(Boolean).join(' - ') || '-';
      return {
        rank: w.rank,
        name: w.displayName || '(unknown)',
        mobile: w.mobileNumber || u.mobileNumber || '-',
        location,
      };
    });

    const PDFDocument = require('pdfkit');
    const { registerFonts, fontFor, makeShapeSafe } = require('../services/reports/subEditorWorkReport');
    const RED = '#E31E24'; const INK = '#15181C'; const GREY = '#6B7280'; const LINE = '#E5E7EB'; const SOFT = '#F7F7F8';
    const M = 40; const doc = new PDFDocument({ size: 'A4', margins: { top: M, left: M, right: M, bottom: 40 }, bufferPages: true, info: { Title: 'Quiz Winners', Author: 'Tehelka News' } });
    const have = registerFonts(doc);
    const shapeSafe = makeShapeSafe(doc);
    const W = doc.page.width - M * 2;
    const txt = (text, x, yy, opts = {}, bold = false, size = 10, color = INK) => {
      const f = fontFor(text, bold, have); const w = opts.width || (doc.page.width - M - x);
      try { doc.font(f.font).fontSize(size).fillColor(color).text(shapeSafe(f.text), x, yy, { width: w, align: opts.align || 'left', lineBreak: false, ellipsis: true }); }
      catch (_) { doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(GREY).text(String(f.text).replace(/[^\x20-\x7E]/g, '?'), x, yy, { width: w, align: opts.align || 'left', lineBreak: false }); }
    };

    // Header
    const logoPath = require('path').join(__dirname, '..', 'public', 'images', 'logo.png');
    let y = M;
    if (require('fs').existsSync(logoPath)) { try { doc.image(logoPath, doc.page.width / 2 - 45, y, { fit: [90, 44] }); y += 50; } catch (_) {} }
    doc.font('Helvetica-Bold').fontSize(18).fillColor(RED).text('QUIZ WINNERS', M, y, { width: W, align: 'center' }); y += 24;
    doc.font('Helvetica').fontSize(10).fillColor(GREY).text(`Week ${weekId}  •  ${winners.length} winner${winners.length === 1 ? '' : 's'}  •  Generated ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })}`, M, y, { width: W, align: 'center' }); y += 20;
    doc.moveTo(M, y).lineTo(M + W, y).strokeColor(RED).lineWidth(1.5).stroke(); y += 12;

    // Table
    const cols = [
      { key: 'rank', label: 'Rank', w: 48, align: 'center' },
      { key: 'name', label: 'Name', w: 190 },
      { key: 'mobile', label: 'Mobile', w: 110 },
      { key: 'location', label: 'Location', w: W - 48 - 190 - 110 },
    ];
    const rowH = 24; const headH = 26;
    const drawHead = () => {
      doc.rect(M, y, W, headH).fill('#F3F4F6');
      let x = M; cols.forEach((c) => { txt(c.label, x + 6, y + 8, { width: c.w - 10, align: c.align || 'left' }, true, 10, INK); x += c.w; });
      y += headH;
    };
    drawHead();
    rows.forEach((r, i) => {
      if (y + rowH > doc.page.height - 40) { doc.addPage(); y = M; drawHead(); }
      if (i % 2 === 1) doc.rect(M, y, W, rowH).fill(SOFT);
      let x = M;
      cols.forEach((c) => { txt(String(r[c.key]), x + 6, y + 6, { width: c.w - 10, align: c.align || 'left' }, c.key === 'rank', c.key === 'name' ? 10.5 : 10, INK); x += c.w; });
      doc.moveTo(M, y + rowH).lineTo(M + W, y + rowH).strokeColor(LINE).lineWidth(0.5).stroke();
      y += rowH;
    });

    // Footer page numbers
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.font('Helvetica').fontSize(8).fillColor(GREY).text(`Tehelka News • Quiz Winners • ${weekId} • Confidential — internal record`, M, doc.page.height - 28, { width: W - 60, lineBreak: false });
      doc.text(`Page ${i - range.start + 1} of ${range.count}`, doc.page.width - M - 60, doc.page.height - 28, { width: 60, align: 'right' });
    }

    const fname = `Quiz-Winners_${weekId}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    doc.pipe(res);
    doc.end();
    logAudit({ req, action: 'quiz_winners_pdf', entityType: 'QuizWeek', entityId: weekId, description: `Downloaded winners PDF for ${weekId} (${winners.length})` });
  } catch (e) {
    console.error('winners pdf:', e.message);
    if (!res.headersSent) res.status(500).send('Failed to build winners PDF.');
  }
};
