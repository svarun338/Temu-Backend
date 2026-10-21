import { Server } from 'socket.io';
import { config } from '../config/index.js';
import { callService } from '../services/callService.js';
import { groupCallService } from '../services/groupCallService.js';
import { conversationService } from '../services/conversationService.js';
import { logger } from '../utils/logger.js';
import { registerCallHandlers } from './handlers/callHandlers.js';
import { registerChatHandlers } from './handlers/chatHandlers.js';
import { handlePresenceConnect, registerPresenceHandlers } from './handlers/presenceHandlers.js';
import { registerTypingHandlers } from './handlers/typingHandlers.js';
import { realtime, rooms } from './realtime.js';
import { socketAuth } from './socketAuth.js';

const MAX_TIMEOUT_MS = 2_147_483_647;

export function createSocketServer(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: config.clientOrigins, credentials: true },
    maxHttpBufferSize: 64 * 1024,
    pingInterval: 25_000,
    pingTimeout: 20_000,
  });

  io.use(socketAuth);

  io.on('connection', async (socket) => {
    const { user, sessionId, tabId, tokenExpiresAt } = socket.data;

    // Register handlers synchronously so no early client event is missed.
    registerPresenceHandlers(socket);
    registerTypingHandlers(socket);
    registerChatHandlers(socket);
    registerCallHandlers(socket);

    // Sockets authenticate once, so drop them when the access token expires;
    // the client refreshes its token and reconnects transparently.
    const expiryTimer = setTimeout(
      () => {
        socket.emit('auth:expired');
        socket.disconnect(true);
      },
      Math.min(Math.max(tokenExpiresAt - Date.now(), 0), MAX_TIMEOUT_MS),
    );
    socket.on('disconnect', () => clearTimeout(expiryTimer));

    try {
      socket.join([rooms.user(user.id), rooms.session(sessionId), rooms.tab(user.id, tabId)]);
      const conversationIds = await conversationService.listIdsForUser(user.id);
      socket.join(conversationIds.map(rooms.conversation));
      await handlePresenceConnect(socket);
      socket.emit('session:ready', { userId: user.id });
      callService.tabConnected(socket);
      // Group calls going on in my groups: show "Join", and ring if it is still ringing for me.
      groupCallService.greet(socket, conversationIds);
    } catch (error) {
      logger.error('Socket connection setup failed', { userId: user.id, error });
      socket.disconnect(true);
    }
  });

  realtime.attach(io);
  return io;
}
