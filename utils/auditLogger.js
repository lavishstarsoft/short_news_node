const AuditLog = require('../models/AuditLog');

function requestIp(req) {
  if (!req) return '';
  const fwd = req.headers?.['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.ip || req.connection?.remoteAddress || '';
}

/**
 * Fire-and-forget audit log write. Never throws — auditing must not
 * break the action being audited.
 */
function logAudit({
  req = null,
  action,
  entityType = '',
  entityId = '',
  targetId = null,
  targetName = '',
  description = '',
  before = null,
  after = null
}) {
  try {
    const actor = req?.admin || {};
    return AuditLog.create({
      actorId: actor.id || actor._id || null,
      actorName: actor.username || actor.name || '',
      actorRole: actor.role || '',
      action,
      entityType,
      entityId: entityId ? String(entityId) : '',
      targetId: targetId || null,
      targetName: targetName || '',
      description,
      before,
      after,
      ip: requestIp(req)
    }).catch((err) => {
      console.error('Audit log write failed:', err.message);
    });
  } catch (err) {
    console.error('Audit log error:', err.message);
    return Promise.resolve(null);
  }
}

module.exports = { logAudit };
