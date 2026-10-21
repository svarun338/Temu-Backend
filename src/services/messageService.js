import { config } from '../config/index.js';
import { withTransaction } from '../db/pool.js';
import { attachmentRepository } from '../repositories/attachmentRepository.js';
import { conversationRepository } from '../repositories/conversationRepository.js';
import { groupRepository } from '../repositories/groupRepository.js';
import { locationRepository } from '../repositories/locationRepository.js';
import { pinRepository, reactionRepository, starRepository } from '../repositories/messageExtrasRepository.js';
import { messageRepository } from '../repositories/messageRepository.js';
import { AppError } from '../utils/AppError.js';
import { blockService } from './blockService.js';
import { e2eeService } from './e2eeService.js';
import { attachmentStorage } from './attachmentStorage.js';
import { conversationService } from './conversationService.js';
import { groupStatus, toAttachment, toLocation, toMessage, toPin } from './serializers.js';

const messageNotFound = () => AppError.notFound('Message not found');

/**
 * Ticks for group messages come from member watermarks, not per-message columns.
 * Returns a function row -> status (or undefined for direct chats).
 */
async function groupStatusResolver(rows, viewerId) {
  const conversationIds = [...new Set(rows.map((row) => row.conversation_id))];
  const types = await conversationRepository.typesFor(conversationIds);
  const cache = new Map();
  const watermarks = async (conversationId, exceptUserId) => {
    const key = `${conversationId}:${exceptUserId}`;
    if (!cache.has(key)) cache.set(key, await conversationRepository.groupWatermarksExcept(conversationId, exceptUserId));
    return cache.get(key);
  };
  const statuses = new Map();
  for (const row of rows) {
    if (types.get(row.conversation_id) !== 'group') continue;
    // "Read" means every member other than the sender has read it.
    statuses.set(row.id, groupStatus(row.id, await watermarks(row.conversation_id, viewerId ?? row.sender_id)));
  }
  return (row) => statuses.get(row.id);
}

/**
 * Attach files, locations, reactions, group ticks (and, for a viewer, their stars) to message rows.
 * Encrypted messages get their wrapped keys: only `deviceId`'s (API responses) or all (`allKeys`, broadcasts).
 */
async function withExtras(rows, viewerId, { deviceId = null, allKeys = false } = {}) {
  const ids = rows.map((row) => row.id);
  const encryptedIds = rows.filter((row) => Number(row.encrypted) && !row.deleted_at).map((row) => row.id);
  const [attachments, locations, reactions, starred, statusOf, keys] = await Promise.all([
    attachmentRepository.listFor(ids),
    locationRepository.listFor(ids),
    reactionRepository.listFor(ids),
    viewerId ? starRepository.starredAmong(viewerId, ids) : new Set(),
    groupStatusResolver(rows, viewerId),
    messageRepository.keysFor(encryptedIds, allKeys ? null : (deviceId ?? 0)),
  ]);
  const now = new Date();
  return rows.map((row) =>
    toMessage(row, {
      attachments: (attachments.get(row.id) ?? []).map(toAttachment),
      location: locations.has(row.id) ? toLocation(locations.get(row.id), now) : null,
      reactions: reactions.get(row.id) ?? [],
      starred: starred.has(row.id),
      status: statusOf(row),
      keys: keys.get(row.id) ?? {},
    }),
  );
}

/** System messages ("Alice added Bob") can't be edited, reacted to, forwarded, pinned or starred. */
function assertRegular(row) {
  if (row.event_type) throw AppError.badRequest('This is a system message');
}

const ageMs = (row) => Date.now() - new Date(row.created_at).getTime();

// Group read/delivered point last announced to each group ("<conversationId>:<kind>" -> message id).
const groupStatusSent = new Map();

export const messageService = {
  async list(userId, conversationId, { before, after, limit }, deviceId = null) {
    await conversationService.assertParticipant(conversationId, userId);
    const pageSize = limit ?? config.chat.pageSize;
    const rows = await messageRepository.list(conversationId, userId, { before, after, limit: pageSize });
    return { messages: await withExtras(rows, userId, { deviceId }), hasMore: rows.length === pageSize };
  },

  /** Specific messages (e.g. to decrypt files shown in a gallery). Only those the user may see. */
  async batch(userId, ids, deviceId = null) {
    const rows = [];
    for (const id of new Set(ids)) {
      const row = await messageRepository.findById(id);
      if (row && !row.event_type && (await conversationRepository.isParticipant(row.conversation_id, userId))) rows.push(row);
    }
    return withExtras(rows, userId, { deviceId });
  },

  /**
   * A message the user may act on: it exists and they participate in its
   * conversation. Unknown and foreign messages both give 404 (no probing).
   */
  async getAccessible(userId, messageId) {
    const row = await messageRepository.findById(messageId);
    if (!row || !(await conversationRepository.isParticipant(row.conversation_id, userId))) throw messageNotFound();
    return row;
  },

  /** Viewer-independent copy for broadcasting (stars are private, so not included). */
  async broadcastCopy(messageId) {
    const row = await messageRepository.findById(messageId);
    if (!row) return null; // already gone (e.g. its sender deleted their account)
    return (await withExtras([row], null, { allKeys: true }))[0];
  },

  /**
   * Throws unless `senderId` may post into the conversation. Direct chats: no
   * block either way. Groups: respects "only admins can send" (blocks don't
   * silence anyone in a group). Returns participant ids.
   */
  async assertCanPost(senderId, conversationId) {
    await conversationService.assertParticipant(conversationId, senderId);
    const participantIds = await conversationRepository.listParticipantIds(conversationId);
    if ((await conversationRepository.getType(conversationId)) === 'group') {
      const [group, role] = await Promise.all([groupRepository.find(conversationId), groupRepository.role(conversationId, senderId)]);
      if (group?.send_permission === 'admins' && role === 'member') {
        throw new AppError(403, 'ADMINS_ONLY', 'Only admins can send messages to this group');
      }
      return participantIds;
    }
    for (const otherId of participantIds) {
      if (otherId !== senderId) await blockService.assertCanInteract(senderId, otherId);
    }
    return participantIds;
  },

  /**
   * Persist a message. The sender is always the authenticated user — never a
   * client-supplied id. Sending is idempotent per (sender, clientId), so a client
   * can safely retry after a dropped connection.
   * Returns { message, created, participantIds }.
   */
  /**
   * `encrypted`: { ciphertext, iv, senderDeviceId, keys: [{ deviceId, wrapped, salt, iv }] } with the
   * content (text, sticker, static location, file keys, quote) inside the ciphertext.
   * `encryptedLocation`: { ciphertext, iv, liveMinutes } for an encrypted live location.
   * `forwardFrom`: an encrypted message re-encrypted by the sender's device; its files are shared.
   * `mentions`: user ids @mentioned in an encrypted message (the server can't read the text).
   */
  async send({
    senderId,
    conversationId,
    body = '',
    clientId,
    replyToId = null,
    attachmentIds = [],
    location = null,
    sticker = null,
    forwardedFrom = null,
    encrypted = null,
    encryptedLocation = null,
    forwardFrom = null,
    mentions = [],
  }) {
    const participantIds = await this.assertCanPost(senderId, conversationId);
    if (forwardFrom) {
      const source = await this.getAccessible(senderId, forwardFrom);
      assertRegular(source);
      if (source.deleted_at) throw AppError.badRequest('A deleted message cannot be forwarded');
      forwardedFrom = source.id;
    }
    const forwarded = Boolean(forwardedFrom);
    if (config.e2ee.required && !encrypted) throw new AppError(400, 'ENCRYPTION_REQUIRED', 'Messages must be end-to-end encrypted');
    if (encrypted && (body || sticker || location)) throw AppError.badRequest('An encrypted message carries its content inside the ciphertext');
    if (encryptedLocation && !encrypted) throw AppError.badRequest('An encrypted location needs an encrypted message');
    if (!body && attachmentIds.length === 0 && !location && !sticker && !forwarded && !encrypted) throw AppError.badRequest('Message cannot be empty');
    if (sticker && (body || attachmentIds.length > 0 || location)) throw AppError.badRequest('A sticker is sent on its own');
    if (encrypted) await e2eeService.assertEnvelope(senderId, conversationId, encrypted);
    // Only people in the chat can be @mentioned (used for notifications; the text stays encrypted).
    const mentionedIds = encrypted ? [...new Set(mentions)].filter((id) => id !== senderId && participantIds.includes(id)) : [];
    if (location && attachmentIds.length > 0) throw AppError.badRequest('A location cannot be sent together with files');

    if (clientId) {
      const existing = await messageRepository.findBySenderAndClientId(senderId, clientId);
      if (existing) return this.duplicateResult(existing, conversationId);
    }

    if (replyToId) {
      // Only messages from the same conversation can be quoted.
      const quoted = await messageRepository.findById(replyToId);
      if (!quoted || quoted.conversation_id !== conversationId || quoted.event_type) {
        throw AppError.badRequest('You can only reply to a message in this chat');
      }
    }
    const isGroup = (await conversationRepository.getType(conversationId)) === 'group';

    const at = new Date();
    let messageId;
    try {
      messageId = await withTransaction(async (connection) => {
        await conversationRepository.lockForUpdate(connection, conversationId);
        const id = await messageRepository.insert(connection, {
          conversationId,
          senderId,
          clientId,
          body,
          sticker,
          encrypted,
          replyToId,
          forwarded,
          at,
        });
        if (encrypted) await messageRepository.insertKeys(connection, id, encrypted.keys);
        if (attachmentIds.length > 0) {
          // Only the sender's own, unsent uploads for this chat can be attached.
          const linked = await attachmentRepository.link(connection, { ids: attachmentIds, messageId: id, uploaderId: senderId, conversationId });
          if (linked !== new Set(attachmentIds).size) throw AppError.badRequest('Some attachments are invalid or were already sent');
          // A custom sticker, like a built-in one, is the whole message.
          const [kinds] = await connection.execute('SELECT kind FROM attachments WHERE message_id = ?', [id]);
          if (kinds.some((k) => k.kind === 'sticker') && (kinds.length > 1 || body || location)) {
            throw AppError.badRequest('A sticker is sent on its own');
          }
        }
        if (forwardedFrom) {
          await attachmentRepository.duplicate(connection, { fromMessageId: forwardedFrom, toMessageId: id, conversationId, uploaderId: senderId });
        }
        if (location) {
          const liveUntil = location.liveMinutes ? new Date(at.getTime() + location.liveMinutes * 60_000) : null;
          await locationRepository.insert(connection, { messageId: id, ...location, liveUntil });
        }
        if (encryptedLocation) {
          const liveUntil = new Date(at.getTime() + encryptedLocation.liveMinutes * 60_000);
          await locationRepository.insert(connection, { messageId: id, cipher: encryptedLocation.ciphertext, cipherIv: encryptedLocation.iv, liveUntil });
        }
        await conversationRepository.setLastMessage(connection, { conversationId, messageId: id, at });
        // In groups the sender has obviously "read" their own message (keeps the group-wide minimum moving).
        if (isGroup) await conversationRepository.advanceWatermark({ conversationId, userId: senderId, upToId: id, kind: 'read' }, connection);
        return id;
      });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY' && clientId) {
        return this.duplicateResult(await messageRepository.findBySenderAndClientId(senderId, clientId), conversationId);
      }
      throw error;
    }

    const [message] = await withExtras([await messageRepository.findById(messageId)], null, { allKeys: true });
    return { message, created: true, participantIds, mentions: mentionedIds };
  },

  async duplicateResult(row, conversationId) {
    if (row.conversation_id !== conversationId) throw AppError.conflict('This client id was already used');
    const participantIds = await conversationRepository.listParticipantIds(conversationId);
    return { message: (await withExtras([row], null, { allKeys: true }))[0], created: false, participantIds };
  },

  /** Copy a message into other conversations the user belongs to. Returns one send result per target. */
  async forward(userId, messageId, conversationIds) {
    const source = await this.getAccessible(userId, messageId);
    assertRegular(source);
    if (source.deleted_at) throw AppError.badRequest('A deleted message cannot be forwarded');
    if (Number(source.encrypted)) {
      throw AppError.badRequest('Encrypted messages are forwarded from your device (send with forwardFrom)');
    }
    const results = [];
    // A forwarded location is a static pin at its current position, never live.
    const sourceLocation = await locationRepository.findByMessageId(source.id);
    const location = sourceLocation
      ? { latitude: Number(sourceLocation.latitude), longitude: Number(sourceLocation.longitude), accuracy: sourceLocation.accuracy_m }
      : null;
    for (const conversationId of new Set(conversationIds)) {
      // Attachments are copied by reference: the forwarded message shares the stored files.
      results.push(await this.send({ senderId: userId, conversationId, body: source.body, sticker: source.sticker, location, forwardedFrom: source.id }));
    }
    return results;
  },

  /** Only the sender may edit, only text that isn't deleted, and only for a limited time. */
  async edit(userId, messageId, body, encrypted = null) {
    const row = await this.getAccessible(userId, messageId);
    assertRegular(row);
    if (row.sender_id !== userId) throw AppError.forbidden('You can only edit your own messages');
    if (row.deleted_at) throw AppError.badRequest('This message was deleted');
    const attachments = (await attachmentRepository.listFor([messageId])).get(messageId) ?? [];
    if (row.sticker || attachments.some((a) => a.kind === 'sticker')) throw AppError.badRequest('Stickers cannot be edited');
    if (ageMs(row) > config.chat.editWindowMinutes * 60_000) {
      throw AppError.forbidden(`Messages can only be edited within ${config.chat.editWindowMinutes} minutes`);
    }
    await this.assertCanPost(userId, row.conversation_id);
    if (Number(row.encrypted)) {
      if (!encrypted) throw AppError.badRequest('Send the edited message encrypted');
      await e2eeService.assertEnvelope(userId, row.conversation_id, encrypted);
      await withTransaction((connection) => messageRepository.replaceEncrypted(connection, messageId, encrypted, new Date()));
    } else {
      if (encrypted || !body) throw AppError.badRequest('This message is not encrypted');
      if (row.body !== body) await messageRepository.updateBody(messageId, body, new Date());
    }
    return this.broadcastCopy(messageId);
  },

  /** "Delete for everyone": the sender only, within the time limit. Content and attachments are erased. */
  async deleteForEveryone(userId, messageId) {
    const row = await this.getAccessible(userId, messageId);
    assertRegular(row);
    if (row.sender_id !== userId) throw AppError.forbidden('You can only delete your own messages for everyone');
    if (!row.deleted_at) {
      if (ageMs(row) > config.chat.deleteForEveryoneHours * 3_600_000) {
        throw AppError.forbidden(`Messages can only be deleted for everyone within ${config.chat.deleteForEveryoneHours} hours`);
      }
      const fileKeys = await withTransaction(async (connection) => {
        await messageRepository.softDelete(connection, messageId, new Date());
        await locationRepository.deleteForMessage(connection, messageId);
        return attachmentRepository.deleteForMessage(connection, messageId);
      });
      // Files go too (unless a forwarded copy still uses them).
      await attachmentStorage.releaseFiles(fileKeys);
    }
    return this.broadcastCopy(messageId);
  },

  /** "Delete for me": hides the message from this user only. */
  async deleteForMe(userId, messageId) {
    const row = await this.getAccessible(userId, messageId);
    await messageRepository.hideForUser(messageId, userId);
    return { messageId, conversationId: row.conversation_id };
  },

  /** Set (emoji) or clear (null) the user's reaction. Returns { conversationId, messageId, reactions }. */
  async react(userId, messageId, emoji) {
    const row = await this.getAccessible(userId, messageId);
    assertRegular(row);
    if (row.deleted_at) throw AppError.badRequest('You cannot react to a deleted message');
    if (emoji) {
      await this.assertCanPost(userId, row.conversation_id);
      await reactionRepository.set(messageId, userId, emoji);
    } else {
      await reactionRepository.remove(messageId, userId);
    }
    const reactions = (await reactionRepository.listFor([messageId])).get(messageId) ?? [];
    return { conversationId: row.conversation_id, messageId, reactions };
  },

  async setStar(userId, messageId, starred) {
    const row = await this.getAccessible(userId, messageId);
    assertRegular(row);
    if (starred) {
      if (row.deleted_at) throw AppError.badRequest('You cannot star a deleted message');
      await starRepository.add(messageId, userId);
    } else {
      await starRepository.remove(messageId, userId);
    }
    return { messageId, conversationId: row.conversation_id, starred };
  },

  async listStarred(userId, deviceId = null) {
    const rows = await starRepository.list(userId);
    const messages = await withExtras(rows, userId, { deviceId });
    return messages.map((message, index) => ({ ...message, starredAt: new Date(rows[index].starred_at).toISOString() }));
  },

  /** Pin a message for both participants. Pinning beyond the limit replaces the oldest pin. */
  async pin(userId, messageId) {
    const row = await this.getAccessible(userId, messageId);
    assertRegular(row);
    if (row.deleted_at) throw AppError.badRequest('You cannot pin a deleted message');
    const conversationId = row.conversation_id;
    await withTransaction(async (connection) => {
      if ((await pinRepository.countForUpdate(connection, conversationId)) >= config.chat.maxPins) {
        const oldest = await pinRepository.oldest(connection, conversationId);
        if (oldest !== messageId) await pinRepository.removeWith(connection, conversationId, oldest);
      }
      await pinRepository.add(connection, { conversationId, messageId, userId });
    });
    return { conversationId, pins: await this.listPinsUnchecked(conversationId) };
  },

  async unpin(userId, messageId) {
    const row = await this.getAccessible(userId, messageId);
    await pinRepository.remove(row.conversation_id, messageId);
    return { conversationId: row.conversation_id, pins: await this.listPinsUnchecked(row.conversation_id) };
  },

  async listPins(userId, conversationId) {
    await conversationService.assertParticipant(conversationId, userId);
    return this.listPinsUnchecked(conversationId);
  },

  async listPinsUnchecked(conversationId) {
    const rows = await pinRepository.list(conversationId);
    const keys = await messageRepository.keysFor(rows.filter((r) => Number(r.encrypted)).map((r) => r.message_id));
    return rows.map((row) => toPin(row, keys.get(row.message_id)));
  },

  /** The sender's own live location, still in a chat they can post to. */
  async ownLiveLocation(userId, messageId) {
    const row = await this.getAccessible(userId, messageId);
    if (row.sender_id !== userId) throw AppError.forbidden('Only the person sharing can update this location');
    await this.assertCanPost(userId, row.conversation_id);
    return row;
  },

  /** Move a live location. Returns { conversationId, messageId, location } to broadcast. */
  async updateLiveLocation(userId, messageId, { latitude, longitude, accuracy, ciphertext, iv }) {
    const row = await this.ownLiveLocation(userId, messageId);
    const moved = ciphertext
      ? await locationRepository.updateCipher({ messageId, cipher: ciphertext, cipherIv: iv, now: new Date() })
      : await locationRepository.updatePosition({ messageId, latitude, longitude, accuracy, now: new Date() });
    if (!moved) throw new AppError(409, 'LOCATION_NOT_LIVE', 'This live location has ended');
    return { conversationId: row.conversation_id, messageId, location: toLocation(await locationRepository.findByMessageId(messageId)) };
  },

  /** Stop sharing a live location early. */
  async stopLiveLocation(userId, messageId) {
    const row = await this.getAccessible(userId, messageId);
    if (row.sender_id !== userId) throw AppError.forbidden('Only the person sharing can stop this location');
    if (!(await locationRepository.stop(messageId, new Date()))) throw new AppError(409, 'LOCATION_NOT_LIVE', 'This live location has already ended');
    return { conversationId: row.conversation_id, messageId, location: toLocation(await locationRepository.findByMessageId(messageId)) };
  },

  /** My live locations that are still running (so the app can resume sharing after a reload). */
  async listMyLiveLocations(userId) {
    const rows = await locationRepository.listActiveForSender(userId, new Date());
    return rows.map((row) => ({ messageId: row.message_id, conversationId: row.conversation_id, liveUntil: new Date(row.live_until).toISOString() }));
  },

  /** Search the user's own messages, optionally within one conversation. */
  async search(userId, { q, conversationId }, deviceId = null) {
    if (conversationId) await conversationService.assertParticipant(conversationId, userId);
    // Only plaintext messages can be searched here; encrypted ones are searched on the device.
    const rows = await messageRepository.search({ userId, query: q, conversationId, limit: 50 });
    return withExtras(rows, userId, { deviceId });
  },

  /**
   * Record that `userId` received (`delivered`) or saw (`read`) messages from the
   * other participant, up to `upToId` (or everything so far).
   * Returns a receipt to broadcast, or null when nothing changed.
   */
  async markReceipt({ userId, conversationId, upToId, kind }) {
    await conversationService.assertParticipant(conversationId, userId);
    const at = new Date();
    if ((await conversationRepository.getType(conversationId)) === 'group') return this.markGroupReceipt({ userId, conversationId, upToId, kind, at });
    const maxId = await withTransaction(async (connection) => {
      await conversationRepository.lockForUpdate(connection, conversationId);
      return messageRepository.markReceipt({ conversationId, recipientId: userId, upToId, at, kind }, connection);
    });
    if (!maxId) return null;
    return { conversationId, upToMessageId: maxId, status: kind, at: at.toISOString(), byUserId: userId };
  },

  /**
   * Groups: move my watermark, then report how far *everyone* has got. A message
   * counts as read/delivered only once all members are past it.
   */
  async markGroupReceipt({ userId, conversationId, upToId, kind, at }) {
    const latest = await conversationRepository.latestMessageId(conversationId);
    const target = Math.min(upToId ?? latest ?? 0, latest ?? 0);
    if (!target) return null;
    if (!(await conversationRepository.advanceWatermark({ conversationId, userId, upToId: target, kind }))) return null;
    const { minRead, minDelivered } = await conversationRepository.groupWatermarks(conversationId);
    const upToMessageId = kind === 'read' ? minRead : minDelivered;
    // The whole group only hears about it when the group-wide point moved (senders' ticks change);
    // otherwise just my own tabs do. In a group of 100 that avoids ~10,000 events per message.
    const key = `${conversationId}:${kind}`;
    const toGroup = upToMessageId > 0 && groupStatusSent.get(key) !== upToMessageId; // 0: nothing to tick yet
    if (toGroup) groupStatusSent.set(key, upToMessageId);
    // byUserId: me, so my other tabs clear their unread badge; senders update their ticks.
    const receipt = { conversationId, upToMessageId, status: kind, at: at.toISOString(), byUserId: userId, group: true };
    return Object.defineProperty(receipt, 'toGroup', { value: toGroup, enumerable: false }); // server-side only
  },

  /** Tests: forget which group read points were announced (conversation ids repeat after a reset). */
  resetGroupStatus() {
    groupStatusSent.clear();
  },

  /** When a user comes online, everything waiting for them counts as delivered. */
  async markAllPendingDelivered(userId) {
    const pending = [
      ...(await messageRepository.listUndeliveredConversations(userId)),
      ...(await conversationRepository.listGroupsWithUndelivered(userId)),
    ];
    const receipts = [];
    for (const row of pending) {
      const receipt = await this.markReceipt({
        userId,
        conversationId: row.conversation_id,
        upToId: row.max_id,
        kind: 'delivered',
      });
      if (receipt) receipts.push(receipt);
    }
    return receipts;
  },
};
