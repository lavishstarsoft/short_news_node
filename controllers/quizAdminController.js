'use strict';

/**
 * Quiz admin — Question Bank (P1) + Weekly Dashboard & Winner selection (P3).
 * Admin-only (routes use requireAdmin). All mutations are audited.
 */

const mongoose = require('mongoose');
const QuizQuestion = require('../models/QuizQuestion');
const QuizEntry = require('../models/QuizEntry');
const QuizWinner = require('../models/QuizWinner');
const QuizTestOverride = require('../models/QuizTestOverride');
const QuizSettings = require('../models/QuizSettings');
const User = require('../models/User');
const { logAudit } = require('../utils/auditLogger');
const { dayInfo, weekMeta, isWeekOver, weekDayKeys, TEST_WEEK_MONDAY, WINNER_COUNT, QUIZ_DAYS } = require('../utils/quizWeek');
const { computeWeekStats, selectWinners } = require('../services/quizWinnerService');
const { closeExpiredWeeks, sendDailyReminder } = require('../services/quizMaintenanceService');
const { weekAnalytics, participantStats } = require('../services/quizAnalyticsService');

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

// GET /admin/quiz/api/questions?active=&category=&language=&locked=&q=&page=&pageSize=
// Server-paginated with search/filter + Used/Unused/Locked status and usage counts.
exports.listQuestions = async (req, res) => {
  try {
    const q = {};
    if (req.query.active === 'true') q.isActive = true;
    if (req.query.active === 'false') q.isActive = false;
    if (req.query.locked === 'true') q.lockedForEdit = true;
    if (req.query.archived === 'true') q.archived = true;
    else if (req.query.archived === 'false') q.archived = { $ne: true };
    if (req.query.category) q.category = String(req.query.category).trim();
    if (req.query.language) q.language = String(req.query.language).trim();
    const search = String(req.query.q || '').trim();
    if (search) q.text = new RegExp(rxEscape(search), 'i');

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(5, parseInt(req.query.pageSize, 10) || 25));
    const total = await QuizQuestion.countDocuments(q);
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, pages);
    const items = await QuizQuestion.find(q).sort({ createdAt: -1 }).skip((safePage - 1) * pageSize).limit(pageSize).lean();

    // "Used" = present in ANY QuizEntry (assigned to a real participant), the rule
    // that forbids hard-delete. usageCount tracks answered uses separately.
    const ids = items.map((i) => i._id);
    const usage = ids.length ? await QuizEntry.aggregate([
      { $match: { questionId: { $in: ids } } },
      { $group: { _id: '$questionId', assigned: { $sum: 1 } } },
    ]) : [];
    const usedMap = new Map(usage.map((u) => [String(u._id), u.assigned]));

    const activeCount = await QuizQuestion.countDocuments({ isActive: true });
    const lockedCount = await QuizQuestion.countDocuments({ lockedForEdit: true });
    const withStatus = items.map((it) => {
      const assignedCount = usedMap.get(String(it._id)) || 0;
      const used = assignedCount > 0 || (it.usageCount || 0) > 0 || !!it.lockedForEdit;
      const status = it.archived ? 'archived' : (it.lockedForEdit ? 'locked' : (used ? 'used' : 'unused'));
      return { ...it, assignedCount, used, status };
    });
    res.json({ total, page: safePage, pageSize, pages, activeCount, lockedCount, items: withStatus });
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

// POST /admin/quiz/api/questions/:id/archive  { archived?: true|false }
// Soft archive/restore — NEVER hard-deletes (preserves historical usage). Archiving
// also removes it from the active pool (isActive=false). Idempotent + audited.
exports.archiveQuestion = async (req, res) => {
  try {
    const doc = await QuizQuestion.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Question not found.' });
    const to = req.body.archived !== false; // default = archive
    const before = { archived: !!doc.archived, isActive: !!doc.isActive };
    doc.archived = to;
    if (to) doc.isActive = false; // archived leaves the assignment pool
    await doc.save();
    logAudit({ req, action: to ? 'quiz_question_archive' : 'quiz_question_restore', entityType: 'QuizQuestion', entityId: String(doc._id), description: `${to ? 'Archived' : 'Restored'} quiz question ${doc._id}`, before, after: { archived: doc.archived, isActive: doc.isActive } });
    res.json({ success: true, archived: doc.archived, isActive: doc.isActive });
  } catch (e) { console.error('quiz archiveQuestion:', e.message); res.status(500).json({ error: 'Failed to archive question.' }); }
};

// POST /admin/quiz/api/questions/bulk-delete
exports.bulkDeleteQuestions = async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ error: 'No question IDs provided.' });
    
    const docs = await QuizQuestion.find({ _id: { $in: ids } });
    const toDeleteIds = [];
    let skipped = 0;
    
    for (const doc of docs) {
      if (doc.archived || doc.lockedForEdit || (doc.usageCount || 0) > 0) { skipped++; continue; }
      const isAssigned = await QuizEntry.exists({ questionId: doc._id });
      if (isAssigned) { skipped++; continue; }
      toDeleteIds.push(doc._id);
    }
    
    if (toDeleteIds.length > 0) {
      await QuizQuestion.deleteMany({ _id: { $in: toDeleteIds } });
      logAudit({ req, action: 'quiz_questions_bulk_delete', entityType: 'QuizQuestion', entityId: 'bulk', description: `Hard deleted ${toDeleteIds.length} unused quiz questions` });
    }
    
    res.json({ success: true, deleted: toDeleteIds.length, skipped });
  } catch (e) { console.error('quiz bulkDeleteQuestions:', e.message); res.status(500).json({ error: 'Failed to bulk delete questions.' }); }
};

// DELETE /admin/quiz/api/questions/:id
exports.deleteQuestion = async (req, res) => {
  try {
    const doc = await QuizQuestion.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Question not found.' });
    if (doc.lockedForEdit || (doc.usageCount || 0) > 0) {
      return res.status(409).json({ error: 'Question has been used or is locked. You can only archive it.' });
    }
    const isAssigned = await QuizEntry.exists({ questionId: doc._id });
    if (isAssigned) {
      return res.status(409).json({ error: 'Question has already been assigned to users. You can only archive it.' });
    }
    await doc.deleteOne();
    logAudit({ req, action: 'quiz_question_delete', entityType: 'QuizQuestion', entityId: String(doc._id), description: `Hard deleted unused quiz question ${doc._id}`, before: { text: doc.text } });
    res.json({ success: true });
  } catch (e) { console.error('quiz deleteQuestion:', e.message); res.status(500).json({ error: 'Failed to delete question.' }); }
};

// GET /admin/quiz/api/questions/:id/stats → answer distribution (A/B/C/D) + correct %
exports.questionStats = async (req, res) => {
  try {
    const doc = await QuizQuestion.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'Question not found.' });
    const agg = await QuizEntry.aggregate([
      { $match: { questionId: doc._id, submittedAt: { $ne: null } } },
      { $group: { _id: '$selectedOption', count: { $sum: 1 }, correct: { $sum: { $cond: ['$isCorrect', 1, 0] } } } },
    ]);
    const assigned = await QuizEntry.countDocuments({ questionId: doc._id });
    const dist = { A: 0, B: 0, C: 0, D: 0 };
    let answered = 0, correct = 0;
    agg.forEach((g) => { answered += g.count; correct += g.correct; if (g._id && dist[g._id] !== undefined) dist[g._id] = g.count; });
    const pct = (n) => (answered ? Math.round((n / answered) * 1000) / 10 : 0);
    const distribution = ['A', 'B', 'C', 'D'].map((k) => ({ option: k, count: dist[k], pct: pct(dist[k]), isCorrect: k === doc.correctOption }));
    res.json({
      id: String(doc._id), text: doc.text, correctOption: doc.correctOption, options: doc.options,
      assigned, answered, correct, correctPct: pct(correct), distribution,
    });
  } catch (e) { console.error('quiz questionStats:', e.message); res.status(500).json({ error: 'Failed to load question stats.' }); }
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
function buildImportPlan(rows, existingNormSet, defaultLanguage = 'te') {
  const seen = new Set();
  const toInsert = []; const results = [];
  let imported = 0, skipped = 0, failed = 0;
  
  // Basic supported languages for validation
  const validLangs = new Set(['te', 'en', 'hi', 'kn', 'ta', 'ml', 'mr', 'gu', 'bn', 'pa', 'or', 'as']);
  
  rows.forEach((row, i) => {
    const rowNo = i + 2; // header is row 1
    const question = cell(row, 'question');
    const options = ['A', 'B', 'C', 'D'].map((k) => ({ key: k, text: cell(row, 'option' + k) })).filter((o) => o.text);
    const correctOption = cell(row, 'correctOption').toUpperCase();
    if (options.length !== 4) { failed++; results.push({ row: rowNo, status: 'failed', error: 'Question and all 4 options (A–D) are required.', question }); return; }
    const v = validateQuestion({ text: question, options, correctOption });
    if (!v.ok) { failed++; results.push({ row: rowNo, status: 'failed', error: v.error, question }); return; }
    
    let rawLang = cell(row, 'language');
    let lang = (rawLang ? rawLang : defaultLanguage).trim().toLowerCase();
    if (!validLangs.has(lang)) {
      failed++; results.push({ row: rowNo, status: 'failed', error: `Invalid or unsupported language code: "${lang}"`, question: v.text }); return;
    }
    
    const nq = qnorm(question) + '::' + lang;
    if (existingNormSet.has(nq) || seen.has(nq)) { skipped++; results.push({ row: rowNo, status: 'skipped', error: 'Duplicate question (already exists for this language).', question: v.text }); return; }
    seen.add(nq);
    
    const isActive = !/^(false|0|no)$/i.test(cell(row, 'isActive'));
    toInsert.push({ text: v.text, options: v.options, correctOption: v.correctOption, language: lang, category: cell(row, 'category') || null, isActive });
    imported++; results.push({ row: rowNo, status: 'ok', language: lang, question: v.text });
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

    const existing = new Set((await QuizQuestion.find({}).select('text language').lean()).map((q) => qnorm(q.text) + '::' + (q.language || 'te')));
    const defaultLanguage = String((req.body && req.body.language) || 'te').trim().toLowerCase();
    const plan = buildImportPlan(rows, existing, defaultLanguage);
    const dryRun = String((req.body && req.body.dryRun) || '') === 'true';
    // mode: 'add' (default) or 'disable_old' → disable the whole current active pool
    // before importing the new set (safe weekly-bank replacement; never deletes).
    const mode = String((req.body && req.body.mode) || 'add');
    if (dryRun) {
      const willDisableOld = mode === 'disable_old' ? await QuizQuestion.countDocuments({ isActive: true }) : 0;
      return res.json({ dryRun: true, mode, total: rows.length, imported: plan.imported, skipped: plan.skipped, failed: plan.failed, willDisableOld, results: plan.results });
    }

    let disabledOld = 0;
    if (mode === 'disable_old') {
      const r = await QuizQuestion.updateMany({ isActive: true }, { $set: { isActive: false } });
      disabledOld = (r && (r.modifiedCount != null ? r.modifiedCount : r.nModified)) || 0;
      logAudit({ req, action: 'quiz_questions_disable_old', entityType: 'QuizQuestion', entityId: 'bulk', description: `Disabled ${disabledOld} old active question(s) before import (soft; not deleted)` });
    }

    let insertedCount = 0;
    if (plan.toInsert.length) {
      const docs = plan.toInsert.map((d) => ({ ...d, createdByName: (req.admin && (req.admin.username || req.admin.name)) || '' }));
      try { const r = await QuizQuestion.insertMany(docs, { ordered: false }); insertedCount = r.length; }
      catch (e) { insertedCount = (e && e.result && e.result.nInserted) || (e && e.insertedDocs && e.insertedDocs.length) || 0; }
    }
    logAudit({ req, action: 'quiz_questions_import', entityType: 'QuizQuestion', entityId: 'bulk', description: `Excel import (${mode}): ${insertedCount} imported, ${plan.skipped} skipped, ${plan.failed} failed, ${disabledOld} disabled (of ${rows.length})` });
    res.json({ dryRun: false, mode, total: rows.length, imported: insertedCount, skipped: plan.skipped, failed: plan.failed, disabledOld, results: plan.results });
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

// GET /admin/quiz/api/analytics?weekId=... → funnel + per-day participation (read-only, IST)
exports.getAnalytics = async (req, res) => {
  try {
    const weekId = targetWeekId(req);
    const data = await weekAnalytics(weekId);
    res.json({ ...data, meta: weekMeta(weekId), todayKey: dayInfo().dayKey });
  } catch (e) { console.error('quiz getAnalytics:', e.message); res.status(500).json({ error: 'Failed to load analytics.' }); }
};

// Escape a user search term for safe regex use.
const rxEscape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isSuperAdmin = (req) => !!(req.admin && req.admin.role === 'superadmin');

// GET /admin/quiz/api/participants?weekId=&dayKey?=&page=&pageSize=&q=
// Server-paginated participant drill-down. Mobile/email/location are Super-Admin only.
exports.listParticipants = async (req, res) => {
  try {
    const weekId = targetWeekId(req);
    const dayKey = req.query.dayKey ? String(req.query.dayKey).trim() : null;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(5, parseInt(req.query.pageSize, 10) || 25));
    const qstr = String(req.query.q || '').trim();
    const isSuper = isSuperAdmin(req);

    let rows = await participantStats(weekId, dayKey);

    // Optional search resolves matching userIds from User, then filters the rollup.
    if (qstr) {
      const rx = new RegExp(rxEscape(qstr), 'i');
      const matched = await User.find({ $or: [{ displayName: rx }, { mobileNumber: rx }, { email: rx }, { googleId: rx }] }).select('googleId').lean();
      const set = new Set(matched.map((u) => u.googleId));
      rows = rows.filter((r) => set.has(r._id));
    }

    rows.sort((a, b) => new Date(b.lastSubmittedAt || 0) - new Date(a.lastSubmittedAt || 0));
    const total = rows.length;
    const pageRows = rows.slice((page - 1) * pageSize, page * pageSize);

    // Join User for just this page's users (bounded fetch).
    const uDocs = await User.find({ googleId: { $in: pageRows.map((r) => r._id) } })
      .select('googleId displayName mobileNumber email locationProfile deviceFingerprint').lean();
    const uMap = new Map(uDocs.map((u) => [u.googleId, u]));

    const participants = pageRows.map((r) => {
      const u = uMap.get(r._id) || {};
      const answered = r.answered || 0;
      const correct = r.correct || 0;
      const base = {
        userId: r._id,
        name: u.displayName || '(unknown)',
        score: correct, answered, correct, wrong: Math.max(0, answered - correct),
        completed: answered >= QUIZ_DAYS, completion: `${answered}/${QUIZ_DAYS}`,
        firstAt: r.firstAssignedAt || null, lastSubmittedAt: r.lastSubmittedAt || null,
      };
      if (isSuper) {
        const loc = u.locationProfile || {};
        base.mobile = u.mobileNumber || '';
        base.email = u.email || '';
        base.device = u.deviceFingerprint || '';
        // Trusted DB location only. Constituency is never inferred → always Not Assigned.
        base.location = {
          state: loc.primaryState || 'Not Assigned',
          district: loc.primaryDistrict || 'Not Assigned',
          constituency: 'Not Assigned',
        };
      }
      return base;
    });

    res.json({ weekId, dayKey, page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)), pii: isSuper, participants });
  } catch (e) { console.error('quiz listParticipants:', e.message); res.status(500).json({ error: 'Failed to load participants.' }); }
};

// CSV cell escaping incl. formula-injection guard (=,+,-,@ prefixed with ').
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
const toCsv = (headers, rows) => [headers.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n');
const iso = (d) => (d ? new Date(d).toISOString() : '');

// GET /admin/quiz/api/participants/export?weekId=  → CSV (PII columns Super-Admin only)
exports.exportParticipants = async (req, res) => {
  try {
    const weekId = targetWeekId(req);
    const isSuper = isSuperAdmin(req);
    const rows = (await participantStats(weekId, null)).sort((a, b) => new Date(b.lastSubmittedAt || 0) - new Date(a.lastSubmittedAt || 0));
    const uDocs = await User.find({ googleId: { $in: rows.map((r) => r._id) } })
      .select('googleId displayName mobileNumber email locationProfile').lean();
    const uMap = new Map(uDocs.map((u) => [u.googleId, u]));

    const headers = isSuper
      ? ['UserId', 'Name', 'Mobile', 'Email', 'State', 'District', 'Constituency', 'Score', 'Answered', 'Correct', 'Wrong', 'Completed', 'FirstAssignedAt', 'LastSubmittedAt']
      : ['UserId', 'Name', 'Score', 'Answered', 'Correct', 'Wrong', 'Completed'];
    const data = rows.map((r) => {
      const u = uMap.get(r._id) || {};
      const answered = r.answered || 0, correct = r.correct || 0;
      const base = [r._id, u.displayName || '(unknown)'];
      if (isSuper) {
        const loc = u.locationProfile || {};
        base.push(u.mobileNumber || '', u.email || '', loc.primaryState || 'Not Assigned', loc.primaryDistrict || 'Not Assigned', 'Not Assigned');
      }
      base.push(correct, answered, correct, Math.max(0, answered - correct), answered >= QUIZ_DAYS ? 'Yes' : 'No');
      if (isSuper) base.push(iso(r.firstAssignedAt), iso(r.lastSubmittedAt));
      return base;
    });
    logAudit({ req, action: 'quiz_participants_export', entityType: 'QuizWeek', entityId: weekId, description: `Exported ${data.length} participants for ${weekId} (pii=${isSuper})` });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="quiz_participants_${weekId}.csv"`);
    res.send(toCsv(headers, data));
  } catch (e) { console.error('quiz exportParticipants:', e.message); res.status(500).json({ error: 'Failed to export participants.' }); }
};

// GET /admin/quiz/api/winners/export?weekId=  → CSV of real winners (test winners excluded)
exports.exportWinners = async (req, res) => {
  try {
    const weekId = req.query.weekId ? String(req.query.weekId).trim() : null;
    const isSuper = isSuperAdmin(req);
    const q = { isTest: { $ne: true } };
    if (weekId) q.weekId = weekId;
    const winners = await QuizWinner.find(q).sort({ weekId: -1, rank: 1 }).lean();

    let uMap = new Map();
    if (isSuper) {
      const uDocs = await User.find({ googleId: { $in: winners.map((w) => w.userId) } }).select('googleId mobileNumber email').lean();
      uMap = new Map(uDocs.map((u) => [u.googleId, u]));
    }
    const headers = isSuper
      ? ['WeekId', 'Rank', 'Name', 'Mobile', 'Email', 'Score', 'Answered', 'Mode', 'SelectedBy', 'SelectedAt']
      : ['WeekId', 'Rank', 'Name', 'Score', 'Answered', 'Mode', 'SelectedBy', 'SelectedAt'];
    const data = winners.map((w) => {
      const row = [w.weekId, w.rank, w.displayName || '(unknown)'];
      if (isSuper) { const u = uMap.get(w.userId) || {}; row.push(u.mobileNumber || '', u.email || ''); }
      row.push(w.score || 0, w.answered || 0, w.mode || '', w.selectedByName || '', iso(w.selectedAt));
      return row;
    });
    logAudit({ req, action: 'quiz_winners_export', entityType: 'QuizWinner', entityId: weekId || 'all', description: `Exported ${data.length} winners (pii=${isSuper})` });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="quiz_winners_${weekId || 'all'}.csv"`);
    res.send(toCsv(headers, data));
  } catch (e) { console.error('quiz exportWinners:', e.message); res.status(500).json({ error: 'Failed to export winners.' }); }
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

// GET /admin/quiz/api/settings
exports.getSettings = async (req, res) => {
  try {
    const s = await QuizSettings.findOne({ key: 'quiz_config' }).lean();
    if (!s) return res.json({ isEnabled: false, enabledLanguages: [], revealTime: '23:30', winnerReleaseTime: '10:00' });
    res.json({ isEnabled: !!s.isEnabled, enabledLanguages: s.enabledLanguages || [], revealTime: s.revealTime || '23:30', winnerReleaseTime: s.winnerReleaseTime || '10:00' });
  } catch (e) { console.error('quiz getSettings:', e.message); res.status(500).json({ error: 'Failed to get settings.' }); }
};

// PUT /admin/quiz/api/settings
exports.updateSettings = async (req, res) => {
  try {
    const isEnabled = !!req.body.isEnabled;
    const rawLangs = Array.isArray(req.body.enabledLanguages) ? req.body.enabledLanguages : [];
    const enabledLanguages = rawLangs.map((l) => String(l).trim().toLowerCase()).filter((l) => l);
    // Reveal/release times (HH:mm IST). Keep valid or fall back to defaults.
    const hhmm = (v, def) => (/^\d{1,2}:\d{2}$/.test(String(v || '')) ? String(v) : def);
    const revealTime = hhmm(req.body.revealTime, '23:30');
    const winnerReleaseTime = hhmm(req.body.winnerReleaseTime, '10:00');

    await QuizSettings.updateOne(
      { key: 'quiz_config' },
      { $set: { isEnabled, enabledLanguages, revealTime, winnerReleaseTime, updatedByName: req.admin ? (req.admin.name || req.admin.username) : 'admin' } },
      { upsert: true }
    );
    // Clear the memory cache in the language service so the public API picks it up immediately
    require('../services/quizLanguageService')._clearCache();
    
    logAudit({ req, action: 'quiz_settings_update', entityType: 'QuizSettings', entityId: 'quiz_config', description: `Quiz settings updated: ON=${isEnabled}, Langs=${enabledLanguages.join(',')}` });
    res.json({ ok: true });
  } catch (e) { console.error('quiz updateSettings:', e.message); res.status(500).json({ error: 'Failed to update settings.' }); }
};

// GET /admin/quiz/api/questions/pool-health
exports.getPoolHealth = async (req, res) => {
  try {
    // We need to count by language: active, unused, used/locked, archived
    // "Used" = has usageCount > 0 OR lockedForEdit OR has QuizEntry
    // To do this perfectly in one go, we first get all question states, then we check QuizEntry usage if needed.
    // However, since it's an admin dashboard, a slight approximation or a two-step query is fine.
    // Let's do a fast aggregation:
    const stats = await QuizQuestion.aggregate([
      {
        $group: {
          _id: '$language',
          total: { $sum: 1 },
          archived: { $sum: { $cond: ['$archived', 1, 0] } },
          locked: { $sum: { $cond: ['$lockedForEdit', 1, 0] } },
          active: { $sum: { $cond: [{ $and: [{ $eq: ['$isActive', true] }, { $ne: ['$archived', true] }] }, 1, 0] } }
        }
      }
    ]);
    
    // For "used", we need to check if they have usageCount > 0 or if they have an entry.
    // Let's just use usageCount and lockedForEdit for the "used" count to be fast.
    const usedCounts = await QuizQuestion.aggregate([
      { $match: { $or: [{ lockedForEdit: true }, { usageCount: { $gt: 0 } }] } },
      { $group: { _id: '$language', usedCount: { $sum: 1 } } }
    ]);
    const usedMap = new Map(usedCounts.map(u => [u._id, u.usedCount]));
    
    const health = stats.map(s => {
      const used = usedMap.get(s._id) || 0;
      // "active" pool is the pool available for random assignment (isActive=true, archived=false)
      // "unused" is roughly (total - archived - used)
      const unused = Math.max(0, s.total - s.archived - used);
      return {
        language: s._id || 'unknown',
        total: s.total,
        active: s.active,
        archived: s.archived,
        locked: s.locked,
        used,
        unused
      };
    });
    
    res.json(health);
  } catch (e) { console.error('quiz getPoolHealth:', e.message); res.status(500).json({ error: 'Failed to get pool health.' }); }
};

// ─────────────── Quiz Rules (dynamic info sections) ───────────────
const QuizRules = require('../models/QuizRules');
const { DEFAULT_QUIZ_RULES } = require('./quizController');

// GET /admin/quiz/rules (management page)
exports.renderRules = (req, res) => res.render('quiz-rules', { admin: req.admin, activePage: 'quiz-rules' });

// GET /admin/quiz/api/rules → current rules (or defaults to start editing from)
exports.getRules = async (req, res) => {
  try {
    const doc = await QuizRules.findOne({ key: 'quiz_rules' }).lean();
    if (doc && Array.isArray(doc.sections)) {
      return res.json({ title: doc.title || 'Daily Quiz', sections: doc.sections });
    }
    res.json(DEFAULT_QUIZ_RULES);
  } catch (e) { console.error('quiz getRules:', e.message); res.status(500).json({ error: 'Failed to load rules.' }); }
};

// PUT /admin/quiz/api/rules  { title, sections: [{ title, content }] }
// Full replace — lets admins add / edit / reorder / delete sections anytime.
exports.updateRules = async (req, res) => {
  try {
    const title = String(req.body.title || 'Daily Quiz').trim();
    const raw = Array.isArray(req.body.sections) ? req.body.sections : [];
    const sections = raw
      .map((s) => ({ title: String((s && s.title) || '').trim(), content: String((s && s.content) || '').trim() }))
      .filter((s) => s.title.length > 0);
    const doc = await QuizRules.findOneAndUpdate(
      { key: 'quiz_rules' },
      { $set: { title, sections } },
      { new: true, upsert: true }
    ).lean();
    logAudit({ req, action: 'quiz_rules_update', entityType: 'QuizRules', entityId: 'quiz_rules', description: `Updated quiz rules (${sections.length} sections)` });
    res.json({ success: true, title: doc.title, sections: doc.sections });
  } catch (e) { console.error('quiz updateRules:', e.message); res.status(500).json({ error: 'Failed to update rules.' }); }
};

exports._internals = { resolveUserByAny }; // exported for tests
