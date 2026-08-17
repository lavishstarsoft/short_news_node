'use strict';

/**
 * agreementTermsController — Super-Admin-only Terms & Conditions management +
 * a read-only agreement-status view for admins.
 *
 * SECURITY: every mutating action re-checks role === 'superadmin' SERVER-SIDE.
 * Hiding UI buttons is not enough.
 */

const mongoose = require('mongoose');
const TncDocument = require('../models/TncDocument');
const AgreementAcceptance = require('../models/AgreementAcceptance');
const requestIp = require('request-ip');
const otpService = require('../services/agreement/otpService');
const emailService = require('../services/agreement/emailService');
const AP = require('../services/agreement/acceptancePoints');

// ── Agreement/T&C DATA PURGE (Super-Admin only, fresh-OTP gated) ──
// Only these AuditLog actions belong to the agreement module. Everything else in the
// shared AuditLog collection (wallet, withdrawals, settings…) is NEVER touched.
const AGREEMENT_AUDIT_ACTIONS = ['agreement_accepted', 'tnc_published', 'tnc_version_unpublished', 'tnc_version_deleted', 'agreement_evidence_viewed'];
// HARD-CODED authorized OTP destination. The purge OTP is sent ONLY here — never to a
// DB email, a record email, or any UI/API-supplied address. Not modifiable at runtime.
const AUTHORIZED_DELETE_OTP_EMAIL = 'ashokca810@gmail.com';
// OTP key namespace (isolated from the public state-agreement accept OTP), bound to the
// acting Super Admin's session id so only that verified Super Admin can complete it.
function purgeOtpId(req) { return 'purge:' + String((req.admin && (req.admin.id || req.admin._id)) || ''); }
function maskEmail(e) { const [u, d] = String(e || '').split('@'); return d ? ((u ? u[0] : '?') + '***@' + d) : '—'; }

async function purgeCounts() {
  const L = require('../models/AuditLog');
  const [tncDocuments, acceptances, signatureFiles, auditByAction] = await Promise.all([
    TncDocument.countDocuments({}),
    AgreementAcceptance.countDocuments({}),
    AgreementAcceptance.countDocuments({ signatureRef: { $nin: ['', null] } }),
    L.aggregate([{ $match: { action: { $in: AGREEMENT_AUDIT_ACTIONS } } }, { $group: { _id: '$action', n: { $sum: 1 } } }])
  ]);
  return {
    tncDocuments, acceptances, signatureFiles,
    auditLogs: auditByAction.reduce((s, x) => s + x.n, 0),
    auditByAction: auditByAction.reduce((o, x) => { o[x._id] = x.n; return o; }, {})
  };
}

function isSuperAdmin(req) { return req.admin && req.admin.role === 'superadmin'; }
function isAdmin(req) { return req.admin && (req.admin.role === 'admin' || req.admin.role === 'superadmin'); }

// POST /admin/agreement-terms/api/:id/delete — Super-Admin, password-gated.
// Referenced-by-acceptances → ARCHIVE/UNPUBLISH (never hard-delete). Unreferenced → delete.
exports.deletePublishedVersion = async (req, res) => {
  if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Super Admin only.' });

  // Reuse the existing reject-news delete password mechanism (server-side; never logged).
  const envPassword = process.env.REJECTED_NEWS_DELETE_PASSWORD;
  if (!envPassword) return res.status(500).json({ error: 'Delete password not configured in .env' });
  const password = req.body && req.body.password;
  if (password !== envPassword) return res.status(401).json({ error: 'Invalid password' });

  const id = String(req.params.id || '');
  if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid version id.' });
  const doc = await TncDocument.findById(id);
  if (!doc) return res.status(404).json({ error: 'Version not found.' });

  const refs = await AgreementAcceptance.countDocuments({ tncVersion: doc.version });
  const AuditLog = require('../models/AuditLog');
  const audit = (action, details) => { try { AuditLog.create({ actorId: req.admin.id || req.admin._id || null, actorName: req.admin.username || req.admin.name || '', actorRole: req.admin.role, action, entityType: 'TncDocument', entityId: id, description: `v${doc.version} — ${action} (references=${refs})`, before: { status: doc.status }, after: details || {} }); } catch (_) {} };

  if (refs > 0) {
    // LEGAL SAFETY: accepted agreements reference this version → keep it immutable,
    // just unpublish/archive it. Historical acceptances keep resolving their frozen T&C.
    if (doc.status !== 'archived') { doc.status = 'archived'; await doc.save(); }
    audit('tnc_version_unpublished', { status: 'archived', references: refs });
    return res.json({ ok: true, action: 'archived', references: refs, message: 'This version is referenced by accepted agreements, so it was unpublished/archived — not deleted. Historical accepted agreements are unaffected.' });
  }

  // Unreferenced → controlled hard delete (bypasses the append-only guard intentionally, Super-Admin + password gated).
  await TncDocument.collection.deleteOne({ _id: doc._id });
  audit('tnc_version_deleted', { status: 'deleted', references: 0 });
  return res.json({ ok: true, action: 'deleted', references: 0, message: 'Version deleted — no accepted agreements referenced it.' });
};

// GET /admin/agreement-status/:acceptanceId — read-only evidence detail (admin/superadmin).
exports.renderAcceptanceDetail = async (req, res) => {
  if (!isAdmin(req)) return res.status(403).send('Access denied. Admins only.');
  const id = String(req.params.acceptanceId || '');
  if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).send('Invalid acceptance id.');
  const acc = await AgreementAcceptance.findById(id).lean();
  if (!acc) return res.status(404).send('Acceptance record not found.');

  const { buildEvidence } = require('../services/agreement/evidence');
  const evidence = await buildEvidence(acc);

  try {
    require('../models/AuditLog').create({
      actorId: req.admin.id || req.admin._id || null, actorName: req.admin.username || req.admin.name || '', actorRole: req.admin.role,
      action: 'agreement_evidence_viewed', entityType: 'AgreementAcceptance', entityId: id,
      targetId: acc.adminId, targetName: acc.name || '',
      description: `Viewed agreement evidence (v${acc.tncVersion})`
    });
  } catch (_) {}

  res.render('agreement-detail', { admin: req.admin, activePage: 'agreement-status', evidence, generatedAt: new Date() });
};

// GET /admin/agreement-terms — management page (Super Admin only).
exports.renderTermsAdmin = async (req, res) => {
  if (!isSuperAdmin(req)) return res.status(403).send('Access denied. Super Admin only.');
  const versions = await TncDocument.find({}).sort({ createdAt: -1 }).lean();
  res.render('agreement-terms', { admin: req.admin, activePage: 'agreement-terms', versions });
};

// GET /admin/agreement-terms/api — list (JSON).
exports.list = async (req, res) => {
  if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Super Admin only.' });
  res.json({ versions: await TncDocument.find({}).sort({ createdAt: -1 }).lean() });
};

// GET /admin/agreement-terms/api/:id — one version.
exports.getVersion = async (req, res) => {
  if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Super Admin only.' });
  const v = await TncDocument.findById(req.params.id).lean();
  if (!v) return res.status(404).json({ error: 'Not found.' });
  res.json(v);
};

// POST /admin/agreement-terms/api/parse-points — deterministic detection preview (Super Admin).
// Uses the SAME server parser the publish flow uses, so the admin sees exactly what will be stored.
exports.parsePoints = async (req, res) => {
  if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Super Admin only.' });
  const parsed = AP.parse((req.body && req.body.bodyEnglish) || '');
  res.json({ ok: true, count: parsed.points.length, points: parsed.points, errors: parsed.errors, markerLines: parsed.markerLines });
};

// POST /admin/agreement-terms/api — create a DRAFT.
exports.createDraft = async (req, res) => {
  if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Super Admin only.' });
  const version = String((req.body.version || '')).trim();
  if (!version) return res.status(400).json({ error: 'Version is required (e.g. 1.1).' });
  try {
    const bodyEnglish = req.body.bodyEnglish || '';
    const doc = await TncDocument.create({
      version,
      title: (req.body.title || 'State In-Charge Appointment — Terms & Conditions').trim(),
      bodyEnglish,
      bodyTelugu: '', // English-only architecture: new versions never store Telugu content.
      acceptancePoints: AP.parse(bodyEnglish).points, // derived deterministically (draft; validated at publish)
      changeSummary: req.body.changeSummary || '',
      status: 'draft',
      createdBy: req.admin.id || req.admin._id
    });
    res.json({ ok: true, id: doc._id });
  } catch (e) {
    if (e && e.code === 11000) return res.status(409).json({ error: 'That version number already exists.' });
    res.status(500).json({ error: 'Failed to create draft.' });
  }
};

// PUT /admin/agreement-terms/api/:id — edit a DRAFT only (published is immutable).
exports.updateDraft = async (req, res) => {
  if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Super Admin only.' });
  const doc = await TncDocument.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found.' });
  if (doc.status !== 'draft') return res.status(409).json({ error: 'Only draft versions can be edited. Create a new version.' });
  if (req.body.title !== undefined) doc.title = String(req.body.title).trim();
  if (req.body.bodyEnglish !== undefined) doc.bodyEnglish = req.body.bodyEnglish;
  if (req.body.bodyTelugu !== undefined) doc.bodyTelugu = req.body.bodyTelugu;
  if (req.body.changeSummary !== undefined) doc.changeSummary = req.body.changeSummary;
  if (req.body.version !== undefined) doc.version = String(req.body.version).trim();
  // Re-derive acceptance points from the (English) body on every draft save.
  doc.acceptancePoints = AP.parse(doc.bodyEnglish || '').points;
  try { await doc.save(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'Failed to save draft.' }); }
};

// POST /admin/agreement-terms/api/:id/publish — freeze + hash + archive previous.
exports.publishDraft = async (req, res) => {
  if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Super Admin only.' });
  const doc = await TncDocument.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found.' });
  if (doc.status !== 'draft') return res.status(409).json({ error: 'Only a draft can be published.' });
  if (!doc.bodyEnglish.trim() && !doc.bodyTelugu.trim()) return res.status(400).json({ error: 'Cannot publish empty terms.' });

  // VALIDATE acceptance markers BEFORE publish — never silently publish malformed markers.
  const parsed = AP.parse(doc.bodyEnglish || '');
  if (parsed.errors.length) {
    return res.status(400).json({ error: 'Acceptance markers have problems — fix them before publishing.', pointErrors: parsed.errors });
  }
  doc.acceptancePoints = parsed.points; // freeze the canonical point set with the published version

  // Archive the currently-published version(s) — via save() so pre-hooks allow the status change.
  const currentlyPublished = await TncDocument.find({ status: 'published' });
  for (const p of currentlyPublished) { p.status = 'archived'; await p.save(); }

  doc.contentHash = TncDocument.computeHash(doc.version, doc.bodyEnglish, doc.bodyTelugu);
  doc.status = 'published';
  doc.publishedAt = new Date();
  doc.effectiveFrom = doc.effectiveFrom || doc.publishedAt;
  doc.publishedBy = req.admin.id || req.admin._id;
  await doc.save();

  try { require('../models/AuditLog').create({ action: 'tnc_published', actorName: req.admin.username || '', actorRole: req.admin.role, entityType: 'TncDocument', entityId: String(doc._id), details: { version: doc.version, hash: doc.contentHash } }); } catch (_) {}
  res.json({ ok: true, version: doc.version, contentHash: doc.contentHash });
};

// ── PURGE: GET /admin/agreement-terms/api/purge/preview — counts only (Super Admin). ──
exports.previewPurge = async (req, res) => {
  if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Super Admin only.' });
  try {
    const counts = await purgeCounts();
    const Admin = require('../models/Admin');
    const acting = await Admin.findById(req.admin.id).select('email').lean();
    const dbEmail = (acting && acting.email) || '';
    res.json({
      ok: true,
      counts,
      otpDestination: maskEmail(AUTHORIZED_DELETE_OTP_EMAIL),
      // Informational only: the acting Super Admin's DB email differs from the fixed
      // authorized OTP address. The OTP is ALWAYS sent to the authorized address regardless.
      configMismatch: String(dbEmail).trim().toLowerCase() !== AUTHORIZED_DELETE_OTP_EMAIL.toLowerCase(),
      preserved: [
        'Super Admin & all user accounts',
        'All non-agreement audit logs',
        'App / OTP / email configuration',
        'All other modules, collections & files'
      ]
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load deletion preview.' });
  }
};

// ── PURGE: POST /admin/agreement-terms/api/purge/send-otp — fresh OTP to fixed email. ──
exports.sendPurgeOtp = async (req, res) => {
  if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Super Admin only.' });
  const { isRedisAvailable } = require('../config/redis');
  if (!isRedisAvailable()) return res.status(503).json({ error: 'Verification service is temporarily unavailable. Try again shortly.' });
  if (!emailService.isConfigured()) return res.status(503).json({ error: 'Email service is not configured; cannot send the verification code.' });
  try {
    const ip = requestIp.getClientIp(req) || req.ip || '';
    const r = await otpService.requestOtp({ adminId: purgeOtpId(req), ip });
    if (r.status === 'sent') {
      // Destination is ALWAYS the hard-coded authorized address — never from req/DB/record.
      await emailService.sendOtpEmail(AUTHORIZED_DELETE_OTP_EMAIL, r.otp, {
        name: 'Super Admin',
        subject: 'Agreement/T&C Data Deletion — verification code'
      }).catch(() => {});
      return res.json({ ok: true, sentTo: maskEmail(AUTHORIZED_DELETE_OTP_EMAIL) });
    }
    if (r.status === 'cooldown') return res.status(429).json({ error: 'Please wait before requesting another code.', retryAfterSec: r.retryAfterSec });
    if (r.status === 'rate_limited') return res.status(429).json({ error: 'Too many code requests. Please try later.' });
    return res.status(503).json({ error: 'Could not generate a verification code right now.' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to send the verification code.' });
  }
};

// ── PURGE: POST /admin/agreement-terms/api/purge/execute — verify OTP + confirm + delete. ──
exports.executePurge = async (req, res) => {
  if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Super Admin only.' });
  const body = req.body || {};
  if (body.confirm !== true && body.confirm !== 'true') return res.status(400).json({ error: 'Final confirmation is required.' });
  if (body.acknowledge !== true && body.acknowledge !== 'true') return res.status(400).json({ error: 'You must acknowledge that this permanently deletes the data.' });
  const otp = String(body.otp || '').trim();
  if (!/^\d{6}$/.test(otp)) return res.status(400).json({ error: 'Enter the 6-digit verification code.' });

  const ip = requestIp.getClientIp(req) || req.ip || '';
  // Server-side OTP verification (consume-on-success; expiry/attempts/reuse handled here).
  const v = await otpService.verifyOtp({ adminId: purgeOtpId(req), otp, ip });
  if (!v.ok) {
    const msg = v.reason === 'expired' ? 'Verification code expired. Please request a new one.'
      : v.reason === 'too_many_attempts' ? 'Too many incorrect attempts. Request a new code.'
      : v.reason === 'unavailable' ? 'Verification service unavailable. Try again shortly.'
      : 'Invalid verification code.';
    return res.status(400).json({ error: msg });
  }

  const L = require('../models/AuditLog');
  const { deleteFromR2 } = require('../middleware/upload');

  // Capture signature refs BEFORE deletion (for storage cleanup after DB commit).
  let sigRefs = [];
  try {
    sigRefs = (await AgreementAcceptance.find({ signatureRef: { $nin: ['', null] } }).select('signatureRef').lean())
      .map(x => x.signatureRef).filter(Boolean);
  } catch (_) { sigRefs = []; }

  const deleted = { acceptances: 0, tncDocuments: 0, auditLogs: 0 };
  const actorObjId = req.admin.id ? new mongoose.Types.ObjectId(String(req.admin.id)) : null;
  const auditDoc = () => ({
    actorId: actorObjId,
    actorName: req.admin.username || req.admin.name || '',
    actorRole: req.admin.role || '',
    action: 'AGREEMENT_DATA_DELETION', // NOT an agreement action → this record survives the purge
    entityType: 'Agreement', entityId: '',
    description: 'Agreement/T&C data purge executed by Super Admin (OTP-verified).',
    after: { deleted, otpVerified: true, at: new Date().toISOString() },
    ip, createdAt: new Date()
  });

  let session = null, committed = false;
  try {
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      // .collection.* bypasses the append-only guards (intended: Super-Admin + OTP gated).
      const r1 = await AgreementAcceptance.collection.deleteMany({}, { session });
      const r2 = await TncDocument.collection.deleteMany({}, { session });
      const r3 = await L.collection.deleteMany({ action: { $in: AGREEMENT_AUDIT_ACTIONS } }, { session });
      deleted.acceptances = r1.deletedCount || 0;
      deleted.tncDocuments = r2.deletedCount || 0;
      deleted.auditLogs = r3.deletedCount || 0;
      await L.collection.insertOne(auditDoc(), { session });
    });
    committed = true;
  } catch (txnErr) {
    // Fallback for a MongoDB deployment without transaction support (standalone).
    if (!committed && /Transaction|replica set|not supported|Sessions are not/i.test(txnErr.message || '')) {
      try {
        const r1 = await AgreementAcceptance.collection.deleteMany({});
        const r2 = await TncDocument.collection.deleteMany({});
        const r3 = await L.collection.deleteMany({ action: { $in: AGREEMENT_AUDIT_ACTIONS } });
        deleted.acceptances = r1.deletedCount || 0;
        deleted.tncDocuments = r2.deletedCount || 0;
        deleted.auditLogs = r3.deletedCount || 0;
        await L.collection.insertOne(auditDoc());
        committed = true;
      } catch (e2) {
        return res.status(500).json({ error: 'Deletion failed. Please retry.' });
      }
    } else {
      return res.status(500).json({ error: 'Deletion failed and was rolled back. No data was deleted.' });
    }
  } finally {
    if (session) session.endSession();
  }

  // Best-effort storage cleanup (R2 is not transactional; runs only after a successful DB commit).
  let signatureFilesDeleted = 0, signatureFilesFailed = 0;
  for (const ref of sigRefs) {
    try { const rr = await deleteFromR2(ref); if (rr && rr.ok) signatureFilesDeleted++; else if (rr && !rr.skipped) signatureFilesFailed++; }
    catch (_) { signatureFilesFailed++; }
  }

  return res.json({ ok: true, deleted: { ...deleted, signatureFilesDeleted, signatureFilesFailed } });
};

// GET /admin/agreement-status — read-only acceptance status (admin/superadmin).
exports.renderAgreementStatus = async (req, res) => {
  if (!isAdmin(req)) return res.status(403).send('Access denied. Admins only.');
  const acceptances = await AgreementAcceptance.find({}).sort({ createdAt: -1 }).limit(200).lean();
  res.render('agreement-status', { admin: req.admin, activePage: 'agreement-status', acceptances });
};

// ── SINGLE DELETE: POST /admin/agreement-terms/api/delete-single/:id/send-otp ──
exports.sendDeleteSingleOtp = async (req, res) => {
  if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Super Admin only.' });
  const { isRedisAvailable } = require('../config/redis');
  if (!isRedisAvailable()) return res.status(503).json({ error: 'Verification service is temporarily unavailable.' });
  if (!emailService.isConfigured()) return res.status(503).json({ error: 'Email service is not configured.' });
  
  try {
    const record = await AgreementAcceptance.findById(req.params.id).lean();
    if (!record) return res.status(404).json({ error: 'Agreement record not found.' });

    const ip = requestIp.getClientIp(req) || req.ip || '';
    const otpId = `del_single_${req.admin.id || req.admin._id}_${req.params.id}`;
    const r = await otpService.requestOtp({ adminId: otpId, ip });
    if (r.status === 'sent') {
      await emailService.sendOtpEmail(AUTHORIZED_DELETE_OTP_EMAIL, r.otp, {
        name: 'Super Admin',
        subject: `Individual Agreement Deletion (${record.name || 'User'}) — verification code`
      }).catch(() => {});
      
      // We must export maskEmail if we need to use it here, or just define it.
      // We can use a simple mask implementation if maskEmail is not globally available in this scope.
      const e = AUTHORIZED_DELETE_OTP_EMAIL;
      const p = e.split('@');
      const masked = p.length < 2 ? '***' : p[0].charAt(0) + '***@' + p[1];
      
      return res.json({ ok: true, sentTo: masked });
    }
    if (r.status === 'cooldown') return res.status(429).json({ error: 'Please wait before requesting another code.', retryAfterSec: r.retryAfterSec });
    if (r.status === 'rate_limited') return res.status(429).json({ error: 'Too many code requests. Please try later.' });
    return res.status(503).json({ error: 'Could not generate a verification code right now.' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to send the verification code.' });
  }
};

// ── SINGLE DELETE: POST /admin/agreement-terms/api/delete-single/:id/execute ──
exports.executeDeleteSingle = async (req, res) => {
  if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Super Admin only.' });
  const body = req.body || {};
  const otp = String(body.otp || '').trim();
  if (!/^\d{6}$/.test(otp)) return res.status(400).json({ error: 'Enter the 6-digit verification code.' });

  try {
    const record = await AgreementAcceptance.findById(req.params.id);
    if (!record) return res.status(404).json({ error: 'Agreement record not found.' });

    const ip = requestIp.getClientIp(req) || req.ip || '';
    const otpId = `del_single_${req.admin.id || req.admin._id}_${req.params.id}`;
    const v = await otpService.verifyOtp({ adminId: otpId, otp, ip });
    
    if (!v.ok) {
      const msg = v.reason === 'expired' ? 'Verification code expired. Please request a new one.'
        : v.reason === 'too_many_attempts' ? 'Too many incorrect attempts. Request a new code.'
        : v.reason === 'unavailable' ? 'Verification service unavailable. Try again shortly.'
        : 'Invalid verification code.';
      return res.status(400).json({ error: msg });
    }

    const { deleteFromR2 } = require('../middleware/upload');
    const L = require('../models/AuditLog');

    const sigRef = record.signatureRef;
    
    // We use .collection.deleteOne here to bypass standard app-level protection, just like purge does
    await AgreementAcceptance.collection.deleteOne({ _id: new mongoose.Types.ObjectId(req.params.id) });

    if (sigRef) {
      deleteFromR2(sigRef).catch(e => console.error('Failed to clean up signature:', e));
    }

    const actorObjId = req.admin.id ? new mongoose.Types.ObjectId(String(req.admin.id)) : null;
    await L.create({
      actorId: actorObjId,
      actorName: req.admin.username || req.admin.name || '',
      actorRole: req.admin.role || '',
      action: 'AGREEMENT_STATUS_DELETED',
      entityType: 'AgreementAcceptance', 
      entityId: String(req.params.id),
      description: `Individual Agreement Status for ${record.name} (${record.email}) deleted by Super Admin (OTP-verified).`,
      after: { otpVerified: true, at: new Date().toISOString() },
      ip, createdAt: new Date()
    });

    return res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to execute deletion.' });
  }
};
