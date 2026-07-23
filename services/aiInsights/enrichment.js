'use strict';

/**
 * Resolve reporter / sub-editor display names for a News document + Admin map.
 * Advisory enrichment only — no verdicts.
 */
function enrichNewsActors(news, adminById) {
  const authorId = news.authorId != null ? String(news.authorId) : null;
  const authorAdmin = authorId ? adminById.get(authorId) : null;
  const authorRole = authorAdmin?.role || null;
  const authorName =
    authorAdmin?.username || news.author || news.authorName || 'Unknown';

  let reporterName = null;
  let reporterId = null;
  let subEditorName = null;
  let subEditorId = null;

  if (authorRole === 'subeditor') {
    subEditorName = authorName;
    subEditorId = authorId;
    reporterName = null;
    reporterId = null;
  } else if (authorRole === 'editor' || authorRole === 'reporter' || !authorRole) {
    // Direct reporters often use role "editor" in this codebase
    reporterName = authorName;
    reporterId = authorId;
  } else if (authorRole === 'admin' || authorRole === 'superadmin') {
    subEditorName = authorName;
    subEditorId = authorId;
  } else {
    reporterName = authorName;
    reporterId = authorId;
  }

  const approvedBy = news.approvalStatus?.approvedBy || null;
  const approvedByRole = (news.approvalStatus?.approvedByRole || '').toLowerCase();
  if (
    !subEditorName &&
    approvedBy &&
    (approvedByRole.includes('sub') || approvedByRole.includes('admin'))
  ) {
    subEditorName = approvedBy;
  }

  return {
    reporterName,
    reporterId,
    subEditorName,
    subEditorId,
  };
}

module.exports = {
  enrichNewsActors,
};
