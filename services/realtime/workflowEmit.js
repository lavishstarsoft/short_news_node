'use strict';

/**
 * Targeted Socket.IO emits for workflow + publish events.
 * Rooms:
 *   reporter:{authorId}  — owning reporter only
 *   admin                — admin dashboard clients
 *   consumers            — optional consumer clients (news_published also broadcasts for legacy apps)
 */

const ROOM = {
  admin: 'admin',
  consumers: 'consumers',
  reporter: (authorId) => `reporter:${String(authorId)}`,
  // Per-admin room (admin / superadmin / subeditor) for scope-routed pending alerts.
  staff: (adminId) => `staff:${String(adminId)}`,
};

function getIo(appOrIo) {
  if (!appOrIo) return null;
  if (typeof appOrIo.to === 'function' && typeof appOrIo.emit === 'function') {
    return appOrIo;
  }
  return appOrIo.locals?.io || null;
}

function emitToReporter(io, authorId, event, payload) {
  if (!io || !authorId) return;
  io.to(ROOM.reporter(authorId)).emit(event, payload);
}

function emitToAdmins(io, event, payload) {
  if (!io) return;
  io.to(ROOM.admin).emit(event, payload);
}

/** Publish events: consumers room + legacy broadcast for mobile clients. */
function emitPublished(io, payload) {
  if (!io) return;
  io.to(ROOM.consumers).emit('news_published', payload);
  // Legacy Flutter / unauthenticated clients still listen globally
  io.emit('news_published', payload);
}

/**
 * Pending-news alert. SCOPE-ROUTED: only the authorized District Sub Editor(s),
 * State Incharge(s) and Super Admin receive it — never a broadcast to all admins,
 * and never a reporter. Event name ('new_news') and payload are unchanged, so
 * existing client handlers keep working; they simply receive only in-scope events.
 * Fire-and-forget; on any failure it falls back to the admin room so an alert is
 * never lost (backward-safe).
 */
function emitNewPendingNews(io, payload) {
  if (!io) return;
  Promise.resolve()
    .then(() => require('./pendingAlertRouter').resolvePendingRecipientIds(payload))
    .then((ids) => {
      if (Array.isArray(ids) && ids.length) {
        for (const id of ids) {
          io.to(ROOM.staff(id)).emit('new_news', payload);
        }
      } else {
        // No resolved recipients (e.g. transient DB issue) — fail safe.
        emitToAdmins(io, 'new_news', payload);
      }
    })
    .catch((err) => {
      console.error('[pendingAlert] recipient routing failed, falling back to admin room:', err && err.message);
      emitToAdmins(io, 'new_news', payload);
    });
}

function emitWorkflowToReporter(io, authorId, payload) {
  emitToReporter(io, authorId, 'story_status_updated_editor', payload);
}

function emitWorkflowToAdmins(io, payload) {
  emitToAdmins(io, 'story_status_updated_admin', payload);
}

function emitWorkflowPair(io, authorId, editorPayload, adminPayload) {
  emitWorkflowToReporter(io, authorId, editorPayload);
  emitWorkflowToAdmins(io, adminPayload || editorPayload);
}

module.exports = {
  ROOM,
  getIo,
  emitToReporter,
  emitToAdmins,
  emitPublished,
  emitNewPendingNews,
  emitWorkflowToReporter,
  emitWorkflowToAdmins,
  emitWorkflowPair,
};
