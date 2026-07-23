'use strict';

/**
 * Phase-3B.5 — Persist shadow metrics only.
 * Never writes News / duplicateCheck / Reporter collections.
 */

function createSemanticShadowStore(deps = {}) {
  const getModel = () =>
    deps.SemanticShadowMetric || require('../../../models/SemanticShadowMetric');

  async function saveMetric(metric) {
    const Model = getModel();
    if (!Model || typeof Model.create !== 'function') {
      return { ok: false, error: 'SemanticShadowMetric model unavailable' };
    }
    const doc = await Model.create(metric);
    return {
      ok: true,
      id: doc && doc._id != null ? String(doc._id) : null,
    };
  }

  return { saveMetric };
}

const defaultStore = createSemanticShadowStore();

module.exports = {
  createSemanticShadowStore,
  saveMetric: defaultStore.saveMetric,
};
