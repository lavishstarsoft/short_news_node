'use strict';

/**
 * News revision helpers (Needs Revision / Send Back for Edit).
 * Phase-1 backend: snapshot freeze on send-back, change summary on resubmit.
 */

const EDITABLE_SNAPSHOT_FIELDS = [
  'title',
  'content',
  'category',
  'location',
  'mediaUrl',
  'mediaType',
  'thumbnailUrl',
  'imageUrl',
  'imageUrls',
  'videoUrl',
  'scope',
  'language',
  'sourceLink',
  'readFullLink',
  'ePaperLink',
];

function normalizeText(value) {
  if (value == null) return '';
  return String(value).trim();
}

function normalizeUrlList(urls) {
  if (!Array.isArray(urls)) return [];
  return urls.map((u) => String(u || '').trim()).filter(Boolean);
}

function urlsEqual(a, b) {
  const left = normalizeUrlList(a);
  const right = normalizeUrlList(b);
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function captureRevisionSnapshot(news, round = 1) {
  const doc = news && typeof news.toObject === 'function' ? news.toObject() : news || {};
  return {
    title: normalizeText(doc.title),
    content: normalizeText(doc.content),
    category: normalizeText(doc.category),
    location: normalizeText(doc.location),
    mediaUrl: normalizeText(doc.mediaUrl),
    mediaType: normalizeText(doc.mediaType) || null,
    thumbnailUrl: normalizeText(doc.thumbnailUrl),
    imageUrl: normalizeText(doc.imageUrl),
    imageUrls: normalizeUrlList(doc.imageUrls),
    videoUrl: normalizeText(doc.videoUrl),
    scope: normalizeText(doc.scope) || null,
    language: normalizeText(doc.language) || null,
    sourceLink: normalizeText(doc.sourceLink),
    readFullLink: normalizeText(doc.readFullLink),
    ePaperLink: normalizeText(doc.ePaperLink),
    capturedAt: new Date(),
    round: Number(round) || 1,
  };
}

function excerpt(text, max = 160) {
  const s = normalizeText(text);
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function buildChangeSummary(beforeSnapshot, afterNews, round) {
  const before = beforeSnapshot || {};
  const after =
    afterNews && typeof afterNews.toObject === 'function'
      ? afterNews.toObject()
      : afterNews || {};

  const fields = {};
  const changedFields = [];

  const titleBefore = normalizeText(before.title);
  const titleAfter = normalizeText(after.title);
  const titleChanged = titleBefore !== titleAfter;
  fields.title = { changed: titleChanged, before: titleBefore, after: titleAfter };
  if (titleChanged) changedFields.push('title');

  const contentBefore = normalizeText(before.content);
  const contentAfter = normalizeText(after.content);
  const contentChanged = contentBefore !== contentAfter;
  fields.content = {
    changed: contentChanged,
    before: contentBefore,
    after: contentAfter,
    beforeExcerpt: excerpt(contentBefore),
    afterExcerpt: excerpt(contentAfter),
  };
  if (contentChanged) changedFields.push('content');

  const categoryBefore = normalizeText(before.category);
  const categoryAfter = normalizeText(after.category);
  const categoryChanged = categoryBefore !== categoryAfter;
  fields.category = {
    changed: categoryChanged,
    before: categoryBefore,
    after: categoryAfter,
  };
  if (categoryChanged) changedFields.push('category');

  const locationBefore = normalizeText(before.location);
  const locationAfter = normalizeText(after.location);
  const locationChanged = locationBefore !== locationAfter;
  fields.location = {
    changed: locationChanged,
    before: locationBefore,
    after: locationAfter,
  };
  if (locationChanged) changedFields.push('location');

  const beforeUrls = normalizeUrlList(
    before.imageUrls && before.imageUrls.length
      ? before.imageUrls
      : [before.mediaUrl || before.imageUrl].filter(Boolean)
  );
  const afterUrls = normalizeUrlList(
    after.imageUrls && after.imageUrls.length
      ? after.imageUrls
      : [after.mediaUrl || after.imageUrl].filter(Boolean)
  );
  const mediaBefore = normalizeText(before.mediaUrl || before.imageUrl);
  const mediaAfter = normalizeText(after.mediaUrl || after.imageUrl);
  const mediaTypeChanged =
    normalizeText(before.mediaType) !== normalizeText(after.mediaType);
  const imageChanged =
    !urlsEqual(beforeUrls, afterUrls) ||
    mediaBefore !== mediaAfter ||
    mediaTypeChanged ||
    normalizeText(before.thumbnailUrl) !== normalizeText(after.thumbnailUrl) ||
    normalizeText(before.videoUrl) !== normalizeText(after.videoUrl);
  fields.image = {
    changed: imageChanged,
    beforeUrls,
    afterUrls,
    beforeMediaUrl: mediaBefore,
    afterMediaUrl: mediaAfter,
    beforeMediaType: normalizeText(before.mediaType) || null,
    afterMediaType: normalizeText(after.mediaType) || null,
  };
  if (imageChanged) changedFields.push('image');

  return {
    round: Number(round) || 1,
    changedFields,
    fields,
    computedAt: new Date(),
  };
}

function getRevisionStatus(news) {
  return (news && news.revisionStatus) || {};
}

function isNeedsRevision(news) {
  return getRevisionStatus(news).needsRevision === true;
}

function defaultRevisionStatus() {
  return {
    needsRevision: false,
    remarks: null,
    sentBackBy: null,
    sentBackById: null,
    sentBackByRole: null,
    sentAt: null,
    revisionCount: 0,
    lastRevisionRound: 0,
    lastResubmitRound: 0,
    resubmittedAt: null,
    revisionSnapshot: null,
    lastChangeSummary: null,
  };
}

/** Strip revision/workflow fields reporters must not set via generic PUT. */
function stripReporterForbiddenFields(body) {
  if (!body || typeof body !== 'object') return body;
  const next = { ...body };
  delete next.revisionStatus;
  delete next.rejectionStatus;
  delete next.approvalStatus;
  delete next.actionHistory;
  delete next.isActive;
  delete next.authorId;
  delete next.publishedAt;
  return next;
}

module.exports = {
  EDITABLE_SNAPSHOT_FIELDS,
  captureRevisionSnapshot,
  buildChangeSummary,
  getRevisionStatus,
  isNeedsRevision,
  defaultRevisionStatus,
  stripReporterForbiddenFields,
};
