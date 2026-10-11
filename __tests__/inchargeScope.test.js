'use strict';

/**
 * The REAL scoped query, with editorCoverageHelper left un-mocked.
 *
 * inchargeApp.test.js mocks that helper so it can assert the controller calls
 * it. That mock returns a flat object — but the real helper returns
 * `{ $and: [base, clause] }`, and the detail endpoint adds `_id` on top of
 * whatever it gets. If that combination were wrong, every tap on a news item
 * would answer "this news is no longer in your queue" while the list above it
 * showed the item perfectly. This suite exists to make that failure impossible
 * to ship unnoticed.
 */

jest.mock('../models/Admin', () => ({ findById: jest.fn(), find: jest.fn() }));
jest.mock('../models/News', () => ({ find: jest.fn(), findOne: jest.fn(), countDocuments: jest.fn(async () => 0) }));
jest.mock('../models/StaffPresence', () => {
  const StaffPresence = { findOne: jest.fn(), updateOne: jest.fn(async () => ({})), find: jest.fn() };
  StaffPresence.StaffPresence = StaffPresence;
  StaffPresence.StaffPresenceLog = { create: jest.fn(async () => ({})), find: jest.fn() };
  return StaffPresence;
});

const Admin = require('../models/Admin');
const News = require('../models/News');
const ctrl = require('../controllers/inchargeAppController');

const ID = '507f1f77bcf86cd799439011';
const REPORTER = '507f1f77bcf86cd799439099';

function mockRes() {
  const res = { code: 200, body: null };
  res.status = (c) => { res.code = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

/** A Bureau who covers one district and works in Telugu — Raju's shape. */
const bureau = {
  _id: 'i1',
  role: 'subeditor',
  displayRole: 'Bureau',
  isActive: true,
  workingLanguage: 'te',
  permissions: {
    canApproveNews: true,
    approvalScope: 'geography',
    managedDistricts: ['Karimnagar'],
    managedStates: [],
    managedConstituencies: [],
    managedLocations: [],
    managedReporterIds: [],
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  Admin.findById.mockReturnValue({ select: () => ({ lean: async () => bureau }) });
  // One reporter in that district, so the coverage filter finds somebody.
  Admin.find.mockReturnValue({
    select: () => ({ lean: async () => [{ _id: REPORTER, assignedDistricts: ['Karimnagar'] }] }),
  });
});

describe('the query a tap on one news item really builds', () => {
  test('it keeps the team scope AND pins the id — a valid Mongo shape', async () => {
    News.findOne.mockReturnValue({ select: () => ({ lean: async () => null }) });
    await ctrl.newsDetail({ admin: { id: 'i1' }, params: { id: ID } }, mockRes());

    const q = News.findOne.mock.calls[0][0];
    expect(q._id).toBe(ID);

    // The real helper wraps the base query, so the scope survives as $and.
    expect(Array.isArray(q.$and)).toBe(true);
    const base = q.$and[0];
    expect(base.isActive).toBe(false);
    expect(base.authorId).toEqual({ $ne: 'i1' });
    expect(base.aiStatus).toEqual({ $in: ['none'] });

    // ...and the reporter/geography clause is still there beside it.
    const scoped = JSON.stringify(q.$and.slice(1));
    expect(scoped).toContain(REPORTER);

    // _id must sit at the top level, not be buried where it cannot match.
    expect(Object.keys(q)).toContain('_id');
  });

  test('the list is filtered to their working language — the dashboard default', async () => {
    // The bug: without this a Telangana Bureau saw Hindi, Punjabi and Tamil
    // news their own web page never showed them.
    News.find.mockReturnValue({
      select: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }),
    });
    await ctrl.pending({ admin: { id: 'i1' }, query: {} }, mockRes());

    const q = JSON.stringify(News.find.mock.calls[0][0]);
    expect(q).toContain('"language":"te"');
  });

  test('asking for "all" drops the language filter, as the web dropdown does', async () => {
    News.find.mockReturnValue({
      select: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }),
    });
    await ctrl.pending({ admin: { id: 'i1' }, query: { language: 'all' } }, mockRes());
    expect(JSON.stringify(News.find.mock.calls[0][0])).not.toContain('"language"');
  });

  test('anything the list shows still opens — same scope, language aside', async () => {
    // Language is a VIEW filter, not a permission, so a tap is not filtered by
    // it. Everything that decides WHAT THEY MAY SEE must still be identical.
    News.find.mockReturnValue({
      select: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }),
    });
    await ctrl.pending({ admin: { id: 'i1' }, query: { language: 'all' } }, mockRes());
    const listQuery = News.find.mock.calls[0][0];

    News.findOne.mockReturnValue({ select: () => ({ lean: async () => null }) });
    await ctrl.newsDetail({ admin: { id: 'i1' }, params: { id: ID } }, mockRes());
    const tapQuery = News.findOne.mock.calls[0][0];

    const { _id, ...withoutId } = tapQuery;
    expect(_id).toBe(ID);
    expect(withoutId).toEqual(listQuery);
  });

  test('the ALARM counts exactly what the list shows, language and all', async () => {
    // A phone that rings for news its owner cannot see is the worst version of
    // this bug: they are reported as late for something invisible to them.
    News.find.mockReturnValue({
      select: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }),
    });
    News.countDocuments.mockResolvedValue(0);
    require('../models/StaffPresence').findOne.mockReturnValue({ select: () => ({ lean: async () => null }) });

    await ctrl.pending({ admin: { id: 'i1' }, query: {} }, mockRes());
    const listQuery = News.find.mock.calls[0][0];

    News.find.mockClear();
    await ctrl.heartbeat({ admin: { id: 'i1' }, body: {}, headers: {} }, mockRes());
    const alarmQuery = News.find.mock.calls[0][0];

    expect(alarmQuery).toEqual(listQuery);
  });

  test('the duplicate comparison is scoped identically', async () => {
    News.findOne.mockReturnValue({ select: () => ({ lean: async () => null }) });
    await ctrl.newsDuplicates({ admin: { id: 'i1' }, params: { id: ID } }, mockRes());

    const q = News.findOne.mock.calls[0][0];
    expect(q._id).toBe(ID);
    expect(Array.isArray(q.$and)).toBe(true);
    expect(q.$and[0].isActive).toBe(false);
  });

  test('an admin gets the wider queue, and a tap still works for them', async () => {
    Admin.findById.mockReturnValue({
      select: () => ({ lean: async () => ({ _id: 'ad', role: 'admin', isActive: true }) }),
    });
    News.findOne.mockReturnValue({ select: () => ({ lean: async () => null }) });
    await ctrl.newsDetail({ admin: { id: 'ad' }, params: { id: ID } }, mockRes());

    const q = News.findOne.mock.calls[0][0];
    expect(q._id).toBe(ID);
    // No $and for a privileged user — the base query is returned untouched, so
    // spreading _id on top must not have destroyed its own $or.
    expect(q.aiStatus).toEqual({ $in: ['none', 'processing', 'review_required', 'failed'] });
    expect(Array.isArray(q.$or)).toBe(true);
  });

  test('a sub-editor who manages nobody sees nothing, and is told so', async () => {
    Admin.findById.mockReturnValue({
      select: () => ({
        lean: async () => ({
          ...bureau,
          permissions: { ...bureau.permissions, managedDistricts: [] },
        }),
      }),
    });
    News.findOne.mockReturnValue({ select: () => ({ lean: async () => null }) });
    const res = mockRes();
    await ctrl.newsDetail({ admin: { id: 'i1' }, params: { id: ID } }, res);

    const q = News.findOne.mock.calls[0][0];
    expect(q.authorId).toBe('__no_managed_reporters__');
    expect(res.code).toBe(404);
  });
});
