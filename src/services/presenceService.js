/**
 * In-memory presence registry: userId -> set of connected socket ids.
 * A user is online while at least one of their sockets (tabs/devices) is connected.
 *
 * Note: this lives in a single Node process. Running several API instances would
 * need a shared store (e.g. the Socket.IO Redis adapter) instead.
 */
const socketsByUser = new Map();

export const presenceService = {
  /** Returns true if this socket made the user go from offline to online. */
  connect(userId, socketId) {
    let sockets = socketsByUser.get(userId);
    const wasOffline = !sockets || sockets.size === 0;
    if (!sockets) {
      sockets = new Set();
      socketsByUser.set(userId, sockets);
    }
    sockets.add(socketId);
    return wasOffline;
  },

  /** Returns true if this was the user's last socket (now offline). */
  disconnect(userId, socketId) {
    const sockets = socketsByUser.get(userId);
    if (!sockets) return false;
    sockets.delete(socketId);
    if (sockets.size === 0) {
      socketsByUser.delete(userId);
      return true;
    }
    return false;
  },

  /** Number of open sockets (tabs/devices) of a user. */
  socketCount(userId) {
    return socketsByUser.get(userId)?.size ?? 0;
  },

  isOnline(userId) {
    return (socketsByUser.get(userId)?.size ?? 0) > 0;
  },

  reset() {
    socketsByUser.clear();
  },
};
