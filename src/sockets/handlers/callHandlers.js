import { config } from '../../config/index.js';
import { callService } from '../../services/callService.js';
import { groupCallService } from '../../services/groupCallService.js';
import { createHandler, createLimiter, schemas } from '../socketUtils.js';

// Placing calls is limited per account (shared by all its tabs), so opening more tabs doesn't allow more ringing.
const startLimiters = new Map();
function startLimiterFor(userId) {
  if (!startLimiters.has(userId)) startLimiters.set(userId, createLimiter(config.isTest ? 1000 : 10, 60_000));
  return startLimiters.get(userId);
}

export function registerCallHandlers(socket) {
  const userId = socket.data.user.id;
  const tabId = socket.data.tabId;
  const callLimiter = createLimiter(10, 30_000);
  // Connecting a call trickles many ICE candidates in a burst.
  const signalLimiter = createLimiter(200, 10_000);

  socket.on(
    'call:start',
    createHandler(socket, {
      schema: schemas.socketCallStart,
      limiter: startLimiterFor(userId),
      handler: (payload) => callService.start(userId, tabId, payload),
    }),
  );

  socket.on(
    'call:accept',
    createHandler(socket, {
      schema: schemas.socketCall,
      limiter: callLimiter,
      handler: ({ callId }) => callService.accept(userId, tabId, callId),
    }),
  );

  socket.on(
    'call:reject',
    createHandler(socket, {
      schema: schemas.socketCall,
      limiter: callLimiter,
      handler: ({ callId }) => callService.reject(userId, callId),
    }),
  );

  socket.on(
    'call:end',
    createHandler(socket, {
      schema: schemas.socketCall,
      limiter: callLimiter,
      handler: ({ callId }) => callService.end(userId, callId),
    }),
  );

  socket.on(
    'call:signal',
    createHandler(socket, {
      schema: schemas.socketCallSignal,
      limiter: signalLimiter,
      handler: (payload) => callService.signal(userId, tabId, payload),
    }),
  );

  // ---- Group calls (mesh, up to MAX_GROUP_CALL_PARTICIPANTS people) ----
  socket.on(
    'groupcall:start',
    createHandler(socket, {
      schema: schemas.socketCallStart,
      limiter: startLimiterFor(userId),
      handler: (payload) => groupCallService.start(userId, tabId, payload),
    }),
  );

  socket.on(
    'groupcall:join',
    createHandler(socket, {
      schema: schemas.socketCall,
      limiter: callLimiter,
      handler: ({ callId }) => groupCallService.join(userId, tabId, callId),
    }),
  );

  socket.on(
    'groupcall:decline',
    createHandler(socket, {
      schema: schemas.socketCall,
      limiter: callLimiter,
      handler: ({ callId }) => groupCallService.decline(userId, callId),
    }),
  );

  socket.on(
    'groupcall:leave',
    createHandler(socket, {
      schema: schemas.socketCall,
      limiter: callLimiter,
      handler: ({ callId }) => groupCallService.leave(userId, callId),
    }),
  );

  // One offer/answer and a burst of ICE candidates per other participant (up to 5 of them).
  const groupSignalLimiter = createLimiter(600, 10_000);
  socket.on(
    'groupcall:signal',
    createHandler(socket, {
      schema: schemas.socketGroupCallSignal,
      limiter: groupSignalLimiter,
      handler: (payload) => groupCallService.signal(userId, tabId, payload),
    }),
  );

  socket.on('disconnect', () => callService.tabDisconnected(userId, tabId));
}
