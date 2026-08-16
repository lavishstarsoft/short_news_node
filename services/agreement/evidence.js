'use strict';

/**
 * evidence.js — build a read-only evidence view of an AgreementAcceptance.
 *
 * The accepted Terms & Conditions are reproduced from the IMMUTABLE TncDocument of
 * the exact accepted version, and the stored contentHash is re-verified against the
 * acceptance's frozen tncHash (integrity proof). The latest/editable T&C is NEVER
 * used. Email is masked. Registered address (if any) comes from the reporter's
 * application data and is kept SEPARATE from captured GPS — never merged.
 */

const TncDocument = require('../../models/TncDocument');
const ReporterApplication = require('../../models/ReporterApplication');

function maskEmail(e) {
  const [u, d] = String(e || '').split('@');
  if (!d) return '***';
  return `${u.slice(0, 1)}***@${d}`;
}

async function registeredAddress(email) {
  try {
    const app = await ReporterApplication.findOne({ 'data.email': String(email || '').toLowerCase() })
      .select('data').lean();
    const addr = app && app.data && (app.data.Address || app.data.address || app.data.Adress);
    return addr ? String(addr).slice(0, 300) : null;
  } catch (_) { return null; }
}

/** Build the structured, safe evidence object for one acceptance doc (lean). */
async function buildEvidence(acc) {
  const tnc = await TncDocument.findOne({ version: acc.tncVersion }).lean();
  const contentAvailable = !!tnc;
  // Re-verify the frozen snapshot: recompute the hash of the stored version content
  // and compare with BOTH the version's stored hash and the acceptance's frozen hash.
  let integrity = false, recomputed = '';
  if (tnc) {
    try { recomputed = TncDocument.computeHash(tnc.version, tnc.bodyEnglish, tnc.bodyTelugu); } catch (_) {}
    integrity = tnc.contentHash === acc.tncHash && recomputed === acc.tncHash;
  }
  const lat = (typeof acc.latitude === 'number') ? acc.latitude : null;
  const lng = (typeof acc.longitude === 'number') ? acc.longitude : null;

  return {
    id: String(acc._id),
    identity: {
      name: acc.name || '',
      emailMasked: maskEmail(acc.email),
      designation: acc.designation || 'State In-Charge',
      state: acc.state || '',
      adminId: String(acc.adminId || ''),
      status: 'Accepted / Completed'
    },
    agreement: {
      tncVersion: acc.tncVersion || '',
      tncHash: acc.tncHash || '',
      title: tnc ? (tnc.title || '') : '',
      publishedAt: tnc ? tnc.publishedAt : null,
      effectiveFrom: tnc ? tnc.effectiveFrom : null,
      // Exact frozen content the person accepted (verbatim; rendered escaped by the view).
      content: tnc ? String(tnc.bodyEnglish || tnc.bodyTelugu || '') : '',
      contentAvailable,
      integrity
    },
    evidence: {
      otpVerified: acc.otpVerified === true,
      acceptedAt: acc.acceptedAt || null,
      createdAt: acc.createdAt || null,
      typedName: acc.typedName || '',
      signatureRef: acc.signatureRef || '',
      hasSignature: !!acc.signatureRef,
      ip: acc.ip || '',
      userAgent: acc.userAgent || '',
      device: acc.deviceMetadata || null,
      acceptanceHash: acc.acceptanceHash || '',
      previousHash: acc.previousHash || '',
      workerId: acc.workerId || ''
    },
    location: {
      permission: acc.locationPermission || 'unavailable',
      latitude: lat,
      longitude: lng,
      hasGps: acc.locationPermission === 'granted' && lat !== null && lng !== null
    },
    registeredAddress: await registeredAddress(acc.email)
  };
}

module.exports = { buildEvidence, maskEmail };
