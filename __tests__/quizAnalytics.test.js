'use strict';

/**
 * Phase 1 — analytics funnel + per-day participation. QuizEntry.aggregate is mocked
 * to a small in-memory dataset; we assert the funnel math and daily breakdown.
 */

const store = { entries: [], winners: [] };

// Minimal aggregate emulator covering the two pipelines the service uses.
jest.mock('../models/QuizEntry', () => ({
  aggregate: jest.fn(async (pipe) => {
    const match = (pipe[0] && pipe[0].$match) || {};
    const rows = store.entries.filter((e) => e.weekId === match.weekId);
    const groupId = pipe[1].$group._id;
    const bucket = new Map();
    for (const e of rows) {
      const key = groupId === '$userId' ? e.userId : e.dayKey;
      const b = bucket.get(key) || { _id: key, a: 0, ans: 0 };
      b.a += 1;
      if (e.submittedAt != null) b.ans += 1;
      bucket.set(key, b);
    }
    if (groupId === '$userId') return [...bucket.values()].map((b) => ({ _id: b._id, assignedDays: b.a, answeredDays: b.ans }));
    return [...bucket.values()].map((b) => ({ _id: b._id, participants: b.a, answered: b.ans }));
  }),
}));
jest.mock('../models/QuizWinner', () => ({ countDocuments: jest.fn(async (q) => store.winners.filter((w) => w.weekId === q.weekId && !w.isTest).length) }));

const { weekAnalytics } = require('../services/quizAnalyticsService');

const WEEK = '2026-08-24'; // a Monday IST week
function entry(userId, dayIndex, submitted) {
  const day = String(23 + dayIndex).padStart(2, '0'); // Mon=24..Sat=29
  return { userId, weekId: WEEK, dayKey: `2026-08-${day}`, dayIndex, submittedAt: submitted ? new Date() : null };
}

beforeEach(() => { store.entries = []; store.winners = []; });

test('funnel: assigned/opened/answered/completed/eligible/winners', async () => {
  // u1 completes all 6 (eligible); u2 answers 3; u3 assigned 2 but answers 0.
  for (let d = 1; d <= 6; d++) store.entries.push(entry('u1', d, true));
  for (let d = 1; d <= 3; d++) store.entries.push(entry('u2', d, true));
  store.entries.push(entry('u3', 1, false), entry('u3', 2, false));
  store.winners.push({ weekId: WEEK, isTest: false }, { weekId: WEEK, isTest: true }); // test winner excluded

  const r = await weekAnalytics(WEEK);
  expect(r.funnel).toEqual({ assigned: 3, opened: 3, answered: 2, completed: 1, eligible: 1, winners: 1 });
});

test('per-day participation + answered counts, all 6 days present in order', async () => {
  store.entries.push(entry('u1', 1, true), entry('u2', 1, false)); // Mon: 2 assigned, 1 answered
  store.entries.push(entry('u1', 2, true)); // Tue: 1/1
  const r = await weekAnalytics(WEEK);
  expect(r.days).toHaveLength(6);
  expect(r.days[0]).toMatchObject({ dayIndex: 1, participants: 2, answered: 1 });
  expect(r.days[1]).toMatchObject({ dayIndex: 2, participants: 1, answered: 1 });
  expect(r.days[5]).toMatchObject({ dayIndex: 6, participants: 0, answered: 0 });
});

test('empty week → all zeros, no throw', async () => {
  const r = await weekAnalytics(WEEK);
  expect(r.funnel).toEqual({ assigned: 0, opened: 0, answered: 0, completed: 0, eligible: 0, winners: 0 });
  expect(r.days.every((d) => d.participants === 0 && d.answered === 0)).toBe(true);
});
