'use strict';

/**
 * curve.js — pure time-shaping engine for the View Distribution Engine.
 *
 * Maps normalized campaign time t = elapsed/total (in [0,1]) to the expected
 * CUMULATIVE fraction F(t) in [0,1], using the regularized incomplete Beta
 * function (the Beta CDF). Shape:
 *
 *   Beta(alpha, beta) with a left-skewed mode => fast early accumulation
 *   (initial BURST) -> decelerating middle (STABLE) -> flat tail (slow TAPER),
 *   i.e. the natural "YouTube-like" pickup curve.
 *
 * Why this design:
 *   - TIME-ANCHORED + SELF-CORRECTING: callers compute
 *       expected = target * F(elapsed/total);  delta = expected - delivered.
 *     Because F depends only on WALL-CLOCK elapsed time (never on cycle count),
 *     a skipped/late/duplicated cycle self-heals on the next tick — no drift.
 *   - PURE & DETERMINISTIC: no DB, Redis, clock, randomness, or mutation.
 *     Same inputs => same output => idempotent and unit-testable.
 *   - CONFIGURABLE: {alpha, beta} reshape burst/taper; Beta(1,1) == linear.
 *
 * Numerical core: Lanczos log-gamma + Numerical-Recipes continued fraction for
 * the incomplete beta — accurate to ~1e-12, dependency-free.
 */

// Default shape: mode at (alpha-1)/(alpha+beta-2) = 1/3 => front-loaded burst.
const DEFAULT_ALPHA = 2;
const DEFAULT_BETA = 3;

// Continued-fraction tuning.
const FPMIN = 1e-30;
const EPS = 3e-12;
const MAXIT = 200;

function posNum(n, fallback) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Lanczos approximation of ln(Γ(x)) for x > 0. */
function logGamma(x) {
  const cof = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) {
    y += 1;
    ser += cof[j] / y;
  }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** Continued fraction for the incomplete beta (Lentz's method). */
function betacf(a, b, x) {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a,b) — the Beta CDF at x. */
function betainc(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x)
  );
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betacf(a, b, x)) / a;
  }
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/**
 * Expected cumulative fraction F(t) at a given elapsed time.
 * @param {number} elapsedMs
 * @param {number} totalMs
 * @param {{alpha?:number, beta?:number}} [opts]
 * @returns {number} in [0,1]; F(0)=0, F(1)=1, monotonic non-decreasing.
 */
function cumulativeFraction(elapsedMs, totalMs, opts = {}) {
  const total = Number(totalMs);
  if (!(total > 0)) return 1; // degenerate window => treat as complete (fail safe)
  const elapsed = Number(elapsedMs);
  if (!Number.isFinite(elapsed) || elapsed <= 0) return 0;
  if (elapsed >= total) return 1;
  const alpha = posNum(opts.alpha, DEFAULT_ALPHA);
  const beta = posNum(opts.beta, DEFAULT_BETA);
  return clamp01(betainc(elapsed / total, alpha, beta));
}

/**
 * Convenience: expected cumulative VALUE for a target total at elapsed time.
 * This is the self-correcting anchor the allocator uses.
 */
function expectedCumulative(target, elapsedMs, totalMs, opts = {}) {
  const t = Number(target);
  if (!Number.isFinite(t) || t <= 0) return 0;
  return t * cumulativeFraction(elapsedMs, totalMs, opts);
}

/**
 * Diagnostic phase label (UI/telemetry only — never used in the math).
 * Thresholds are on normalized time; defaults align with the burst/taper shape.
 */
function phaseOf(t, opts = {}) {
  const x = clamp01(Number(t));
  const burstEnd = posNum(opts.burstEnd, 0.25);
  const taperStart = posNum(opts.taperStart, 0.75);
  if (x < burstEnd) return 'burst';
  if (x < taperStart) return 'stable';
  return 'taper';
}

/**
 * Sample the curve for admin preview: [{t, f}]. Pure.
 * @param {number} points number of samples (>=2)
 */
function curveSeries(points = 21, opts = {}) {
  const n = Math.max(2, Math.floor(points));
  const alpha = posNum(opts.alpha, DEFAULT_ALPHA);
  const beta = posNum(opts.beta, DEFAULT_BETA);
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    out.push({ t, f: clamp01(betainc(t, alpha, beta)) });
  }
  return out;
}

module.exports = {
  cumulativeFraction,
  expectedCumulative,
  phaseOf,
  curveSeries,
  // exported for tests / advanced tuning
  betainc,
  DEFAULT_ALPHA,
  DEFAULT_BETA
};
