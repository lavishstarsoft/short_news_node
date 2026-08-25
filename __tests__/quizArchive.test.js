'use strict';

/**
 * Phase 6 — safe Archive/Restore (never hard-delete). Archiving removes a question
 * from the active pool (isActive=false), preserves the doc, and is idempotent.
 */

const store = { questions: [] };

jest.mock('../models/QuizQuestion', () => ({
  findById: jest.fn(async (id) => {
    const doc = store.questions.find((q) => String(q._id) === String(id));
    if (!doc) return null;
    return { ...doc, save: async function () { Object.assign(doc, { archived: this.archived, isActive: this.isActive }); }, deleteOne: async function () { store.questions.splice(store.questions.indexOf(doc), 1); } };
  }),
}));
jest.mock('../models/QuizEntry', () => ({
  exists: jest.fn(async (q) => store.entries.some((e) => String(e.questionId) === String(q.questionId))),
}));
jest.mock('../models/QuizWinner', () => ({}));
jest.mock('../models/QuizTestOverride', () => ({}));
jest.mock('../models/User', () => ({}));
jest.mock('../utils/auditLogger', () => ({ logAudit: jest.fn() }));
jest.mock('../services/quizWinnerService', () => ({ computeWeekStats: jest.fn(), selectWinners: jest.fn() }));
jest.mock('../services/quizMaintenanceService', () => ({ closeExpiredWeeks: jest.fn(), sendDailyReminder: jest.fn() }));
jest.mock('../services/quizAnalyticsService', () => ({ weekAnalytics: jest.fn(), participantStats: jest.fn() }));

const { logAudit } = require('../utils/auditLogger');
const ctrl = require('../controllers/quizAdminController');
function res() { return { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; }

beforeEach(() => {
  store.questions = [{ _id: 'q1', text: 'Used one', archived: false, isActive: true, usageCount: 4, lockedForEdit: true }, { _id: 'q2', text: 'Unused one', archived: false, isActive: true, usageCount: 0, lockedForEdit: false }, { _id: 'q3', text: 'Assigned one', archived: false, isActive: true, usageCount: 0, lockedForEdit: false }];
  store.entries = [{ questionId: 'q3' }];
  logAudit.mockClear();
});

test('archive a used/locked question → soft, leaves pool, never deleted, audited', async () => {
  const r = res(); await ctrl.archiveQuestion({ params: { id: 'q1' }, body: { archived: true }, admin: { role: 'admin' } }, r);
  expect(r.body).toMatchObject({ success: true, archived: true, isActive: false });
  expect(store.questions).toHaveLength(3); // doc still exists
  expect(store.questions[0]).toMatchObject({ archived: true, isActive: false });
  expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'quiz_question_archive' }));
});

test('archive is idempotent (re-archiving stays archived, still success)', async () => {
  await ctrl.archiveQuestion({ params: { id: 'q1' }, body: { archived: true }, admin: {} }, res());
  const r = res(); await ctrl.archiveQuestion({ params: { id: 'q1' }, body: { archived: true }, admin: {} }, r);
  expect(r.body).toMatchObject({ success: true, archived: true });
  expect(store.questions[0].archived).toBe(true);
});

test('restore (archived:false) → archived cleared, audited as restore', async () => {
  store.questions[0].archived = true; store.questions[0].isActive = false;
  const r = res(); await ctrl.archiveQuestion({ params: { id: 'q1' }, body: { archived: false }, admin: {} }, r);
  expect(r.body).toMatchObject({ success: true, archived: false });
  expect(store.questions[0].archived).toBe(false);
  expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'quiz_question_restore' }));
});

test('unknown id → 404', async () => {
  const r = res(); await ctrl.archiveQuestion({ params: { id: 'nope' }, body: {}, admin: {} }, r);
  expect(r.code).toBe(404);
});

test('deleteQuestion: unused question → hard delete', async () => {
  const r = res(); await ctrl.deleteQuestion({ params: { id: 'q2' }, admin: {} }, r);
  expect(r.body).toMatchObject({ success: true });
  expect(store.questions.some((q) => q._id === 'q2')).toBe(false); // doc deleted
  expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'quiz_question_delete' }));
});

test('deleteQuestion: used/locked question → 409 rejection', async () => {
  const r = res(); await ctrl.deleteQuestion({ params: { id: 'q1' }, admin: {} }, r);
  expect(r.code).toBe(409);
  expect(r.body).toMatchObject({ error: expect.stringContaining('is locked') });
  expect(store.questions.some((q) => q._id === 'q1')).toBe(true); // not deleted
});

test('deleteQuestion: assigned (but unanswered) question → 409 rejection', async () => {
  const r = res(); await ctrl.deleteQuestion({ params: { id: 'q3' }, admin: {} }, r);
  expect(r.code).toBe(409);
  expect(r.body).toMatchObject({ error: expect.stringContaining('already been assigned') });
  expect(store.questions.some((q) => q._id === 'q3')).toBe(true); // not deleted
});
