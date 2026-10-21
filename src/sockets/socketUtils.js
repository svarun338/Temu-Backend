import { schemas, formatIssues } from '../validation/schemas.js';
import { conversationService } from '../services/conversationService.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { rooms } from './realtime.js';

/**
 * Wrap a socket event handler with validation, per-socket rate limiting and
 * uniform acknowledgements: ack({ ok: true, data }) or ack({ ok: false, error }).
 */
export function createHandler(socket, { schema, limiter, handler }) {
  return async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      if (limiter && !limiter.take()) {
        throw new AppError(429, 'RATE_LIMITED', 'You are doing that too fast. Please slow down.');
      }
      const parsed = schema.safeParse(payload ?? {});
      if (!parsed.success) throw AppError.validation(formatIssues(parsed.error));
      const data = await handler(parsed.data);
      reply({ ok: true, data: data ?? null });
    } catch (error) {
      if (error instanceof AppError) {
        reply({ ok: false, error: { code: error.code, message: error.message, details: error.details } });
      } else {
        logger.error('Socket handler failed', { userId: socket.data.user?.id, error });
        reply({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
      }
    }
  };
}

/** Simple token bucket: `capacity` events, refilled continuously over `perMs`. */
export function createLimiter(capacity, perMs) {
  let tokens = capacity;
  let last = Date.now();
  return {
    take() {
      const now = Date.now();
      tokens = Math.min(capacity, tokens + ((now - last) / perMs) * capacity);
      last = now;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}

/**
 * Server-side authorization for conversation-scoped events: the socket must
 * belong to a participant. Membership is cached as Socket.IO room membership.
 */
export async function ensureConversationAccess(socket, conversationId) {
  const room = rooms.conversation(conversationId);
  if (socket.rooms.has(room)) return;
  await conversationService.assertParticipant(conversationId, socket.data.user.id);
  socket.join(room);
}

export { schemas };
