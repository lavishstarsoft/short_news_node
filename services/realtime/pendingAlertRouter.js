'use strict';

/**
 * pendingAlertRouter.js — resolves WHICH admins should receive a pending-news
 * alert, so the server routes it only to authorized reviewers instead of
 * broadcasting to every admin/sub-editor.
 *
 * This is the exact inverse of the existing pending LIST scope
 * (utils/editorCoverageHelper.buildPendingNewsFilterForSubEditor): "which news
 * does this sub-editor see" ⇒ "which sub-editors see this news". It reuses the
 * same helpers so routing and the dashboard list can never diverge.
 *
 * Recipients:
 *   - Super Admin / Admin (or permissions.canViewAllNews) → always.
 *   - Sub Editor approvalScope 'all' (+ canApproveNews)    → always.
 *   - Sub Editor approvalScope 'reporters'                 → if news.authorId ∈ managedReporterIds.
 *   - Sub Editor approvalScope 'geography'                 → if news.location ∈ managed geography,
 *                                                            or the author's coverage overlaps it.
 *   - Reporter (role 'editor')                             → NEVER.
 */

const Admin = require('../../models/Admin');
const {
  normalizeApprovalScope,
  getSubEditorManagedCoverage,
  newsLocationMatchesCoverage,
  reporterMatchesCoverage,
  uniqueStrings
} = require('../../utils/editorCoverageHelper');

/**
 * @param {object} news  { authorId, location } (a News doc or the pending payload)
 * @returns {Promise<string[]>} admin id strings to notify (deduped). Empty on failure.
 */
async function resolvePendingRecipientIds(news) {
  if (!news) return [];
  const location = news.location || '';
  const authorId = news.authorId ? String(news.authorId) : '';

  // Admins are few (never the 1L+ reporters) → one indexed query, cacheable later.
  const admins = await Admin.find({
    isActive: { $ne: false },
    role: { $in: ['admin', 'superadmin', 'subeditor'] }
  })
    .select('_id role permissions')
    .lean();

  // Author coverage is only needed to match a geography sub-editor to the
  // author's assigned area (mirrors getManagedReporterIds for 'geography').
  let authorDoc = null;
  const needsAuthorCoverage =
    authorId &&
    admins.some(
      (a) =>
        a.role === 'subeditor' &&
        !(a.permissions && a.permissions.canViewAllNews) &&
        normalizeApprovalScope(a.permissions && a.permissions.approvalScope) === 'geography'
    );
  if (needsAuthorCoverage) {
    authorDoc = await Admin.findById(authorId)
      .select('assignedStates assignedState assignedDistricts assignedConstituencies assignedLocations location constituency')
      .lean();
  }

  const recipients = new Set();
  for (const a of admins) {
    const id = String(a._id);
    if (a.role === 'superadmin' || a.role === 'admin') {
      recipients.add(id);
      continue;
    }
    // sub-editor
    const perms = a.permissions || {};
    if (perms.canViewAllNews) {
      recipients.add(id);
      continue;
    }
    const scope = normalizeApprovalScope(perms.approvalScope);
    if (scope === 'all') {
      if (perms.canApproveNews) recipients.add(id);
      continue;
    }
    if (scope === 'reporters') {
      if (authorId && uniqueStrings(perms.managedReporterIds || []).includes(authorId)) {
        recipients.add(id);
      }
      continue;
    }
    // geography
    const coverage = getSubEditorManagedCoverage(a);
    if (location && newsLocationMatchesCoverage(location, coverage)) {
      recipients.add(id);
      continue;
    }
    if (authorDoc && reporterMatchesCoverage(authorDoc, coverage)) {
      recipients.add(id);
    }
  }

  return [...recipients];
}

module.exports = { resolvePendingRecipientIds };
