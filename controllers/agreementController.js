'use strict';

/**
 * agreementController — public Common Agreement Link flow.
 *   GET  /state-agreement                 → page (email → OTP → T&C → accept)
 *   POST /state-agreement/request-otp      → { email } → generic response, OTP to registered email only
 *   POST /state-agreement/verify-otp       → { email, otp } → scoped agreement session
 *   GET  /state-agreement/terms            → current published T&C (session required)
 *   POST /state-agreement/accept           → immutable AgreementAcceptance (session required)
 *
 * Identity is ALWAYS taken from the server-side Admin record — never from client input.
 */

const requestIp = require('request-ip');
const Admin = require('../models/Admin');
const TncDocument = require('../models/TncDocument');
const AgreementAcceptance = require('../models/AgreementAcceptance');
const otpService = require('../services/agreement/otpService');
const emailService = require('../services/agreement/emailService');
const agreementSession = require('../services/agreement/session');
const { isRedisAvailable } = require('../config/redis');

const WORKER_ID = `${process.env.NODE_APP_INSTANCE ?? process.env.pm_id ?? ''}:${process.pid}`;
const GENERIC = { message: 'If this is a registered State In-Charge email, a verification code has been sent.' };

const clientIp = (req) => requestIp.getClientIp(req) || req.ip || '';
const maskEmail = (e) => {
  const [u, d] = String(e || '').split('@');
  if (!d) return '***';
  return `${u.slice(0, 1)}***@${d}`;
};
// State In-Charge = role subeditor + active. (We never expose which check failed.)
async function findInCharge(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || e.length > 200) return null;
  const a = await Admin.findOne({ email: e, role: 'subeditor', isActive: { $ne: false } })
    .select('_id name email displayRole assignedState assignedStates isActive agreementStatus');
  return a || null;
}

exports.renderStart = (req, res) => {
  res.render('state-agreement', { });
};

// POST /request-otp — ALWAYS returns the same generic response (no enumeration).
exports.requestOtp = async (req, res) => {
  try {
    // OTP storage/rate-limiting requires Redis. If it is down, the code can never be
    // generated or emailed — say so plainly. This check runs BEFORE the email lookup,
    // so the response is identical for registered and unregistered addresses (no
    // enumeration leak) while no longer masking an outage as "code sent".
    if (!isRedisAvailable()) {
      return res.status(503).json({ error: 'Verification service is temporarily unavailable. Please try again in a few minutes.' });
    }
    const ic = await findInCharge(req.body && req.body.email);
    if (ic) {
      const r = await otpService.requestOtp({ adminId: ic._id, ip: clientIp(req) });
      if (r.status === 'sent' && emailService.isConfigured()) {
        // Fire-and-forget send; failure must not reveal existence.
        emailService.sendOtpEmail(ic.email, r.otp, { name: ic.name || 'State In-Charge' }).catch(() => {});
        if (ic.agreementStatus == null) { Admin.updateOne({ _id: ic._id }, { $set: { agreementStatus: 'invited' } }).catch(() => {}); }
      }
      // cooldown / rate_limited also return generic (do not leak state).
    }
    return res.json(GENERIC);
  } catch (_) {
    return res.json(GENERIC); // fail-closed to generic
  }
};

// POST /verify-otp — on success, issue scoped session + return masked identity.
exports.verifyOtp = async (req, res) => {
  try {
    const email = req.body && req.body.email;
    const otp = req.body && req.body.otp;
    const ic = await findInCharge(email);
    if (!ic) return res.status(400).json({ error: 'Invalid code or email.' }); // generic
    const v = await otpService.verifyOtp({ adminId: ic._id, otp, ip: clientIp(req) });
    if (!v.ok) return res.status(400).json({ error: 'Invalid or expired code.' });

    agreementSession.issue(res, { adminId: ic._id, otpVerified: true });
    Admin.updateOne({ _id: ic._id }, { $set: { agreementStatus: 'otp_verified' } }).catch(() => {});

    const identity = {
      name: ic.name || '',
      emailMasked: maskEmail(ic.email),
      designation: ic.displayRole || 'State In-Charge',
      state: (ic.assignedStates && ic.assignedStates[0]) || ic.assignedState || ''
    };

    // Already-completed detection — ONLY revealed AFTER successful OTP verification
    // (never before), so it cannot be used to enumerate accounts. Scoped to this
    // verified identity; no acceptanceId is exposed to the client here.
    const existing = await AgreementAcceptance.findOne({ adminId: ic._id }).sort({ createdAt: -1 }).lean();
    if (existing) {
      return res.json({
        ok: true, alreadyCompleted: true, identity,
        summary: {
          status: 'Completed',
          tncVersion: existing.tncVersion,
          acceptedAt: existing.acceptedAt,
          hasSignature: !!existing.signatureRef,
          gpsCaptured: existing.locationPermission === 'granted' && existing.latitude != null,
          ipCaptured: !!existing.ip
        }
      });
    }
    return res.json({ ok: true, identity });
  } catch (_) { return res.status(500).json({ error: 'Verification failed.' }); }
};

// GET /my-acceptance — the verified subeditor's OWN completed agreement (session-scoped,
// no id param → cannot be used to view anyone else's record).
exports.getMyAcceptance = async (req, res) => {
  try {
    const { adminId } = req.agreement || {};
    if (!adminId) return res.status(401).json({ error: 'Session required.' });
    const acc = await AgreementAcceptance.findOne({ adminId }).sort({ createdAt: -1 }).lean();
    if (!acc) return res.status(404).json({ error: 'No completed agreement found.' });
    const { buildEvidence } = require('../services/agreement/evidence');
    return res.json({ ok: true, evidence: await buildEvidence(acc) });
  } catch (_) { return res.status(500).json({ error: 'Could not load your agreement.' }); }
};

// GET /terms — current published T&C (session required).
exports.getTerms = async (req, res) => {
  try {
    const tnc = await TncDocument.findOne({ status: 'published' }).sort({ publishedAt: -1 }).lean();
    if (!tnc) return res.status(404).json({ error: 'No published Terms & Conditions available yet.' });
    res.json({
      version: tnc.version, title: tnc.title, effectiveFrom: tnc.effectiveFrom,
      contentHash: tnc.contentHash, bodyEnglish: tnc.bodyEnglish, bodyTelugu: tnc.bodyTelugu,
      // Canonical acceptance points (server truth). The client renders checkboxes for these
      // but can NEVER define them — accept validation re-derives required points from the DB.
      acceptancePoints: (Array.isArray(tnc.acceptancePoints) ? tnc.acceptancePoints : [])
        .map(p => ({ key: p.key, label: p.label, required: p.required, order: p.order }))
    });
  } catch (_) { res.status(500).json({ error: 'Failed to load terms.' }); }
};

// POST /accept — create the immutable acceptance (session required).
exports.accept = async (req, res) => {
  try {
    const { adminId, otpVerified } = req.agreement || {};
    if (!otpVerified) return res.status(401).json({ error: 'OTP verification required.' });

    const ic = await Admin.findById(adminId).select('_id name email displayRole assignedState assignedStates role isActive');
    if (!ic || ic.role !== 'subeditor' || ic.isActive === false) return res.status(403).json({ error: 'Account not eligible.' });

    // DUPLICATE PROTECTION — if a completed acceptance already exists for this admin,
    // never create a second one. The original immutable record (and its hash chain)
    // is preserved untouched.
    const existingAcc = await AgreementAcceptance.findOne({ adminId: ic._id }).sort({ createdAt: -1 }).lean();
    if (existingAcc) {
      agreementSession.clear(res);
      return res.json({ ok: true, alreadyCompleted: true, version: existingAcc.tncVersion, acceptedAt: existingAcc.acceptedAt });
    }

    const tnc = await TncDocument.findOne({ status: 'published' }).sort({ publishedAt: -1 }).lean();
    if (!tnc) return res.status(409).json({ error: 'No published Terms available.' });

    const b = req.body || {};
    if (b.acceptedVersion && b.acceptedVersion !== tnc.version) {
      return res.status(409).json({ error: 'Terms have been updated. Please reload and read the latest version.' });
    }

    // ── POINT-BY-POINT server-side validation (SOURCE OF TRUTH = published version) ──
    // The client's checkbox state is NEVER trusted. The server independently derives the
    // required points from the DB and validates the submitted key set. Fail-closed.
    const AP = require('../services/agreement/acceptancePoints');
    const canonicalPoints = Array.isArray(tnc.acceptancePoints) ? tnc.acceptancePoints : [];
    const isPointAware = canonicalPoints.length > 0;
    let acceptedPointsRecord = [];
    let requiredKeys = [];
    let acceptedPointsCanonical = '';
    if (isPointAware) {
      // Bind to the exact version's hash: a hash that doesn't match this version → refuse.
      if (b.tncHash && String(b.tncHash) !== String(tnc.contentHash)) {
        return res.status(409).json({ error: 'Please refresh the agreement and try again.' });
      }
      const byKey = new Map(canonicalPoints.map(p => [p.key, p]));
      requiredKeys = canonicalPoints.filter(p => p.required).map(p => p.key);
      // Client submits ONLY keys (string or {key}); labels/required come from the server.
      let submitted = Array.isArray(b.acceptedPoints) ? b.acceptedPoints : [];
      submitted = submitted.map(x => (x && typeof x === 'object') ? String(x.key || '') : String(x || '')).filter(Boolean);
      if (new Set(submitted).size !== submitted.length) {
        return res.status(400).json({ error: 'Please refresh the agreement and try again.' }); // duplicate keys
      }
      for (const k of submitted) {
        if (!byKey.has(k)) return res.status(400).json({ error: 'Please refresh the agreement and try again.' }); // unknown key
      }
      const missing = requiredKeys.filter(rk => !submitted.includes(rk));
      if (missing.length) {
        return res.status(400).json({ error: 'You must accept all required points before continuing.' });
      }
      const at0 = new Date();
      acceptedPointsRecord = submitted.map(k => { const p = byKey.get(k); return { key: p.key, label: p.label, required: p.required, acceptedAt: at0 }; });
      acceptedPointsCanonical = AP.canonicalForHash({ tncVersion: tnc.version, tncHash: tnc.contentHash, required: requiredKeys, accepted: submitted });
    }

    if (b.agree !== true && b.agree !== 'true') return res.status(400).json({ error: 'You must accept the Terms & Conditions.' });
    const typedName = String(b.typedName || '').trim();
    if (!typedName) return res.status(400).json({ error: 'Full name is required.' });
    // Soft name check (case-insensitive, spaces collapsed) — mismatch is flagged, not blocked.
    const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const nameMatches = norm(typedName) === norm(ic.name);

    // Optional drawn signature → store PNG to existing R2 (fail-open: never blocks acceptance).
    let signatureRef = '';
    if (typeof b.signatureData === 'string' && b.signatureData.startsWith('data:image/')) {
      try {
        const base64 = b.signatureData.split(',')[1] || '';
        const buf = Buffer.from(base64, 'base64');
        if (buf.length > 0 && buf.length < 2 * 1024 * 1024) {
          const { uploadToR2 } = require('../middleware/upload');
          signatureRef = await uploadToR2(buf, 'agreement_signatures', `sig_${ic._id}_${Date.now()}.png`, 'image/png');
        }
      } catch (_) { signatureRef = ''; }
    }

    // Evidence (corroborating only).
    const acceptedAt = new Date();
    const fields = {
      adminId: ic._id,
      name: ic.name || '', email: ic.email || '',
      designation: ic.displayRole || 'State In-Charge',
      state: (ic.assignedStates && ic.assignedStates[0]) || ic.assignedState || '',
      tncVersion: tnc.version, tncHash: tnc.contentHash,
      acceptedAt, otpVerified: true, typedName,
      signatureRef,
      ip: clientIp(req), userAgent: (req.headers['user-agent'] || '').slice(0, 400),
      deviceMetadata: sanitizeDevice(b.device),
      locationPermission: ['granted', 'denied', 'unavailable'].includes(b.locationPermission) ? b.locationPermission : 'unavailable',
      latitude: numOrNull(b.latitude), longitude: numOrNull(b.longitude),
      // Point-by-point acceptance (server-canonical; empty for legacy/non-point versions).
      acceptedPoints: acceptedPointsRecord,
      requiredPointKeys: requiredKeys
    };

    // Tamper-evident hash chain (append-only). Point-aware records also bind the canonical
    // point set; legacy records pass no canonical → identical hash to before (no chain break).
    const prev = await AgreementAcceptance.findOne({}).sort({ createdAt: -1 }).select('acceptanceHash').lean();
    const previousHash = prev ? prev.acceptanceHash : '';
    const acceptanceHash = AgreementAcceptance.computeHash({ ...fields, acceptedPointsCanonical }, previousHash);

    const doc = await AgreementAcceptance.create({ ...fields, previousHash, acceptanceHash, workerId: WORKER_ID });
    Admin.updateOne({ _id: ic._id }, { $set: { agreementStatus: 'agreement_accepted' } }).catch(() => {});
    agreementSession.clear(res); // one-time — session done after acceptance

    try {
      require('../models/AuditLog').create({
        action: 'agreement_accepted', actorName: ic.name || '', actorRole: 'subeditor',
        entityType: 'AgreementAcceptance', entityId: String(doc._id),
        details: { tncVersion: tnc.version, ip: fields.ip, nameMatches, locationPermission: fields.locationPermission }
      });
    } catch (_) {}

    return res.json({ ok: true, acceptanceId: String(doc._id), version: tnc.version, acceptedAt });
  } catch (e) {
    return res.status(500).json({ error: 'Could not record acceptance.' });
  }
};

function numOrNull(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function sanitizeDevice(d) {
  if (!d || typeof d !== 'object') return null;
  const pick = (k) => (typeof d[k] === 'string' ? d[k].slice(0, 120) : (typeof d[k] === 'number' ? d[k] : undefined));
  return { platform: pick('platform'), screen: pick('screen'), timezone: pick('timezone'), language: pick('language') };
}
