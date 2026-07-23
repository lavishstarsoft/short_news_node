'use strict';

/**
 * Map advisory AI /v1/detect payload → legacy duplicateCheck shape
 * used by newsController (identical API fields for clients).
 */

const MEDIA_METHODS = new Set([
  'url',
  'bytes',
  'phash',
  'dhash',
  'openclip',
  'ann',
  'media',
  'image',
]);

function buildMatchReason(hasImage, hasContent) {
  if (hasImage && hasContent) {
    return {
      matchSource: 'both',
      reasonLabel: 'Image + Content',
      reasonMessage:
        'Same/similar image and similar text content were both detected.',
    };
  }
  if (hasImage) {
    return {
      matchSource: 'image',
      reasonLabel: 'Image',
      reasonMessage:
        'Same or very similar image detected (title/content may be different).',
    };
  }
  return {
    matchSource: 'content',
    reasonLabel: 'Content',
    reasonMessage: 'Similar title or text content detected.',
  };
}

function textScoresIndicateContent(sim) {
  if (!sim || typeof sim !== 'object') return false;
  const title = typeof sim.title === 'number' ? sim.title : 0;
  const content = typeof sim.content === 'number' ? sim.content : 0;
  const keywords = typeof sim.keywords === 'number' ? sim.keywords : 0;
  return title > 0 || content > 0 || keywords > 0;
}

function mapAiResponseToDuplicateCheck(aiData, candidates = []) {
  const byId = new Map(
    (candidates || []).map((c) => [String(c.id), c])
  );

  const media = (aiData && aiData.media) || {};
  const mediaDup = media.duplicate === true || media.matched === true;
  const mediaId =
    media.matchedNewsId != null ? String(media.matchedNewsId) : null;
  const mediaMethod = media.method || 'image';
  const mediaScore =
    typeof media.similarity === 'number'
      ? media.similarity
      : typeof media.score === 'number'
        ? media.score
        : mediaDup
          ? 100
          : 0;

  const similarById = new Map();
  let hasImage = false;
  let hasContent = false;

  function upsertMatch(entry) {
    const id = entry.articleId != null ? String(entry.articleId) : null;
    if (!id) {
      return;
    }
    const existing = similarById.get(id);
    if (!existing) {
      similarById.set(id, entry);
      return;
    }
    // Merge sources when same article matched on both layers
    const sources = new Set(
      [existing.matchSource, entry.matchSource].filter(Boolean)
    );
    if (sources.has('image') && sources.has('content')) {
      existing.matchSource = 'both';
      existing.matchType = existing.matchType || entry.matchType;
      existing.reasonLabel = 'Image + Content';
    } else if (!existing.matchSource) {
      existing.matchSource = entry.matchSource;
      existing.matchType = entry.matchType || existing.matchType;
      existing.reasonLabel = entry.reasonLabel || existing.reasonLabel;
    }
    const prev =
      existing.similarity && typeof existing.similarity.overall === 'number'
        ? existing.similarity.overall
        : 0;
    const next =
      entry.similarity && typeof entry.similarity.overall === 'number'
        ? entry.similarity.overall
        : 0;
    if (next > prev) {
      existing.similarity = entry.similarity;
    }
    existing.isDuplicate = existing.isDuplicate || entry.isDuplicate;
    existing.isSuspicious = existing.isSuspicious || entry.isSuspicious;
  }

  // 1) Explicit media hit
  if (mediaDup && mediaId) {
    hasImage = true;
    const cand = byId.get(mediaId) || {};
    upsertMatch({
      articleId: mediaId,
      articleTitle: cand.title || '',
      content: cand.content || '',
      publishedAt: cand.publishedAt || null,
      author: cand.author || null,
      category: cand.category || null,
      location: cand.location || null,
      similarity: {
        title: 0,
        content: 0,
        keywords: 0,
        overall: mediaScore || 100,
      },
      isDuplicate:
        mediaMethod === 'url' ||
        mediaMethod === 'bytes' ||
        mediaScore >= 85,
      isSuspicious: mediaScore >= 70 && mediaScore < 85,
      matchSource: 'image',
      matchType: mediaMethod,
      reasonLabel: 'Image',
    });
  }

  // 2) Exact text hash (skip if this exact row is only the media-promoted one)
  if (aiData.exact && aiData.exact.matched && aiData.exact.matched_candidate_id) {
    const id = String(aiData.exact.matched_candidate_id);
    const isMediaPromotedExact = mediaDup && mediaId && id === mediaId;
    if (!isMediaPromotedExact) {
      hasContent = true;
      const cand = byId.get(id) || {};
      upsertMatch({
        articleId: id,
        articleTitle: cand.title || '',
        content: cand.content || '',
        publishedAt: cand.publishedAt || null,
        author: cand.author || null,
        category: cand.category || null,
        location: cand.location || null,
        similarity: {
          title: 100,
          content: 100,
          keywords: 100,
          overall: 100,
        },
        isDuplicate: true,
        isSuspicious: false,
        matchSource: 'content',
        matchType: 'text_exact',
        reasonLabel: 'Content',
      });
    }
  }

  // 3) Near text / media-injected near rows
  for (const m of (aiData.near && aiData.near.matches) || []) {
    const id = m.candidate_id != null ? String(m.candidate_id) : null;
    if (!id) continue;
    const cand = byId.get(id) || {};
    const label = m.label || '';
    const similarity = {
      title: typeof m.title_score === 'number' ? m.title_score : 0,
      content: typeof m.content_score === 'number' ? m.content_score : 0,
      keywords: typeof m.keyword_score === 'number' ? m.keyword_score : 0,
      overall: typeof m.score === 'number' ? m.score : 0,
    };
    const looksLikeMediaInject =
      (mediaDup && mediaId && id === mediaId && !textScoresIndicateContent(similarity)) ||
      (similarity.title === 0 &&
        similarity.content === 0 &&
        similarity.keywords === 0 &&
        mediaDup &&
        mediaId === id);

    if (looksLikeMediaInject) {
      hasImage = true;
      upsertMatch({
        articleId: id,
        articleTitle: cand.title || '',
        content: cand.content || '',
        publishedAt: cand.publishedAt || null,
        author: cand.author || null,
        category: cand.category || null,
        location: cand.location || null,
        similarity,
        isDuplicate: label === 'exact_duplicate' || label === 'very_similar',
        isSuspicious: label === 'possible_duplicate',
        matchSource: 'image',
        matchType: mediaMethod || 'media',
        reasonLabel: 'Image',
      });
    } else {
      hasContent = true;
      upsertMatch({
        articleId: id,
        articleTitle: cand.title || '',
        content: cand.content || '',
        publishedAt: cand.publishedAt || null,
        author: cand.author || null,
        category: cand.category || null,
        location: cand.location || null,
        similarity,
        isDuplicate: label === 'exact_duplicate' || label === 'very_similar',
        isSuspicious: label === 'possible_duplicate',
        matchSource: 'content',
        matchType: 'text_near',
        reasonLabel: 'Content',
      });
    }
  }

  const similarArticles = Array.from(similarById.values());
  // Prefer image / both first for admin visibility
  similarArticles.sort((a, b) => {
    const rank = (s) =>
      s.matchSource === 'both' ? 0 : s.matchSource === 'image' ? 1 : 2;
    const rd = rank(a) - rank(b);
    if (rd !== 0) return rd;
    const sa = (a.similarity && a.similarity.overall) || 0;
    const sb = (b.similarity && b.similarity.overall) || 0;
    return sb - sa;
  });

  for (const row of similarArticles) {
    if (row.matchSource === 'both') {
      hasImage = true;
      hasContent = true;
      row.reasonLabel = 'Image + Content';
    } else if (row.matchSource === 'image') {
      hasImage = true;
    } else if (row.matchSource === 'content') {
      hasContent = true;
    } else if (row.matchType && MEDIA_METHODS.has(String(row.matchType))) {
      row.matchSource = 'image';
      row.reasonLabel = 'Image';
      hasImage = true;
    } else {
      row.matchSource = row.matchSource || 'content';
      row.reasonLabel = row.reasonLabel || 'Content';
      hasContent = true;
    }
  }

  const overall = (aiData && aiData.overall) || {};
  const isDuplicate =
    overall.is_duplicate === true ||
    (mediaDup &&
      (mediaMethod === 'url' ||
        mediaMethod === 'bytes' ||
        mediaScore >= 85));
  const isSuspicious =
    !isDuplicate &&
    (overall.is_suspicious === true ||
      (mediaDup && mediaScore >= 70));

  const reason = buildMatchReason(
    hasImage || (mediaDup && isDuplicate),
    hasContent ||
      (!mediaDup && (isDuplicate || isSuspicious || similarArticles.length > 0))
  );

  // If only media flagged overall but no rows, still expose image reason
  if ((isDuplicate || isSuspicious) && !hasImage && !hasContent && mediaDup) {
    Object.assign(reason, buildMatchReason(true, false));
  }

  const mediaPassAt =
    media.query_sha256 ||
    media.querySha256 ||
    media.query_phash ||
    media.queryPhash ||
    mediaDup
      ? new Date()
      : null;

  const score = isDuplicate
    ? Math.max(
        typeof overall.score === 'number' ? overall.score : 0,
        mediaScore,
        ...similarArticles.map((s) =>
          s.similarity && typeof s.similarity.overall === 'number'
            ? s.similarity.overall
            : 0
        )
      )
    : typeof overall.score === 'number'
      ? overall.score
      : 0;

  return {
    isDuplicate,
    isSuspicious,
    score,
    matchCount: similarArticles.length,
    checkedAt: new Date(),
    mediaPassAt,
    matchSource: reason.matchSource,
    reasonLabel: reason.reasonLabel,
    reasonMessage: reason.reasonMessage,
    similarArticles: similarArticles.slice(0, 5),
  };
}

module.exports = {
  mapAiResponseToDuplicateCheck,
  buildMatchReason,
};
