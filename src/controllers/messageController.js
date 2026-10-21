import { messageService } from '../services/messageService.js';
import { notificationService } from '../services/notificationService.js';
import { realtime } from '../sockets/realtime.js';

/**
 * Message actions. Changes that both participants see (edit, delete for
 * everyone, reactions, pins) are broadcast to the conversation; private ones
 * (delete for me, stars) only to the user's own other tabs.
 */
export const messageController = {
  /** Specific messages by id (to decrypt files in a gallery, quoted messages…). */
  async batch(req, res) {
    res.json({ messages: await messageService.batch(req.user.id, req.valid.query.ids, req.deviceId) });
  },

  async edit(req, res) {
    const message = await messageService.edit(req.user.id, req.valid.params.messageId, req.valid.body.body, req.valid.body.encrypted);
    realtime.toConversation(message.conversationId, 'message:updated', message);
    res.json({ message });
  },

  async remove(req, res) {
    const { messageId } = req.valid.params;
    if (req.valid.query.scope === 'everyone') {
      const message = await messageService.deleteForEveryone(req.user.id, messageId);
      realtime.toConversation(message.conversationId, 'message:updated', message);
      return res.json({ message });
    }
    const hidden = await messageService.deleteForMe(req.user.id, messageId);
    realtime.emitToUsers([req.user.id], 'message:hidden', hidden);
    return res.json(hidden);
  },

  async react(req, res) {
    const result = await messageService.react(req.user.id, req.valid.params.messageId, req.valid.body.emoji);
    realtime.toConversation(result.conversationId, 'message:reactions', result);
    res.json(result);
  },

  async unreact(req, res) {
    const result = await messageService.react(req.user.id, req.valid.params.messageId, null);
    realtime.toConversation(result.conversationId, 'message:reactions', result);
    res.json(result);
  },

  async star(req, res) {
    const result = await messageService.setStar(req.user.id, req.valid.params.messageId, true);
    realtime.emitToUsers([req.user.id], 'message:starred', result);
    res.json(result);
  },

  async unstar(req, res) {
    const result = await messageService.setStar(req.user.id, req.valid.params.messageId, false);
    realtime.emitToUsers([req.user.id], 'message:starred', result);
    res.json(result);
  },

  async listStarred(req, res) {
    res.json({ messages: await messageService.listStarred(req.user.id, req.deviceId) });
  },

  async pin(req, res) {
    const result = await messageService.pin(req.user.id, req.valid.params.messageId);
    realtime.toConversation(result.conversationId, 'conversation:pins', result);
    res.json(result);
  },

  async unpin(req, res) {
    const result = await messageService.unpin(req.user.id, req.valid.params.messageId);
    realtime.toConversation(result.conversationId, 'conversation:pins', result);
    res.json(result);
  },

  async forward(req, res) {
    const results = await messageService.forward(req.user.id, req.valid.params.messageId, req.valid.body.conversationIds);
    for (const result of results) {
      if (!result.created) continue;
      realtime.broadcastMessage(result);
      notificationService.run(() => notificationService.afterMessageCreated(result), { userId: req.user.id });
    }
    res.status(201).json({ messages: results.map((result) => result.message) });
  },

  /** REST fallback for live location updates (sockets are preferred). */
  async updateLocation(req, res) {
    const result = await messageService.updateLiveLocation(req.user.id, req.valid.params.messageId, req.valid.body);
    realtime.toConversation(result.conversationId, 'location:updated', result);
    res.json(result);
  },

  async stopLocation(req, res) {
    const result = await messageService.stopLiveLocation(req.user.id, req.valid.params.messageId);
    realtime.toConversation(result.conversationId, 'location:updated', result);
    res.json(result);
  },

  async listLiveLocations(req, res) {
    res.json({ locations: await messageService.listMyLiveLocations(req.user.id) });
  },

  async search(req, res) {
    res.json({ messages: await messageService.search(req.user.id, req.valid.query, req.deviceId) });
  },
};
