// Mock external deps so the middleware can be tested without a DB or network.
const mockVerifyIdToken = jest.fn();
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({
    verifyIdToken: mockVerifyIdToken,
  })),
}));
jest.mock('../models/User', () => ({
  findOne: jest.fn().mockResolvedValue(null),
}));

function buildRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

describe('verifyMobileUser middleware', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    mockVerifyIdToken.mockReset();
    jest.resetModules();
  });

  test('legacy mode: allows request without a token', async () => {
    process.env.REQUIRE_MOBILE_AUTH = 'false';
    const { verifyMobileUser } = require('../middleware/mobileAuth');
    const req = { headers: {}, body: { userId: 'client-supplied' } };
    const res = buildRes();
    const next = jest.fn();

    await verifyMobileUser(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBeNull();
  });

  test('strict mode: rejects request without a token', async () => {
    process.env.REQUIRE_MOBILE_AUTH = 'true';
    const { verifyMobileUser } = require('../middleware/mobileAuth');
    const req = { headers: {}, body: {} };
    const res = buildRes();
    const next = jest.fn();

    await verifyMobileUser(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  test('valid token overrides client-supplied userId with verified id', async () => {
    process.env.REQUIRE_MOBILE_AUTH = 'true';
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({ sub: 'verified-google-id' }),
    });
    const { verifyMobileUser } = require('../middleware/mobileAuth');
    const req = {
      headers: { authorization: 'Bearer good.token.here' },
      body: { userId: 'attacker-supplied-id' },
    };
    const res = buildRes();
    const next = jest.fn();

    await verifyMobileUser(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.verifiedGoogleId).toBe('verified-google-id');
    expect(req.body.userId).toBe('verified-google-id');
  });

  test('strict mode: rejects an invalid token', async () => {
    process.env.REQUIRE_MOBILE_AUTH = 'true';
    mockVerifyIdToken.mockRejectedValue(new Error('bad token'));
    const { verifyMobileUser } = require('../middleware/mobileAuth');
    const req = {
      headers: { authorization: 'Bearer bad.token' },
      body: {},
    };
    const res = buildRes();
    const next = jest.fn();

    await verifyMobileUser(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});
