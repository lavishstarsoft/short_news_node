'use strict';

/**
 * Quiz winner selection (P3) — server-authoritative, one-time, immutable.
 *
 * Eligibility: a user must have answered all 6 Mon–Sat questions. Ranking (for the
 * eligible list / admin view) is correctCount desc, then earliest completion.
 * Two modes: random_lottery (crypto Fisher–Yates) and admin_select (exactly 10 of
 * the eligible). One-time is enforced by an atomic QuizWeek status flip.
 *
 * The lottery draws only from lotteryPool(): all 6 answered AND all 6 correct AND
 * never won before (quizPastWinnerService). Fewer than 10 in the pool → all of them
 * win and the admin fills the rest on the Winners (Manual) page.
 */

const crypto = require('crypto');
const QuizEntry = require('../models/QuizEntry');
const QuizWeek = require('../models/QuizWeek');
const QuizWinner = require('../models/QuizWinner');
const { QUIZ_DAYS, WINNER_COUNT, isWeekOver, weekMeta } = require('../utils/quizWeek');
const { logAudit } = require('../utils/auditLogger');
const { deviceFlagsForWinners } = require('./quizCollusionService');
const { screenPastWinners } = require('./quizPastWinnerService');

/** Per-user week stats + eligibility. Reads QuizEntry once (no N+1). */
async function computeWeekStats(weekId) {
  const rows = await QuizEntry.aggregate([
    { $match: { weekId, submittedAt: { $ne: null } } },
    { $group: { _id: '$userId', answered: { $sum: 1 }, correct: { $sum: { $cond: ['$isCorrect', 1, 0] } }, lastSubmittedAt: { $max: '$submittedAt' } } },
  ]);
  const participants = rows.map((r) => ({ userId: r._id, answered: r.answered, correct: r.correct, lastSubmittedAt: r.lastSubmittedAt }));
  const eligible = participants
    .filter((p) => p.answered >= QUIZ_DAYS)
    .sort((a, b) => (b.correct - a.correct) || (new Date(a.lastSubmittedAt) - new Date(b.lastSubmittedAt)));
  return { participants, eligible };
}

/**
 * Who goes into the random lottery: the eligible users who got all 6 right and
 * have never won before (same account, phone or device). A same-name match does
 * not keep anyone out — it comes back as a warning for the admin.
 * `screen` (userId → screening) may be passed in when the caller already has it.
 */
async function lotteryPool(weekId, eligible, screen) {
  const perfect = eligible.filter((e) => e.correct >= QUIZ_DAYS);
  const s = screen || await screenPastWinners(weekId, perfect.map((e) => e.userId));
  const pool = []; const excluded = []; const nameWarnings = [];
  for (const e of perfect) {
    const r = s.get(e.userId) || {};
    if (r.pastWin) { excluded.push({ userId: e.userId, name: r.name || '', ...r.pastWin }); continue; }
    pool.push(e);
    if (r.nameMatch) nameWarnings.push({ userId: e.userId, name: r.name || '', ...r.nameMatch });
  }
  return { perfect: perfect.length, pool, excluded, nameWarnings };
}

/** crypto-random pick of n distinct items (partial Fisher–Yates). */
function cryptoPick(arr, n) {
  const a = arr.slice();
  for (let i = 0; i < n && i < a.length; i++) {
    const j = i + crypto.randomInt(a.length - i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

/**
 * Select the week's winners. actor = req.admin. For admin_select, adminUserIds is
 * an ordered array of exactly 10 eligible userIds. displayNameByUser optionally maps
 * userId→name for the frozen snapshot.
 */
async function selectWinners({ weekId, mode, adminUserIds, actor, req, displayNameByUser = {} }) {
  if (!['random_lottery', 'admin_select'].includes(mode)) return { ok: false, error: 'Invalid mode.' };
  if (!isWeekOver(weekId)) return { ok: false, error: 'The quiz week (Mon–Sat) is not over yet.' };

  // Ensure the week doc exists.
  const m = weekMeta(weekId);
  await QuizWeek.updateOne({ weekId }, { $setOnInsert: { weekId, startDate: m.startDate, endDate: m.endDate, sundayDate: m.sundayDate, status: 'active' } }, { upsert: true });

  const { eligible } = await computeWeekStats(weekId);
  const byUser = new Map(eligible.map((e) => [e.userId, e]));

  let chosen;
  let lottery = null;
  if (mode === 'random_lottery') {
    lottery = await lotteryPool(weekId, eligible);
    if (!lottery.pool.length) {
      return { ok: false, error: lottery.perfect
        ? `All ${lottery.perfect} who scored ${QUIZ_DAYS}/${QUIZ_DAYS} have won before — no one new to draw. Use the Winners (Manual) page.`
        : `No one scored ${QUIZ_DAYS}/${QUIZ_DAYS} this week — nothing to draw. Use the Winners (Manual) page.` };
    }
    chosen = cryptoPick(lottery.pool, WINNER_COUNT); // fewer than 10 in the pool → all of them
  } else {
    const ids = Array.isArray(adminUserIds) ? adminUserIds.map(String) : [];
    if (ids.length !== WINNER_COUNT) return { ok: false, error: `Select exactly ${WINNER_COUNT} winners.` };
    if (new Set(ids).size !== ids.length) return { ok: false, error: 'Duplicate winner selected.' };
    const notEligible = ids.filter((id) => !byUser.has(id));
    if (notEligible.length) return { ok: false, error: 'One or more selected users are not eligible.' };
    chosen = ids.map((id) => byUser.get(id));
  }

  // One-time gate: flip status atomically. Only the first caller succeeds.
  const flip = await QuizWeek.updateOne({ weekId, status: { $in: ['active', 'closed'] } }, { $set: { status: 'winners_selected' } });
  if (!flip.modifiedCount) return { ok: false, error: 'Winners have already been selected for this week.' };

  const docs = chosen.map((e, i) => ({
    weekId, rank: i + 1, userId: e.userId,
    displayName: displayNameByUser[e.userId] || '',
    score: e.correct, answered: e.answered, mode,
    selectedById: (actor && (actor.id || actor._id)) || null,
    selectedByName: (actor && (actor.username || actor.name)) || '',
    selectedAt: new Date(),
  }));
  try {
    await QuizWinner.insertMany(docs, { ordered: true });
  } catch (e) {
    if (e && e.code === 11000) return { ok: false, error: 'Winners already recorded for this week.' };
    throw e;
  }

  // Fair-play flags: winners who share a physical install with another account.
  // Informational ONLY — the winner set above is unchanged; a human reviews these
  // before payout so legit family-on-one-phone cases aren't auto-penalised.
  const flagged = await deviceFlagsForWinners(weekId, chosen.map((e) => e.userId));

  // The draw's proof: who was in the pool, and who was kept out and why.
  const chosenIds = new Set(docs.map((d) => d.userId));
  const draw = lottery && {
    scoredPerfect: lottery.perfect,
    pool: lottery.pool.length,
    excluded: lottery.excluded.map((x) => ({ userId: x.userId, reason: x.reason, weekId: x.weekId })),
  };
  logAudit({ req, action: 'quiz_winners_selected', entityType: 'QuizWeek', entityId: weekId, description: `Selected ${docs.length} winners for ${weekId} via ${mode}${draw ? ` (pool ${draw.pool} of ${draw.scoredPerfect} perfect scorers, ${draw.excluded.length} past winners kept out)` : ''}`, after: { mode, winners: docs.map((d) => ({ rank: d.rank, userId: d.userId, score: d.score })), flagged, draw } });
  return {
    ok: true, mode, weekId,
    winners: docs.map((d) => ({ rank: d.rank, userId: d.userId, displayName: d.displayName, score: d.score })),
    flagged,
    ...(draw && {
      pool: draw.pool,
      excludedPastWinners: draw.excluded.length,
      short: WINNER_COUNT - docs.length,
      nameWarnings: lottery.nameWarnings.filter((w) => chosenIds.has(w.userId)),
    }),
  };
}

module.exports = { computeWeekStats, lotteryPool, cryptoPick, selectWinners };
