'use strict';

const mongoose = require('mongoose');
const {
  resolvePeriod, istDayStart, istDateStr, classifyArticle, aggregate, buildPdf, toSummaryJson, fontFor,
} = require('../services/reports/subEditorWorkReport');

const oidAt = (date) => mongoose.Types.ObjectId.createFromTime(Math.floor(new Date(date).getTime() / 1000));

describe('sub-editor work report — period (IST)', () => {
  test('single date = IST midnight to midnight', () => {
    const p = resolvePeriod({ date: '2026-09-11' });
    expect(p.start.toISOString()).toBe('2026-09-10T18:30:00.000Z');
    expect(p.end.toISOString()).toBe('2026-09-11T18:30:00.000Z');
    expect(p.days).toBe(1);
    expect(p.fromStr).toBe('2026-09-11');
  });
  test('default = today in IST', () => {
    const now = new Date('2026-09-11T20:00:00Z'); // 01:30 IST on the 12th
    expect(resolvePeriod({ now }).fromStr).toBe('2026-09-12');
  });
  test('range inclusive; invalid / too long rejected', () => {
    const p = resolvePeriod({ from: '2026-09-01', to: '2026-09-07' });
    expect(p.days).toBe(7);
    expect(() => resolvePeriod({ from: '2026-09-07', to: '2026-09-01' })).toThrow();
    expect(() => resolvePeriod({ from: '2026-01-01', to: '2026-06-01' })).toThrow(/too long/);
    expect(() => resolvePeriod({ date: '11-09-2026' })).toThrow();
  });
  test('istDateStr round-trips istDayStart', () => {
    expect(istDateStr(istDayStart('2026-09-11'))).toBe('2026-09-11');
  });
});

describe('sub-editor work report — classify + aggregate', () => {
  const period = resolvePeriod({ date: '2026-09-11' });
  const t = (h) => new Date(`2026-09-11T${String(h).padStart(2, '0')}:00:00+05:30`);
  const E1 = { _id: new mongoose.Types.ObjectId(), name: 'Ravi', username: 'ravi', isActive: true };
  const E2 = { _id: new mongoose.Types.ObjectId(), name: 'Sita', username: 'sita', isActive: true };
  const a1 = String(E1._id); const a2 = String(E2._id);

  const docs = [
    // posted + published same day, 20 min later
    { _id: oidAt(t(9)), title: 'హెచ్-1బీ వీసా', language: 'te', category: 'Business', authorId: a1, isActive: true, aiStatus: 'verified', views: 120,
      actionHistory: [{ action: 'approved', performedAt: new Date(t(9).getTime() + 20 * 60000), performedByName: 'Ravi', performedByRole: 'Sub Editor' }] },
    // posted, AI flagged, published anyway by superadmin (marker)
    { _id: oidAt(t(10)), title: 'Duplicate one', language: 'hi', category: 'Politics', authorId: a1, isActive: true, aiStatus: 'verified',
      duplicateCheck: { isDuplicate: true, score: 96, matchCount: 1, similarArticles: [{ title: 'Original', authorEmail: 'x@y.com' }] },
      actionHistory: [{ action: 'approved', performedAt: t(11), performedByName: 'boss', performedByRole: 'Admin', metadata: { aiOverride: true } }] },
    // posted, AI flagged, deleted by superadmin
    { _id: oidAt(t(12)), title: 'Dup two', language: 'te', category: 'Crime', authorId: a1, isActive: false, isDeactivated: true, aiStatus: 'review_required',
      duplicateCheck: { isDuplicate: true, score: 91 }, actionHistory: [{ action: 'deleted', performedAt: t(13), performedByName: 'boss' }] },
    // posted, still waiting in AI review
    { _id: oidAt(t(14)), title: 'Waiting', language: 'te', category: 'Crime', authorId: a2, isActive: false, aiStatus: 'review_required', duplicateCheck: { isSuspicious: true, score: 88 }, actionHistory: [] },
    // posted YESTERDAY, edited + published today (counts as published/edited, not posted)
    { _id: oidAt(new Date('2026-09-10T15:00:00+05:30')), title: 'Old one', language: 'en', category: 'Sports', authorId: a2, isActive: true, aiStatus: 'verified',
      actionHistory: [{ action: 'updated', performedAt: t(8), performedByName: 'boss', metadata: { changedFields: ['title'] } }, { action: 'approved', performedAt: t(8), performedByName: 'boss' }] },
    // posted, sent back then auto-rejected
    { _id: oidAt(t(15)), title: 'Stale', language: 'te', category: 'Politics', authorId: a2, isActive: false, rejectionStatus: { isRejected: true, reason: 'No Response to Revision Request' },
      actionHistory: [{ action: 'needs_revision', performedAt: t(15) }, { action: 'rejected', performedAt: t(16), performedByName: 'System (Auto)', performedByRole: 'system' }] },
    // posted in period but by an unknown author → ignored
    { _id: oidAt(t(16)), title: 'Ghost', language: 'te', category: 'X', authorId: 'nobody', isActive: false, actionHistory: [] },
    // self-published (AI gate passed, no 'approved' entry) with a noisy legacy
    // duplicateCheck flag → counts as published, NOT as AI flagged
    { _id: oidAt(t(17)), title: 'Self published', language: 'en', category: 'News', authorId: a2, isActive: true, aiStatus: 'verified',
      duplicateCheck: { isSuspicious: true, score: 65 }, actionHistory: [] },
  ];

  const classified = docs.map((d) => classifyArticle(d, period));
  const agg = aggregate(classified, [E1, E2]);

  test('classification basics', () => {
    expect(classified[0].postedInPeriod).toBe(true);
    expect(classified[0].minutesToPublish).toBe(20);
    expect(classified[1].publishedAnyway).toBe(true);
    expect(classified[1].aiFlagged).toBe(true);
    expect(classified[2].status).toBe('deleted');
    expect(classified[2].deletedBy).toBe('boss');
    expect(classified[4].postedInPeriod).toBe(false);
    expect(classified[4].publishedInPeriod).toBe(true);
    expect(classified[4].edits[0].fields).toEqual(['title']);
    expect(classified[5].autoRejected).toBe(true);
    expect(classified[5].status).toBe('rejected');
    expect(classified[7].publishedInPeriod).toBe(true);
    expect(classified[7].aiFlagged).toBe(false);
    expect(classified[7].publishedAnyway).toBe(false);
  });

  test('per editor + totals', () => {
    const ravi = agg.rows.find((r) => r.name === 'Ravi');
    const sita = agg.rows.find((r) => r.name === 'Sita');
    expect(ravi.posted).toBe(3);
    expect(ravi.published).toBe(2);
    expect(ravi.aiFlagged).toBe(2);
    expect(ravi.publishedAnyway).toBe(1);
    expect(ravi.deleted).toBe(1);
    expect(ravi.duplicateRate).toBe(67);
    expect(ravi.avgPublishMinutes).toBe(40); // (20 + 60) / 2
    expect(ravi.languages).toEqual(['hi', 'te']);
    expect(ravi.rank).toBe(1);
    expect(sita.posted).toBe(3);
    expect(sita.published).toBe(2); // 'Old one' approved today + self-published
    expect(sita.edited).toBe(1);
    expect(sita.sentBack).toBe(1);
    expect(sita.rejected).toBe(1);
    expect(sita.autoRejected).toBe(1);
    expect(sita.pendingNow).toBe(1);
    expect(agg.totals.posted).toBe(6);
    expect(agg.totals.byLanguage).toEqual({ te: 4, hi: 1, en: 1 });
    expect(agg.totals.hours[9]).toBe(1);
    expect(agg.duplicates.length).toBe(3);
    expect(agg.deletes.length).toBe(1);
    expect(agg.edits.length).toBe(1);
    expect(agg.rejects.length).toBe(1);
    expect(agg.topViewed[0].title).toBe('హెచ్-1బీ వీసా');
    expect(agg.zeroActivity).toEqual([]);
  });

  test('zero-activity editor is listed', () => {
    const E3 = { _id: new mongoose.Types.ObjectId(), name: 'Idle', isActive: true };
    const a = aggregate(classified, [E1, E2, E3]);
    expect(a.zeroActivity.map((r) => r.name)).toEqual(['Idle']);
    expect(a.rows.find((r) => r.name === 'Idle').rank).toBe(null);
  });

  test('summary json is plain and has no hours', () => {
    const s = toSummaryJson({ ...agg, repeatOffenders: [] }, period);
    expect(s.totals.hours).toBeUndefined();
    expect(s.rows[0].name).toBe('Ravi');
    expect(s.counts.duplicates).toBe(3);
  });

  test('PDF renders (multi-section) without throwing and has ≥ 1 page', async () => {
    const data = { ...agg, editors: [E1, E2], articles: classified, repeatOffenders: [{ authorId: a1, name: 'Ravi', days: 3 }] };
    const { doc, reportId } = buildPdf(data, { period, generatedBy: 'test', filters: {} });
    expect(reportId).toMatch(/^SEWR-\d{12}-[0-9A-F]{4}$/);
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    const done = new Promise((r) => doc.on('end', r));
    doc.end();
    await done;
    const buf = Buffer.concat(chunks);
    expect(buf.slice(0, 5).toString()).toBe('%PDF-');
    expect((buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length).toBeGreaterThanOrEqual(1);
  });
});

describe('sub-editor work report — font fallback', () => {
  test('Telugu → Telugu font when available; unknown script → marker; Latin → Helvetica', () => {
    expect(fontFor('హెచ్-1బీ', false, { telugu: true }).font).toBe('F_telugu');
    expect(fontFor('हिंदी शीर्षक', true, { telugu: true }).text).toMatch(/devanagari text/);
    expect(fontFor('Plain title', true, {}).font).toBe('Helvetica-Bold');
    expect(fontFor('emoji 🙂 here', false, {}).text).toBe('emoji ?? here');
    // ZWJ (crashes the shaper) is stripped; ZWNJ is kept
    expect(fontFor('క్ష‍త్రియ', false, { telugu: true }).text).toBe('క్షత్రియ');
    expect(fontFor('హెచ్‌-1బీ', false, { telugu: true }).text).toBe('హెచ్‌-1బీ');
  });
  test('shapeSafe patches only the word fontkit cannot shape (Telugu BRICS)', () => {
    const PDFDocument = require('pdfkit');
    const path = require('path');
    const doc = new PDFDocument();
    doc.on('data', () => {});
    doc.registerFont('T', path.join(__dirname, '..', 'assets', 'fonts', 'NotoSansTelugu-Regular.ttf'));
    doc.font('T').fontSize(9);
    const { makeShapeSafe } = require('../services/reports/subEditorWorkReport');
    const safe = makeShapeSafe(doc);
    const out = safe('బ్రిక్స్ సదస్సు కోసం ఢిల్లీకి');
    expect(out).toContain('సదస్సు కోసం ఢిల్లీకి'); // untouched words
    expect(out.startsWith('బ్రిక్స్')).toBe(false); // patched word
    expect(out).toMatch(/^బ్‌రిక్‌స్‌ /);
    expect(() => doc.widthOfString(out)).not.toThrow();
    expect(safe('plain words')).toBe('plain words');
  });
  test('the ZWJ title that crashed fontkit now renders', async () => {
    const period = resolvePeriod({ date: '2026-09-11' });
    const E = { _id: new mongoose.Types.ObjectId(), name: 'Z', isActive: true };
    const doc0 = { _id: oidAt(new Date('2026-09-11T10:00:00+05:30')), title: 'క్ష‍త్రియ 🙂 ﻿test', language: 'te', category: 'News', authorId: String(E._id), isActive: false, aiStatus: 'review_required', duplicateCheck: { isDuplicate: true, score: 90 }, actionHistory: [] };
    const cl = [classifyArticle(doc0, period)];
    const { doc } = buildPdf({ ...aggregate(cl, [E]), editors: [E], articles: cl, repeatOffenders: [] }, { period });
    const done = new Promise((r) => doc.on('end', r)); doc.on('data', () => {}); doc.end(); await done;
  });
});
