'use strict';

/**
 * Quiz user APIs (P2) — server-authoritative daily question + locked answer.
 * Identity is the verified googleId (req.verifiedGoogleId), never client-supplied.
 * correctOption is NEVER returned before submission. All day/week logic is IST.
 */

const mongoose = require('mongoose');
const QuizQuestion = require('../models/QuizQuestion');
const QuizEntry = require('../models/QuizEntry');
const QuizWeek = require('../models/QuizWeek');
const QuizWinner = require('../models/QuizWinner');
const DeviceLink = require('../models/DeviceLink');
const QuizTestOverride = require('../models/QuizTestOverride');
const QuizRules = require('../models/QuizRules');
const { dayInfo, weekDayKeys, weekMeta, simTestDate } = require('../utils/quizWeek');
const { getQuizEnabledLanguages, getQuizConfig, isQuizLanguageAllowed } = require('../services/quizLanguageService');
const poolAlert = require('../services/quizPoolAlertService');

const uid = (req) => req.verifiedGoogleId || null;
const reqLang = (req) => (req.query && req.query.lang ? String(req.query.lang).trim().toLowerCase() : null);

/** Sanitized per-install id from the X-Device-Id header (untrusted). Accepts only a
 *  UUID-shaped opaque token (8–64 of [A-Za-z0-9-]); anything else → null. */
function deviceIdFrom(req) {
  const raw = req && req.headers && (req.headers['x-device-id'] || req.headers['X-Device-Id']);
  if (!raw) return null;
  const s = String(raw).trim();
  return /^[A-Za-z0-9-]{8,64}$/.test(s) ? s : null;
}

/**
 * Effective quiz day for a user. If an admin has enabled test mode for THIS user,
 * simulate the chosen weekday of the fixed test week (weekId 2024-01-xx). Real users
 * (no active override) get real IST time. Returns { di, testMode }.
 */
async function resolveQuizContext(userId) {
  if (!userId) return { di: dayInfo(), testMode: false, now: new Date() };
  let ov = null;
  try { ov = await QuizTestOverride.findOne({ userId, active: true }).lean(); } catch (_) { ov = null; }
  if (!ov) return { di: dayInfo(), testMode: false, now: new Date() };
  // Simulated "now" for the chosen day (late evening IST) so reveal/release gates
  // behave usefully in test mode: Mon–Fri answers stay hidden, a simulated Saturday
  // is PAST the reveal time (green/red visible), and a simulated Sunday is past the
  // winner-release time (winners visible) — letting admins walk the whole flow.
  const simNow = new Date(simTestDate(ov.simDayIndex) + 'T23:45:00+05:30');
  return { di: dayInfo(simNow), testMode: true, testDay: ov.simDayIndex, now: simNow };
}

// ── Weekly reveal / winner release gating (IST) ──
function _istDateTime(dateKey, hhmm) {
  const t = /^\d{1,2}:\d{2}$/.test(hhmm || '') ? hhmm : '23:30';
  const [h, m] = t.split(':');
  return new Date(`${dateKey}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+05:30`);
}
/** Fallback/floor: when correct answers reveal for a user who did NOT play Saturday
 *  — Saturday (endDate) at the admin-configured revealTime IST. */
function revealAtFor(weekId, revealTime) { return _istDateTime(weekMeta(weekId).endDate, revealTime); }
/** When the 10 winners become visible: Sunday (sundayDate) at winnerReleaseTime IST. */
function winnerReleaseAtFor(weekId, releaseTime) { return _istDateTime(weekMeta(weekId).sundayDate, releaseTime); }

// The whole week's correctness unlocks 30 minutes AFTER the user submits Saturday's answer.
const REVEAL_DELAY_MS = 30 * 60 * 1000;

/**
 * When the whole week's correctness reveals FOR THIS USER. It's a single board-wide
 * reveal (green/red for every submitted day at once), designed to be exciting yet
 * cheat-resistant:
 *   • Submitted Saturday's answer  → 30 min after that submission. The delay means
 *     the correct Saturday answer isn't exposed the instant it's locked, and because
 *     the reveal is personal (a user only ever sees their OWN board, gated by their
 *     OWN Saturday submission) it can't leak to someone who hasn't submitted yet.
 *   • Did NOT submit Saturday      → the admin-configured Saturday reveal time, so a
 *     user who skipped Saturday still sees the week's results that evening.
 * Revealing Mon–Fri answers together on Saturday is safe: those days are already
 * closed for everyone (you can only answer the current day's question), so nothing
 * about them is still "live" to cheat on.
 * @param {Array} entries the user's QuizEntry docs for the week
 */
function userRevealAt(entries, weekId, revealTime) {
  const satKey = weekMeta(weekId).endDate; // Saturday's dayKey
  const sat = (entries || []).find((e) => e.dayKey === satKey);
  if (sat && sat.submittedAt) return new Date(new Date(sat.submittedAt).getTime() + REVEAL_DELAY_MS);
  return revealAtFor(weekId, revealTime); // floor / fallback for non-Saturday-players
}

/**
 * Has the week's correctness revealed for this user yet?
 *  • Submitted Saturday's answer → compare against the REAL clock, because the
 *    30-minute unlock is real elapsed time since submitting. This keeps the
 *    countdown observable even in test mode, where ctxNow is a frozen simulated
 *    timestamp that could never "reach" a real 2026 submit time.
 *  • Otherwise → compare the effective (possibly simulated) now against the floor.
 */
function isRevealed(entries, weekId, revealAt, ctxNow) {
  const satKey = weekMeta(weekId).endDate;
  const submittedSat = (entries || []).some((e) => e.dayKey === satKey && e.submittedAt);
  return submittedSat ? (Date.now() >= revealAt.getTime()) : (ctxNow >= revealAt);
}
const publicQuestion = (q) => ({ id: String(q._id), text: q.text, options: (q.options || []).map((o) => ({ key: o.key, text: o.text })) });

async function ensureWeek(weekId) {
  const m = weekMeta(weekId);
  await QuizWeek.updateOne({ weekId }, { $setOnInsert: { weekId, startDate: m.startDate, endDate: m.endDate, sundayDate: m.sundayDate, status: 'active' } }, { upsert: true });
}

/**
 * Find-or-assign today's question with LIFETIME no-repeat.
 *
 * A question is NEVER shown again once it has been assigned to this user OR seen on
 * this device (any past week). We therefore exclude every questionId this
 * userId/deviceId has ever received. There is intentionally NO repeat-fallback: if
 * the fresh pool is exhausted we return null (the app shows "no question") rather
 * than re-serving a seen question — so admins must keep the active pool stocked.
 * @param {string|null} deviceId best-effort per-install id (may be null)
 */
async function assignQuestion(userId, weekId, dayKey, dayIndex, lang, deviceId = null) {
  const existing = await QuizEntry.findOne({ userId, weekId, dayKey });
  if (existing) return existing;

  // Lifetime "seen" set: everything this account got, plus everything ever assigned
  // on this device (only add the device clause when we actually have one).
  const seenBy = [{ userId }];
  if (deviceId) seenBy.push({ deviceId });
  const used = (await QuizEntry.find({ $or: seenBy }).select('questionId').lean()).map((e) => e.questionId);

  // Fire-and-forget pool-health alert: if this player's fresh pool is near empty,
  // email support + raise an admin notification. Throttled internally; never blocks.
  poolAlert.maybeAlertLowPool(lang, used).catch(() => {});

  const picked = await QuizQuestion.aggregate([
    { $match: { isActive: true, language: lang, _id: { $nin: used } } },
    { $sample: { size: 1 } },
  ]);
  if (!picked.length) return null; // fresh pool exhausted (or none active) → never repeat

  await QuizEntry.updateOne(
    { userId, weekId, dayKey },
    { $setOnInsert: { userId, weekId, dayKey, dayIndex, questionId: picked[0]._id, assignedAt: new Date(), deviceId: deviceId || null } },
    { upsert: true }
  );
  return QuizEntry.findOne({ userId, weekId, dayKey });
}

/** Mon..Sat progress states. Before the weekly reveal, submitted days are neutral
 * ('submitted'); after reveal they become 'correct'/'wrong'. */
function buildProgress(weekId, todayKey, entriesByDay, revealed) {
  return weekDayKeys(weekId).map((dk, i) => {
    const e = entriesByDay.get(dk);
    let state;
    if (dk > todayKey) state = 'upcoming';
    else if (e && e.submittedAt) state = revealed ? (e.isCorrect ? 'correct' : 'wrong') : 'submitted';
    else if (dk === todayKey) state = 'today';
    else state = 'missed';
    return { dayIndex: i + 1, dayKey: dk, state };
  });
}

async function winnersFor(weekId) {
  const rows = await QuizWinner.find({ weekId }).sort({ rank: 1 }).lean();
  return rows.map((w) => ({
    rank: w.rank, name: w.displayName, score: w.score, mode: w.mode,
    // Real display data (empty → app shows name/photo only, no fake phone).
    mobileNumber: w.mobileNumber || null,
    profileImage: w.profileImage || null,
  }));
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

    if (!di.isQuizDay) { // Sunday → winners (only after the configured release time)
      const releaseAt = winnerReleaseAtFor(di.weekId, conf.winnerReleaseTime);
      const released = ctx.now >= releaseAt;
      const winners = released ? await winnersFor(di.weekId) : [];
      return res.json({
        weekId: di.weekId, dayIndex: 0, isQuizDay: false, isSunday: true,
        winnersReleased: released, winnersReady: released && winners.length > 0,
        winners, winnerReleaseAt: releaseAt.toISOString(), testMode: ctx.testMode,
      });
    }

    const entry = await assignQuestion(userId, di.weekId, di.dayKey, di.dayIndex, userLang, deviceIdFrom(req));
    if (!entry) return res.json({ weekId: di.weekId, dayIndex: di.dayIndex, isQuizDay: true, question: null, message: 'No question available today.', testMode: ctx.testMode });
    const q = await QuizQuestion.findById(entry.questionId).lean();

    const entries = await QuizEntry.find({ userId, weekId: di.weekId }).lean();
    const byDay = new Map(entries.map((e) => [e.dayKey, e]));
    const answered = !!entry.submittedAt;

    // Correctness (green/red) is hidden until 30 min after the user's Saturday
    // submission (or the configured Saturday time if they skipped Saturday). The
    // 30-min countdown is REAL elapsed time, so it runs during a simulated day too.
    const revealAt = userRevealAt(entries, di.weekId, conf.revealTime);
    const revealed = isRevealed(entries, di.weekId, revealAt, ctx.now);

    res.json({
      weekId: di.weekId, dayIndex: di.dayIndex, isQuizDay: true, testMode: ctx.testMode,
      question: q ? publicQuestion(q) : null,
      status: answered ? 'answered' : 'unanswered',
      revealed, revealAt: revealAt.toISOString(),
      // Neutral until reveal: only the locked selection is returned; correctOption
      // and isCorrect are withheld until the weekly reveal has passed.
      answer: answered
        ? (revealed
            ? { selectedOption: entry.selectedOption, isCorrect: entry.isCorrect, correctOption: q ? q.correctOption : null }
            : { selectedOption: entry.selectedOption })
        : null,
      weekProgress: buildProgress(di.weekId, di.dayKey, byDay, revealed),
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

    if (entry.submittedAt) { // idempotent — already locked (no reveal here)
      return res.json({ locked: true, submitted: true, alreadySubmitted: true, selectedOption: entry.selectedOption });
    }
    const sel = String(selectedOption || '').toUpperCase().trim();
    if (!(q.options || []).some((o) => o.key === sel)) return res.status(400).json({ error: 'Invalid option.' });

    // isCorrect is computed & stored server-side, but NEVER returned on submit — the
    // result stays hidden until the weekly Saturday reveal.
    const isCorrect = sel === q.correctOption;
    const deviceId = deviceIdFrom(req); // best-effort, sanitized, may be null
    // Only set deviceId when we actually have one, so a header-less submit never
    // wipes the device recorded at assign time (needed for lifetime no-repeat).
    const set = { selectedOption: sel, isCorrect, submittedAt: new Date() };
    if (deviceId) set.deviceId = deviceId;
    const upd = await QuizEntry.updateOne({ _id: entry._id, submittedAt: null }, { $set: set });
    if (upd.matchedCount === 0) { // concurrent submit won the race → return the frozen (hidden) result
      const fresh = await QuizEntry.findById(entry._id).lean();
      return res.json({ locked: true, submitted: true, alreadySubmitted: true, selectedOption: fresh ? fresh.selectedOption : sel });
    }
    QuizQuestion.updateOne({ _id: q._id }, { $inc: { usageCount: 1 } }).catch(() => {});
    // Record the account↔install link for fair-play draw analysis. Fully fire-and-forget:
    // any failure here must NEVER affect the user's answer submission.
    if (deviceId) {
      DeviceLink.updateOne(
        { deviceId, userId },
        { $setOnInsert: { deviceId, userId, firstSeenAt: new Date() }, $set: { lastSeenAt: new Date() }, $inc: { hitCount: 1 } },
        { upsert: true }
      ).catch(() => {});
    }
    res.json({ locked: true, submitted: true, selectedOption: sel });
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
    // Per-user reveal: 30 min (real elapsed) after the Saturday submission.
    const revealAt = userRevealAt(entries, di.weekId, conf.revealTime);
    const revealed = isRevealed(entries, di.weekId, revealAt, ctx.now);
    const byDay = new Map(entries.map((e) => [e.dayKey, e]));
    const qIds = entries.map((e) => e.questionId);
    const qMap = new Map((await QuizQuestion.find({ _id: { $in: qIds } }).lean()).map((q) => [String(q._id), q]));
    const days = weekDayKeys(di.weekId).map((dk, i) => {
      const e = byDay.get(dk);
      const q = e ? qMap.get(String(e.questionId)) : null;
      const submitted = !!(e && e.submittedAt);
      return {
        dayIndex: i + 1, dayKey: dk,
        state: dk > di.dayKey ? 'upcoming' : (submitted ? (revealed ? (e.isCorrect ? 'correct' : 'wrong') : 'submitted') : (dk === di.dayKey ? 'today' : 'missed')),
        question: q ? { text: q.text, options: q.options.map((o) => ({ key: o.key, text: o.text })) } : null,
        selectedOption: submitted ? e.selectedOption : null,
        // Correctness + correct answer are withheld until the weekly reveal time.
        isCorrect: submitted && revealed ? e.isCorrect : null,
        correctOption: submitted && revealed && q ? q.correctOption : null,
      };
    });
    res.json({ weekId: di.weekId, todayIndex: di.dayIndex, revealed, revealAt: revealAt.toISOString(), days, testMode: ctx.testMode });
  } catch (e) { console.error('quiz week:', e.message); res.status(500).json({ error: 'Failed to load week.' }); }
};

// GET /api/public/quiz/winners — the 10 weekly winners, gated by the Sunday release time.
exports.winners = async (req, res) => {
  try {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ error: 'Sign in to view winners.' });
    const conf = await getQuizConfig();
    const ctx = await resolveQuizContext(userId);
    const di = ctx.di;
    const releaseAt = winnerReleaseAtFor(di.weekId, conf.winnerReleaseTime);
    const released = ctx.now >= releaseAt;
    const winners = released ? await winnersFor(di.weekId) : [];
    res.json({
      weekId: di.weekId, isSunday: !di.isQuizDay,
      winnersReleased: released, winnersReady: released && winners.length > 0,
      winners, winnerReleaseAt: releaseAt.toISOString(), testMode: ctx.testMode,
    });
  } catch (e) { console.error('quiz winners:', e.message); res.status(500).json({ error: 'Failed to load winners.' }); }
};

// Fallback used when no QuizRules doc exists yet (or DB is unreachable).
const DEFAULT_QUIZ_RULES = {
  title: 'Daily Quiz',
  sections: [
    { title: 'About Daily Quiz', content: 'Answer daily questions correctly and stand a chance to win ₹1,000 every week.' },
    { title: 'How to Play', content: 'Play the Daily Quiz from Monday to Saturday — one question each day. Answer correctly to earn points; your answer locks once submitted.' },
    { title: 'Rules & Eligibility', content: 'You must complete your profile (Name, Mobile, PAN, State, District) to be eligible. Answer all 6 days to qualify for the weekly draw.' },
    { title: 'Prize & Rewards', content: 'Every Sunday, 10 winners are selected from the top scorers. Each winner receives ₹1,000 to their registered mobile number via UPI.' },
    { title: 'Need Help?', content: 'For any queries about the Daily Quiz or prizes, please contact our support team from the app settings.' },
  ],
};

// GET /api/public/quiz/rules — fully dynamic info sections for the app.
// Returns { title, sections: [{ title, content }] } from the DB, falling back to
// sensible defaults so the app always renders something.
exports.rules = async (req, res) => {
  try {
    let doc = null;
    if (mongoose.connection.readyState === 1) {
      doc = await QuizRules.findOne({ key: 'quiz_rules' }).lean();
    }
    if (doc && Array.isArray(doc.sections) && doc.sections.length) {
      return res.json({
        title: doc.title || 'Daily Quiz',
        sections: doc.sections.map((s) => ({ title: s.title || '', content: s.content || '' })),
      });
    }
    res.json(DEFAULT_QUIZ_RULES);
  } catch (e) {
    console.error('quiz rules:', e.message);
    res.json(DEFAULT_QUIZ_RULES);
  }
};

exports.DEFAULT_QUIZ_RULES = DEFAULT_QUIZ_RULES;

exports._internals = { assignQuestion, buildProgress, resolveQuizContext, userRevealAt, isRevealed, REVEAL_DELAY_MS };
