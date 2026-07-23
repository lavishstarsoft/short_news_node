'use strict';

/**
 * Validate AI POST /v1/embed response before Node persistence.
 * Phase-3B.3 — Node only; AI never writes MongoDB.
 */

const C = require('./constants');

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
function validateEmbedResponse(payload, options = {}) {
  const expectedModelId = options.modelId || C.DEFAULT_MODEL_ID;
  const expectedVersion = options.embeddingVersion || C.DEFAULT_EMBEDDING_VERSION;
  const expectedDims = options.dimensions || C.EMBEDDING_DIMENSIONS;

  if (!isPlainObject(payload)) {
    return { ok: false, error: 'embed response must be an object' };
  }
  if (payload.success !== true) {
    return { ok: false, error: 'embed response.success must be true' };
  }
  if (payload.implemented !== true) {
    return { ok: false, error: 'embed response.implemented must be true' };
  }
  if (payload.modelId !== expectedModelId) {
    return {
      ok: false,
      error: `invalid modelId "${payload.modelId}"; expected "${expectedModelId}"`,
    };
  }
  if (payload.embeddingVersion !== expectedVersion) {
    return {
      ok: false,
      error: `invalid embeddingVersion "${payload.embeddingVersion}"; expected "${expectedVersion}"`,
    };
  }
  if (payload.dimensions !== expectedDims) {
    return {
      ok: false,
      error: `invalid dimensions ${payload.dimensions}; expected ${expectedDims}`,
    };
  }
  if (!Array.isArray(payload.embedding)) {
    return { ok: false, error: 'embedding must be an array' };
  }
  if (payload.embedding.length !== expectedDims) {
    return {
      ok: false,
      error: `embedding length ${payload.embedding.length}; expected ${expectedDims}`,
    };
  }
  for (let i = 0; i < payload.embedding.length; i += 1) {
    if (!isFiniteNumber(payload.embedding[i])) {
      return { ok: false, error: `embedding[${i}] is not a finite number` };
    }
  }
  if (!isPlainObject(payload.metadata)) {
    return { ok: false, error: 'metadata must be an object' };
  }

  return {
    ok: true,
    value: {
      modelId: payload.modelId,
      embeddingVersion: payload.embeddingVersion,
      dimensions: payload.dimensions,
      embedding: payload.embedding.slice(),
      metadata: payload.metadata,
      phase: payload.phase,
    },
  };
}

module.exports = {
  validateEmbedResponse,
};
