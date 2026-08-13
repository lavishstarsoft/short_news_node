'use strict';

/**
 * reporterDistrictController — unit tests (mocked models). Covers auth, canonical
 * validation, idempotent assign, duplicate prevention, remove, audit logging,
 * and that the stored value is the canonical Location NAME (not the client string).
 */

jest.mock('../models/Admin', () => ({ find: jest.fn(), findOne: jest.fn(), findById: jest.fn(), updateOne: jest.fn(() => Promise.resolve({ modifiedCount: 1 })) }));
jest.mock('../models/Location', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/ReporterApplication', () => ({ find: jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve([]) }) })) }));
jest.mock('../models/AuditLog', () => ({ create: jest.fn(() => Promise.resolve({ _id: 'audit1' })) }));

const Admin = require('../models/Admin');
const Location = require('../models/Location');
const AuditLog = require('../models/AuditLog');
const ctrl = require('../controllers/reporterDistrictController');

function mockRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = jest.fn((c) => { res.statusCode = c; return res; });
  res.json = jest.fn((b) => { res.body = b; return res; });
  res.send = jest.fn((b) => { res.body = b; return res; });
  res.render = jest.fn((v, d) => { res.body = { v, d }; return res; });
  return res;
}
const ADMIN = { role: 'superadmin', id: 'admin1', username: 'boss' };
const findByIdLean = (districts) => ({ select: () => ({ lean: () => Promise.resolve({ assignedDistricts: districts }) }) });
const canonChain = (doc) => ({ select: () => ({ lean: () => Promise.resolve(doc) }) });

beforeEach(() => jest.clearAllMocks());

describe('authorization', () => {
  test('non-admin cannot assign (403)', async () => {
    const res = mockRes();
    await ctrl.assign({ admin: { role: 'editor' }, body: { reporterId: 'r1', district: 'Mahoba' } }, res);
    expect(res.statusCode).toBe(403);
    expect(Admin.updateOne).not.toHaveBeenCalled();
  });
  test('non-admin cannot open the page (403)', async () => {
    const res = mockRes();
    ctrl.renderPage({ admin: { role: 'editor' } }, res);
    expect(res.statusCode).toBe(403);
  });
  test('non-admin cannot list districts (403)', async () => {
    const res = mockRes();
    await ctrl.districts({ admin: null, query: {} }, res);
    expect(res.statusCode).toBe(403);
  });
});

describe('assign', () => {
  test('rejects a non-canonical district (400)', async () => {
    Location.findOne.mockReturnValue(canonChain(null)); // not found in Location
    const res = mockRes();
    await ctrl.assign({ admin: ADMIN, body: { reporterId: 'r1', district: 'NotARealDistrict' } }, res);
    expect(res.statusCode).toBe(400);
    expect(Admin.updateOne).not.toHaveBeenCalled();
  });

  test('stores the canonical NAME (not the client string) + writes AuditLog with locationId', async () => {
    Location.findOne.mockReturnValue(canonChain({ name: 'Mahoba', parentName: 'Uttar Pradesh', _id: 'loc-mahoba' }));
    Admin.findOne.mockResolvedValue({ _id: 'r1', name: 'Ashok', assignedDistricts: [] });
    Admin.findById.mockReturnValue(findByIdLean(['Mahoba']));
    const res = mockRes();
    // client sends lowercase 'mahoba'
    await ctrl.assign({ admin: ADMIN, body: { reporterId: 'r1', district: 'mahoba', state: 'Uttar Pradesh' } }, res);

    expect(res.body.ok).toBe(true);
    expect(res.body.changed).toBe(true);
    expect(res.body.district).toBe('Mahoba'); // canonical casing from Location
    expect(Admin.updateOne).toHaveBeenCalledWith(
      { _id: 'r1', assignedDistricts: { $ne: 'Mahoba' } },
      { $addToSet: { assignedDistricts: 'Mahoba' } }
    );
    const audit = AuditLog.create.mock.calls[0][0];
    expect(audit.action).toBe('reporter_district_assign');
    expect(audit.before).toEqual({ assignedDistricts: [] });
    expect(audit.after.locationId).toBe('loc-mahoba');
    expect(audit.after.canonicalDistrict).toBe('Mahoba');
  });

  test('is idempotent — already-assigned makes no write', async () => {
    Location.findOne.mockReturnValue(canonChain({ name: 'Mahoba', parentName: 'Uttar Pradesh', _id: 'loc-mahoba' }));
    Admin.findOne.mockResolvedValue({ _id: 'r1', name: 'Ashok', assignedDistricts: ['Mahoba'] });
    const res = mockRes();
    await ctrl.assign({ admin: ADMIN, body: { reporterId: 'r1', district: 'Mahoba' } }, res);
    expect(res.body.changed).toBe(false);
    expect(Admin.updateOne).not.toHaveBeenCalled();
    expect(AuditLog.create).not.toHaveBeenCalled();
  });

  test('404 when the target is not an editor', async () => {
    Location.findOne.mockReturnValue(canonChain({ name: 'Mahoba', parentName: 'Uttar Pradesh', _id: 'loc-mahoba' }));
    Admin.findOne.mockResolvedValue(null);
    const res = mockRes();
    await ctrl.assign({ admin: ADMIN, body: { reporterId: 'rX', district: 'Mahoba' } }, res);
    expect(res.statusCode).toBe(404);
  });
});

describe('remove', () => {
  test('pulls an existing district and audits it', async () => {
    Admin.findOne.mockResolvedValue({ _id: 'r1', name: 'Ashok', assignedDistricts: ['Mahoba', 'Banda'] });
    Admin.findById.mockReturnValue(findByIdLean(['Banda']));
    const res = mockRes();
    await ctrl.remove({ admin: ADMIN, body: { reporterId: 'r1', district: 'mahoba' } }, res);
    expect(res.body.changed).toBe(true);
    expect(Admin.updateOne).toHaveBeenCalledWith({ _id: 'r1' }, { $pull: { assignedDistricts: 'Mahoba' } });
    expect(AuditLog.create.mock.calls[0][0].action).toBe('reporter_district_remove');
  });

  test('no-op when district not present', async () => {
    Admin.findOne.mockResolvedValue({ _id: 'r1', name: 'Ashok', assignedDistricts: ['Banda'] });
    const res = mockRes();
    await ctrl.remove({ admin: ADMIN, body: { reporterId: 'r1', district: 'Mahoba' } }, res);
    expect(res.body.changed).toBe(false);
    expect(Admin.updateOne).not.toHaveBeenCalled();
  });
});

describe('districts dropdown', () => {
  test('returns canonical Location districts for a state', async () => {
    Location.find.mockReturnValue({ select: () => ({ sort: () => ({ lean: () => Promise.resolve([{ name: 'Agra', _id: 'l1' }, { name: 'Mahoba', _id: 'l2' }]) }) }) });
    const res = mockRes();
    await ctrl.districts({ admin: ADMIN, query: { state: 'Uttar Pradesh' } }, res);
    expect(res.body.districts.map(d => d.name)).toEqual(['Agra', 'Mahoba']);
  });
});
