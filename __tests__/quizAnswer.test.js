'use strict';

/**
 * P2 — daily question assignment + answer lock/idempotency + correct-answer hiding.
 * Models are mocked; we exercise the controller's server-authoritative logic.
 */

const store = { questions: [], entries: [], weeks: [] };
const oid = (s) => ({ toString: () => s, _id: s });

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
  findById: jest.fn((id) => ({ lean: async () => store.entries.find((x) => String(x._id) === String(id)) || null })),
  find: jest.fn((q) => ({ select: () => ({ lean: async () => store.entries.filter((e) => e.userId === q.userId && e.weekId === q.weekId) }), lean: async () => store.entries.filter((e) => e.userId === q.userId && e.weekId === q.weekId) })),
  updateOne: jest.fn(async (filter, update) => {
    // upsert assign
    if (update.$setOnInsert) {
      const exists = store.entries.find((e) => e.userId === filter.userId && e.weekId === filter.weekId && e.dayKey === filter.dayKey);
      if (!exists) { store.entries.push({ _id: 'e' + (store.entries.length + 1), ...update.$setOnInsert, selectedOption: null, isCorrect: null, submittedAt: null }); return { upsertedCount: 1, matchedCount: 0 }; }
      return { upsertedCount: 0, matchedCount: 1 };
    }
    // lock submit (guarded by submittedAt:null)
    const e = store.entries.find((x) => String(x._id) === String(filter._id) && x.submittedAt === null);
    if (!e) return { matchedCount: 0 };
    Object.assign(e, update.$set); return { matchedCount: 1 };
  }),
}));
jest.mock('../models/QuizWeek', () => ({ updateOne: jest.fn(async () => ({})) }));
jest.mock('../models/QuizWinner', () => ({ find: jest.fn(() => ({ sort: () => ({ lean: async () => [] }) })) }));
jest.mock('../models/QuizTestOverride', () => ({ findOne: jest.fn(() => ({ lean: async () => null })) })); // no test override in these tests
jest.mock('../services/quizLanguageService', () => ({
  isQuizLanguageAllowed: jest.fn(async () => true),
  getQuizConfig: jest.fn(async () => ({ isEnabled: true, enabledLanguages: ['te'] }))
}));

const ctrl = require('../controllers/quizController');

function res() { return { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; }
const REALDATE = Date;
function mockNow(iso) { global.Date = class extends REALDATE { constructor(...a) { super(...(a.length ? a : [iso])); } static now() { return new REALDATE(iso).getTime(); } }; }
afterEach(() => { global.Date = REALDATE; });

beforeEach(() => {
  store.questions = [
    { _id: 'q1', isActive: true, options: [{ key: 'A', text: 'x' }, { key: 'B', text: 'y' }], correctOption: 'A', text: 'Q1' },
    { _id: 'q2', isActive: true, options: [{ key: 'A', text: 'x' }, { key: 'B', text: 'y' }], correctOption: 'B', text: 'Q2' },
  ];
  store.entries = [];
});

const REQ = { verifiedGoogleId: 'user-1', body: {}, query: { lang: 'te' } };

test('today (Mon) assigns a question and NEVER exposes correctOption', async () => {
  mockNow('2026-08-24T06:00:00+05:30');
  const r = res(); await ctrl.today({ ...REQ, body: {} }, r);
  expect(r.body.isQuizDay).toBe(true);
  expect(r.body.question.id).toBeDefined();
  expect(JSON.stringify(r.body.question)).not.toContain('correctOption');
  expect(r.body.status).toBe('unanswered');
  expect(store.entries.length).toBe(1);
});

test('answer locks WITHOUT revealing correctness; idempotent on re-submit', async () => {
  mockNow('2026-08-24T06:00:00+05:30');
  await ctrl.today({ ...REQ, body: {} }, res());
  const qid = store.entries[0].questionId;
  const r1 = res(); await ctrl.answer({ ...REQ, body: { questionId: qid, selectedOption: 'A' } }, r1);
  expect(r1.body.locked).toBe(true);
  expect(r1.body.submitted).toBe(true);
  expect(r1.body.selectedOption).toBe('A');
  // Hidden-until-reveal contract: no correctness leaked on submit.
  expect(r1.body.isCorrect).toBeUndefined();
  expect(r1.body.correctOption).toBeUndefined();
  // Server still stores the truth for the weekend reveal.
  expect(store.entries[0].isCorrect).toBe(qid === 'q1'); // q1 correct is A
  // re-submit with a different option → must NOT change the frozen answer
  const r2 = res(); await ctrl.answer({ ...REQ, body: { questionId: qid, selectedOption: 'B' } }, r2);
  expect(r2.body.alreadySubmitted).toBe(true);
  expect(r2.body.correctOption).toBeUndefined();
  expect(store.entries[0].selectedOption).toBe('A'); // unchanged
});

test('answer rejects a mismatched questionId', async () => {
  mockNow('2026-08-24T06:00:00+05:30');
  await ctrl.today({ ...REQ, body: {} }, res());
  const r = res(); await ctrl.answer({ ...REQ, body: { questionId: 'nope', selectedOption: 'A' } }, r);
  expect(r.code).toBe(400);
});

test('no-repeat: second day gets a different question than day one', async () => {
  mockNow('2026-08-24T06:00:00+05:30');
  await ctrl.today({ ...REQ, body: {} }, res());
  const day1q = store.entries[0].questionId;
  mockNow('2026-08-25T06:00:00+05:30'); // Tue, same week
  await ctrl.today({ ...REQ, body: {} }, res());
  const day2 = store.entries.find((e) => e.dayKey === '2026-08-25');
  expect(day2.questionId).not.toBe(day1q);
});

test('unauthenticated (no googleId) → 401', async () => {
  mockNow('2026-08-24T06:00:00+05:30');
  const r = res(); await ctrl.today({ body: {} }, r);
  expect(r.code).toBe(401);
});

test('Sunday → not a quiz day, returns winners block', async () => {
  mockNow('2026-08-30T06:00:00+05:30');
  const r = res(); await ctrl.today({ ...REQ, body: {} }, r);
  expect(r.body.isQuizDay).toBe(false);
  expect(r.body.isSunday).toBe(true);
});

test('userRevealAt: reveals 30 min after the Saturday submission', () => {
  const { userRevealAt, REVEAL_DELAY_MS } = ctrl._internals;
  const weekId = '2026-08-24';                 // Monday
  const submittedAt = new Date('2026-08-29T10:00:00+05:30'); // Saturday 10:00 IST
  const entries = [{ dayKey: '2026-08-29', submittedAt }];
  const at = userRevealAt(entries, weekId, '23:30');
  expect(at.getTime()).toBe(submittedAt.getTime() + REVEAL_DELAY_MS); // +30 min
});

test('userRevealAt: falls back to the configured Saturday floor when Saturday not submitted', () => {
  const { userRevealAt } = ctrl._internals;
  const at = userRevealAt([{ dayKey: '2026-08-24', submittedAt: new Date() }], '2026-08-24', '20:00');
  expect(at.toISOString()).toBe(new Date('2026-08-29T20:00:00+05:30').toISOString()); // Sat 20:00 IST
});

test('today on Saturday: correctness hidden until 30 min after submit, then revealed', async () => {
  // User already submitted Saturday's answer at 10:00 IST (wrong: picked B, correct is A).
  store.entries = [{
    _id: 'e1', userId: 'user-1', weekId: '2026-08-24', dayKey: '2026-08-29',
    dayIndex: 6, questionId: 'q1', selectedOption: 'B', isCorrect: false,
    submittedAt: new Date('2026-08-29T10:00:00+05:30'),
  }];
  // 10:20 IST → 30 min not elapsed → still hidden
  mockNow('2026-08-29T10:20:00+05:30');
  let r = res(); await ctrl.today({ ...REQ, body: {} }, r);
  expect(r.body.revealed).toBe(false);
  expect(r.body.answer.selectedOption).toBe('B');
  expect(r.body.answer.correctOption).toBeUndefined();
  expect(r.body.answer.isCorrect).toBeUndefined();
  // 10:31 IST → past reveal → correctness exposed
  mockNow('2026-08-29T10:31:00+05:30');
  r = res(); await ctrl.today({ ...REQ, body: {} }, r);
  expect(r.body.revealed).toBe(true);
  expect(r.body.answer.correctOption).toBe('A');
  expect(r.body.answer.isCorrect).toBe(false);
});

test('progress bar stays neutral ("submitted") before reveal, never correct/wrong', async () => {
  store.entries = [{
    _id: 'e1', userId: 'user-1', weekId: '2026-08-24', dayKey: '2026-08-25',
    dayIndex: 2, questionId: 'q1', selectedOption: 'A', isCorrect: true,
    submittedAt: new Date('2026-08-25T09:00:00+05:30'),
  }];
  mockNow('2026-08-26T06:00:00+05:30'); // Wednesday, well before Saturday reveal
  const r = res(); await ctrl.today({ ...REQ, body: {} }, r);
  const tue = r.body.weekProgress.find((d) => d.dayKey === '2026-08-25');
  expect(tue.state).toBe('submitted');
  expect(r.body.weekProgress.some((d) => d.state === 'correct' || d.state === 'wrong')).toBe(false);
});
