'use strict';

/**
 * Semantic infrastructure constants (3B.1+).
 * Queue workers still not executed. Atlas search is isolated (3B.4).
 */

module.exports = {
  ENV_SEMANTIC_ENABLED: 'AI_SEMANTIC_ENABLED',
  /** Phase-3B.5 — metrics-only shadow; default OFF. Never decides duplicates. */
  ENV_SEMANTIC_SHADOW_ENABLED: 'AI_SEMANTIC_SHADOW_ENABLED',
  /** Phase-4.1 — background PENDING embed worker; default OFF. */
  ENV_EMBED_WORKER_ENABLED: 'AI_EMBED_WORKER_ENABLED',

  /** Future embed job type (contract only — not consumed yet). */
  JOB_TYPE_EMBED_TEXT: 'embed_text_v1',

  DEFAULT_MODEL_ID: 'intfloat/multilingual-e5-small',
  DEFAULT_EMBEDDING_VERSION: 'e5s-v1',
  EMBEDDING_DIMENSIONS: 384,

  /** Shadow embed HTTP timeout (ms) — separate from detect ≤1000ms. */
  DEFAULT_SHADOW_EMBED_TIMEOUT_MS: 5000,
  DEFAULT_SHADOW_TOP_K: 5,

  /** Phase-3B.6 — advisory thresholds (cosine). */
  DEFAULT_SEMANTIC_SCORE_POSSIBLE: 0.88,
  DEFAULT_SEMANTIC_SCORE_STRONG: 0.92,
  DEFAULT_SEMANTIC_ADVISORY_TOP_K: 5,
  DEFAULT_SEMANTIC_MIN_SCORE_MARGIN: 0.03,

  /** Phase-4.1 — embed worker defaults */
  DEFAULT_EMBED_WORKER_MAX_ATTEMPTS: 5,
  DEFAULT_EMBED_WORKER_BASE_DELAY_MS: 2000,
  DEFAULT_EMBED_WORKER_MAX_DELAY_MS: 300000,
  DEFAULT_EMBED_WORKER_BATCH_SIZE: 10,
  DEFAULT_EMBED_WORKER_POLL_MS: 5000,
  DEFAULT_EMBED_WORKER_EMBED_TIMEOUT_MS: 15000,
  /** Phase-4.2.6 — claim lease duration (ms). Must exceed typical embed time. */
  DEFAULT_EMBED_WORKER_LEASE_MS: 60000,

  MODALITY_TEXT: 'text',

  STATUS: {
    PENDING: 'PENDING',
    READY: 'READY',
    FAILED: 'FAILED',
    STALE: 'STALE',
  },
};
