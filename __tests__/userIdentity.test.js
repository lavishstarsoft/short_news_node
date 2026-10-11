'use strict';

const { resolveUserFilter, classifyUserId } = require('../utils/userIdentity');

const OID = '65a0f3b2c1d2e3f4a5b6c7d8';
const GOOGLE = '115806710826496439329'; // the exact value from the production BSONError

describe('classifyUserId', () => {
  test('24-hex → Mongo _id', () => {
    expect(classifyUserId(OID)).toEqual({ _id: OID });
    expect(classifyUserId(OID.toUpperCase())).toEqual({ _id: OID.toUpperCase() });
  });

  test('21-digit Google id → googleId (this used to be cast to ObjectId and crash)', () => {
    expect(classifyUserId(GOOGLE)).toEqual({ googleId: GOOGLE });
    expect(classifyUserId(Number('1234567890123'))).toEqual({ googleId: '1234567890123' }); // numeric input tolerated
  });

  test('junk → invalid; empty → null', () => {
    expect(classifyUserId('anonymous')).toEqual({ invalid: 'anonymous' });
    expect(classifyUserId('client-supplied')).toEqual({ invalid: 'client-supplied' });
    expect(classifyUserId('')).toBeNull();
    expect(classifyUserId(null)).toBeNull();
    expect(classifyUserId(undefined)).toBeNull();
  });
});

describe('resolveUserFilter — priority mirrors verifyMobileUser', () => {
  test('1) cached authUser wins → filter by its _id', () => {
    expect(resolveUserFilter({ authUser: { _id: OID }, verifiedGoogleId: GOOGLE, bodyUserId: 'junk' })).toEqual({ _id: OID });
  });

  test('2) authUser missing (new user / cache miss) but token verified → filter by googleId', () => {
    expect(resolveUserFilter({ authUser: null, verifiedGoogleId: GOOGLE, bodyUserId: GOOGLE })).toEqual({ googleId: GOOGLE });
  });

  test('3) legacy no-token mode: client body id classified safely', () => {
    expect(resolveUserFilter({ bodyUserId: OID })).toEqual({ _id: OID });
    expect(resolveUserFilter({ bodyUserId: GOOGLE })).toEqual({ googleId: GOOGLE });
    expect(resolveUserFilter({ bodyUserId: 'anonymous' })).toEqual({ invalid: 'anonymous' });
  });

  test('nothing usable → null (route answers 401 as before)', () => {
    expect(resolveUserFilter({})).toBeNull();
    expect(resolveUserFilter({ authUser: {}, bodyUserId: '' })).toBeNull();
  });

  test('the production failure case never yields an _id filter', () => {
    // token verified, cached user null, body overwritten with the Google id
    const f = resolveUserFilter({ authUser: null, verifiedGoogleId: GOOGLE, bodyUserId: GOOGLE });
    expect(f._id).toBeUndefined();
    expect(f.googleId).toBe(GOOGLE);
  });
});
