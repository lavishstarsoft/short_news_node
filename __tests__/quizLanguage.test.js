'use strict';

/**
 * Quiz language targeting. Pure matcher (empty=all, any-match, case-insensitive,
 * missing-lang blocked when restricted) + controller gate on today/answer/week
 * (available:false / 403) with NO QuizEntry created for blocked users.
 */

const { isQuizLanguageAllowed } = require('../services/quizLanguageService');

describe('isQuizLanguageAllowed (pure)', () => {
  test('empty/undefined config → NO languages allowed (Phase 2)', () => {
    expect(isQuizLanguageAllowed('te', [])).toBe(false);
    expect(isQuizLanguageAllowed(null, [])).toBe(false);
    expect(isQuizLanguageAllowed('te', undefined)).toBe(false);
  });
  test('any-match among multiple selected languages', () => {
    expect(isQuizLanguageAllowed('en', ['te', 'en', 'hi'])).toBe(true);
    expect(isQuizLanguageAllowed('ta', ['te', 'en'])).toBe(false);
  });
  test('case-insensitive', () => {
    expect(isQuizLanguageAllowed('TE', ['te'])).toBe(true);
    expect(isQuizLanguageAllowed('te', ['TE'])).toBe(true);
  });
  test('restricted config but no language → blocked (direct API guard)', () => {
    expect(isQuizLanguageAllowed(null, ['te'])).toBe(false);
    expect(isQuizLanguageAllowed('', ['te'])).toBe(false);
  });
  test('isEnabled = false → always blocked', () => {
    expect(isQuizLanguageAllowed('te', [], false)).toBe(false);
    expect(isQuizLanguageAllowed('te', ['te'], false)).toBe(false);
  });
});

// ── Controller gate ──
const store = { questions: [], entries: [] };
jest.mock('../models/QuizQuestion', () => ({
  aggregate: jest.fn(async () => (store.questions.length ? [store.questions[0]] : [])),
  findById: jest.fn((id) => ({ lean: async () => store.questions.find((q) => String(q._id) === String(id)) || null })),
  find: jest.fn(() => ({ lean: async () => store.questions })),
  updateOne: jest.fn(async () => ({})),
}));
jest.mock('../models/QuizEntry', () => ({
  findOne: jest.fn(async (q) => store.entries.find((e) => e.userId === q.userId && e.weekId === q.weekId && e.dayKey === q.dayKey) || null),
  find: jest.fn((q) => ({ select: () => ({ lean: async () => store.entries.filter((e) => e.userId === q.userId) }), lean: async () => store.entries.filter((e) => e.userId === q.userId) })),
  updateOne: jest.fn(async (filter, update) => { if (update.$setOnInsert) store.entries.push({ ...update.$setOnInsert, submittedAt: null }); return {}; }),
}));
jest.mock('../models/QuizWeek', () => ({ updateOne: jest.fn(async () => ({})) }));
jest.mock('../models/QuizWinner', () => ({ find: jest.fn(() => ({ sort: () => ({ lean: async () => [] }) })) }));
jest.mock('../models/QuizTestOverride', () => ({ findOne: jest.fn(() => ({ lean: async () => null })) }));
// Keep the real pure matcher; stub only the settings getter per test.
jest.mock('../services/quizLanguageService', () => {
  const real = jest.requireActual('../services/quizLanguageService');
  return { ...real, getQuizConfig: jest.fn() };
});

const { getQuizConfig } = require('../services/quizLanguageService');
const setConfig = (langs, isEnabled = true) => getQuizConfig.mockResolvedValue({ langs, isEnabled });
const ctrl = require('../controllers/quizController');
function res() { return { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; }
const REALDATE = Date;
function mockNow(iso) { global.Date = class extends REALDATE { constructor(...a) { super(...(a.length ? a : [iso])); } static now() { return new REALDATE(iso).getTime(); } }; }
afterEach(() => { global.Date = REALDATE; });

beforeEach(() => {
  setConfig([]);
  store.questions = [{ _id: 'q1', isActive: true, options: [{ key: 'A', text: 'x' }, { key: 'B', text: 'y' }], correctOption: 'A', text: 'Q1' }];
  store.entries = [];
});

const REQ = (query) => ({ verifiedGoogleId: 'u1', query: query || {}, body: {} });

test('today: config empty → unavailable (no languages enabled)', async () => {
  mockNow('2026-08-24T06:00:00+05:30');
  const r = res(); await ctrl.today(REQ({}), r);
  expect(r.body.available).toBe(false);
  expect(r.body.reason).toBe('language');
});

test('today: restricted + non-matching lang → available:false and NO entry created', async () => {
  setConfig(['te']);
  mockNow('2026-08-24T06:00:00+05:30');
  const r = res(); await ctrl.today(REQ({ lang: 'en' }), r);
  expect(r.body).toEqual({ available: false, reason: 'language' });
  expect(store.entries).toHaveLength(0); // participation untouched — no assignment
});

test('today: restricted + matching lang → available', async () => {
  setConfig(['te', 'en']);
  mockNow('2026-08-24T06:00:00+05:30');
  const r = res(); await ctrl.today(REQ({ lang: 'en' }), r);
  expect(r.body.isQuizDay).toBe(true);
  expect(r.body.question).toBeTruthy();
});

test('today: isQuizEnabled = false → available:false and NO entry created', async () => {
  setConfig(['te', 'en'], false);
  mockNow('2026-08-24T06:00:00+05:30');
  const r = res(); await ctrl.today(REQ({ lang: 'te' }), r);
  expect(r.body).toEqual({ available: false, enabled: false, reason: 'disabled' });
  expect(store.entries).toHaveLength(0);
});

test('answer: non-matching lang → 403', async () => {
  setConfig(['te']);
  mockNow('2026-08-24T06:00:00+05:30');
  const r = res(); await ctrl.answer({ verifiedGoogleId: 'u1', query: { lang: 'hi' }, body: { questionId: 'q1', selectedOption: 'A' } }, r);
  expect(r.code).toBe(403);
});

test('week: non-matching lang → 403; matching → ok', async () => {
  setConfig(['te']);
  mockNow('2026-08-24T06:00:00+05:30');
  const r1 = res(); await ctrl.week(REQ({ lang: 'en' }), r1);
  expect(r1.code).toBe(403);
  const r2 = res(); await ctrl.week(REQ({ lang: 'te' }), r2);
  expect(r2.code).toBe(200);
});

test('answer/week: isQuizEnabled = false → 403', async () => {
  setConfig(['te'], false);
  mockNow('2026-08-24T06:00:00+05:30');
  const r1 = res(); await ctrl.answer({ verifiedGoogleId: 'u1', query: { lang: 'te' }, body: { questionId: 'q1', selectedOption: 'A' } }, r1);
  expect(r1.code).toBe(403);
  const r2 = res(); await ctrl.week(REQ({ lang: 'te' }), r2);
  expect(r2.code).toBe(403);
});
