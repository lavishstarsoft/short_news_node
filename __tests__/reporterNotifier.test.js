'use strict';

const { buildMessage, notifyReporter } = require('../services/reporterNotifier');

const REPORTER = '65a0000000000000000000a1';
const NEWS = '65b0000000000000000000b2';

/** Capture what would be sent to OneSignal. */
function fakeClient() {
  const sent = [];
  return {
    sent,
    getClient: () => ({ appId: 'app-1', api: { createNotification: async (n) => { sent.push(n); return { id: 'n1' }; } } }),
  };
}

describe('reporter workflow push copy (English)', () => {
  test('approved mentions the headline', () => {
    const m = buildMessage('approved', { title: 'Road repaired at last' });
    expect(m.title).toBe('News approved ✅');
    expect(m.message).toBe('Your news has been published: Road repaired at last');
  });

  test('rejected carries the reason', () => {
    const m = buildMessage('rejected', { title: 'Road repaired', reason: 'Incomplete article' });
    expect(m.title).toBe('News rejected ❌');
    expect(m.message).toContain('Road repaired');
    expect(m.message).toContain('Reason: Incomplete article');
  });

  test('needs_revision carries the remarks', () => {
    const m = buildMessage('needs_revision', { title: 'Road repaired', remarks: 'Add the date and place' });
    expect(m.title).toBe('Changes requested ✏️');
    expect(m.message).toContain('Add the date and place');
  });

  test('reverted tells the reporter it is pending again', () => {
    const m = buildMessage('reverted', { title: 'Road repaired' });
    expect(m.title).toBe('Back to pending ↩️');
    expect(m.message).toContain('back in pending');
  });

  test('missing reason / remarks still produces a sensible line', () => {
    expect(buildMessage('rejected', { title: 'X' }).message).toContain('was rejected');
    expect(buildMessage('needs_revision', { title: 'X' }).message).toContain('requested changes');
  });

  test('long headlines are trimmed, unknown events produce nothing', () => {
    const m = buildMessage('approved', { title: 'y'.repeat(200) });
    expect(m.message.length).toBeLessThan(140);
    expect(m.message.endsWith('…')).toBe(true);
    expect(buildMessage('exploded', {})).toBeNull();
  });
});

describe('notifyReporter delivery', () => {
  test('targets the reporter by external_id and carries routing data', async () => {
    const c = fakeClient();
    const res = await notifyReporter('approved', { reporterId: REPORTER, newsId: NEWS, title: 'Road repaired' }, { getClient: c.getClient });

    expect(res.sent).toBe(true);
    expect(c.sent).toHaveLength(1);
    const n = c.sent[0];
    expect(n.include_aliases).toEqual({ external_id: [REPORTER] });
    expect(n.target_channel).toBe('push');
    expect(n.headings.en).toBe('News approved ✅');
    expect(n.data).toMatchObject({ type: 'reporter_workflow', status: 'approved', newsId: NEWS, route: 'reporter_stories' });
  });

  test('carries the reporter language so older app builds display it', async () => {
    const c = fakeClient();
    await notifyReporter('approved', { reporterId: REPORTER, title: 'X' }, { getClient: c.getClient, lookupLanguage: async () => 'te' });
    expect(c.sent[0].data.language).toBe('te');
    expect(c.sent[0].data.type).toBe('reporter_workflow');
  });

  test('language lookup failing / unknown → payload simply omits it (still sent)', async () => {
    const c = fakeClient();
    const res = await notifyReporter('approved', { reporterId: REPORTER, title: 'X' }, { getClient: c.getClient, lookupLanguage: async () => null });
    expect(res.sent).toBe(true);
    expect(c.sent[0].data.language).toBeUndefined();
  });

  test('no reporter id → nothing is sent', async () => {
    const c = fakeClient();
    const res = await notifyReporter('approved', { title: 'X' }, { getClient: c.getClient });
    expect(res).toEqual({ sent: false, skipped: 'no_reporter' });
    expect(c.sent).toHaveLength(0);
  });

  test('OneSignal not configured → skipped, never throws', async () => {
    const res = await notifyReporter('approved', { reporterId: REPORTER }, { getClient: () => null });
    expect(res).toEqual({ sent: false, skipped: 'onesignal_not_configured' });
  });

  test('a OneSignal failure is swallowed (approve/reject must never break)', async () => {
    const getClient = () => ({ appId: 'a', api: { createNotification: async () => { throw new Error('onesignal down'); } } });
    await expect(notifyReporter('rejected', { reporterId: REPORTER, title: 'X', reason: 'spam' }, { getClient })).resolves.toEqual({ sent: false, skipped: 'error' });
  });
});
