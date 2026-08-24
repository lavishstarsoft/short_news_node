'use strict';

/**
 * Quiz admin — Question Bank (P1) + Weekly Dashboard & Winner selection (P3).
 * Admin-only (routes use requireAdmin). All mutations are audited.
 */

const mongoose = require('mongoose');
const QuizQuestion = require('../models/QuizQuestion');
const QuizWinner = require('../models/QuizWinner');
const QuizTestOverride = require('../models/QuizTestOverride');
const User = require('../models/User');
const { logAudit } = require('../utils/auditLogger');
const { dayInfo, weekMeta, isWeekOver, TEST_WEEK_MONDAY, WINNER_COUNT } = require('../utils/quizWeek');
const { computeWeekStats, selectWinners } = require('../services/quizWinnerService');
const { closeExpiredWeeks, sendDailyReminder } = require('../services/quizMaintenanceService');

/** Map googleId → displayName for a set of users (one query, no N+1). */
async function namesFor(userIds) {
  if (!userIds.length) return {};
  const users = await User.find({ googleId: { $in: userIds } }).select('googleId displayName deviceFingerprint').lean();
  const m = {}; users.forEach((u) => { m[u.googleId] = { name: u.displayName || '', device: u.deviceFingerprint || '' }; });
  return m;
}

const KEYS = ['A', 'B', 'C', 'D'];

/** Validate an MCQ payload → { ok, error?, options, correctOption }. Pure. */
function validateQuestion(body) {
  const text = String(body.text || '').trim();
  if (text.length < 3) return { ok: false, error: 'Question text is required.' };
  const rawOpts = Array.isArray(body.options) ? body.options : [];
  const options = rawOpts
    .map((o) => ({ key: String(o.key || '').toUpperCase().trim(), text: String(o.text || '').trim() }))
    .filter((o) => o.text);
  if (options.length < 2 || options.length > 4) return { ok: false, error: 'Provide 2–4 options.' };
  const keys = options.map((o) => o.key);
  if (keys.some((k) => !KEYS.includes(k))) return { ok: false, error: 'Option keys must be A–D.' };
  if (new Set(keys).size !== keys.length) return { ok: false, error: 'Duplicate option keys.' };
  const correctOption = String(body.correctOption || '').toUpperCase().trim();
  if (!keys.includes(correctOption)) return { ok: false, error: 'Correct option must be one of the provided options.' };
  return { ok: true, text, options, correctOption };
}

exports.validateQuestion = validateQuestion; // exported for tests

// GET /admin/quiz/questions (page)
exports.renderQuestions = (req, res) => res.render('quiz-questions', { admin: req.admin, activePage: 'quiz-questions' });

// GET /admin/quiz/api/questions
exports.listQuestions = async (req, res) => {
  try {
    const q = {};
    if (req.query.active === 'true') q.isActive = true;
    if (req.query.active === 'false') q.isActive = false;
    const items = await QuizQuestion.find(q).sort({ createdAt: -1 }).limit(500).lean();
    const active = await QuizQuestion.countDocuments({ isActive: true });
    res.json({ count: items.length, activeCount: active, items });
  } catch (e) { console.error('quiz listQuestions:', e.message); res.status(500).json({ error: 'Failed to load questions.' }); }
};

// POST /admin/quiz/api/questions
exports.createQuestion = async (req, res) => {
  try {
    const v = validateQuestion(req.body || {});
    if (!v.ok) return res.status(400).json({ error: v.error });
    const doc = await QuizQuestion.create({
      text: v.text, options: v.options, correctOption: v.correctOption,
      language: String(req.body.language || 'te').trim(),
      category: req.body.category ? String(req.body.category).trim() : null,
      isActive: req.body.isActive !== false,
      createdByName: (req.admin && (req.admin.username || req.admin.name)) || '',
    });
    logAudit({ req, action: 'quiz_question_create', entityType: 'QuizQuestion', entityId: String(doc._id), description: `Created quiz question: ${v.text.slice(0, 60)}`, after: { text: v.text, correctOption: v.correctOption } });
    res.status(201).json({ success: true, id: String(doc._id) });
  } catch (e) { console.error('quiz createQuestion:', e.message); res.status(500).json({ error: 'Failed to create question.' }); }
};

// PUT /admin/quiz/api/questions/:id
exports.updateQuestion = async (req, res) => {
  try {
    const doc = await QuizQuestion.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Question not found.' });
    const before = { text: doc.text, correctOption: doc.correctOption, isActive: doc.isActive, options: doc.options };

    // isActive toggle is ALWAYS allowed (even when locked).
    if (typeof req.body.isActive === 'boolean') doc.isActive = req.body.isActive;
    if (req.body.category !== undefined) doc.category = req.body.category ? String(req.body.category).trim() : null;
    if (req.body.language !== undefined) doc.language = String(req.body.language || 'te').trim();

    // Content edits (text/options/correctOption) are blocked once used in a closed week.
    const wantsContentEdit = req.body.text !== undefined || req.body.options !== undefined || req.body.correctOption !== undefined;
    if (wantsContentEdit) {
      if (doc.lockedForEdit) {
        return res.status(409).json({ error: 'This question was used in a completed week and can no longer be edited (you may still disable it).' });
      }
      const v = validateQuestion({ text: req.body.text ?? doc.text, options: req.body.options ?? doc.options, correctOption: req.body.correctOption ?? doc.correctOption });
      if (!v.ok) return res.status(400).json({ error: v.error });
      doc.text = v.text; doc.options = v.options; doc.correctOption = v.correctOption;
    }
    await doc.save();
    logAudit({ req, action: 'quiz_question_update', entityType: 'QuizQuestion', entityId: String(doc._id), description: `Updated quiz question ${doc._id}`, before, after: { text: doc.text, correctOption: doc.correctOption, isActive: doc.isActive } });
    res.json({ success: true });
  } catch (e) { console.error('quiz updateQuestion:', e.message); res.status(500).json({ error: 'Failed to update question.' }); }
};

// ── Excel import / template ──

const IMPORT_HEADERS = ['question', 'optionA', 'optionB', 'optionC', 'optionD', 'correctOption', 'category', 'language', 'isActive'];
const qnorm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const cell = (row, name) => { const k = Object.keys(row).find((x) => x.trim().toLowerCase() === name.toLowerCase()); return k ? String(row[k]).trim() : ''; };

/** Parse an uploaded workbook buffer into row objects. Throws on unreadable file. */
function parseWorkbook(buffer) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: '' });
}

/** Pure: validate + classify rows against an existing-question set. Reused by tests. */
function buildImportPlan(rows, existingNormSet) {
  const seen = new Set();
  const toInsert = []; const results = [];
  let imported = 0, skipped = 0, failed = 0;
  rows.forEach((row, i) => {
    const rowNo = i + 2; // header is row 1
    const question = cell(row, 'question');
    const options = ['A', 'B', 'C', 'D'].map((k) => ({ key: k, text: cell(row, 'option' + k) })).filter((o) => o.text);
    const correctOption = cell(row, 'correctOption').toUpperCase();
    if (options.length !== 4) { failed++; results.push({ row: rowNo, status: 'failed', error: 'Question and all 4 options (A–D) are required.' }); return; }
    const v = validateQuestion({ text: question, options, correctOption });
    if (!v.ok) { failed++; results.push({ row: rowNo, status: 'failed', error: v.error }); return; }
    const nq = qnorm(question);
    if (existingNormSet.has(nq) || seen.has(nq)) { skipped++; results.push({ row: rowNo, status: 'skipped', error: 'Duplicate question (already exists) — not overwritten.' }); return; }
    seen.add(nq);
    const isActive = !/^(false|0|no)$/i.test(cell(row, 'isActive'));
    toInsert.push({ text: v.text, options: v.options, correctOption: v.correctOption, language: cell(row, 'language') || 'te', category: cell(row, 'category') || null, isActive });
    imported++; results.push({ row: rowNo, status: 'ok' });
  });
  return { toInsert, results, imported, skipped, failed };
}

exports.buildImportPlan = buildImportPlan; // tests

// POST /admin/quiz/api/questions/import  (multipart file; body.dryRun='true' → preview only)
exports.importQuestions = async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'Upload an .xlsx/.xls file (field "file").' });
    let rows;
    try { rows = parseWorkbook(req.file.buffer); }
    catch (_) { return res.status(400).json({ error: 'Could not read the Excel file. Use the provided template.' }); }
    if (!rows.length) return res.status(400).json({ error: 'No rows found in the file.' });

    const existing = new Set((await QuizQuestion.find({}).select('text').lean()).map((q) => qnorm(q.text)));
    const plan = buildImportPlan(rows, existing);
    const dryRun = String((req.body && req.body.dryRun) || '') === 'true';
    if (dryRun) return res.json({ dryRun: true, total: rows.length, imported: plan.imported, skipped: plan.skipped, failed: plan.failed, results: plan.results });

    let insertedCount = 0;
    if (plan.toInsert.length) {
      const docs = plan.toInsert.map((d) => ({ ...d, createdByName: (req.admin && (req.admin.username || req.admin.name)) || '' }));
      try { const r = await QuizQuestion.insertMany(docs, { ordered: false }); insertedCount = r.length; }
      catch (e) { insertedCount = (e && e.result && e.result.nInserted) || (e && e.insertedDocs && e.insertedDocs.length) || 0; }
    }
    logAudit({ req, action: 'quiz_questions_import', entityType: 'QuizQuestion', entityId: 'bulk', description: `Excel import: ${insertedCount} imported, ${plan.skipped} skipped, ${plan.failed} failed (of ${rows.length})` });
    res.json({ dryRun: false, total: rows.length, imported: insertedCount, skipped: plan.skipped, failed: plan.failed, results: plan.results });
  } catch (e) { console.error('quiz importQuestions:', e.message); res.status(500).json({ error: 'Import failed.' }); }
};

// GET /admin/quiz/api/questions/template  → .xlsx with headers + example
exports.downloadTemplate = (req, res) => {
  try {
    const XLSX = require('xlsx');
    const ws = XLSX.utils.aoa_to_sheet([
      IMPORT_HEADERS,
      ['Capital of India?', 'New Delhi', 'Mumbai', 'Kolkata', 'Chennai', 'A', 'GK', 'te', 'true'],
      ['2 + 2 = ?', '3', '4', '5', '6', 'B', 'Math', 'en', 'true'],
    ]);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Questions');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="quiz_questions_template.xlsx"');
    res.send(buf);
  } catch (e) { console.error('quiz template:', e.message); res.status(500).json({ error: 'Failed to build template.' }); }
};

// ── P3: Weekly Dashboard + Winner selection ──

const targetWeekId = (req) => String(req.query.weekId || req.body.weekId || dayInfo().weekId);

// GET /admin/quiz/dashboard (page)
exports.renderDashboard = (req, res) => res.render('quiz-dashboard', { admin: req.admin, activePage: 'quiz-dashboard' });

// GET /admin/quiz/api/week?weekId=... → stats + status
exports.weekStats = async (req, res) => {
  try {
    const weekId = targetWeekId(req);
    const m = weekMeta(weekId);
    const { participants, eligible } = await computeWeekStats(weekId);
    const winners = await QuizWinner.countDocuments({ weekId });
    res.json({
      weekId, meta: m, weekOver: isWeekOver(weekId),
      participants: participants.length,
      eligible: eligible.length,
      winnersSelected: winners > 0,
      canSelect: isWeekOver(weekId) && winners === 0,
    });
  } catch (e) { console.error('quiz weekStats:', e.message); res.status(500).json({ error: 'Failed to load week stats.' }); }
};

// GET /admin/quiz/api/week/eligible?weekId=...
exports.eligibleList = async (req, res) => {
  try {
    const weekId = targetWeekId(req);
    const { eligible } = await computeWeekStats(weekId);
    const names = await namesFor(eligible.map((e) => e.userId));
    res.json({ weekId, count: eligible.length, eligible: eligible.map((e, i) => ({ rankIfSorted: i + 1, userId: e.userId, name: (names[e.userId] || {}).name || '(unknown)', device: (names[e.userId] || {}).device || '', correct: e.correct, answered: e.answered, lastSubmittedAt: e.lastSubmittedAt })) });
  } catch (e) { console.error('quiz eligibleList:', e.message); res.status(500).json({ error: 'Failed to load eligible users.' }); }
};

// POST /admin/quiz/api/week/winners  { weekId, mode: 'random_lottery'|'admin_select', userIds? }
exports.selectWinners = async (req, res) => {
  try {
    const weekId = targetWeekId(req);
    const mode = String(req.body.mode || '');
    const adminUserIds = req.body.userIds;
    // snapshot names for whoever may be chosen
    const { eligible } = await computeWeekStats(weekId);
    const names = await namesFor(eligible.map((e) => e.userId));
    const displayNameByUser = {}; Object.keys(names).forEach((k) => { displayNameByUser[k] = names[k].name; });
    const r = await selectWinners({ weekId, mode, adminUserIds, actor: req.admin, req, displayNameByUser });
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json(r);
  } catch (e) { console.error('quiz selectWinners:', e.message); res.status(500).json({ error: 'Failed to select winners.' }); }
};

// POST /admin/quiz/api/maintenance { action: 'close'|'remind' } — idempotent lifecycle
exports.maintenance = async (req, res) => {
  try {
    const action = String(req.body.action || 'close');
    if (action === 'remind') return res.json(await sendDailyReminder());
    const r = await closeExpiredWeeks();
    logAudit({ req, action: 'quiz_maintenance', entityType: 'QuizWeek', entityId: 'closeExpiredWeeks', description: `Closed ${r.closed} week(s), locked ${r.locked} question(s)` });
    res.json(r);
  } catch (e) { console.error('quiz maintenance:', e.message); res.status(500).json({ error: 'Maintenance failed.' }); }
};

// GET /admin/quiz/api/winners  (history, latest weeks first)
exports.winnerHistory = async (req, res) => {
  try {
    const rows = await QuizWinner.find({}).sort({ weekId: -1, rank: 1 }).limit(500).lean();
    const byWeek = {};
    rows.forEach((w) => { (byWeek[w.weekId] = byWeek[w.weekId] || { weekId: w.weekId, mode: w.mode, selectedByName: w.selectedByName, selectedAt: w.selectedAt, winners: [] }).winners.push({ rank: w.rank, name: w.displayName, userId: w.userId, score: w.score }); });
    res.json({ weeks: Object.values(byWeek) });
  } catch (e) { console.error('quiz winnerHistory:', e.message); res.status(500).json({ error: 'Failed to load winner history.' }); }
};

// ─────────────── Quiz Test Mode (admin day simulation) ───────────────
// Lets an admin simulate Mon..Sun for ONE app user (googleId), so the full week
// + Sunday winners flow can be verified without waiting for a real Sunday. Test
// data lives under weekId = TEST_WEEK_MONDAY (2024), isolated from live weeks.

const DAY_LABELS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const clean = (v) => String(v || '').trim();

/**
 * Resolve an admin-typed identifier to a real user. Accepts Mongo _id, googleId,
 * mobile number, email, or exact display name. Returns the User doc or null.
 * The quiz identity is always User.googleId (== req.verifiedGoogleId at runtime),
 * so callers must key QuizTestOverride by the resolved googleId — never the _id.
 */
async function resolveUserByAny(query) {
  const q = clean(query);
  if (!q) return null;
  const or = [{ googleId: q }, { email: q.toLowerCase() }, { mobileNumber: q }, { displayName: q }];
  if (mongoose.Types.ObjectId.isValid(q) && String(new mongoose.Types.ObjectId(q)) === q) {
    or.push({ _id: new mongoose.Types.ObjectId(q) });
  }
  return User.findOne({ $or: or }).select('googleId displayName mobileNumber email').lean();
}

const publicUser = (u) => ({ googleId: u.googleId || '', name: u.displayName || '', mobile: u.mobileNumber || '', email: u.email || '' });

// GET /admin/quiz/resolve-user?q=...  → look up a user before enabling test mode
exports.resolveTestUser = async (req, res) => {
  try {
    const q = clean(req.query.q);
    if (!q) return res.status(400).json({ error: 'Enter a user _id, googleId, mobile, email, or name.' });
    const u = await resolveUserByAny(q);
    if (!u) return res.status(404).json({ error: `No user matches "${q}".` });
    if (!u.googleId) return res.status(422).json({ error: `${u.displayName || 'This user'} has no Google sign-in ID, so quiz identity cannot be resolved.` });
    res.json({ ok: true, user: publicUser(u) });
  } catch (e) { console.error('quiz resolveTestUser:', e.message); res.status(500).json({ error: 'Failed to look up user.' }); }
};

// GET /admin/quiz/test-mode/active — the currently-active override(s), read straight
// from MongoDB (source of truth) so the dashboard can auto-populate after a refresh
// without the admin re-typing an identifier. Each is resolved back to its user.
exports.activeTestMode = async (req, res) => {
  try {
    const rows = await QuizTestOverride.find({ active: true }).sort({ updatedAt: -1 }).lean();
    const active = [];
    for (const ov of rows) {
      const u = await User.findOne({ googleId: ov.userId }).select('googleId displayName mobileNumber email').lean();
      active.push({
        googleId: ov.userId,
        simDayIndex: ov.simDayIndex,
        dayLabel: DAY_LABELS[ov.simDayIndex] || '',
        updatedByName: ov.updatedByName || '',
        user: u ? publicUser(u) : { googleId: ov.userId, name: '(unknown user)', mobile: '', email: '' },
      });
    }
    res.json({ active, testWeekId: TEST_WEEK_MONDAY });
  } catch (e) { console.error('quiz activeTestMode:', e.message); res.status(500).json({ error: 'Failed to read active test mode.' }); }
};

// GET /admin/quiz/test-mode?q=...  (q may be _id / googleId / mobile / email / name)
exports.getTestMode = async (req, res) => {
  try {
    const q = clean(req.query.q || req.query.userId);
    if (!q) return res.json({ active: false });
    const u = await resolveUserByAny(q);
    if (!u || !u.googleId) return res.json({ active: false, resolved: false });
    const ov = await QuizTestOverride.findOne({ userId: u.googleId }).lean();
    res.json({ resolved: true, user: publicUser(u), active: !!(ov && ov.active), simDayIndex: ov ? ov.simDayIndex : 1, testWeekId: TEST_WEEK_MONDAY });
  } catch (e) { console.error('quiz getTestMode:', e.message); res.status(500).json({ error: 'Failed to read test mode.' }); }
};

// POST /admin/quiz/test-mode  { q (any identifier), simDayIndex(1..7), active }
exports.setTestMode = async (req, res) => {
  try {
    const q = clean(req.body.q || req.body.userId);
    if (!q) return res.status(400).json({ error: 'Target user is required (_id, googleId, mobile, email, or name).' });
    const u = await resolveUserByAny(q);
    if (!u) return res.status(404).json({ error: `No user matches "${q}".` });
    if (!u.googleId) return res.status(422).json({ error: `${u.displayName || 'This user'} has no Google sign-in ID, so test mode cannot be enabled.` });

    const userId = u.googleId; // quiz identity — NEVER the _id
    const active = req.body.active !== false && req.body.active !== 'false';
    const simDayIndex = Math.max(1, Math.min(7, parseInt(req.body.simDayIndex, 10) || 1));
    const updatedByName = req.admin ? (req.admin.name || req.admin.username || 'admin') : 'admin';
    await QuizTestOverride.updateOne(
      { userId },
      { $set: { simDayIndex, active, updatedByName } },
      { upsert: true }
    );
    logAudit({ req, action: 'quiz_test_mode_set', entityType: 'QuizTestOverride', entityId: userId,
      description: `Test mode ${active ? 'ON' : 'OFF'} for ${u.displayName || userId} (googleId ${userId}) → ${DAY_LABELS[simDayIndex]}`,
      after: { active, simDayIndex } });
    res.json({ ok: true, user: publicUser(u), active, simDayIndex, dayLabel: DAY_LABELS[simDayIndex], testWeekId: TEST_WEEK_MONDAY });
  } catch (e) { console.error('quiz setTestMode:', e.message); res.status(500).json({ error: 'Failed to update test mode.' }); }
};

// POST /admin/quiz/test-winners  → 10 fake winners under the test week (isTest:true)
exports.createTestWinners = async (req, res) => {
  try {
    const selectedByName = req.admin ? (req.admin.name || req.admin.username || 'admin') : 'admin';
    // Replace any prior TEST winners for the test week (never touches real weeks).
    await QuizWinner.deleteMany({ weekId: TEST_WEEK_MONDAY, isTest: true });
    const docs = Array.from({ length: WINNER_COUNT }, (_, i) => ({
      weekId: TEST_WEEK_MONDAY, rank: i + 1, userId: `test-winner-${i + 1}`,
      displayName: `Test Winner ${i + 1}`, score: WINNER_COUNT - i, answered: 6,
      mode: 'admin_select', isTest: true, selectedByName,
    }));
    await QuizWinner.insertMany(docs);
    logAudit({ req, action: 'quiz_test_winners_create', entityType: 'QuizWinner', entityId: TEST_WEEK_MONDAY,
      description: `Created ${docs.length} TEST winners (isolated, no payout)` });
    res.json({ ok: true, count: docs.length, testWeekId: TEST_WEEK_MONDAY });
  } catch (e) { console.error('quiz createTestWinners:', e.message); res.status(500).json({ error: 'Failed to create test winners.' }); }
};

// DELETE /admin/quiz/test-winners → remove the test winners
exports.clearTestWinners = async (req, res) => {
  try {
    const r = await QuizWinner.deleteMany({ weekId: TEST_WEEK_MONDAY, isTest: true });
    logAudit({ req, action: 'quiz_test_winners_clear', entityType: 'QuizWinner', entityId: TEST_WEEK_MONDAY,
      description: `Cleared ${r.deletedCount || 0} TEST winners` });
    res.json({ ok: true, deleted: r.deletedCount || 0 });
  } catch (e) { console.error('quiz clearTestWinners:', e.message); res.status(500).json({ error: 'Failed to clear test winners.' }); }
};

exports._internals = { resolveUserByAny }; // exported for tests
