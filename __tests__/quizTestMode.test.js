'use strict';

/**
 * Quiz Test Mode — admin day simulation. Verifies that an active per-user override
 * simulates Mon..Sun of the isolated 2024 test week (weekId 2024-01-01), that real
 * users are completely unaffected, that Sunday shows the winners block, that
 * "Create Test Winners" writes isolated isTest winners, and that exiting test mode
 * immediately restores real IST behaviour. All models are mocked.
 */

const store = { questions: [], entries: [], winners: [], overrides: [] };

jest.mock('../models/QuizQuestion', () => ({
  aggregate: jest.fn(async (pipe) => {
    const match = (pipe[0] && pipe[0].$match) || {};
    let pool = store.questions.filter((q) => (match.isActive === undefined || q.isActive === match.isActive));
    if (match._id && match._id.$nin) { const nin = new Set(match._id.$nin.map(String)); pool = pool.filter((q) => !nin.has(String(q._id))); }
    return pool.length ? [pool[0]] : [];
  }),
  findById: jest.fn((id) => ({ lean: async () => store.questions.find((q) => String(q._id) === String(id)) || null })),
  find: jest.fn(() => ({ lean: async () => store.questions })),
  updateOne: jest.fn(async () => ({})),
}));
jest.mock('../models/QuizEntry', () => ({
  findOne: jest.fn(async (q) => store.entries.find((e) => e.userId === q.userId && e.weekId === q.weekId && e.dayKey === q.dayKey) || null),
  find: jest.fn((q) => ({ select: () => ({ lean: async () => store.entries.filter((e) => e.userId === q.userId && e.weekId === q.weekId) }), lean: async () => store.entries.filter((e) => e.userId === q.userId && e.weekId === q.weekId) })),
  updateOne: jest.fn(async (filter, update) => {
    if (update.$setOnInsert) {
      const exists = store.entries.find((e) => e.userId === filter.userId && e.weekId === filter.weekId && e.dayKey === filter.dayKey);
      if (!exists) { store.entries.push({ _id: 'e' + (store.entries.length + 1), ...update.$setOnInsert, selectedOption: null, isCorrect: null, submittedAt: null }); return { upsertedCount: 1 }; }
    }
    return { matchedCount: 1 };
  }),
}));
jest.mock('../models/QuizWeek', () => ({ updateOne: jest.fn(async () => ({})) }));
jest.mock('../models/QuizWinner', () => ({
  find: jest.fn((q) => ({ sort: () => ({ lean: async () => store.winners.filter((w) => w.weekId === q.weekId).sort((a, b) => a.rank - b.rank) }) })),
  deleteMany: jest.fn(async (q) => { const before = store.winners.length; store.winners = store.winners.filter((w) => !(w.weekId === q.weekId && (q.isTest === undefined || w.isTest === q.isTest))); return { deletedCount: before - store.winners.length }; }),
  insertMany: jest.fn(async (docs) => { store.winners.push(...docs); return docs; }),
}));
jest.mock('../models/QuizTestOverride', () => ({
  findOne: jest.fn((q) => {
    const match = store.overrides.find((o) => o.userId === q.userId && (q.active === undefined || o.active === q.active)) || null;
    return { lean: async () => match };
  }),
  updateOne: jest.fn(async (filter, update) => {
    let o = store.overrides.find((x) => x.userId === filter.userId);
    if (!o) { o = { userId: filter.userId }; store.overrides.push(o); }
    Object.assign(o, update.$set); return { upsertedCount: 1 };
  }),
}));
jest.mock('../models/User', () => ({ find: jest.fn(() => ({ select: () => ({ lean: async () => [] }) })) }));
jest.mock('../utils/auditLogger', () => ({ logAudit: jest.fn() }));
jest.mock('../services/quizWinnerService', () => ({ computeWeekStats: jest.fn(), selectWinners: jest.fn() }));
jest.mock('../services/quizMaintenanceService', () => ({ closeExpiredWeeks: jest.fn(), sendDailyReminder: jest.fn() }));

const ctrl = require('../controllers/quizController');
const admin = require('../controllers/quizAdminController');
const { TEST_WEEK_MONDAY } = require('../utils/quizWeek');

function res() { return { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; }
const REALDATE = Date;
function mockNow(iso) { global.Date = class extends REALDATE { constructor(...a) { super(...(a.length ? a : [iso])); } static now() { return new REALDATE(iso).getTime(); } }; }
afterEach(() => { global.Date = REALDATE; });

beforeEach(() => {
  store.questions = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ _id: 'q' + n, isActive: true, options: [{ key: 'A', text: 'x' }, { key: 'B', text: 'y' }], correctOption: 'A', text: 'Q' + n }));
  store.entries = []; store.winners = []; store.overrides = [];
});

function setOverride(userId, simDayIndex, active = true) { store.overrides.push({ userId, simDayIndex, active }); }

// Real "now" is deep in production (2026); test mode must ignore it entirely.
const PROD_NOW = '2026-08-24T06:00:00+05:30'; // a real Monday

describe('simulated weekdays (Mon..Sat)', () => {
  [1, 2, 3, 4, 5, 6].forEach((day) => {
    test(`day ${day} → quiz day in the isolated 2024 test week`, async () => {
      mockNow(PROD_NOW);
      setOverride('test-user', day);
      const r = res(); await ctrl.today({ verifiedGoogleId: 'test-user', body: {} }, r);
      expect(r.body.testMode).toBe(true);
      expect(r.body.isQuizDay).toBe(true);
      expect(r.body.dayIndex).toBe(day);
      expect(r.body.weekId).toBe(TEST_WEEK_MONDAY); // 2024, never a real week
      expect(r.body.question).toBeTruthy();
    });
  });
});

test('simulated Sunday (day 7) → winners block, testMode true, "announced soon" until winners exist', async () => {
  mockNow(PROD_NOW);
  setOverride('test-user', 7);
  const r = res(); await ctrl.today({ verifiedGoogleId: 'test-user', body: {} }, r);
  expect(r.body.testMode).toBe(true);
  expect(r.body.isSunday).toBe(true);
  expect(r.body.isQuizDay).toBe(false);
  expect(r.body.weekId).toBe(TEST_WEEK_MONDAY);
  expect(r.body.winnersReady).toBe(false); // no winners yet → app shows "announced soon"
});

test('Create Test Winners → 10 isolated isTest winners, then simulated Sunday shows them', async () => {
  const ar = res(); await admin.createTestWinners({ admin: { name: 'Tester' }, body: {} }, ar);
  expect(ar.body.ok).toBe(true);
  expect(ar.body.count).toBe(10);
  expect(store.winners).toHaveLength(10);
  expect(store.winners.every((w) => w.isTest === true && w.weekId === TEST_WEEK_MONDAY)).toBe(true);

  mockNow(PROD_NOW);
  setOverride('test-user', 7);
  const r = res(); await ctrl.today({ verifiedGoogleId: 'test-user', body: {} }, r);
  expect(r.body.winnersReady).toBe(true);
  expect(r.body.winners).toHaveLength(10);
  expect(r.body.winners[0].rank).toBe(1);
});

test('real user (no override) is unaffected → real IST week, testMode false', async () => {
  mockNow(PROD_NOW); // real Monday 2026-08-24
  const r = res(); await ctrl.today({ verifiedGoogleId: 'real-user', body: {} }, r);
  expect(r.body.testMode).toBe(false);
  expect(r.body.weekId).toBe('2026-08-24'); // real production week, not the 2024 test week
  expect(r.body.dayIndex).toBe(1);
});

test('exiting test mode (active:false) immediately restores real IST behaviour', async () => {
  mockNow(PROD_NOW);
  setOverride('test-user', 6, false); // disabled override
  const r = res(); await ctrl.today({ verifiedGoogleId: 'test-user', body: {} }, r);
  expect(r.body.testMode).toBe(false);
  expect(r.body.weekId).toBe('2026-08-24'); // back to real week, ignores simDayIndex
});

test('setTestMode upserts an active override; getTestMode reflects it', async () => {
  const sr = res(); await admin.setTestMode({ admin: { name: 'Tester' }, body: { userId: 'u9', simDayIndex: 3, active: true } }, sr);
  expect(sr.body.ok).toBe(true);
  expect(sr.body.dayLabel).toBe('Wednesday');
  const gr = res(); await admin.getTestMode({ query: { userId: 'u9' } }, gr);
  expect(gr.body.active).toBe(true);
  expect(gr.body.simDayIndex).toBe(3);
});

test('createTestWinners is idempotent and clearTestWinners removes only test winners', async () => {
  await admin.createTestWinners({ admin: { name: 'T' }, body: {} }, res());
  await admin.createTestWinners({ admin: { name: 'T' }, body: {} }, res()); // re-run
  expect(store.winners).toHaveLength(10); // replaced, not duplicated
  const cr = res(); await admin.clearTestWinners({ body: {} }, cr);
  expect(cr.body.deleted).toBe(10);
  expect(store.winners).toHaveLength(0);
});
