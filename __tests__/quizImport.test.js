'use strict';

/** Quiz Excel import — validation, duplicates, locked (skip-not-modify), idempotency. */

// buildImportPlan is pure but the controller module pulls in models/services at load.
jest.mock('../models/QuizQuestion', () => ({}));
jest.mock('../models/QuizWinner', () => ({}));
jest.mock('../models/User', () => ({}));
jest.mock('../services/quizWinnerService', () => ({ computeWeekStats: jest.fn(), selectWinners: jest.fn() }));
jest.mock('../services/quizMaintenanceService', () => ({ closeExpiredWeeks: jest.fn(), sendDailyReminder: jest.fn() }));

const { buildImportPlan } = require('../controllers/quizAdminController');

const row = (o = {}) => ({ question: 'Q?', optionA: 'a', optionB: 'b', optionC: 'c', optionD: 'd', correctOption: 'A', category: 'GK', language: 'te', isActive: 'true', ...o });

test('valid rows are planned for insert', () => {
  const plan = buildImportPlan([row({ question: 'Q1?' }), row({ question: 'Q2?', correctOption: 'C' })], new Set());
  expect(plan.imported).toBe(2);
  expect(plan.failed).toBe(0);
  expect(plan.toInsert[0]).toMatchObject({ text: 'Q1?', correctOption: 'A', isActive: true });
  expect(plan.toInsert[0].options).toHaveLength(4);
});

test('invalid rows fail with row-wise errors (missing option, bad correctOption)', () => {
  const plan = buildImportPlan([
    row({ question: 'Missing D', optionD: '' }),        // only 3 options
    row({ question: 'Bad correct', correctOption: 'E' }), // invalid key
    row({ question: '', }),                               // empty question
  ], new Set());
  expect(plan.imported).toBe(0);
  expect(plan.failed).toBe(3);
  expect(plan.results.every((r) => r.status === 'failed' && r.error)).toBe(true);
  expect(plan.results[0].row).toBe(2); // header is row 1
});

test('duplicates within file AND against existing DB are skipped, never inserted', () => {
  const existing = new Set(['already there::te']);
  const plan = buildImportPlan([
    row({ question: 'Already There' }),  // matches existing (normalized)
    row({ question: 'New One' }),
    row({ question: 'new one' }),        // intra-file dup of New One
  ], existing);
  expect(plan.imported).toBe(1);
  expect(plan.skipped).toBe(2);
  expect(plan.toInsert).toHaveLength(1);
  expect(plan.results.filter((r) => r.status === 'skipped')).toHaveLength(2);
});

test('locked/used question (exists in DB) is SKIPPED — import never modifies it', () => {
  const existing = new Set(['locked q::te']); // a question already in the bank (possibly lockedForEdit)
  const plan = buildImportPlan([row({ question: 'Locked Q', correctOption: 'B' })], existing);
  expect(plan.imported).toBe(0);
  expect(plan.skipped).toBe(1);
  expect(plan.toInsert).toHaveLength(0); // nothing to write → existing untouched
});

test('idempotent re-upload: after the questions exist, a second upload imports 0', () => {
  const rows = [row({ question: 'Alpha?' }), row({ question: 'Beta?' })];
  const first = buildImportPlan(rows, new Set());
  expect(first.imported).toBe(2);
  // simulate they were inserted → now in existing set
  const existing = new Set(first.toInsert.map((d) => d.text.toLowerCase() + '::' + d.language));
  const second = buildImportPlan(rows, existing);
  expect(second.imported).toBe(0);
  expect(second.skipped).toBe(2);
});
