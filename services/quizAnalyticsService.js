'use strict';

/**
 * Quiz analytics (read-only) — funnel + per-day participation for a week, plus the
 * paginated participant drill-down. All aggregation runs server-side over QuizEntry
 * (no per-user loops). IST day/week keys come from utils/quizWeek. This module never
 * exposes correctOption and never infers location.
 *
 * Funnel note: a question is ASSIGNED the moment /quiz/today is first called, so
 * "assigned" and "opened" are the same event today — we report both from the same
 * count and label them honestly in the UI.
 */

const QuizEntry = require('../models/QuizEntry');
const QuizWinner = require('../models/QuizWinner');
const { weekDayKeys, QUIZ_DAYS } = require('../utils/quizWeek');

/** Funnel + per-day counts for a week. Two aggregation passes, no N+1. */
async function weekAnalytics(weekId) {
  const perUser = await QuizEntry.aggregate([
    { $match: { weekId } },
    { $group: {
      _id: '$userId',
      assignedDays: { $sum: 1 },
      answeredDays: { $sum: { $cond: [{ $ne: ['$submittedAt', null] }, 1, 0] } },
    } },
  ]);
  const assigned = perUser.length;
  const answered = perUser.filter((u) => u.answeredDays > 0).length;
  const completed = perUser.filter((u) => u.answeredDays >= QUIZ_DAYS).length;
  const winners = await QuizWinner.countDocuments({ weekId, isTest: { $ne: true } });

  const dayAgg = await QuizEntry.aggregate([
    { $match: { weekId } },
    { $group: {
      _id: '$dayKey',
      participants: { $sum: 1 },
      answered: { $sum: { $cond: [{ $ne: ['$submittedAt', null] }, 1, 0] } },
    } },
  ]);
  const byKey = new Map(dayAgg.map((d) => [d._id, d]));
  const days = weekDayKeys(weekId).map((dk, i) => ({
    dayKey: dk, dayIndex: i + 1,
    participants: (byKey.get(dk) || {}).participants || 0,
    answered: (byKey.get(dk) || {}).answered || 0,
  }));

  // eligible == completed 6/6 (single source of truth with the winner service).
  const funnel = { assigned, opened: assigned, answered, completed, eligible: completed, winners };
  return { weekId, funnel, days };
}

/**
 * Per-user week rollup for the participant drill-down. One $group over QuizEntry.
 * Optional dayKey filters to users who participated on that specific IST day.
 * Returns stat rows only (no PII) — the controller joins User + gates PII.
 */
async function participantStats(weekId, dayKey) {
  const rows = await QuizEntry.aggregate([
    { $match: { weekId } },
    { $group: {
      _id: '$userId',
      answered: { $sum: { $cond: [{ $ne: ['$submittedAt', null] }, 1, 0] } },
      correct: { $sum: { $cond: ['$isCorrect', 1, 0] } },
      dayKeys: { $addToSet: '$dayKey' },
      firstAssignedAt: { $min: '$assignedAt' },
      lastSubmittedAt: { $max: '$submittedAt' },
    } },
  ]);
  return dayKey ? rows.filter((r) => (r.dayKeys || []).includes(dayKey)) : rows;
}

module.exports = { weekAnalytics, participantStats };
