'use strict';

/**
 * agreementTermsController — Super-Admin-only Terms & Conditions management +
 * a read-only agreement-status view for admins.
 *
 * SECURITY: every mutating action re-checks role === 'superadmin' SERVER-SIDE.
 * Hiding UI buttons is not enough.
 */

const TncDocument = require('../models/TncDocument');
const AgreementAcceptance = require('../models/AgreementAcceptance');

function isSuperAdmin(req) { return req.admin && req.admin.role === 'superadmin'; }
function isAdmin(req) { return req.admin && (req.admin.role === 'admin' || req.admin.role === 'superadmin'); }

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

// POST /admin/agreement-terms/api — create a DRAFT.
exports.createDraft = async (req, res) => {
  if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Super Admin only.' });
  const version = String((req.body.version || '')).trim();
  if (!version) return res.status(400).json({ error: 'Version is required (e.g. 1.1).' });
  try {
    const doc = await TncDocument.create({
      version,
      title: (req.body.title || 'State In-Charge Appointment — Terms & Conditions').trim(),
      bodyEnglish: req.body.bodyEnglish || '',
      bodyTelugu: req.body.bodyTelugu || '',
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

// GET /admin/agreement-status — read-only acceptance status (admin/superadmin).
exports.renderAgreementStatus = async (req, res) => {
  if (!isAdmin(req)) return res.status(403).send('Access denied. Admins only.');
  const acceptances = await AgreementAcceptance.find({}).sort({ createdAt: -1 }).limit(200).lean();
  res.render('agreement-status', { admin: req.admin, activePage: 'agreement-status', acceptances });
};
