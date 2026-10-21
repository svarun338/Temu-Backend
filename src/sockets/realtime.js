/**
 * Thin gateway between the HTTP/service layer and Socket.IO so that messages
 * sent over REST are broadcast exactly like messages sent over a socket.
 */
let io = null;

export const rooms = {
  user: (userId) => `user:${userId}`,
  session: (sessionId) => `session:${sessionId}`,
  conversation: (conversationId) => `conversation:${conversationId}`,
  // One browser tab (a call belongs to the tab that placed or answered it).
  tab: (userId, tabId) => `tab:${userId}:${tabId}`,
};

export const realtime = {
  attach(instance) {
    io = instance;
  },

  detach() {
    io = null;
  },

  /** Deliver a newly stored message to every participant's sockets. */
  broadcastMessage({ message, participantIds }) {
    if (!io) return;
    const room = rooms.conversation(message.conversationId);
    // Make sure every participant socket is in the room (e.g. the first message of a new chat).
    for (const userId of participantIds) io.in(rooms.user(userId)).socketsJoin(room);
    io.to(room).emit('message:new', message);
  },

  /** Send an event to everyone in a conversation (all participants' sockets). */
  toConversation(conversationId, event, payload) {
    if (!io) return;
    io.to(rooms.conversation(conversationId)).emit(event, payload);
  },

  /** Take users' sockets out of a conversation room (removed from / left a group). */
  removeFromConversation(userIds, conversationId) {
    if (!io || userIds.length === 0) return;
    io.in(userIds.map(rooms.user)).socketsLeave(rooms.conversation(conversationId));
  },

  /**
   * Delivered/read ticks. A group receipt that didn't move the group-wide point
   * (toGroup: false) only goes to the reader's own tabs, to clear their unread badge.
   */
  broadcastReceipt(receipt) {
    if (!io || !receipt) return;
    if (receipt.group && receipt.toGroup === false) {
      io.to(rooms.user(receipt.byUserId)).emit('message:status', receipt);
      return;
    }
    io.to(rooms.conversation(receipt.conversationId)).emit('message:status', receipt);
  },

  emitToUsers(userIds, event, payload) {
    if (!io || userIds.length === 0) return;
    io.to(userIds.map(rooms.user)).emit(event, payload);
  },

  /** Send to one browser tab of a user. */
  toTab(userId, tabId, event, payload) {
    if (!io) return;
    io.to(rooms.tab(userId, tabId)).emit(event, payload);
  },

  /** Send to every tab of a user except one (e.g. "answered on another tab"). */
  toUserExceptTab(userId, tabId, event, payload) {
    if (!io) return;
    io.to(rooms.user(userId)).except(rooms.tab(userId, tabId)).emit(event, payload);
  },

  /** Is this tab connected right now? */
  isTabConnected(userId, tabId) {
    return Boolean(io?.sockets.adapter.rooms.get(rooms.tab(userId, tabId))?.size);
  },

  /** Force-disconnect every socket authenticated with a (now revoked) session. */
  disconnectSessions(sessionIds) {
    if (!io) return;
    for (const sessionId of sessionIds) {
      io.in(rooms.session(sessionId)).emit('auth:revoked');
      io.in(rooms.session(sessionId)).disconnectSockets(true);
    }
  },
};
