import { conversationService } from '../services/conversationService.js';
import { messageService } from '../services/messageService.js';
import { notificationService } from '../services/notificationService.js';
import { settingsService } from '../services/settingsService.js';
import { realtime } from '../sockets/realtime.js';

export const conversationController = {
  async list(req, res) {
    res.json({ conversations: await conversationService.list(req.user.id, req.deviceId) });
  },

  async open(req, res) {
    const { conversation, created } = await conversationService.openDirect(req.user.id, req.valid.body.userId);
    res.status(created ? 201 : 200).json({ conversation });
  },

  async get(req, res) {
    res.json({ conversation: await conversationService.get(req.user.id, req.valid.params.id, req.deviceId) });
  },

  async listMessages(req, res) {
    const result = await messageService.list(req.user.id, req.valid.params.id, req.valid.query, req.deviceId);
    res.json(result);
  },

  /** REST fallback for sending; broadcasts over Socket.IO exactly like a socket send. */
  async sendMessage(req, res) {
    const result = await messageService.send({
      senderId: req.user.id,
      conversationId: req.valid.params.id,
      body: req.valid.body.body,
      clientId: req.valid.body.clientId,
      replyToId: req.valid.body.replyToId,
      attachmentIds: req.valid.body.attachmentIds,
      location: req.valid.body.location,
      sticker: req.valid.body.sticker,
      encrypted: req.valid.body.encrypted,
      encryptedLocation: req.valid.body.encryptedLocation,
      forwardFrom: req.valid.body.forwardFrom,
      mentions: req.valid.body.mentions,
    });
    if (result.created) {
      realtime.broadcastMessage(result);
      notificationService.run(() => notificationService.afterMessageCreated(result), { userId: req.user.id });
    }
    res.status(result.created ? 201 : 200).json({ message: result.message });
  },

  /** Mute (duration '8h' | '1w' | 'always') or unmute (DELETE) a chat for me. Other tabs are told live. */
  async mute(req, res) {
    const result = await settingsService.muteConversation(req.user.id, req.valid.params.id, req.valid.body.duration);
    realtime.emitToUsers([req.user.id], 'conversation:muted', result);
    res.json(result);
  },

  async unmute(req, res) {
    const result = await settingsService.muteConversation(req.user.id, req.valid.params.id, null);
    realtime.emitToUsers([req.user.id], 'conversation:muted', result);
    res.json(result);
  },

  async listPins(req, res) {
    res.json({ pins: await messageService.listPins(req.user.id, req.valid.params.id) });
  },

  async markRead(req, res) {
    const receipt = await messageService.markReceipt({
      userId: req.user.id,
      conversationId: req.valid.params.id,
      upToId: req.valid.body.messageId,
      kind: 'read',
    });
    realtime.broadcastReceipt(receipt);
    res.json({ receipt });
  },
};
