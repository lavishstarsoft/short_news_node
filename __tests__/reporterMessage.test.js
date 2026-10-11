'use strict';

const { createReporterMessageController } = require('../controllers/reporterMessageController');
const { buildMessage } = require('../services/reporterNotifier');

const REP = '65a0000000000000000000a1';
const ADMIN = '65b0000000000000000000b2';
const MSG1 = '65c0000000000000000000c3';

function mockRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  return res;
}

/** In-memory ReporterMessage model double covering create / find / updateMany. */
function fakeModel(seed = []) {
  const docs = [...seed];
  const chain = (arr) => ({ sort: () => chain(arr), limit: () => chain(arr), lean: async () => arr, select: () => chain(arr) });
  return {
    docs,
    create: async (d) => { const doc = { _id: MSG1, createdAt: new Date(), readAt: null, ...d }; docs.push(doc); return doc; },
    find: (f) => chain(docs.filter((d) => d.reporterId === f.reporterId && (!f.createdAt || d.createdAt >= f.createdAt.$gte))),
    updateMany: async (f, u) => {
      let n = 0;
      for (const d of docs) {
        const idOk = !f._id || f._id.$in.includes(String(d._id));
        if (d.reporterId === f.reporterId && d.readAt === null && idOk) { d.readAt = u.$set.readAt; n++; }
      }
      return { modifiedCount: n };
    },
  };
}
const fakeAdmin = (exists = true) => ({ findById: () => ({ select: () => ({ lean: async () => (exists ? { _id: REP, role: 'editor', username: 'ravi' } : null) }) }) });

function build({ model = fakeModel(), adminExists = true, pushes = [] } = {}) {
  return { c: createReporterMessageController({ ReporterMessage: model, Admin: fakeAdmin(adminExists), notifyReporterAsync: (e, p) => pushes.push({ e, p }) }), model, pushes };
}

describe('admin → reporter message: send', () => {
  const adminReq = (body) => ({ params: { id: REP }, body, admin: { id: ADMIN, username: 'desk', role: 'admin' } });

  test('saves the message, scoped to the reporter, and pushes it', async () => {
    const { c, model, pushes } = build();
    const res = mockRes();
    await c.sendToReporter(adminReq({ title: 'Please call', message: 'Call the desk about your Khammam story.' }), res);
    expect(res.body.success).toBe(true);
    expect(model.docs).toHaveLength(1);
    expect(model.docs[0]).toMatchObject({ reporterId: REP, title: 'Please call', fromAdminName: 'desk', fromAdminRole: 'admin' });
    expect(pushes).toEqual([{ e: 'message', p: { reporterId: REP, newsId: '', title: 'Please call', message: 'Call the desk about your Khammam story.' } }]);
    expect(res.body.message.from).toBe('desk · admin');
  });

  test('empty message → 400; unknown reporter → 404; bad id → 400', async () => {
    const { c } = build();
    let res = mockRes();
    await c.sendToReporter(adminReq({ message: '   ' }), res);
    expect(res.statusCode).toBe(400);

    res = mockRes();
    await build({ adminExists: false }).c.sendToReporter(adminReq({ message: 'hi' }), res);
    expect(res.statusCode).toBe(404);

    res = mockRes();
    await c.sendToReporter({ params: { id: 'nope' }, body: { message: 'hi' }, admin: { id: ADMIN } }, res);
    expect(res.statusCode).toBe(400);
  });

  test('missing title falls back to the default subject', async () => {
    const { c, model } = build();
    await c.sendToReporter(adminReq({ message: 'Good work today.' }), mockRes());
    expect(model.docs[0].title).toBe('Message from Tehelka News');
  });
});

describe('reporter: list + mark read (own messages only)', () => {
  const seed = () => [
    { _id: MSG1, reporterId: REP, title: 'A', message: 'mine', fromAdminName: 'desk', fromAdminRole: 'admin', createdAt: new Date(), readAt: null },
    { _id: '65c0000000000000000000c4', reporterId: 'someone-else', title: 'B', message: 'not mine', createdAt: new Date(), readAt: null },
  ];

  test('list returns only my messages with unread count', async () => {
    const { c } = build({ model: fakeModel(seed()) });
    const res = mockRes();
    await c.listMine({ admin: { id: REP }, query: {} }, res);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ id: MSG1, message: 'mine', from: 'desk · admin' });
    expect(res.body.unread).toBe(1);
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  test('markRead only touches my own unread messages', async () => {
    const model = fakeModel(seed());
    const { c } = build({ model });
    const res = mockRes();
    await c.markRead({ admin: { id: REP }, body: { ids: [MSG1, '65c0000000000000000000c4'] } }, res);
    expect(res.body.updated).toBe(1);
    expect(model.docs[0].readAt).not.toBeNull();
    expect(model.docs[1].readAt).toBeNull(); // other reporter's message untouched
  });

  test('unauthenticated → 401', async () => {
    const { c } = build();
    const res = mockRes();
    await c.listMine({ query: {} }, res);
    expect(res.statusCode).toBe(401);
  });
});

describe('push copy for an admin message', () => {
  test('uses the subject as title and the body as text', () => {
    const m = buildMessage('message', { title: 'Please call', message: 'Call the desk.' });
    expect(m).toEqual({ title: 'Please call', message: 'Call the desk.' });
  });
  test('defaults when subject / body are missing', () => {
    expect(buildMessage('message', {}).title).toBe('Message from Tehelka News');
    expect(buildMessage('message', {}).message).toContain('new message');
  });
});
