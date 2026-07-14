const crypto = require('crypto');

// In production, use environment variables
const SECRET_KEY = 'super_secret_referral_key_2026';

const verifyHmac = (req, res, next) => {
  const timestamp = req.headers['x-timestamp'];
  const signature = req.headers['x-signature'];

  if (!timestamp || !signature) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Missing HMAC signature' });
  }

  // Prevent Replay Attacks: Reject requests older than 5 minutes
  const requestTime = parseInt(timestamp, 10);
  const currentTime = Date.now();
  if (Math.abs(currentTime - requestTime) > 5 * 60 * 1000) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Request expired (Replay Attack Prevention)' });
  }

  // Construct payload to sign
  // req.rawBody or JSON.stringify(req.body). We must ensure exact string match.
  // Express body-parser usually parses to object, so we convert back to string.
  // A better approach is to use the raw body, but for simple JSON:
  const payloadStr = JSON.stringify(req.body);
  const payload = timestamp + payloadStr;

  const hmac = crypto.createHmac('sha256', SECRET_KEY);
  hmac.update(payload);
  const expectedSignature = hmac.digest('hex');

  // Time-safe comparison
  if (signature.length !== expectedSignature.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Invalid HMAC signature' });
  }

  next();
};

module.exports = verifyHmac;
