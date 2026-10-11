'use strict';

const {
  checkDuplicateFast,
  isRecurringTopic,
  cosineSimilarity,
} = require('../utils/similarityDetector');
const {
  computeScore,
  tierFor,
} = require('../services/integrity/reporterReliabilityService');

// Helper: build a corpus article
const A = (id, title, content, extra = {}) => ({
  _id: id,
  title,
  content,
  language: 'te',
  author: extra.author || 'r1',
  publishedAt: new Date(),
  location: extra.location || 'Hyderabad',
  category: extra.category || 'News',
});

const bodyTe =
  'హైదరాబాద్‌లో ఒక మహిళ అనుమానాస్పద స్థితిలో మృతి చెందింది పోలీసులు కేసు నమోదు చేసి దర్యాప్తు చేస్తున్నారు కుటుంబ సభ్యులు ఆందోళన వ్యక్తం చేశారు మృతురాలి భర్తను అదుపులోకి తీసుకున్నారు';

describe('Enhanced duplicate detection (text layer)', () => {
  test('exact same title + content → duplicate', () => {
    const res = checkDuplicateFast(
      { title: 'మహిళ అనుమానాస్పద మృతి', content: bodyTe, language: 'te' },
      [A('o1', 'మహిళ అనుమానాస్పద మృతి', bodyTe)]
    );
    expect(res.length).toBe(1);
    expect(res[0].isDuplicate).toBe(true);
  });

  test('HEADLINE CHANGED but same body → still detected (was missed before)', () => {
    // Completely different headline, identical body.
    const res = checkDuplicateFast(
      { title: 'సంచలనం రేపిన ఘటన నగరంలో కలకలం', content: bodyTe, language: 'te' },
      [A('o1', 'మహిళ అనుమానాస్పద మృతి', bodyTe)]
    );
    expect(res.length).toBe(1);
    // body near-identical ⇒ duplicate (content>=85 rule) or at least suspicious
    expect(res[0].isDuplicate || res[0].isSuspicious).toBe(true);
  });

  test('reporter A vs reporter B same story → detected (author-agnostic)', () => {
    const res = checkDuplicateFast(
      { title: 'మహిళ అనుమానాస్పద మృతి', content: bodyTe, language: 'te', author: 'B' },
      [A('o1', 'మహిళ అనుమానాస్పద మృతి', bodyTe, { author: 'A' })]
    );
    expect(res.length).toBe(1);
    expect(res[0].isDuplicate).toBe(true);
  });

  test('genuinely different story → NOT flagged', () => {
    const other =
      'విజయవాడలో భారీ వర్షాలకు రహదారులు జలమయమయ్యాయి ట్రాఫిక్ స్తంభించింది ప్రజలు తీవ్ర ఇబ్బందులు పడ్డారు మున్సిపల్ సిబ్బంది రంగంలోకి దిగారు';
    const res = checkDuplicateFast(
      { title: 'మహిళ అనుమానాస్పద మృతి', content: bodyTe, language: 'te' },
      [A('o1', 'భారీ వర్షాలు ట్రాఫిక్ జామ్', other)]
    );
    const flagged = res.some((r) => r.isDuplicate || r.isSuspicious);
    expect(flagged).toBe(false);
  });

  test('recurring topic detection', () => {
    expect(isRecurringTopic({ title: 'ఈరోజు బంగారం ధరలు' })).toBe(true);
    expect(isRecurringTopic({ title: 'కూరగాయల ధరలు నేటి రేట్లు' })).toBe(true);
    expect(isRecurringTopic({ title: 'మహిళ అనుమానాస్పద మృతి' })).toBe(false);
  });

  test('recurring gold price with DIFFERENT numbers → not hard-duplicate', () => {
    const t1 = 'ఈరోజు బంగారం ధర 10 గ్రాములు 75000 రూపాయలు వెండి ధర 95000';
    const t2 = 'ఈరోజు బంగారం ధర 10 గ్రాములు 78000 రూపాయలు వెండి ధర 97000';
    const res = checkDuplicateFast(
      { title: 'బంగారం ధరలు', content: t2, language: 'te', category: 'business' },
      [A('o1', 'బంగారం ధరలు', t1, { category: 'business' })]
    );
    // Must NOT be a hard duplicate (numbers differ, recurring guard downgrades).
    const hard = res.some((r) => r.isDuplicate);
    expect(hard).toBe(false);
  });

  test('recurring guard: numbers actually change similarity', () => {
    const withNums1 = 'ధర 75000 రూపాయలు మార్కెట్ స్థిరంగా ఉంది';
    const withNums2 = 'ధర 99000 రూపాయలు మార్కెట్ స్థిరంగా ఉంది';
    const keep = cosineSimilarity(withNums1, withNums2, { keepNumbers: true });
    const drop = cosineSimilarity(withNums1, withNums2, { keepNumbers: false });
    // keeping numbers should NOT be higher than dropping them (different numbers
    // add non-matching tokens → equal or lower similarity).
    expect(keep).toBeLessThanOrEqual(drop);
  });
});

describe('Reporter reliability scoring', () => {
  test('insufficient data → null score', () => {
    expect(computeScore({ totalSubmissions: 2, exactDuplicates: 1 })).toBeNull();
  });

  test('clean reporter → high score / trusted', () => {
    const s = computeScore({
      totalSubmissions: 50,
      approved: 48,
      rejected: 0,
      exactDuplicates: 0,
      nearDuplicates: 0,
      suspiciousCount: 0,
    });
    expect(s).toBeGreaterThanOrEqual(90);
    expect(tierFor(s)).toBe('trusted');
  });

  test('AI-only suspicious barely dents score (light weight)', () => {
    const s = computeScore({
      totalSubmissions: 50,
      approved: 40,
      rejected: 0,
      exactDuplicates: 0,
      nearDuplicates: 0,
      suspiciousCount: 25, // 50% suspicious
    });
    // 50% suspicious ⇒ only ~1pt penalty (2 * 0.5). Stays trusted.
    expect(s).toBeGreaterThanOrEqual(80);
  });

  test('exact duplicates penalise heavily', () => {
    const sClean = computeScore({ totalSubmissions: 50, approved: 25, exactDuplicates: 0, nearDuplicates: 0, rejected: 0, suspiciousCount: 0 });
    const sDup = computeScore({ totalSubmissions: 50, approved: 25, exactDuplicates: 25, nearDuplicates: 25, rejected: 0, suspiciousCount: 0 });
    expect(sClean - sDup).toBeGreaterThanOrEqual(5); // exact 50% ⇒ ≥6pt drop
    expect(sDup).toBeLessThan(sClean);
  });

  test('tier boundaries', () => {
    expect(tierFor(85)).toBe('trusted');
    expect(tierFor(60)).toBe('watch');
    expect(tierFor(40)).toBe('review');
    expect(tierFor(10)).toBe('high_risk');
    expect(tierFor(null)).toBe('insufficient_data');
  });
});
