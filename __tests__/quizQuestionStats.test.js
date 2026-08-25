'use strict';

/** Phase 9 — per-question answer distribution (A/B/C/D) + correct %. */

const store = { entries: [], question: null };

jest.mock('../models/QuizQuestion', () => ({
  findById: jest.fn(() => ({ lean: async () => store.question })),
}));
jest.mock('../models/QuizEntry', () => ({
  aggregate: jest.fn(async () => {
    const answered = store.entries.filter((e) => e.submittedAt != null);
    const m = new Map();
    for (const e of answered) {
      const b = m.get(e.selectedOption) || { _id: e.selectedOption, count: 0, correct: 0 };
      b.count++; if (e.isCorrect) b.correct++; m.set(e.selectedOption, b);
    }
    return [...m.values()];
  }),
  countDocuments: jest.fn(async () => store.entries.length),
}));
jest.mock('../models/QuizWinner', () => ({}));
jest.mock('../models/QuizTestOverride', () => ({}));
jest.mock('../models/User', () => ({}));
jest.mock('../utils/auditLogger', () => ({ logAudit: jest.fn() }));
jest.mock('../services/quizWinnerService', () => ({ computeWeekStats: jest.fn(), selectWinners: jest.fn() }));
jest.mock('../services/quizMaintenanceService', () => ({ closeExpiredWeeks: jest.fn(), sendDailyReminder: jest.fn() }));
jest.mock('../services/quizAnalyticsService', () => ({ weekAnalytics: jest.fn(), participantStats: jest.fn() }));

const ctrl = require('../controllers/quizAdminController');
function res() { return { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; }

beforeEach(() => {
  store.question = { _id: 'q1', text: 'Q?', correctOption: 'A', options: [{ key: 'A', text: 'a' }] };
  store.entries = [];
});

test('distribution + correct% over answered entries; assigned includes unanswered', async () => {
  // 5 answered: A×3 (correct), B×1, C×1; plus 2 unanswered assignments.
  store.entries.push(
    { selectedOption: 'A', isCorrect: true, submittedAt: new Date() },
    { selectedOption: 'A', isCorrect: true, submittedAt: new Date() },
    { selectedOption: 'A', isCorrect: true, submittedAt: new Date() },
    { selectedOption: 'B', isCorrect: false, submittedAt: new Date() },
    { selectedOption: 'C', isCorrect: false, submittedAt: new Date() },
    { selectedOption: null, isCorrect: null, submittedAt: null },
    { selectedOption: null, isCorrect: null, submittedAt: null },
  );
  const r = res(); await ctrl.questionStats({ params: { id: 'q1' } }, r);
  expect(r.body.assigned).toBe(7);
  expect(r.body.answered).toBe(5);
  expect(r.body.correct).toBe(3);
  expect(r.body.correctPct).toBe(60);
  const byOpt = Object.fromEntries(r.body.distribution.map((d) => [d.option, d]));
  expect(byOpt.A).toMatchObject({ count: 3, pct: 60, isCorrect: true });
  expect(byOpt.B).toMatchObject({ count: 1, pct: 20, isCorrect: false });
  expect(byOpt.C).toMatchObject({ count: 1, pct: 20 });
  expect(byOpt.D).toMatchObject({ count: 0, pct: 0 });
});

test('no answers → zeros, no divide-by-zero', async () => {
  const r = res(); await ctrl.questionStats({ params: { id: 'q1' } }, r);
  expect(r.body).toMatchObject({ assigned: 0, answered: 0, correct: 0, correctPct: 0 });
  expect(r.body.distribution.every((d) => d.count === 0 && d.pct === 0)).toBe(true);
});

test('unknown question → 404', async () => {
  store.question = null;
  const r = res(); await ctrl.questionStats({ params: { id: 'x' } }, r);
  expect(r.code).toBe(404);
});
