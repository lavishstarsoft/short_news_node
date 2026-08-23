'use strict';

/**
 * P4 — Emergency access override service (grant / revoke / read).
 *
 * Reuses existing IST semantics (istDateKey) and the AuditLog pattern. Never
 * writes wallet/history. All mutations are audited. Grants only ever raise TODAY's
 * cap; enforcement elsewhere reads getActiveExtraAllowed() which is scoped to
 * dateKey === today → automatic expiry, no cron needed.
 */

const ReporterAccessOverride = require('../models/ReporterAccessOverride');
const AuditLog = require('../models/AuditLog');
const { istDateKey } = require('./indianDateTime');

const MAX_EXTRA_PER_GRANT = 10;

/**
 * Active extra submissions granted to a reporter for the IST day of `when`.
 * Returns 0 when there is no active override (the common case) → pure read.
 */
async function getActiveExtraAllowed(reporterId, when) {
  const dateKey = istDateKey(when || new Date());
  const row = await ReporterAccessOverride.findOne({
    reporterId,
    dateKey,
    status: 'active',
  }).lean();
  return row && Number.isFinite(row.extraAllowed) ? row.extraAllowed : 0;
}

/** Read today's override row (for UI display). null when none. */
async function getTodayOverride(reporterId, when) {
  const dateKey = istDateKey(when || new Date());
  return ReporterAccessOverride.findOne({ reporterId, dateKey }).lean();
}

/**
 * Grant +extra submissions for TODAY (IST). Accumulates onto today's row and
 * re-activates a previously revoked row. Server derives dateKey; caller supplies
 * validated reporter + granter.
 */
async function grantAccess({ reporterId, reporterName, granter, extra }) {
  const n = Math.max(1, Math.min(MAX_EXTRA_PER_GRANT, Math.floor(Number(extra) || 0)));
  const dateKey = istDateKey(new Date());

  const before = await ReporterAccessOverride.findOne({ reporterId, dateKey }).lean();
  const row = await ReporterAccessOverride.findOneAndUpdate(
    { reporterId, dateKey },
    {
      $inc: { extraAllowed: n },
      $set: {
        status: 'active',
        grantedById: (granter && (granter.id || granter._id)) || null,
        grantedByName: (granter && (granter.username || granter.name)) || '',
        grantedByRole: (granter && granter.role) || '',
        revokedById: null, revokedByName: '', revokedByRole: '', revokedAt: null,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await audit('reporter_access_grant', granter, reporterId, reporterName, {
    before: before ? { extraAllowed: before.extraAllowed, status: before.status } : null,
    after: { dateKey, extraAllowed: row.extraAllowed, status: row.status, added: n },
    description: `Granted +${n} emergency submissions for ${dateKey} (total extra ${row.extraAllowed})`,
  });

  return { ok: true, dateKey, extraAllowed: row.extraAllowed, added: n };
}

/** Revoke today's override → immediately restores the normal cap. */
async function revokeAccess({ reporterId, reporterName, granter }) {
  const dateKey = istDateKey(new Date());
  const before = await ReporterAccessOverride.findOne({ reporterId, dateKey }).lean();
  if (!before || before.status !== 'active') {
    return { ok: false, error: 'no_active_override' };
  }
  await ReporterAccessOverride.updateOne(
    { reporterId, dateKey },
    {
      $set: {
        status: 'revoked',
        revokedById: (granter && (granter.id || granter._id)) || null,
        revokedByName: (granter && (granter.username || granter.name)) || '',
        revokedByRole: (granter && granter.role) || '',
        revokedAt: new Date(),
      },
    }
  );
  await audit('reporter_access_revoke', granter, reporterId, reporterName, {
    before: { extraAllowed: before.extraAllowed, status: before.status },
    after: { dateKey, extraAllowed: before.extraAllowed, status: 'revoked' },
    description: `Revoked emergency access for ${dateKey}`,
  });
  return { ok: true, dateKey };
}

async function audit(action, actor, targetId, targetName, { before, after, description }) {
  try {
    await AuditLog.create({
      actorId: (actor && (actor.id || actor._id)) || null,
      actorName: (actor && (actor.username || actor.name)) || '',
      actorRole: (actor && actor.role) || '',
      action,
      entityType: 'ReporterAccessOverride',
      entityId: String(targetId),
      targetId,
      targetName: targetName || '',
      description,
      before,
      after,
    });
  } catch (_) { /* audit is best-effort; never blocks the grant/revoke */ }
}

module.exports = {
  MAX_EXTRA_PER_GRANT,
  getActiveExtraAllowed,
  getTodayOverride,
  grantAccess,
  revokeAccess,
};
