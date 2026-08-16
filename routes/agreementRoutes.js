'use strict';

/**
 * agreementRoutes — PUBLIC Common Agreement Link flow (mounted at /state-agreement).
 * No admin auth; identity is established via registered-email + OTP only. OTP
 * endpoints are rate-limited. Nothing here can reach admin routes/APIs.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const c = require('../controllers/agreementController');
const { requireAgreementSession } = require('../services/agreement/session');

// Dedicated limiter for OTP endpoints (per-IP; the service also does per-email/IP checks).
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AGREEMENT_OTP_ROUTE_MAX) || 40,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false }
});

router.get('/', c.renderStart);
router.post('/request-otp', otpLimiter, c.requestOtp);
router.post('/verify-otp', otpLimiter, c.verifyOtp);
router.get('/terms', requireAgreementSession, c.getTerms);
router.post('/accept', requireAgreementSession, c.accept);
router.get('/my-acceptance', requireAgreementSession, c.getMyAcceptance);

module.exports = router;
