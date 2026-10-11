'use strict';

/**
 * Admin → reporter personal messages.
 *
 *  POST /admin/editors/:id/message          (admin / superadmin) send one
 *  GET  /admin/api/reporter/messages        (reporter) my messages, last N days
 *  POST /admin/api/reporter/messages/read   (reporter) mark mine as read
 *
 * Scope is always server-side: a reporter can only ever read / mark their own.
 * Sending also fires a push (fire-and-forget) so the phone lights up.
 */

const OBJECT_ID = /^[a-f0-9]{24}$/i;
const DEFAULT_TITLE = 'Message from Tehelka News';

function toItem(doc) {
  return {
    id: String(doc._id),
    title: doc.title || DEFAULT_TITLE,
    message: doc.message || '',
    from: [doc.fromAdminName, doc.fromAdminRole].filter(Boolean).join(' · '),
    fromAdminName: doc.fromAdminName || '',
    fromAdminRole: doc.fromAdminRole || '',
    createdAt: doc.createdAt || null,
    readAt: doc.readAt || null,
  };
}

function createReporterMessageController(deps = {}) {
  const Model = deps.ReporterMessage || require('../models/ReporterMessage');
  const AdminModel = deps.Admin || require('../models/Admin');
  const notify = deps.notifyReporterAsync || require('../services/reporterNotifier').notifyReporterAsync;
  const now = deps.now || (() => new Date());

  const actorId = (req) => req.adminId || req.userId || (req.admin && (req.admin.id || req.admin._id)) || null;

  /** Admin sends a message to one reporter. */
  async function sendToReporter(req, res) {
    try {
      const id = String((req.params && req.params.id) || '');
      if (!OBJECT_ID.test(id)) return res.status(400).json({ success: false, error: 'Invalid reporter id' });

      const message = String((req.body && req.body.message) || '').trim();
      const title = (String((req.body && req.body.title) || '').trim() || DEFAULT_TITLE).slice(0, 80);
      if (!message) return res.status(400).json({ success: false, error: 'Message is required' });
      if (message.length > 1000) return res.status(400).json({ success: false, error: 'Message cannot exceed 1000 characters' });

      const target = await AdminModel.findById(id).select('_id role username').lean();
      if (!target) return res.status(404).json({ success: false, error: 'Reporter not found' });

      // Sender identity: token payload first, DB fallback for a proper name.
      const fromId = actorId(req);
      let fromName = (req.admin && req.admin.username) || '';
      let fromRole = (req.admin && req.admin.role) || '';
      if ((!fromName || !fromRole) && fromId) {
        try {
          const me = await AdminModel.findById(fromId).select('username role').lean();
          if (me) {
            fromName = fromName || me.username || '';
            fromRole = fromRole || me.role || '';
          }
        } catch (_) { /* best-effort */ }
      }

      const doc = await Model.create({
        reporterId: id,
        title,
        message,
        fromAdminId: fromId ? String(fromId) : undefined,
        fromAdminName: fromName || 'Admin',
        fromAdminRole: fromRole || 'admin',
      });

      // Push to the reporter's phone — never blocks the admin's request.
      notify('message', { reporterId: id, newsId: '', title, message });

      return res.json({ success: true, message: toItem(doc) });
    } catch (err) {
      console.error('[reporterMessage] send failed:', err && err.message);
      return res.status(500).json({ success: false, error: 'Could not send the message. Please try again.' });
    }
  }

  /** Reporter lists their own messages (default last 30 days, newest first). */
  async function listMine(req, res) {
    try {
      const reporterId = actorId(req);
      if (!reporterId) return res.status(401).json({ success: false, error: 'Not authenticated' });
      const daysRaw = parseInt(req.query && req.query.days, 10);
      const days = Number.isFinite(daysRaw) ? Math.min(90, Math.max(1, daysRaw)) : 30;
      const since = new Date(now().getTime() - days * 24 * 60 * 60 * 1000);

      const docs = await Model.find({ reporterId: String(reporterId), createdAt: { $gte: since } })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean();

      res.set('Cache-Control', 'no-store');
      return res.json({ success: true, items: docs.map(toItem), unread: docs.filter((d) => !d.readAt).length });
    } catch (err) {
      console.error('[reporterMessage] list failed:', err && err.message);
      return res.status(500).json({ success: false, error: 'Could not load messages.' });
    }
  }

  /** Reporter marks their own messages as read: { ids: [...] } or { all: true }. */
  async function markRead(req, res) {
    try {
      const reporterId = actorId(req);
      if (!reporterId) return res.status(401).json({ success: false, error: 'Not authenticated' });
      const all = !!(req.body && req.body.all);
      const ids = (Array.isArray(req.body && req.body.ids) ? req.body.ids : []).map(String).filter((v) => OBJECT_ID.test(v)).slice(0, 200);
      if (!all && !ids.length) return res.json({ success: true, updated: 0 });

      const filter = { reporterId: String(reporterId), readAt: null };
      if (!all) filter._id = { $in: ids };
      const r = await Model.updateMany(filter, { $set: { readAt: now() } });
      return res.json({ success: true, updated: (r && (r.modifiedCount ?? r.nModified)) || 0 });
    } catch (err) {
      console.error('[reporterMessage] markRead failed:', err && err.message);
      return res.status(500).json({ success: false, error: 'Could not update messages.' });
    }
  }

  return { sendToReporter, listMine, markRead, toItem };
}

const defaultController = createReporterMessageController();

module.exports = {
  createReporterMessageController,
  sendToReporter: defaultController.sendToReporter,
  listMine: defaultController.listMine,
  markRead: defaultController.markRead,
};
