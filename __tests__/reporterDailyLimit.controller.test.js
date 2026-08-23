'use strict';

/**
 * P2 — createNews gate integration (early-return paths only).
 * Verifies the tiered daily cap blocks the 11th submission, returns the exact
 * message + resolved State In-Charge contact, consumes no wallet/history, and
 * that idempotency replays run BEFORE the gate (never consume a slot).
 *
 * Load-time connectors (Redis / OneSignal) are mocked so the controller can be
 * required without opening live handles.
 */

jest.mock('../config/redis', () => ({ redisClient: {}, isRedisAvailable: () => false }));
jest.mock('../services/oneSignalService', () => ({}));
jest.mock('../middleware/cache', () => ({ clearCache: jest.fn() }));
// P4 override service — no active override in P2 tests (extra=0 → P2 behaviour unchanged).
jest.mock('../utils/accessOverrideService', () => ({ getActiveExtraAllowed: jest.fn().mockResolvedValue(0) }));

// News: constructor (should NEVER run on blocked/replay paths) + statics.
// Names are prefixed `mock` so Jest allows them inside the hoisted mock factory.
const mockNewsSaveSpy = jest.fn();
const mockNewsCtor = jest.fn(function () { this.save = mockNewsSaveSpy; });
mockNewsCtor.findOne = jest.fn();
mockNewsCtor.countDocuments = jest.fn();
jest.mock('../models/News', () => mockNewsCtor);

const mockAdminFindById = jest.fn();
jest.mock('../models/Admin', () => ({ findById: mockAdminFindById }));

const News = require('../models/News');
const Admin = require('../models/Admin');
const newsSaveSpy = mockNewsSaveSpy;
const newsCtor = mockNewsCtor;
const adminFindById = mockAdminFindById;
const controller = require('../controllers/newsController');

const selectStub = (doc) => ({ select: () => Promise.resolve(doc) });

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

beforeEach(() => {
  newsSaveSpy.mockReset();
  newsCtor.mockClear();
  News.findOne.mockReset();
  News.countDocuments.mockReset();
  adminFindById.mockReset();
});

describe('createNews — tiered daily cap gate', () => {
  test('stringer at 10 today → 11th blocked with 429, exact message + contact, no News saved', async () => {
    adminFindById.mockImplementation((id) =>
      String(id) === 'rep1'
        ? selectStub({ _id: 'rep1', role: 'editor', reporterTier: 'stringer', assignedDistricts: ['Banda'] })
        : { find: () => ({ select: () => ({ lean: () => Promise.resolve([
            { _id: 's1', name: 'Banda SIC', mobileNumber: '99999', displayRole: 'State In-Charge', permissions: { managedDistricts: ['Banda'] } },
          ]) }) }) }
    );
    // resolver uses Admin.find (not findById) — provide it too.
    Admin.find = () => ({ select: () => ({ lean: () => Promise.resolve([
      { _id: 's1', name: 'Banda SIC', mobileNumber: '99999', displayRole: 'State In-Charge', permissions: { managedDistricts: ['Banda'] } },
    ]) }) });

    News.findOne.mockResolvedValue(null);        // no idempotency hit
    News.countDocuments.mockResolvedValue(10);    // already 10 today

    const req = { admin: { id: 'rep1', role: 'editor' }, body: { title: 't', content: 'c' }, get: () => '' };
    const res = makeRes();
    await controller.createNews(req, res);

    expect(res.statusCode).toBe(429);
    expect(res.body.error).toBe('You have reached the daily limit of 10 news. Please contact your State In-Charge.');
    expect(res.body.limitReached).toBe(true);
    expect(res.body.dailyLimit).toBe(10);
    expect(res.body.stateInCharge).toEqual({ name: 'Banda SIC', mobileNumber: '99999' });
    // No wallet/history side effects: News was never constructed or saved.
    expect(newsCtor).not.toHaveBeenCalled();
    expect(newsSaveSpy).not.toHaveBeenCalled();
  });

  test('idempotency replay returns existing news BEFORE the gate → no slot consumed', async () => {
    adminFindById.mockReturnValue(selectStub({ _id: 'rep1', role: 'editor', reporterTier: 'stringer' }));
    const existing = { _id: 'existing1', title: 'dup' };
    News.findOne.mockResolvedValue(existing);     // idempotency key matches

    const req = {
      admin: { id: 'rep1', role: 'editor' },
      body: { title: 't', content: 'c', clientIdempotencyKey: 'key-123' },
      get: (h) => (h === 'Idempotency-Key' ? 'key-123' : ''),
    };
    const res = makeRes();
    await controller.createNews(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(existing);
    // Gate never ran → the daily count query was not even executed.
    expect(News.countDocuments).not.toHaveBeenCalled();
    expect(newsCtor).not.toHaveBeenCalled();
  });
});
