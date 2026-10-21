import { conversationService } from '../services/conversationService.js';
import { groupService } from '../services/groupService.js';
import { notificationService } from '../services/notificationService.js';
import { realtime } from '../sockets/realtime.js';

/**
 * Broadcast a group change: its system messages to everyone involved, a
 * "group:updated" nudge so clients refresh member lists, and removal of
 * people who left or were removed from the conversation room.
 */
export async function publishGroupChange(result, actorId) {
  const { conversationId, eventIds, participantIds, removedUserIds } = result;
  const messages = await groupService.eventMessages(eventIds);
  for (const message of messages) {
    realtime.broadcastMessage({ message, participantIds });
    notificationService.run(() => notificationService.afterGroupEvent({ message, participantIds }), { userId: actorId });
  }
  realtime.emitToUsers(participantIds, 'group:updated', { conversationId });
  if (removedUserIds.length) {
    realtime.removeFromConversation(removedUserIds, conversationId);
    realtime.emitToUsers(removedUserIds, 'group:removed', { conversationId, deleted: Boolean(result.deleted) });
  }
}

export const groupController = {
  async create(req, res) {
    const result = await groupService.create(req.user.id, req.valid.body);
    await publishGroupChange(result, req.user.id);
    res.status(201).json({ conversation: await conversationService.get(req.user.id, result.conversationId, req.deviceId) });
  },

  async get(req, res) {
    res.json({ group: await groupService.getInfo(req.user.id, req.valid.params.id) });
  },

  async update(req, res) {
    await publishGroupChange(await groupService.update(req.user.id, req.valid.params.id, req.valid.body), req.user.id);
    res.json({ group: await groupService.getInfo(req.user.id, req.valid.params.id) });
  },

  async setAvatar(req, res) {
    await publishGroupChange(await groupService.setAvatar(req.user.id, req.valid.params.id, req.file ?? { buffer: null }), req.user.id);
    res.json({ group: await groupService.getInfo(req.user.id, req.valid.params.id) });
  },

  async removeAvatar(req, res) {
    await publishGroupChange(await groupService.setAvatar(req.user.id, req.valid.params.id, null), req.user.id);
    res.json({ group: await groupService.getInfo(req.user.id, req.valid.params.id) });
  },

  async addMembers(req, res) {
    await publishGroupChange(await groupService.addMembers(req.user.id, req.valid.params.id, req.valid.body.userIds), req.user.id);
    res.json({ group: await groupService.getInfo(req.user.id, req.valid.params.id) });
  },

  async removeMember(req, res) {
    const { id, userId } = req.valid.params;
    await publishGroupChange(await groupService.removeMember(req.user.id, id, userId), req.user.id);
    if (userId === req.user.id) return res.status(204).end();
    return res.json({ group: await groupService.getInfo(req.user.id, id) });
  },

  async setRole(req, res) {
    const { id, userId } = req.valid.params;
    await publishGroupChange(await groupService.setRole(req.user.id, id, userId, req.valid.body.role), req.user.id);
    res.json({ group: await groupService.getInfo(req.user.id, id) });
  },

  async leave(req, res) {
    await publishGroupChange(await groupService.leave(req.user.id, req.valid.params.id), req.user.id);
    res.status(204).end();
  },

  async createInvite(req, res) {
    res.json(await groupService.createInvite(req.user.id, req.valid.params.id));
  },

  async revokeInvite(req, res) {
    res.json(await groupService.revokeInvite(req.user.id, req.valid.params.id));
  },

  async previewInvite(req, res) {
    res.json({ invite: await groupService.previewInvite(req.user.id, req.valid.params.code) });
  },

  async join(req, res) {
    const result = await groupService.joinByInvite(req.user.id, req.valid.params.code);
    await publishGroupChange(result, req.user.id);
    res.json({ conversation: await conversationService.get(req.user.id, result.conversationId, req.deviceId) });
  },
};
