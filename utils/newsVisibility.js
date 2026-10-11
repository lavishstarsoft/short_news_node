'use strict';

/**
 * ONE rule for "may the PUBLIC see this news?" — used by every public entry
 * point that serves a single news item (GraphQL newsById / newsByShortId, the
 * short-link landing page, the /api/public/expand API).
 *
 * The feed already filters on isActive, but a direct link used to bypass that:
 * a rejected or still-pending story could be opened via its share link. Only an
 * approved, live story passes here. Everything else is hidden:
 *   • pending            → isActive is false (not yet approved)
 *   • rejected           → rejectionStatus.isRejected
 *   • deactivated        → isDeactivated (admin toggled it off)
 *   • sent back to edit  → revisionStatus.needsRevision
 */
const PUBLIC_NEWS_SELECT = 'isActive isDeactivated rejectionStatus revisionStatus';

function isPublicNews(news) {
  if (!news) return false;
  if (news.isActive !== true) return false;
  if (news.isDeactivated === true) return false;
  if (news.rejectionStatus && news.rejectionStatus.isRejected === true) return false;
  if (news.revisionStatus && news.revisionStatus.needsRevision === true) return false;
  return true;
}

module.exports = { isPublicNews, PUBLIC_NEWS_SELECT };
