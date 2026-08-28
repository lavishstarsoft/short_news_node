'use strict';

/** Scale: verified token + user are cached → no RSA verify / no Mongo per request. */

const mockVerify = jest.fn();
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn(() => ({ verifyIdToken: mockVerify })),
}));
const mockLean = jest.fn();
jest.mock('../models/User', () => ({ findOne: jest.fn(() => ({ lean: mockLean })) }));

const auth = require('../middleware/mobileAuth');

beforeEach(() => { jest.clearAllMocks(); });

test('token verification is cached — RSA verify runs ONCE for a repeated token', async () => {
  const exp = Math.floor(Date.now() / 1000) + 3600; // 1h left
  mockVerify.mockResolvedValue({ getPayload: () => ({ sub: 'g-123', exp }) });

  const a = await auth.verifyGoogleIdTokenCached('TOKEN_A');
  const b = await auth.verifyGoogleIdTokenCached('TOKEN_A');
  const c = await auth.verifyGoogleIdTokenCached('TOKEN_A');

  expect([a, b, c]).toEqual(['g-123', 'g-123', 'g-123']);
  expect(mockVerify).toHaveBeenCalledTimes(1); // cached after the first verify
});

test('user lookup is cached within TTL — Mongo findOne runs ONCE per googleId', async () => {
  mockLean.mockResolvedValue({ _id: 'u1', googleId: 'g-9' });

  const u1 = await auth.getUserCached('g-9');
  const u2 = await auth.getUserCached('g-9');

  expect(u1._id).toBe('u1');
  expect(u2._id).toBe('u1');
  expect(mockLean).toHaveBeenCalledTimes(1); // second call served from cache
});

test('a null user is cached too (absorbs miss storms)', async () => {
  mockLean.mockResolvedValue(null);
  const a = await auth.getUserCached('g-missing');
  const b = await auth.getUserCached('g-missing');
  expect(a).toBeNull();
  expect(b).toBeNull();
  expect(mockLean).toHaveBeenCalledTimes(1);
});

test('invalidateAuthCache forces a fresh verify + fetch', async () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  mockVerify.mockResolvedValue({ getPayload: () => ({ sub: 'g-7', exp }) });
  mockLean.mockResolvedValue({ _id: 'u7', googleId: 'g-7' });

  await auth.verifyGoogleIdTokenCached('TOK7');
  await auth.getUserCached('g-7');
  auth.invalidateAuthCache({ token: 'TOK7', googleId: 'g-7' });
  await auth.verifyGoogleIdTokenCached('TOK7');
  await auth.getUserCached('g-7');

  expect(mockVerify).toHaveBeenCalledTimes(2);
  expect(mockLean).toHaveBeenCalledTimes(2);
});
