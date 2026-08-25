'use strict';

/**
 * Quiz user APIs (P2) — server-authoritative daily question + locked answer.
 * Identity is the verified googleId (req.verifiedGoogleId), never client-supplied.
 * correctOption is NEVER returned before submission. All day/week logic is IST.
 */

const QuizQuestion = require('../models/QuizQuestion');
const QuizEntry = require('../models/QuizEntry');
const QuizWeek = require('../models/QuizWeek');
const QuizWinner = require('../models/QuizWinner');
const QuizTestOverride = require('../models/QuizTestOverride');
const { dayInfo, weekDayKeys, weekMeta, simTestDate } = require('../utils/quizWeek');
const { getQuizEnabledLanguages, getQuizConfig, isQuizLanguageAllowed } = require('../services/quizLanguageService');

const uid = (req) => req.verifiedGoogleId || null;
const reqLang = (req) => (req.query && req.query.lang ? String(req.query.lang).trim().toLowerCase() : null);

/**
 * Effective quiz day for a user. If an admin has enabled test mode for THIS user,
 * simulate the chosen weekday of the fixed test week (weekId 2024-01-xx). Real users
 * (no active override) get real IST time. Returns { di, testMode }.
 */
async function resolveQuizContext(userId) {
  if (!userId) return { di: dayInfo(), testMode: false };
  let ov = null;
  try { ov = await QuizTestOverride.findOne({ userId, active: true }).lean(); } catch (_) { ov = null; }
  if (!ov) return { di: dayInfo(), testMode: false };
  const di = dayInfo(new Date(simTestDate(ov.simDayIndex) + 'T06:00:00+05:30'));
  return { di, testMode: true, testDay: ov.simDayIndex };
}
const publicQuestion = (q) => ({ id: String(q._id), text: q.text, options: (q.options || []).map((o) => ({ key: o.key, text: o.text })) });

async function ensureWeek(weekId) {
  const m = weekMeta(weekId);
  await QuizWeek.updateOne({ weekId }, { $setOnInsert: { weekId, startDate: m.startDate, endDate: m.endDate, sundayDate: m.sundayDate, status: 'active' } }, { upsert: true });
}

/** Find-or-assign today's question for a user (atomic, no-repeat within week, no full-pool load). */
async function assignQuestion(userId, weekId, dayKey, dayIndex, lang) {
  const existing = await QuizEntry.findOne({ userId, weekId, dayKey });
  if (existing) return existing;
  const used = (await QuizEntry.find({ userId, weekId }).select('questionId').lean()).map((e) => e.questionId);
  let picked = await QuizQuestion.aggregate([{ $match: { isActive: true, language: lang, _id: { $nin: used } } }, { $sample: { size: 1 } }]);
  if (!picked.length) picked = await QuizQuestion.aggregate([{ $match: { isActive: true, language: lang } }, { $sample: { size: 1 } }]); // pool < 6 fallback
  if (!picked.length) return null; // no active questions for this language
  await QuizEntry.updateOne(
    { userId, weekId, dayKey },
    { $setOnInsert: { userId, weekId, dayKey, dayIndex, questionId: picked[0]._id, assignedAt: new Date() } },
    { upsert: true }
  );
  return QuizEntry.findOne({ userId, weekId, dayKey });
}

/** Mon..Sat progress states from the user's entries (one query, no N+1). */
function buildProgress(weekId, todayKey, entriesByDay) {
  return weekDayKeys(weekId).map((dk, i) => {
    const e = entriesByDay.get(dk);
    let state;
    if (dk > todayKey) state = 'upcoming';
    else if (e && e.submittedAt) state = e.isCorrect ? 'correct' : 'wrong';
    else if (dk === todayKey) state = 'today';
    else state = 'missed';
    return { dayIndex: i + 1, dayKey: dk, state };
  });
}

async function winnersFor(weekId) {
  const rows = await QuizWinner.find({ weekId }).sort({ rank: 1 }).lean();
  return rows.map((w) => ({ rank: w.rank, name: w.displayName, score: w.score, mode: w.mode }));
}

// GET /api/public/quiz/today
exports.today = async (req, res) => {
  try {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ error: 'Sign in to play the quiz.' });
    // Language targeting (Quiz/week level). Empty config = all. Blocks before any
    // assignment so no QuizEntry is created for users outside the target languages.
    const conf = await getQuizConfig();
    if (!conf.isEnabled) {
      return res.json({ available: false, enabled: false, reason: 'disabled' });
    }
    const userLang = reqLang(req);
    if (!isQuizLanguageAllowed(userLang, conf.langs, conf.isEnabled)) {
      return res.json({ available: false, reason: 'language' });
    }
    const ctx = await resolveQuizContext(userId);
    const di = ctx.di;
    await ensureWeek(di.weekId);

    if (!di.isQuizDay) { // Sunday → winners
      const winners = await winnersFor(di.weekId);
      return res.json({ weekId: di.weekId, dayIndex: 0, isQuizDay: false, isSunday: true, winnersReady: winners.length > 0, winners, testMode: ctx.testMode });
    }

    const entry = await assignQuestion(userId, di.weekId, di.dayKey, di.dayIndex, userLang);
    if (!entry) return res.json({ weekId: di.weekId, dayIndex: di.dayIndex, isQuizDay: true, question: null, message: 'No question available today.', testMode: ctx.testMode });
    const q = await QuizQuestion.findById(entry.questionId).lean();

    const entries = await QuizEntry.find({ userId, weekId: di.weekId }).lean();
    const byDay = new Map(entries.map((e) => [e.dayKey, e]));
    const answered = !!entry.submittedAt;

    res.json({
      weekId: di.weekId, dayIndex: di.dayIndex, isQuizDay: true, testMode: ctx.testMode,
      question: q ? publicQuestion(q) : null,
      status: answered ? 'answered' : 'unanswered',
      answer: answered ? { selectedOption: entry.selectedOption, isCorrect: entry.isCorrect, correctOption: q ? q.correctOption : null } : null,
      weekProgress: buildProgress(di.weekId, di.dayKey, byDay),
    });
  } catch (e) { console.error('quiz today:', e.message); res.status(500).json({ error: 'Failed to load today\'s quiz.' }); }
};

// POST /api/public/quiz/answer  { questionId, selectedOption }
exports.answer = async (req, res) => {
  try {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ error: 'Sign in to play the quiz.' });
    const conf = await getQuizConfig();
    if (!conf.isEnabled || !isQuizLanguageAllowed(reqLang(req), conf.langs, conf.isEnabled)) {
      return res.status(403).json({ error: 'Quiz is not available for your language.' });
    }
    const ctx = await resolveQuizContext(userId);
    const di = ctx.di;
    if (!di.isQuizDay) return res.status(400).json({ error: 'No quiz today.' });

    const { questionId, selectedOption } = req.body || {};
    const entry = await QuizEntry.findOne({ userId, weekId: di.weekId, dayKey: di.dayKey });
    if (!entry) return res.status(400).json({ error: 'Open today\'s quiz first.' });
    if (String(entry.questionId) !== String(questionId)) return res.status(400).json({ error: 'Question mismatch.' });

    const q = await QuizQuestion.findById(entry.questionId).lean();
    if (!q) return res.status(400).json({ error: 'Question unavailable.' });

    if (entry.submittedAt) { // idempotent — already locked
      return res.json({ locked: true, alreadySubmitted: true, isCorrect: entry.isCorrect, correctOption: q.correctOption });
    }
    const sel = String(selectedOption || '').toUpperCase().trim();
    if (!(q.options || []).some((o) => o.key === sel)) return res.status(400).json({ error: 'Invalid option.' });

    const isCorrect = sel === q.correctOption;
    const upd = await QuizEntry.updateOne(
      { _id: entry._id, submittedAt: null },
      { $set: { selectedOption: sel, isCorrect, submittedAt: new Date() } }
    );
    if (upd.matchedCount === 0) { // concurrent submit won the race → return the frozen result
      const fresh = await QuizEntry.findById(entry._id).lean();
      return res.json({ locked: true, alreadySubmitted: true, isCorrect: fresh.isCorrect, correctOption: q.correctOption });
    }
    // First correct use of a question → mark usageCount (edit-lock happens when the week closes).
    QuizQuestion.updateOne({ _id: q._id }, { $inc: { usageCount: 1 } }).catch(() => {});
    res.json({ locked: true, isCorrect, correctOption: q.correctOption });
  } catch (e) { console.error('quiz answer:', e.message); res.status(500).json({ error: 'Failed to submit answer.' }); }
};

// GET /api/public/quiz/week — read-only Mon–Sat history (correctOption only for submitted days)
exports.week = async (req, res) => {
  try {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ error: 'Sign in to play the quiz.' });
    const conf = await getQuizConfig();
    if (!conf.isEnabled || !isQuizLanguageAllowed(reqLang(req), conf.langs, conf.isEnabled)) {
      return res.status(403).json({ error: 'Quiz is not available for your language.' });
    }
    const ctx = await resolveQuizContext(userId);
    const di = ctx.di;
    const entries = await QuizEntry.find({ userId, weekId: di.weekId }).lean();
    const byDay = new Map(entries.map((e) => [e.dayKey, e]));
    const qIds = entries.map((e) => e.questionId);
    const qMap = new Map((await QuizQuestion.find({ _id: { $in: qIds } }).lean()).map((q) => [String(q._id), q]));
    const days = weekDayKeys(di.weekId).map((dk, i) => {
      const e = byDay.get(dk);
      const q = e ? qMap.get(String(e.questionId)) : null;
      const submitted = !!(e && e.submittedAt);
      return {
        dayIndex: i + 1, dayKey: dk,
        state: dk > di.dayKey ? 'upcoming' : (submitted ? (e.isCorrect ? 'correct' : 'wrong') : (dk === di.dayKey ? 'today' : 'missed')),
        question: q ? { text: q.text, options: q.options.map((o) => ({ key: o.key, text: o.text })) } : null,
        selectedOption: submitted ? e.selectedOption : null,
        isCorrect: submitted ? e.isCorrect : null,
        correctOption: submitted && q ? q.correctOption : null, // revealed only after submit
      };
    });
    res.json({ weekId: di.weekId, todayIndex: di.dayIndex, days, testMode: ctx.testMode });
  } catch (e) { console.error('quiz week:', e.message); res.status(500).json({ error: 'Failed to load week.' }); }
};

exports._internals = { assignQuestion, buildProgress, resolveQuizContext };
