'use strict';

/**
 * READ-ONLY dry run: how many recent te news would flip to "duplicate" if we
 * lower AI_SEMANTIC_DUP_SCORE from 0.92 → 0.90 (fact gate 0.40 unchanged)?
 * Compares a sample of recent te news against the live window and lists the
 * NEWLY-duplicate pairs so false positives can be eyeballed. Changes nothing.
 *   node scripts/dryrun_semantic_threshold.js [sampleSize] [proposedDupScore]
 */
require('dotenv').config();
const mongoose = require('mongoose');
const S = require('../services/aiDuplicate/semantic/semanticDecisionService');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  try {
    const sample = parseInt(process.argv[2], 10) || 300;
    const band2Sem = parseFloat(process.argv[3]) || 0.90;  // second duplicate band: lower sem…
    const band2Fact = parseFloat(process.argv[4]) || 0.55; // …but HIGHER shared-fact requirement

    const tCur = S.loadThresholds();
    // Proposed = current rules PLUS a band: sem>=band2Sem & fact>=band2Fact → duplicate.
    const verdictProposed = (sem, fact) => {
      if (S.verdictFor(sem, fact, tCur) === 'duplicate') return 'duplicate';
      if (sem >= band2Sem && fact >= band2Fact) return 'duplicate';
      return S.verdictFor(sem, fact, tCur); // suspicious/none unchanged
    };
    const svc = S.createSemanticDecisionService();
    const win = await svc.getWindow('te', tCur);
    const items = win.items;
    const N = items.length;
    const Q = Math.min(sample, N);
    console.log(`te window=${N} | sampling ${Q} | current: dupStrong=${tCur.dupStrong}, dupScore=${tCur.dupScore}&fact${tCur.dupFact} | PROPOSED adds band: sem>=${band2Sem} & fact>=${band2Fact} → duplicate`);

    let curDup = 0, newDup = 0, curSus = 0, newSus = 0;
    const newPairs = [];

    for (let i = 0; i < Q; i++) {
      const q = items[i];
      let bestCur = null, bestNew = null, bestMatch = null, bestSem = 0, bestFact = 0;
      for (let j = 0; j < N; j++) {
        if (j === i) continue;
        const c = items[j];
        if (q.newsId === c.newsId) continue;
        const sem = S.cosine(q.embedding, c.embedding);
        if (sem < tCur.minSem) continue;
        const fact = S.factOverlap(q.tokens, c.tokens, win.idf);
        const vc = S.verdictFor(sem, fact, tCur);
        const vn = verdictProposed(sem, fact);
        const rank = (v) => (v === 'duplicate' ? 2 : v === 'suspicious' ? 1 : 0);
        if (rank(vn) > rank(bestNew ? bestNew : 'none') || (rank(vn) === rank(bestNew ? bestNew : 'none') && sem > bestSem)) {
          bestCur = vc; bestNew = vn; bestMatch = c.title; bestSem = sem; bestFact = fact;
        }
      }
      if (bestCur === 'duplicate') curDup++;
      if (bestNew === 'duplicate') newDup++;
      if (bestCur === 'suspicious') curSus++;
      if (bestNew === 'suspicious') newSus++;
      // Newly duplicate because of the lower threshold
      if (bestNew === 'duplicate' && bestCur !== 'duplicate') {
        newPairs.push({ q: q.title, m: bestMatch, sem: bestSem, fact: bestFact });
      }
    }

    console.log(`\n── counts over ${Q} queries ──`);
    console.log(`  DUPLICATE : current=${curDup}  proposed=${newDup}   (newly duplicate = ${newDup - curDup})`);
    console.log(`  SUSPICIOUS: current=${curSus}  proposed=${newSus}`);
    console.log(`\n── NEWLY "duplicate" via the band sem>=${band2Sem} & fact>=${band2Fact} (eyeball for false positives) ──`);
    newPairs.sort((a, b) => a.sem - b.sem).slice(0, 20).forEach((p, i) =>
      console.log(`  ${i + 1}. sem=${p.sem.toFixed(3)} fact=${p.fact.toFixed(3)}\n       A: ${(p.q || '').slice(0, 60)}\n       B: ${(p.m || '').slice(0, 60)}`));
    if (!newPairs.length) console.log('  (none)');
  } finally {
    await mongoose.disconnect();
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
