'use strict';

/**
 * Phase 5 — question bank list: search/filter/pagination + Used/Unused/Locked status
 * and usage counts (assigned from QuizEntry, answered from usageCount).
 */

const store = { questions: [], entries: [] };

jest.mock('../models/QuizQuestion', () => {
  const filt = (list, q) => list.filter((x) => {
    if (q.isActive !== undefined && x.isActive !== q.isActive) return false;
    if (q.lockedForEdit !== undefined && !!x.lockedForEdit !== q.lockedForEdit) return false;
    if (q.category !== undefined && x.category !== q.category) return false;
    if (q.language !== undefined && x.language !== q.language) return false;
    if (q.text instanceof RegExp && !q.text.test(x.text)) return false;
    return true;
  });
  return {
    countDocuments: jest.fn(async (q) => filt(store.questions, q || {}).length),
    find: jest.fn((q) => ({ sort: () => ({ skip: (s) => ({ limit: (l) => ({ lean: async () => filt(store.questions, q || {}).slice(s, s + l) }) }) }) })),
  };
});
jest.mock('../models/QuizEntry', () => ({
  aggregate: jest.fn(async (pipe) => {
    const ids = new Set(pipe[0].$match.questionId.$in.map(String));
    const m = new Map();
    store.entries.filter((e) => ids.has(String(e.questionId))).forEach((e) => m.set(String(e.questionId), (m.get(String(e.questionId)) || 0) + 1));
    return [...m.entries()].map(([k, v]) => ({ _id: k, assigned: v }));
  }),
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
  store.questions = [
    { _id: 'q1', text: 'Capital of India?', options: [], correctOption: 'A', language: 'te', category: 'GK', isActive: true, usageCount: 0, lockedForEdit: false },
    { _id: 'q2', text: 'Two plus two?', options: [], correctOption: 'B', language: 'en', category: 'Math', isActive: true, usageCount: 3, lockedForEdit: false },
    { _id: 'q3', text: 'Old locked one', options: [], correctOption: 'A', language: 'te', category: 'GK', isActive: false, usageCount: 5, lockedForEdit: true },
  ];
  store.entries = [{ questionId: 'q1' }, { questionId: 'q1' }]; // q1 assigned twice but never answered
});

test('status classification: unused / used(answered) / used(assigned) / locked', async () => {
  const r = res(); await ctrl.listQuestions({ query: {} }, r);
  const byId = Object.fromEntries(r.body.items.map((i) => [i._id, i]));
  expect(byId.q1).toMatchObject({ status: 'used', assignedCount: 2, used: true }); // assigned only
  expect(byId.q2).toMatchObject({ status: 'used', assignedCount: 0 }); // usageCount>0
  expect(byId.q3).toMatchObject({ status: 'locked' });
  expect(r.body.activeCount).toBe(2);
  expect(r.body.lockedCount).toBe(1);
});

test('a truly unused question is flagged unused', async () => {
  store.questions.push({ _id: 'q4', text: 'Fresh', options: [], correctOption: 'A', language: 'te', isActive: true, usageCount: 0, lockedForEdit: false });
  const r = res(); await ctrl.listQuestions({ query: {} }, r);
  expect(r.body.items.find((i) => i._id === 'q4')).toMatchObject({ status: 'unused', used: false, assignedCount: 0 });
});

test('search filters by text (regex, case-insensitive)', async () => {
  const r = res(); await ctrl.listQuestions({ query: { q: 'capital' } }, r);
  expect(r.body.total).toBe(1);
  expect(r.body.items[0]._id).toBe('q1');
});

test('filter by language + locked', async () => {
  const r1 = res(); await ctrl.listQuestions({ query: { language: 'en' } }, r1);
  expect(r1.body.items.map((i) => i._id)).toEqual(['q2']);
  const r2 = res(); await ctrl.listQuestions({ query: { locked: 'true' } }, r2);
  expect(r2.body.items.map((i) => i._id)).toEqual(['q3']);
});

test('pagination (pageSize clamped to a floor of 5)', async () => {
  for (let n = 4; n <= 8; n++) store.questions.push({ _id: 'q' + n, text: 'T' + n, options: [], correctOption: 'A', language: 'te', isActive: true, usageCount: 0, lockedForEdit: false });
  const r = res(); await ctrl.listQuestions({ query: { page: 1, pageSize: 5 } }, r);
  expect(r.body.total).toBe(8);
  expect(r.body.pages).toBe(2);
  expect(r.body.items).toHaveLength(5);
});
