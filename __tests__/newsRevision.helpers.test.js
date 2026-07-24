'use strict';

const {
  captureRevisionSnapshot,
  buildChangeSummary,
  isNeedsRevision,
  stripReporterForbiddenFields,
  defaultRevisionStatus,
} = require('../services/newsRevision/revisionHelpers');

describe('newsRevision helpers', () => {
  test('defaultRevisionStatus has needsRevision false', () => {
    expect(defaultRevisionStatus().needsRevision).toBe(false);
  });

  test('isNeedsRevision reads revisionStatus.needsRevision', () => {
    expect(isNeedsRevision({ revisionStatus: { needsRevision: true } })).toBe(
      true
    );
    expect(isNeedsRevision({ revisionStatus: { needsRevision: false } })).toBe(
      false
    );
    expect(isNeedsRevision({})).toBe(false);
  });

  test('captureRevisionSnapshot freezes editable fields', () => {
    const snap = captureRevisionSnapshot(
      {
        title: '  Hello  ',
        content: 'Body',
        category: 'Politics',
        location: 'Hyderabad',
        mediaUrl: 'https://cdn.example/a.jpg',
        mediaType: 'image',
        imageUrls: ['https://cdn.example/a.jpg'],
        language: 'te',
      },
      2
    );
    expect(snap.title).toBe('Hello');
    expect(snap.round).toBe(2);
    expect(snap.capturedAt).toBeInstanceOf(Date);
    expect(snap.imageUrls).toEqual(['https://cdn.example/a.jpg']);
  });

  test('buildChangeSummary detects title/content/image changes', () => {
    const before = captureRevisionSnapshot(
      {
        title: 'Old',
        content: 'Old body',
        category: 'A',
        location: 'L1',
        mediaUrl: 'https://cdn.example/old.jpg',
        mediaType: 'image',
        imageUrls: ['https://cdn.example/old.jpg'],
      },
      1
    );
    const after = {
      title: 'New',
      content: 'New body',
      category: 'A',
      location: 'L1',
      mediaUrl: 'https://cdn.example/new.jpg',
      mediaType: 'image',
      imageUrls: ['https://cdn.example/new.jpg'],
    };
    const summary = buildChangeSummary(before, after, 1);
    expect(summary.changedFields).toEqual(
      expect.arrayContaining(['title', 'content', 'image'])
    );
    expect(summary.fields.title.changed).toBe(true);
    expect(summary.fields.content.beforeExcerpt).toContain('Old');
    expect(summary.fields.image.changed).toBe(true);
  });

  test('buildChangeSummary allows empty changedFields when unchanged', () => {
    const before = captureRevisionSnapshot(
      {
        title: 'Same',
        content: 'Same',
        category: 'A',
        location: 'L',
        mediaUrl: 'https://cdn.example/a.jpg',
        mediaType: 'image',
        imageUrls: ['https://cdn.example/a.jpg'],
      },
      1
    );
    const summary = buildChangeSummary(
      before,
      {
        title: 'Same',
        content: 'Same',
        category: 'A',
        location: 'L',
        mediaUrl: 'https://cdn.example/a.jpg',
        mediaType: 'image',
        imageUrls: ['https://cdn.example/a.jpg'],
      },
      1
    );
    expect(summary.changedFields).toEqual([]);
  });

  test('stripReporterForbiddenFields removes workflow fields', () => {
    const cleaned = stripReporterForbiddenFields({
      title: 'T',
      revisionStatus: { needsRevision: false },
      rejectionStatus: { isRejected: true },
      approvalStatus: { isApproved: true },
      actionHistory: [],
      isActive: true,
      authorId: 'x',
      publishedAt: new Date(),
      content: 'C',
    });
    expect(cleaned.title).toBe('T');
    expect(cleaned.content).toBe('C');
    expect(cleaned.revisionStatus).toBeUndefined();
    expect(cleaned.rejectionStatus).toBeUndefined();
    expect(cleaned.approvalStatus).toBeUndefined();
    expect(cleaned.actionHistory).toBeUndefined();
    expect(cleaned.isActive).toBeUndefined();
    expect(cleaned.authorId).toBeUndefined();
    expect(cleaned.publishedAt).toBeUndefined();
  });
});

describe('reporter edit lock rules (phase-1 contract)', () => {
  function canReporterEdit(news, canEditAny) {
    if (canEditAny) return true;
    if (news.isActive === true) return false;
    if (news.rejectionStatus && news.rejectionStatus.isRejected) return false;
    return news.revisionStatus && news.revisionStatus.needsRevision === true;
  }

  function canResubmit(news, isOwner) {
    if (!isOwner) return { ok: false, code: 403 };
    if (news.isActive === true) return { ok: false, code: 400 };
    if (news.rejectionStatus && news.rejectionStatus.isRejected) {
      return { ok: false, code: 400 };
    }
    if (!(news.revisionStatus && news.revisionStatus.needsRevision === true)) {
      return { ok: false, code: 409 };
    }
    return { ok: true, code: 200 };
  }

  test('pending without needsRevision is locked for reporters', () => {
    expect(
      canReporterEdit(
        {
          isActive: false,
          revisionStatus: { needsRevision: false },
        },
        false
      )
    ).toBe(false);
  });

  test('needsRevision unlocks reporter revision UI (resubmit path)', () => {
    expect(
      canReporterEdit(
        {
          isActive: false,
          revisionStatus: { needsRevision: true },
        },
        false
      )
    ).toBe(true);
  });

  test('admins can edit regardless of revisionStatus', () => {
    expect(
      canReporterEdit(
        {
          isActive: false,
          revisionStatus: { needsRevision: false },
        },
        true
      )
    ).toBe(true);
  });

  test('resubmit requires ownership + needsRevision', () => {
    const news = {
      isActive: false,
      revisionStatus: { needsRevision: true },
    };
    expect(canResubmit(news, true).ok).toBe(true);
    expect(canResubmit(news, false).code).toBe(403);
    expect(
      canResubmit(
        { ...news, revisionStatus: { needsRevision: false } },
        true
      ).code
    ).toBe(409);
    expect(canResubmit({ ...news, isActive: true }, true).code).toBe(400);
  });
});
