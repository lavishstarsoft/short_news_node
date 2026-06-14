describe('config/secrets getJwtSecret', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.resetModules();
  });

  test('returns the configured JWT_SECRET when present', () => {
    process.env.JWT_SECRET = 'super-secret-value';
    process.env.NODE_ENV = 'production';
    const { getJwtSecret } = require('../config/secrets');
    expect(getJwtSecret()).toBe('super-secret-value');
  });

  test('falls back to a dev secret when not in production', () => {
    delete process.env.JWT_SECRET;
    process.env.NODE_ENV = 'development';
    const { getJwtSecret } = require('../config/secrets');
    expect(getJwtSecret()).toEqual(expect.any(String));
    expect(getJwtSecret().length).toBeGreaterThan(0);
  });

  test('throws in production when JWT_SECRET is missing', () => {
    delete process.env.JWT_SECRET;
    process.env.NODE_ENV = 'production';
    const { getJwtSecret } = require('../config/secrets');
    expect(() => getJwtSecret()).toThrow();
  });
});
