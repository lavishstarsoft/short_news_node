'use strict';

/** P5 — closeExpiredWeeks: closes past weeks, locks used questions, idempotent. */

const store = { weeks: [], entries: [], questions: [] };

jest.mock('../models/QuizWeek', () => ({
  find: jest.fn(() => ({ lean: async () => store.weeks.filter((w) => w.status === 'active') })),
  updateOne: jest.fn(async (f, u) => { const w = store.weeks.find((x) => x.weekId === f.weekId && x.status === f.status); if (w) { w.status = u.$set.status; return { modifiedCount: 1 }; } return { modifiedCount: 0 }; }),
}));
jest.mock('../models/QuizEntry', () => ({
  distinct: jest.fn(async (field, q) => [...new Set(store.entries.filter((e) => e.weekId === q.weekId).map((e) => e.questionId))]),
}));
jest.mock('../models/QuizQuestion', () => ({
  updateMany: jest.fn(async (f, u) => { let n = 0; store.questions.forEach((q) => { if (f._id.$in.includes(q._id) && q.lockedForEdit === f.lockedForEdit) { q.lockedForEdit = u.$set.lockedForEdit; n++; } }); return { modifiedCount: n }; }),
}));

const { closeExpiredWeeks } = require('../services/quizMaintenanceService');

const REALDATE = Date;
beforeAll(() => { global.Date = class extends REALDATE { constructor(...a) { super(...(a.length ? a : ['2026-09-01T06:00:00+05:30'])); } static now() { return new REALDATE('2026-09-01T06:00:00+05:30').getTime(); } }; });
afterAll(() => { global.Date = REALDATE; });

beforeEach(() => {
  store.weeks = [
    { weekId: '2026-08-24', startDate: '2026-08-24', endDate: '2026-08-29', status: 'active' }, // past → should close
    { weekId: '2026-08-31', startDate: '2026-08-31', endDate: '2026-09-05', status: 'active' }, // current → stays
  ];
  store.entries = [{ weekId: '2026-08-24', questionId: 'q1' }, { weekId: '2026-08-24', questionId: 'q2' }];
  store.questions = [{ _id: 'q1', lockedForEdit: false }, { _id: 'q2', lockedForEdit: false }, { _id: 'q3', lockedForEdit: false }];
});

test('closes only past weeks and locks their used questions', async () => {
  const r = await closeExpiredWeeks();
  expect(r.closed).toBe(1);
  expect(r.locked).toBe(2);
  expect(store.weeks.find((w) => w.weekId === '2026-08-24').status).toBe('closed');
  expect(store.weeks.find((w) => w.weekId === '2026-08-31').status).toBe('active'); // current stays
  expect(store.questions.find((q) => q._id === 'q1').lockedForEdit).toBe(true);
  expect(store.questions.find((q) => q._id === 'q3').lockedForEdit).toBe(false); // unused → not locked
});

test('idempotent: second run closes/locks nothing new', async () => {
  await closeExpiredWeeks();
  const r2 = await closeExpiredWeeks();
  expect(r2.closed).toBe(0);
  expect(r2.locked).toBe(0);
});
