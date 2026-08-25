'use strict';

/**
 * Phase 7 — import modes. 'add' (default) inserts new + skips duplicates and never
 * touches existing. 'disable_old' soft-disables the whole active pool BEFORE
 * importing (safe weekly replacement); it never deletes.
 */

const store = { questions: [] };

jest.mock('../models/QuizQuestion', () => ({
  find: jest.fn(() => ({ select: () => ({ lean: async () => store.questions.map((q) => ({ text: q.text })) }) })),
  countDocuments: jest.fn(async (q) => store.questions.filter((x) => q.isActive === undefined || x.isActive === q.isActive).length),
  updateMany: jest.fn(async () => { let n = 0; store.questions.forEach((x) => { if (x.isActive) { x.isActive = false; n++; } }); return { modifiedCount: n }; }),
  insertMany: jest.fn(async (docs) => { docs.forEach((d) => store.questions.push({ ...d })); return docs; }),
}));
jest.mock('../models/QuizEntry', () => ({}));
jest.mock('../models/QuizWinner', () => ({}));
jest.mock('../models/QuizTestOverride', () => ({}));
jest.mock('../models/User', () => ({}));
jest.mock('../utils/auditLogger', () => ({ logAudit: jest.fn() }));
jest.mock('../services/quizWinnerService', () => ({ computeWeekStats: jest.fn(), selectWinners: jest.fn() }));
jest.mock('../services/quizMaintenanceService', () => ({ closeExpiredWeeks: jest.fn(), sendDailyReminder: jest.fn() }));
jest.mock('../services/quizAnalyticsService', () => ({ weekAnalytics: jest.fn(), participantStats: jest.fn() }));

const XLSX = require('xlsx');
const { logAudit } = require('../utils/auditLogger');
const ctrl = require('../controllers/quizAdminController');

function res() { return { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; }
function wbBuffer(rows) {
  const ws = XLSX.utils.aoa_to_sheet([['question', 'optionA', 'optionB', 'optionC', 'optionD', 'correctOption', 'category', 'language', 'isActive'], ...rows]);
  const b = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(b, ws, 'Q');
  return XLSX.write(b, { type: 'buffer', bookType: 'xlsx' });
}
const NEWROW = ['Fresh question?', 'a', 'b', 'c', 'd', 'A', 'GK', 'te', 'true'];

beforeEach(() => {
  store.questions = [
    { text: 'Old one A', isActive: true },
    { text: 'Old one B', isActive: true },
  ];
  logAudit.mockClear();
});

test('mode=add → inserts new, does NOT disable existing', async () => {
  const req = { file: { buffer: wbBuffer([NEWROW]) }, body: { mode: 'add' }, admin: {} };
  const r = res(); await ctrl.importQuestions(req, r);
  expect(r.body).toMatchObject({ imported: 1, disabledOld: 0 });
  expect(store.questions.filter((q) => q.isActive).length).toBe(3); // 2 old still active + 1 new
});

test('mode=disable_old → disables whole active pool BEFORE import, then adds new', async () => {
  const req = { file: { buffer: wbBuffer([NEWROW]) }, body: { mode: 'disable_old' }, admin: {} };
  const r = res(); await ctrl.importQuestions(req, r);
  expect(r.body).toMatchObject({ imported: 1, disabledOld: 2 });
  const active = store.questions.filter((q) => q.isActive);
  expect(active).toHaveLength(1);
  expect(active[0].text).toBe('Fresh question?'); // only the new one is active
  expect(store.questions).toHaveLength(3); // nothing deleted
  expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'quiz_questions_disable_old' }));
});

test('dryRun preview reports willDisableOld without mutating', async () => {
  const req = { file: { buffer: wbBuffer([NEWROW]) }, body: { mode: 'disable_old', dryRun: 'true' }, admin: {} };
  const r = res(); await ctrl.importQuestions(req, r);
  expect(r.body).toMatchObject({ dryRun: true, imported: 1, willDisableOld: 2 });
  expect(store.questions.every((q) => q.isActive)).toBe(true); // untouched
});
