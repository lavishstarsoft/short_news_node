// Central place to resolve security-critical secrets.
// In production these MUST come from the environment (server.js fails fast if
// they are missing). For local development we allow a clearly-marked fallback.

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const DEV_JWT_FALLBACK = 'dev_only_insecure_jwt_secret_change_me';

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (secret) return secret;

  if (IS_PRODUCTION) {
    // Should never reach here because server.js exits on missing JWT_SECRET,
    // but guard anyway so we never sign tokens with a known constant in prod.
    throw new Error('JWT_SECRET is not configured');
  }
  return DEV_JWT_FALLBACK;
}

module.exports = {
  getJwtSecret,
  IS_PRODUCTION,
};
