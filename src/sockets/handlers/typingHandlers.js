import { conversationRepository } from '../../repositories/conversationRepository.js';
import { conversationService } from '../../services/conversationService.js';
import { blockService } from '../../services/blockService.js';
import { rooms } from '../realtime.js';
import { createHandler, createLimiter, ensureConversationAccess, schemas } from '../socketUtils.js';

export function registerTypingHandlers(socket) {
  const userId = socket.data.user.id;
  const limiter = createLimiter(40, 10_000);
  const typingIn = new Set();

  /** activity: 'typing' or 'recording' (a voice message). */
  const emitTyping = (conversationId, isTyping, activity = 'typing') => {
    socket.to(rooms.conversation(conversationId)).emit('typing', { conversationId, userId, isTyping, activity });
  };

  for (const [event, isTyping] of [
    ['typing:start', true],
    ['typing:stop', false],
  ]) {
    socket.on(
      event,
      createHandler(socket, {
        schema: schemas.socketTyping,
        limiter,
        handler: async ({ conversationId, activity }) => {
          await ensureConversationAccess(socket, conversationId);
          if (isTyping && (await isBlockedInConversation(userId, conversationId))) return;
          if (isTyping) typingIn.add(conversationId);
          else typingIn.delete(conversationId);
          emitTyping(conversationId, isTyping, activity);
        },
      }),
    );
  }

  // Never leave a stale "typing…" behind when the connection drops.
  socket.on('disconnect', () => {
    for (const conversationId of typingIn) emitTyping(conversationId, false);
    typingIn.clear();
  });
}

/** Typing is never shown across a block in a direct chat (groups aren't affected by blocks). */
async function isBlockedInConversation(userId, conversationId) {
  if ((await conversationRepository.getType(conversationId)) === 'group') return false;
  const participantIds = await conversationService.listParticipantIds(conversationId);
  for (const otherId of participantIds) {
    if (otherId !== userId && (await blockService.isBlockedBetween(userId, otherId))) return true;
  }
  return false;
}
