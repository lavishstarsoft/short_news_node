'use strict';

/**
 * READ-ONLY diagnostic: measure the real semantic (meaning) + fact scores for
 * the owner's test texts against the live Telugu window. Changes nothing.
 *   node scripts/measure_semantic.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');
const S = require('../services/aiDuplicate/semantic/semanticDecisionService');
const { loadAiConfig } = require('../services/aiDuplicate/config');

async function embed(text) {
  const cfg = loadAiConfig(process.env);
  if (!cfg.baseUrl || !cfg.apiKey) throw new Error('embed config missing');
  const r = await axios.post(
    `${cfg.baseUrl}/v1/embed`,
    { title: text, content: '', language: 'te' },
    { timeout: 8000, headers: { 'Content-Type': 'application/json', 'X-AI-Service-Key': cfg.apiKey }, validateStatus: () => true }
  );
  if (r.status < 200 || r.status >= 300 || !Array.isArray(r.data.embedding)) {
    throw new Error('embed failed status=' + r.status);
  }
  return r.data.embedding;
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  try {
    const t = S.loadThresholds();
    const svc = S.createSemanticDecisionService();
    const win = await svc.getWindow('te', t);
    console.log('te window size:', win.items.length,
      '| thresholds → minSem', t.minSem, 'dupStrong', t.dupStrong, 'dupScore', t.dupScore, 'dupFact', t.dupFact, 'susScore', t.susScore, 'susFact', t.susFact);

    // ── PAIR: Vijayawada vs Bezawada accident ──────────────────────────────
    const a1 = 'విజయవాడలో యాక్సిడెంట్ జరిగింది';
    const a2 = 'బెజవాడాలో ఈరోజు ఉదయం యాక్సిడెంట్ జరిగింది';
    const e1 = await embed(a1);
    const e2 = await embed(a2);
    const semPair = S.cosine(e1, e2);
    const tok1 = S.factTokens(a1, '');
    const tok2 = S.factTokens(a2, '');
    const factPair = S.factOverlap(tok1, tok2, win.idf);
    console.log('\n=== PAIR: Vijayawada vs Bezawada accident ===');
    console.log('  sem (meaning) =', semPair.toFixed(3), ' fact (shared) =', factPair.toFixed(3),
      ' verdict =', S.verdictFor(semPair, factPair, t) || 'NONE');
    console.log('  factTokens #1:', [...tok1].join(', '));
    console.log('  factTokens #2:', [...tok2].join(', '));

    // ── GANDHI text vs already-published te window ─────────────────────────
    const g = 'గాంధీజీ ఆశయాలను ముందుకు తీసుకెళ్లాలి: సంజీవ్ ముదిరాజ్';
    const eg = await embed(g);
    const gTok = S.factTokens(g, '');
    const scored = win.items
      .map((it) => {
        const sem = S.cosine(eg, it.embedding);
        const fact = S.factOverlap(gTok, it.tokens, win.idf);
        return { title: it.title, sem, fact, verdict: S.verdictFor(sem, fact, t) };
      })
      .sort((x, y) => y.sem - x.sem)
      .slice(0, 5);
    console.log('\n=== GANDHI text: top 5 closest in the published te window ===');
    scored.forEach((s, i) =>
      console.log(`  ${i + 1}. sem=${s.sem.toFixed(3)} fact=${s.fact.toFixed(3)} verdict=${s.verdict || 'NONE'} | ${(s.title || '').slice(0, 55)}`));
  } finally {
    await mongoose.disconnect();
  }
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
