'use strict';

/**
 * Phase-0 Same-Event SHADOW — deterministic regression tests.
 *
 * These exercise the evaluator end-to-end with INJECTED fake News/NewsVector
 * and injected query embeddings (no DB, no AI). Semantic vectors are crafted so
 * that same-topic/different-event pairs score BELOW dupStrong (mirroring the
 * real e5 behaviour noted in semanticDecisionService), so discrimination comes
 * from the shared-facts / geo / date signals — exactly what Phase 0 measures.
 *
 * Nothing here writes to any DB; the evaluator is compute-only by construction.
 */

const { evaluateShadow } = require('../services/aiDuplicate/sameEvent/shadowEvaluator');
const { loadThresholds } = require('../services/aiDuplicate/semantic/semanticDecisionService');

const EV = 'e5s-v1';
const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 8, 15, 6, 0, 0); // 15 Sep 2026

const cfg = {
  windowDays: 400,
  dateWindowDays: 3,
  maxVectorCandidates: 6000,
  maxEventCandidates: 300,
  maxTotalCandidates: 800,
  topK: 5,
  geoGuardMin: 0.34,
  dateGuardMin: 0.5,
};
const thresholds = loadThresholds({});

// ---- semantic vectors: [imm, acc, wea, wed, transfer, adil, niz, other] ----
const V = {
  immAdil:  [0.95, 0, 0, 0, 0, 0.30, 0,    0.05],
  immAdil2: [0.95, 0, 0, 0, 0, 0.30, 0,    0.12], // same event, reworded (detail differs)
  immNiz:   [0.95, 0, 0, 0, 0, 0,    0.30, 0.05], // same topic, different district
  accAdil:  [0,    0.95, 0, 0, 0, 0.30, 0,  0.05],
  wedAdil:  [0, 0, 0.95, 0, 0, 0.30, 0,     0.05],
  transfer: [0, 0, 0, 0, 0.95, 0.30, 0,     0.05],
  weaKar:   [0, 0, 0.95, 0, 0, 0, 0,        0.20],
};

// ---- text fixtures (short, realistic Telugu) ----
const T = {
  immAdil: {
    title: 'ఆదిలాబాద్: నిమర్జనం ప్రదేశాలలో ప్రత్యేక బందోబస్తు',
    content:
      'ఆదిలాబాద్ జిల్లాలో నిమర్జనం ప్రదేశాలలో ప్రత్యేక బందోబస్తు ఏర్పాటు చేశామని ఎస్పీ అఖిల్ మహాజన్ తెలిపారు. చాంద, పెనుగంగ ప్రదేశాలలో మహిళా సిబ్బందిని కేటాయించారు.',
  },
  immAdilReworded: {
    title: 'నిమర్జనం వేళ ఆదిలాబాద్‌లో కట్టుదిట్టమైన భద్రత',
    content:
      'ఆదిలాబాద్ జిల్లాలో గణేష్ నిమర్జనం సందర్భంగా ఎస్పీ అఖిల్ మహాజన్ ఆధ్వర్యంలో పటిష్ట బందోబస్తు. చాంద, పెనుగంగ వద్ద మహిళా పోలీసులను మోహరించారు.',
  },
  immNiz: {
    title: 'నిజామాబాద్: నిమర్జనం ఘాట్‌ల వద్ద బందోబస్తు',
    content:
      'నిజామాబాద్ జిల్లాలో నిమర్జనం ఘాట్‌ల వద్ద ప్రత్యేక బందోబస్తు ఏర్పాటు చేశామని ఎస్పీ రవీందర్ తెలిపారు.',
  },
  accAdil: {
    title: 'ఆదిలాబాద్: రోడ్డు ప్రమాదంలో ముగ్గురు మృతి',
    content: 'ఆదిలాబాద్ జిల్లాలో ఘోర రోడ్డు ప్రమాదంలో ముగ్గురు మృతి చెందారు.',
  },
  wedAdil: {
    title: 'ఆదిలాబాద్: వివాహ వేడుకకు ప్రత్యేక ఏర్పాట్లు',
    content: 'ఆదిలాబాద్‌లో ఘనంగా వివాహ వేడుక జరిగింది, ప్రత్యేక ఏర్పాట్లు చేశారు.',
  },
  transfer: {
    title: 'ఆదిలాబాద్ ఎస్పీ అఖిల్ మహాజన్ బదిలీ',
    content: 'ఆదిలాబాద్ ఎస్పీ అఖిల్ మహాజన్ బదిలీ అయ్యారు. కొత్త ఎస్పీ నియామకం జరిగింది.',
  },
  immAdil2025: {
    title: 'ఆదిలాబాద్: 2025 నిమర్జనం బందోబస్తు',
    content: '2025 సంవత్సరంలో ఆదిలాబాద్ జిల్లాలో నిమర్జనం బందోబస్తు ఏర్పాటు చేశారు, ఎస్పీ అఖిల్ మహాజన్.',
  },
  immAdil2026: {
    title: 'ఆదిలాబాద్: 2026 నిమర్జనం బందోబస్తు',
    content: '2026 సంవత్సరంలో ఆదిలాబాద్ జిల్లాలో నిమర్జనం బందోబస్తు ఏర్పాటు చేశారు, ఎస్పీ అఖిల్ మహాజన్.',
  },
  weaKar: {
    title: 'కరీంనగర్: వాతావరణం చల్లగా',
    content: 'కరీంనగర్ జిల్లాలో వాతావరణం చల్లగా మారింది, వర్షాలు కురిశాయి.',
  },
};

let seq = 1;
function mk(id, textKey, over = {}) {
  return Object.assign(
    {
      _id: id,
      title: T[textKey].title,
      content: T[textKey].content,
      author: 'Reporter ' + id,
      authorId: 'auth-' + id,
      location: 'Adilabad',
      scope: 'district',
      language: 'te',
      publishedAt: new Date(NOW - DAY),
      isActive: true,
      rejectionStatus: { isRejected: false },
      contentHash: 'h-' + id,
    },
    over
  );
}

// ---- fake models -----------------------------------------------------------
function fakeNews(docs) {
  return {
    find(q = {}) {
      let rows = docs.slice();
      if (q._id && q._id.$in) {
        const ids = q._id.$in.map(String);
        rows = rows.filter((d) => ids.includes(String(d._id)));
      }
      if (q.language) rows = rows.filter((d) => d.language === q.language);
      if (q.publishedAt && q.publishedAt.$gte) {
        const s = new Date(q.publishedAt.$gte).getTime();
        rows = rows.filter((d) => new Date(d.publishedAt).getTime() >= s);
      }
      const qb = {
        select() { return qb; },
        sort() { return qb; },
        limit(n) { qb._n = n; return qb; },
        lean() { return Promise.resolve(typeof qb._n === 'number' ? rows.slice(0, qb._n) : rows); },
      };
      return qb;
    },
  };
}
function fakeNewsVector(vecs) {
  return {
    find(q = {}) {
      let rows = vecs.slice();
      if (q.status) rows = rows.filter((v) => v.status === q.status);
      if (q.language) rows = rows.filter((v) => v.language === q.language);
      if (q.embeddingVersion) rows = rows.filter((v) => v.embeddingVersion === q.embeddingVersion);
      if (q.publishedAt && q.publishedAt.$gte) {
        const s = new Date(q.publishedAt.$gte).getTime();
        rows = rows.filter((v) => new Date(v.publishedAt).getTime() >= s);
      }
      const qb = {
        select() { return qb; },
        sort() { return qb; },
        limit(n) { qb._n = n; return qb; },
        lean() { return Promise.resolve(typeof qb._n === 'number' ? rows.slice(0, qb._n) : rows); },
      };
      return qb;
    },
  };
}

/**
 * Run the shadow evaluator for `current` against `candidates`.
 * candidates: [{ doc, emb }]. `current`: { doc, emb }.
 */
async function run(current, candidates, prodDup = null) {
  const news = fakeNews(candidates.map((c) => c.doc));
  const nv = fakeNewsVector(
    candidates
      .filter((c) => c.emb)
      .map((c) => ({
        newsId: c.doc._id,
        embedding: c.emb,
        publishedAt: c.doc.publishedAt,
        status: 'READY',
        language: c.doc.language,
        embeddingVersion: EV,
      }))
  );
  return evaluateShadow(
    { news: current.doc, productionDuplicateCheck: prodDup },
    {
      News: news,
      NewsVector: nv,
      thresholds,
      getQueryEmbedding: async () => ({ embedding: current.emb, source: 'test' }),
      log: { info() {}, warn() {} },
    },
    cfg
  );
}

// A stable base corpus (idf spread) that shares NO same-event with Adilabad immersion.
function base() {
  return [
    { doc: mk('niz1', 'immNiz', { location: 'Nizamabad' }), emb: V.immNiz },
    { doc: mk('kar1', 'weaKar', { location: 'Karimnagar' }), emb: V.weaKar },
    { doc: mk('accA', 'accAdil', { location: 'Adilabad' }), emb: V.accAdil },
  ];
}
function matchOf(shadow, id) {
  return (shadow.referenceMatches || []).find((m) => m.newsId === String(id));
}

describe('Phase-0 Same-Event Shadow', () => {
  test('1. same event + same wording → duplicate', async () => {
    const current = { doc: mk('cur', 'immAdil'), emb: V.immAdil };
    const prev = { doc: mk('prevSame', 'immAdil', { authorId: 'auth-A' }), emb: V.immAdil };
    const shadow = await run(current, [...base(), prev]);
    expect(shadow.verdict).toBe('duplicate');
    expect(matchOf(shadow, 'prevSame')).toBeTruthy();
  });

  test('2. same event + different wording → duplicate/suspicious', async () => {
    const current = { doc: mk('cur', 'immAdilReworded'), emb: V.immAdil2 };
    const prev = { doc: mk('prevRew', 'immAdil'), emb: V.immAdil };
    const shadow = await run(current, [...base(), prev]);
    expect(['duplicate', 'suspicious']).toContain(shadow.verdictGuarded);
    expect(matchOf(shadow, 'prevRew')).toBeTruthy();
  });

  test('3. same event + different reporter → detected (no same-author veto)', async () => {
    const current = { doc: mk('cur', 'immAdilReworded', { authorId: 'auth-R2' }), emb: V.immAdil2 };
    const prev = { doc: mk('prevRep', 'immAdil', { authorId: 'auth-R1' }), emb: V.immAdil };
    const shadow = await run(current, [...base(), prev]);
    const m = matchOf(shadow, 'prevRep');
    expect(m).toBeTruthy();
    expect(m.sameAuthor).toBe(false);
    expect(['duplicate', 'suspicious']).toContain(m.verdictGuarded);
  });

  test('4. previous article REJECTED → still a reference candidate (advisory only)', async () => {
    const current = { doc: mk('cur', 'immAdilReworded'), emb: V.immAdil2 };
    const prev = {
      doc: mk('prevRej', 'immAdil', { isActive: false, rejectionStatus: { isRejected: true } }),
      emb: V.immAdil,
    };
    const shadow = await run(current, [...base(), prev]);
    const m = matchOf(shadow, 'prevRej');
    expect(m).toBeTruthy();
    expect(m.referenceOnly).toBe(true);
    expect(['duplicate', 'suspicious']).toContain(m.verdictGuarded);
  });

  test('5. same topic + different event (Adilabad vs Nizamabad) → NOT duplicate', async () => {
    const current = { doc: mk('cur', 'immAdil'), emb: V.immAdil };
    const shadow = await run(current, base()); // base includes Nizamabad immersion
    const m = matchOf(shadow, 'niz1');
    if (m) expect(m.verdictGuarded).not.toBe('duplicate');
    expect(shadow.verdictGuarded).not.toBe('duplicate');
  });

  test('6. same district + different event (immersion vs accident) → NOT duplicate', async () => {
    const current = { doc: mk('cur', 'immAdil'), emb: V.immAdil };
    const shadow = await run(current, base()); // base has Adilabad accident
    const m = matchOf(shadow, 'accA');
    if (m) expect(m.verdictGuarded).not.toBe('duplicate');
  });

  test('7. same person + different incident → NOT duplicate', async () => {
    const current = { doc: mk('cur', 'immAdil'), emb: V.immAdil };
    const transfer = { doc: mk('trf', 'transfer', { location: 'Adilabad' }), emb: V.transfer };
    const shadow = await run(current, [...base(), transfer]);
    const m = matchOf(shadow, 'trf');
    if (m) expect(m.verdictGuarded).not.toBe('duplicate');
  });

  test('8. different districts + same topic → NOT duplicate', async () => {
    const current = { doc: mk('cur', 'immAdil', { location: 'Adilabad' }), emb: V.immAdil };
    const niz = { doc: mk('niz2', 'immNiz', { location: 'Nizamabad' }), emb: V.immNiz };
    const shadow = await run(current, [...base(), niz]);
    const m = matchOf(shadow, 'niz2');
    if (m) expect(m.verdictGuarded).not.toBe('duplicate');
  });

  test('9. different dates + same topic (recurring) → NOT duplicate', async () => {
    const current = { doc: mk('cur', 'immAdil2026', { authorId: 'auth-CUR' }), emb: V.immAdil };
    const lastYear = {
      doc: mk('imm2025', 'immAdil2025', { authorId: 'auth-OLD', publishedAt: new Date(NOW - 360 * DAY) }),
      emb: V.immAdil,
    };
    const shadow = await run(current, [...base(), lastYear]);
    const m = matchOf(shadow, 'imm2025');
    if (m) expect(m.verdictGuarded).not.toBe('duplicate');
  });

  test('10. unrelated articles with similar keywords → NOT duplicate', async () => {
    const current = { doc: mk('cur', 'immAdil'), emb: V.immAdil };
    const wed = { doc: mk('wed', 'wedAdil', { location: 'Adilabad' }), emb: V.wedAdil };
    const shadow = await run(current, [...base(), wed]);
    const m = matchOf(shadow, 'wed');
    if (m) expect(m.verdictGuarded).not.toBe('duplicate');
  });

  test('11. different language → preserved language safety (not retrieved)', async () => {
    const current = { doc: mk('cur', 'immAdil'), emb: V.immAdil };
    const hi = {
      doc: mk('hi1', 'immAdil', { language: 'hi', location: 'Adilabad' }),
      emb: V.immAdil,
    };
    const shadow = await run(current, [...base(), hi]);
    expect(matchOf(shadow, 'hi1')).toBeFalsy();
  });

  test('12. Adilabad immersion scenario → shadow flags rejected prior; production differs', async () => {
    const current = { doc: mk('curAdb', 'immAdilReworded'), emb: V.immAdil2 };
    const rejectedPrior = {
      doc: mk('adbRej', 'immAdil', { isActive: false, rejectionStatus: { isRejected: true } }),
      emb: V.immAdil,
    };
    // production said "different" (the real-world miss we investigated)
    const shadow = await run(current, [...base(), rejectedPrior], {
      isDuplicate: false,
      isSuspicious: false,
      score: 0,
    });
    const m = matchOf(shadow, 'adbRej');
    expect(m).toBeTruthy();
    expect(m.referenceOnly).toBe(true);
    expect(['duplicate', 'suspicious']).toContain(shadow.verdictGuarded);
    expect(shadow.productionVerdict).toBe('different');
    expect(shadow.differsFromProduction).toBe(true);
  });
});
