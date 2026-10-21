import { withTransaction } from '../db/pool.js';
import { contactRepository } from '../repositories/contactRepository.js';
import { conversationRepository, directKey } from '../repositories/conversationRepository.js';
import { messageRepository } from '../repositories/messageRepository.js';
import { userRepository } from '../repositories/userRepository.js';
import { AppError } from '../utils/AppError.js';
import { blockService } from './blockService.js';
import { toConversation } from './serializers.js';

/** Wrapped keys of encrypted last messages for one device. */
function lastMessageKeys(rows, deviceId) {
  const ids = rows.filter((row) => row.lm_id && Number(row.lm_encrypted)).map((row) => row.lm_id);
  return messageRepository.keysFor(ids, deviceId ?? 0);
}

// 404 rather than 403 so callers cannot probe which conversation ids exist.
const notFound = () => AppError.notFound('Conversation not found');

export const conversationService = {
  /** `deviceId`: the requesting device, so encrypted last messages come with its key. */
  async list(userId, deviceId = null) {
    const rows = await conversationRepository.listForUser(userId);
    const keys = await lastMessageKeys(rows, deviceId);
    return rows.map((row) => toConversation(row, keys.get(row.lm_id)));
  },

  async get(userId, conversationId, deviceId = null) {
    const row = await conversationRepository.findForUser(conversationId, userId);
    if (!row) throw notFound();
    const keys = await lastMessageKeys([row], deviceId);
    return toConversation(row, keys.get(row.lm_id));
  },

  /** Throws 404 unless `userId` participates in the conversation. */
  async assertParticipant(conversationId, userId) {
    if (!(await conversationRepository.isParticipant(conversationId, userId))) throw notFound();
  },

  /**
   * Get or create the one-to-one conversation between `userId` and `peerId`.
   * New conversations can only be started with users in your contact list.
   * Returns { conversation, created }.
   */
  async openDirect(userId, peerId) {
    if (userId === peerId) throw AppError.badRequest('You cannot start a conversation with yourself');
    const peer = await userRepository.findById(peerId);
    if (!peer || !peer.email_verified_at) throw AppError.notFound('User not found');

    const key = directKey(userId, peerId);
    let conversationId = await conversationRepository.findIdByDirectKey(key);
    let created = false;

    if (!conversationId) {
      await blockService.assertCanInteract(userId, peerId);
      if (!(await contactRepository.exists(userId, peerId))) {
        throw AppError.forbidden('Add this user to your contacts before starting a conversation');
      }
      try {
        conversationId = await withTransaction((connection) =>
          conversationRepository.createDirect(connection, { key, createdBy: userId, userIds: [userId, peerId] }),
        );
        created = true;
      } catch (error) {
        if (error.code !== 'ER_DUP_ENTRY') throw error;
        // The other user opened the same conversation at the same moment.
        conversationId = await conversationRepository.findIdByDirectKey(key);
      }
    }

    return { conversation: await this.get(userId, conversationId), created };
  },

  listIdsForUser(userId) {
    return conversationRepository.listIdsForUser(userId);
  },

  listParticipantIds(conversationId) {
    return conversationRepository.listParticipantIds(conversationId);
  },
};
