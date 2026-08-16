'use strict';

/**
 * deletePublishedVersion — Super-Admin + password (REJECTED_NEWS_DELETE_PASSWORD),
 * referenced→archive (never delete), unreferenced→delete. Password never leaked.
 */

jest.mock('../models/TncDocument', () => ({ findById: jest.fn(), findOne: jest.fn(), find: jest.fn(), create: jest.fn(), computeHash: jest.fn(), collection: { deleteOne: jest.fn(() => Promise.resolve({ deletedCount: 1 })) } }));
jest.mock('../models/AgreementAcceptance', () => ({ countDocuments: jest.fn(), findById: jest.fn(), find: jest.fn() }));
jest.mock('../models/AuditLog', () => ({ create: jest.fn(() => Promise.resolve({})) }));

const TncDocument = require('../models/TncDocument');
const AgreementAcceptance = require('../models/AgreementAcceptance');
const AuditLog = require('../models/AuditLog');
const ctrl = require('../controllers/agreementTermsController');

const VALID_ID = '6a7eb90110fbca123c922d51';
const PWD = 'super-secret-delete-pw';

function mockRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = jest.fn((c) => { res.statusCode = c; return res; });
  res.json = jest.fn((b) => { res.body = b; return res; });
  return res;
}
function makeDoc(status) { return { _id: VALID_ID, version: '1.0.0', status: status || 'published', save: jest.fn(() => Promise.resolve()) }; }
const SUPER = (extra = {}) => ({ admin: { role: 'superadmin', id: 's1', username: 'boss' }, params: { id: VALID_ID }, body: { password: PWD }, ...extra });

beforeEach(() => { jest.clearAllMocks(); process.env.REJECTED_NEWS_DELETE_PASSWORD = PWD; });

test('non-super-admin cannot delete (403)', async () => {
  const res = mockRes();
  await ctrl.deletePublishedVersion({ admin: { role: 'admin' }, params: { id: VALID_ID }, body: { password: PWD } }, res);
  expect(res.statusCode).toBe(403);
  expect(TncDocument.findById).not.toHaveBeenCalled();
});

test('500 when the delete password is not configured', async () => {
  delete process.env.REJECTED_NEWS_DELETE_PASSWORD;
  const res = mockRes();
  await ctrl.deletePublishedVersion(SUPER(), res);
  expect(res.statusCode).toBe(500);
});

test('wrong password → 401 and NO lookup/deletion', async () => {
  const res = mockRes();
  await ctrl.deletePublishedVersion(SUPER({ body: { password: 'WRONG' } }), res);
  expect(res.statusCode).toBe(401);
  expect(res.body.error).toBe('Invalid password');
  expect(TncDocument.findById).not.toHaveBeenCalled();
  expect(TncDocument.collection.deleteOne).not.toHaveBeenCalled();
});

test('correct password + REFERENCED version → ARCHIVED, never hard-deleted', async () => {
  const doc = makeDoc('published');
  TncDocument.findById.mockResolvedValue(doc);
  AgreementAcceptance.countDocuments.mockResolvedValue(2);
  const res = mockRes();
  await ctrl.deletePublishedVersion(SUPER(), res);
  expect(res.body.ok).toBe(true);
  expect(res.body.action).toBe('archived');
  expect(res.body.references).toBe(2);
  expect(doc.status).toBe('archived');
  expect(doc.save).toHaveBeenCalled();
  expect(TncDocument.collection.deleteOne).not.toHaveBeenCalled(); // referenced → never deleted
  expect(AuditLog.create).toHaveBeenCalled();
});

test('correct password + UNREFERENCED version → hard-deleted', async () => {
  const doc = makeDoc('published');
  TncDocument.findById.mockResolvedValue(doc);
  AgreementAcceptance.countDocuments.mockResolvedValue(0);
  const res = mockRes();
  await ctrl.deletePublishedVersion(SUPER(), res);
  expect(res.body.action).toBe('deleted');
  expect(TncDocument.collection.deleteOne).toHaveBeenCalledWith({ _id: doc._id });
  expect(doc.save).not.toHaveBeenCalled();
});

test('invalid version id → 400', async () => {
  const res = mockRes();
  await ctrl.deletePublishedVersion(SUPER({ params: { id: 'not-an-id' } }), res);
  expect(res.statusCode).toBe(400);
});

test('response never contains the password', async () => {
  const doc = makeDoc('published');
  TncDocument.findById.mockResolvedValue(doc);
  AgreementAcceptance.countDocuments.mockResolvedValue(1);
  const res = mockRes();
  await ctrl.deletePublishedVersion(SUPER(), res);
  expect(JSON.stringify(res.body)).not.toContain(PWD);
  const audited = JSON.stringify(AuditLog.create.mock.calls);
  expect(audited).not.toContain(PWD);
});
