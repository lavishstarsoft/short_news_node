const {
  assertSocketUserId,
  resolveRegisterUserId,
} = require('../middleware/socketAuth');

describe('socketAuth', () => {
  const originalRequireMobileAuth = process.env.REQUIRE_MOBILE_AUTH;

  afterEach(() => {
    process.env.REQUIRE_MOBILE_AUTH = originalRequireMobileAuth;
    jest.resetModules();
  });

  test('resolveRegisterUserId uses verified identity over client id', () => {
    process.env.REQUIRE_MOBILE_AUTH = 'true';
    jest.resetModules();
    const { resolveRegisterUserId: resolve } = require('../middleware/socketAuth');

    const socket = { verifiedUserId: 'google-123' };
    expect(resolve(socket, 'google-123')).toEqual({ ok: true, userId: 'google-123' });
    expect(resolve(socket, 'fake-user')).toEqual({
      ok: false,
      error: 'Registered userId does not match authenticated identity',
    });
  });

  test('resolveRegisterUserId blocks real user ids without auth when required', () => {
    process.env.REQUIRE_MOBILE_AUTH = 'true';
    jest.resetModules();
    const { resolveRegisterUserId: resolve } = require('../middleware/socketAuth');

    const socket = { verifiedUserId: null };
    expect(resolve(socket, 'fake-user')).toEqual({
      ok: false,
      error: 'Authentication required to register userId',
    });
    expect(resolve(socket, 'anonymous_user')).toEqual({
      ok: true,
      userId: 'anonymous_user',
    });
  });

  test('assertSocketUserId rejects impersonation when token verified', () => {
    process.env.REQUIRE_MOBILE_AUTH = 'true';
    jest.resetModules();
    const { assertSocketUserId: assertUser } = require('../middleware/socketAuth');

    const socket = { verifiedUserId: 'google-123' };
    expect(assertUser(socket, 'google-123')).toBe(true);
    expect(assertUser(socket, 'other-user')).toBe(false);
  });
});
