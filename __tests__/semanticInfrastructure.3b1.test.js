'use strict';

const {
  isAiSemanticEnabled,
  planContentHashChange,
  buildEmbedTextJobPayload,
  createEmbedJobQueuePort,
  validateNewsVectorRecord,
  STATUS,
} = require('../services/aiDuplicate/semantic');

describe('Phase-3B.1 semantic infrastructure', () => {
  test('AI_SEMANTIC_ENABLED defaults to false', () => {
    expect(isAiSemanticEnabled({})).toBe(false);
    expect(isAiSemanticEnabled({ AI_SEMANTIC_ENABLED: 'false' })).toBe(false);
  });

  test('contentHash change plans STALE + PENDING + embed job', () => {
    const plan = planContentHashChange({
      newsId: 'n1',
      previousContentHash: 'hash-a',
      nextContentHash: 'hash-b',
      language: 'te',
      title: 't',
      content: 'c',
      existingVector: { status: STATUS.READY },
    });
    expect(plan.changed).toBe(true);
    expect(plan.actions.map((a) => a.type)).toEqual([
      'mark_vector_stale',
      'upsert_vector_pending',
      'enqueue_embed_job',
    ]);
    expect(plan.actions[2].job.meta.executable).toBe(false);
  });

  test('unchanged contentHash plans nothing', () => {
    const plan = planContentHashChange({
      newsId: 'n1',
      previousContentHash: 'same',
      nextContentHash: 'same',
    });
    expect(plan.changed).toBe(false);
    expect(plan.actions).toEqual([]);
  });

  test('queue port does not execute', async () => {
    const port = createEmbedJobQueuePort();
    const job = buildEmbedTextJobPayload({
      newsId: 'n1',
      contentHash: 'h1',
      title: 't',
      content: 'c',
    });
    const result = await port.enqueue(job);
    expect(result.accepted).toBe(false);
  });

  test('READY validation requires 384-dim embedding', () => {
    const bad = validateNewsVectorRecord({
      newsId: 'n1',
      contentHash: 'h',
      embeddingVersion: 'e5s-v1',
      modelId: 'intfloat/multilingual-e5-small',
      status: STATUS.READY,
      embedding: [1, 2],
    });
    expect(bad.ok).toBe(false);
  });
});
