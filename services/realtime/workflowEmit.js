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

function emitNewPendingNews(io, payload) {
  emitToAdmins(io, 'new_news', payload);
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
