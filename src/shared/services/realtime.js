/** Socket.io bridge for in-app real-time updates (notifications, design status). */

let ioRef = null;

export function initRealtime(io) {
  ioRef = io;
}

export function emitToUser(userId, event, payload) {
  if (!ioRef || !userId) return;
  ioRef.to(`user:${userId}`).emit(event, payload);
}

export function emitToFactory(factoryId, event, payload) {
  if (!ioRef || !factoryId) return;
  ioRef.to(`factory:${factoryId}`).emit(event, payload);
}

export function serializeId(value) {
  if (!value) return value;
  return value.toString ? value.toString() : value;
}

export function emitDesignUpdated(design, { actorId } = {}) {
  if (!design) return;
  emitToFactory(design.factoryId, 'design:updated', {
    designId: serializeId(design._id),
    status: design.status,
    designCode: design.designCode,
    title: design.title,
    actorId: serializeId(actorId),
  });
}
