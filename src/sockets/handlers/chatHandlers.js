import { messageService } from '../../services/messageService.js';
import { notificationService } from '../../services/notificationService.js';
import { realtime } from '../realtime.js';
import { createHandler, createLimiter, ensureConversationAccess, schemas } from '../socketUtils.js';

export function registerChatHandlers(socket) {
  const userId = socket.data.user.id;
  const sendLimiter = createLimiter(20, 10_000);
  const receiptLimiter = createLimiter(120, 10_000);
  // Live location: at most ~1 update every 3 seconds per socket.
  const locationLimiter = createLimiter(10, 30_000);

  // Move my live location; everyone in the chat sees it move.
  socket.on(
    'location:update',
    createHandler(socket, {
      schema: schemas.socketLocationUpdate,
      limiter: locationLimiter,
      handler: async ({ messageId, ...coords }) => {
        const result = await messageService.updateLiveLocation(userId, messageId, coords);
        realtime.toConversation(result.conversationId, 'location:updated', result);
        return result;
      },
    }),
  );

  socket.on(
    'location:stop',
    createHandler(socket, {
      schema: schemas.socketLocationStop,
      limiter: receiptLimiter,
      handler: async ({ messageId }) => {
        const result = await messageService.stopLiveLocation(userId, messageId);
        realtime.toConversation(result.conversationId, 'location:updated', result);
        return result;
      },
    }),
  );

  // Join a conversation room after verifying participation.
  socket.on(
    'conversation:join',
    createHandler(socket, {
      schema: schemas.socketConversation,
      limiter: receiptLimiter,
      handler: async ({ conversationId }) => {
        await ensureConversationAccess(socket, conversationId);
      },
    }),
  );

  // The message is acknowledged only after it has been committed to the database.
  socket.on(
    'message:send',
    createHandler(socket, {
      schema: schemas.socketSend,
      limiter: sendLimiter,
      handler: async ({ conversationId, body, clientId, replyToId, attachmentIds, location, sticker, encrypted, encryptedLocation, forwardFrom, mentions }) => {
        const result = await messageService.send({
          senderId: userId,
          conversationId,
          body,
          clientId,
          replyToId,
          attachmentIds,
          location,
          sticker,
          encrypted,
          encryptedLocation,
          forwardFrom,
          mentions,
        });
        await ensureConversationAccess(socket, conversationId);
        realtime.broadcastMessage(result);
        if (result.created) notificationService.run(() => notificationService.afterMessageCreated(result), { userId });
        return { message: result.message };
      },
    }),
  );

  socket.on(
    'message:delivered',
    createHandler(socket, {
      schema: schemas.socketReceipt,
      limiter: receiptLimiter,
      handler: async ({ conversationId, messageId }) => {
        const receipt = await messageService.markReceipt({ userId, conversationId, upToId: messageId, kind: 'delivered' });
        realtime.broadcastReceipt(receipt);
        return receipt;
      },
    }),
  );

  socket.on(
    'message:read',
    createHandler(socket, {
      schema: schemas.socketReceipt,
      limiter: receiptLimiter,
      handler: async ({ conversationId, messageId }) => {
        const receipt = await messageService.markReceipt({ userId, conversationId, upToId: messageId, kind: 'read' });
        realtime.broadcastReceipt(receipt);
        return receipt;
      },
    }),
  );
}
