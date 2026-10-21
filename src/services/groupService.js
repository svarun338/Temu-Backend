import crypto from 'node:crypto';
import { withTransaction } from '../db/pool.js';
import { blockRepository } from '../repositories/blockRepository.js';
import { contactRepository } from '../repositories/contactRepository.js';
import { conversationRepository } from '../repositories/conversationRepository.js';
import { groupRepository } from '../repositories/groupRepository.js';
import { messageRepository } from '../repositories/messageRepository.js';
import { userRepository } from '../repositories/userRepository.js';
import { AppError } from '../utils/AppError.js';
import { attachmentStorage } from './attachmentStorage.js';
import { messageService } from './messageService.js';
import { presenceService } from './presenceService.js';
import { deleteAvatarFile, storeAvatarImage } from './profileService.js';
import { avatarUrl, canSeeEmail, canSeePresence } from './serializers.js';
import { groupCallService } from './groupCallService.js';
import { logger } from '../utils/logger.js';

/**
 * A transaction that changes a group. It locks the chat row first, the same order as
 * sending a message (chat row, then member rows), so concurrent sends, receipts and
 * group changes queue up instead of deadlocking.
 */
const inGroup = (conversationId, fn) =>
  withTransaction(async (connection) => {
    await conversationRepository.lockForUpdate(connection, conversationId);
    return fn(connection);
  });

/** Someone who leaves (or is removed from) a group leaves its call too; never blocks the group change. */
const leaveGroupCall = (conversationId, userId) =>
  groupCallService.removedFromGroup(conversationId, userId).catch((error) => logger.warn('Leaving the group call failed', { conversationId, userId, error }));

export const MAX_GROUP_MEMBERS = 256;
const notFound = () => AppError.notFound('Group not found');
const isAdmin = (role) => role === 'owner' || role === 'admin';
const snapshot = (user) => ({ id: user.id, name: user.name });

/** A member as seen by `viewerId`: the same privacy rules as everywhere (email, online, blocks). */
function toMember(row, viewerId) {
  const self = row.id === viewerId;
  const blockedMe = Boolean(Number(row.blocked_me));
  return {
    id: row.id,
    name: row.name,
    email: self || canSeeEmail(row) ? row.email : null,
    about: blockedMe ? null : (row.about ?? null),
    avatarUrl: blockedMe ? null : avatarUrl(row.avatar_path),
    role: row.role,
    isOnline: self || canSeePresence(row) ? presenceService.isOnline(row.id) : false,
  };
}

function toGroupInfo(conversationId, group, members, myRole, viewerId) {
  return {
    conversationId,
    name: group.name,
    description: group.description ?? null,
    avatarUrl: avatarUrl(group.avatar_path),
    sendPermission: group.send_permission,
    editPermission: group.edit_permission,
    createdAt: new Date(group.created_at).toISOString(),
    myRole,
    // Only admins see (and share) the invite link.
    inviteCode: isAdmin(myRole) ? (group.invite_code ?? null) : null,
    members: members.map((row) => toMember(row, viewerId)),
  };
}

/**
 * Result of a change: the system messages to broadcast, who is in the group now,
 * and who was removed (their sockets must leave the conversation room).
 */
const change = (conversationId, eventIds, participantIds, removedUserIds = []) => ({ conversationId, eventIds, participantIds, removedUserIds });

export const groupService = {
  /** Me in this group: { group, role }. Non-members and non-groups both get 404. */
  async membership(userId, conversationId) {
    const [group, role] = await Promise.all([groupRepository.find(conversationId), groupRepository.role(conversationId, userId)]);
    if (!group || !role) throw notFound();
    return { group, role };
  },

  async requireAdmin(userId, conversationId) {
    const membership = await this.membership(userId, conversationId);
    if (!isAdmin(membership.role)) throw new AppError(403, 'ADMINS_ONLY', 'Only group admins can do that');
    return membership;
  },

  /** People that `actorId` may put in a group: real, verified, their contacts, no block either way. */
  async assertAddable(actorId, userIds) {
    for (const userId of userIds) {
      const user = await userRepository.findById(userId);
      if (!user || !user.email_verified_at) throw AppError.badRequest('Some of these people could not be found');
      if (!(await contactRepository.exists(actorId, userId))) {
        throw AppError.badRequest(`Add ${user.name} to your contacts before adding them to a group`);
      }
      if (await blockRepository.existsBetween(actorId, userId)) throw AppError.badRequest(`You can't add ${user.name}`);
    }
  },

  /** Insert a system message (inside a transaction) and keep the chat list ordered. */
  async recordEvent(connection, { conversationId, actorId, type, data, at = new Date() }) {
    await conversationRepository.lockForUpdate(connection, conversationId);
    const id = await messageRepository.insertEvent(connection, { conversationId, actorId, type, data, at });
    await conversationRepository.setLastMessage(connection, { conversationId, messageId: id, at });
    await conversationRepository.advanceWatermark({ conversationId, userId: actorId, upToId: id, kind: 'read' }, connection);
    return id;
  },

  async create(creatorId, { name, description, memberIds }) {
    const ids = [...new Set(memberIds)].filter((id) => id !== creatorId);
    if (ids.length === 0) throw AppError.badRequest('Add at least one person to the group');
    if (ids.length + 1 > MAX_GROUP_MEMBERS) throw AppError.badRequest(`A group can have at most ${MAX_GROUP_MEMBERS} members`);
    await this.assertAddable(creatorId, ids);
    const users = await Promise.all(ids.map((id) => userRepository.findById(id)));

    const result = await withTransaction(async (connection) => {
      const conversationId = await conversationRepository.createGroupConversation(connection, creatorId);
      await groupRepository.create(connection, { conversationId, name, description, createdBy: creatorId });
      await groupRepository.addMembers(connection, { conversationId, userIds: [creatorId], role: 'owner', addedBy: creatorId });
      await groupRepository.addMembers(connection, { conversationId, userIds: ids, addedBy: creatorId });
      const eventIds = [
        await this.recordEvent(connection, { conversationId, actorId: creatorId, type: 'group_created', data: { name } }),
        await this.recordEvent(connection, { conversationId, actorId: creatorId, type: 'members_added', data: { users: users.map(snapshot) } }),
      ];
      return { conversationId, eventIds };
    });
    return change(result.conversationId, result.eventIds, [creatorId, ...ids]);
  },

  async getInfo(userId, conversationId) {
    const { group, role } = await this.membership(userId, conversationId);
    return toGroupInfo(conversationId, group, await groupRepository.listMembers(conversationId, userId), role, userId);
  },

  /** Name/description follow "who can edit info"; permissions are admin-only. */
  async update(userId, conversationId, { name, description, sendPermission, editPermission }) {
    const { group, role } = await this.membership(userId, conversationId);
    const editsInfo = name !== undefined || description !== undefined;
    if (editsInfo && group.edit_permission === 'admins' && !isAdmin(role)) {
      throw new AppError(403, 'ADMINS_ONLY', 'Only admins can edit the group info');
    }
    if ((sendPermission !== undefined || editPermission !== undefined) && !isAdmin(role)) {
      throw new AppError(403, 'ADMINS_ONLY', 'Only admins can change group settings');
    }
    await groupRepository.update(conversationId, {
      name,
      description: description === undefined ? undefined : description || null,
      send_permission: sendPermission,
      edit_permission: editPermission,
    });

    const eventIds = await inGroup(conversationId, async (connection) => {
      const ids = [];
      const record = (type, data) => this.recordEvent(connection, { conversationId, actorId: userId, type, data });
      if (name !== undefined && name !== group.name) ids.push(await record('group_renamed', { name }));
      if (description !== undefined && (description || null) !== group.description) ids.push(await record('description_changed', {}));
      if (sendPermission !== undefined && sendPermission !== group.send_permission) ids.push(await record('send_permission_changed', { value: sendPermission }));
      if (editPermission !== undefined && editPermission !== group.edit_permission) ids.push(await record('edit_permission_changed', { value: editPermission }));
      return ids;
    });
    return change(conversationId, eventIds, await conversationRepository.listParticipantIds(conversationId));
  },

  async setAvatar(userId, conversationId, file) {
    const { group, role } = await this.membership(userId, conversationId);
    if (group.edit_permission === 'admins' && !isAdmin(role)) throw new AppError(403, 'ADMINS_ONLY', 'Only admins can edit the group info');
    const fileName = file ? await storeAvatarImage(file) : null;
    await groupRepository.update(conversationId, { avatar_path: fileName });
    await deleteAvatarFile(group.avatar_path);
    const eventId = await inGroup(conversationId, (connection) =>
      this.recordEvent(connection, { conversationId, actorId: userId, type: fileName ? 'photo_changed' : 'photo_removed', data: {} }),
    );
    return change(conversationId, [eventId], await conversationRepository.listParticipantIds(conversationId));
  },

  async addMembers(userId, conversationId, userIds) {
    await this.requireAdmin(userId, conversationId);
    const ids = [...new Set(userIds)].filter((id) => id !== userId);
    await this.assertAddable(userId, ids);
    const result = await inGroup(conversationId, async (connection) => {
      if ((await groupRepository.countMembers(conversationId, connection)) + ids.length > MAX_GROUP_MEMBERS) {
        throw AppError.badRequest(`A group can have at most ${MAX_GROUP_MEMBERS} members`);
      }
      // New members start caught up: older messages don't count as unread for them.
      const latest = await conversationRepository.latestMessageId(conversationId);
      const added = await groupRepository.addMembers(connection, { conversationId, userIds: ids, addedBy: userId, upToMessageId: latest });
      if (added.length === 0) return { eventIds: [] };
      const users = await Promise.all(added.map((id) => userRepository.findById(id)));
      return { eventIds: [await this.recordEvent(connection, { conversationId, actorId: userId, type: 'members_added', data: { users: users.map(snapshot) } })] };
    });
    return change(conversationId, result.eventIds, await conversationRepository.listParticipantIds(conversationId));
  },

  /** Admins remove members; only the owner can remove admins; nobody removes the owner. */
  async removeMember(userId, conversationId, targetId) {
    if (targetId === userId) return this.leave(userId, conversationId);
    const { role } = await this.requireAdmin(userId, conversationId);
    const targetRole = await groupRepository.role(conversationId, targetId);
    if (!targetRole) throw AppError.notFound('This person is not in the group');
    if (targetRole === 'owner') throw new AppError(403, 'FORBIDDEN', "The group owner can't be removed");
    if (targetRole === 'admin' && role !== 'owner') throw new AppError(403, 'FORBIDDEN', 'Only the group owner can remove an admin');
    const target = await userRepository.findById(targetId);
    const participantsBefore = await conversationRepository.listParticipantIds(conversationId);
    await leaveGroupCall(conversationId, targetId);
    const eventId = await inGroup(conversationId, async (connection) => {
      await groupRepository.removeMember(connection, conversationId, targetId);
      return this.recordEvent(connection, { conversationId, actorId: userId, type: 'member_removed', data: { user: snapshot(target) } });
    });
    // The removed person still receives the "you were removed" message, then loses access.
    return change(conversationId, [eventId], participantsBefore, [targetId]);
  },

  /** Make someone an admin or a regular member again. The owner's role can't be changed. */
  async setRole(userId, conversationId, targetId, newRole) {
    await this.requireAdmin(userId, conversationId);
    const targetRole = await groupRepository.role(conversationId, targetId);
    if (!targetRole) throw AppError.notFound('This person is not in the group');
    if (targetRole === 'owner') throw new AppError(403, 'FORBIDDEN', "The group owner's role can't be changed");
    if (targetRole === newRole) return change(conversationId, [], await conversationRepository.listParticipantIds(conversationId));
    const target = await userRepository.findById(targetId);
    const eventId = await inGroup(conversationId, async (connection) => {
      await groupRepository.setRole(conversationId, targetId, newRole, connection);
      const type = newRole === 'admin' ? 'admin_promoted' : 'admin_dismissed';
      return this.recordEvent(connection, { conversationId, actorId: userId, type, data: { user: snapshot(target) } });
    });
    return change(conversationId, [eventId], await conversationRepository.listParticipantIds(conversationId));
  },

  /** Leave a group. An owner hands the group to the longest-serving admin (or member); the last one out deletes it. */
  async leave(userId, conversationId) {
    const { group, role } = await this.membership(userId, conversationId);
    const me = await userRepository.findById(userId);
    const participantsBefore = await conversationRepository.listParticipantIds(conversationId);
    await leaveGroupCall(conversationId, userId); // first: the group may be deleted below
    const result = await inGroup(conversationId, async (connection) => {
      const eventIds = [];
      if (role === 'owner') {
        const nextOwnerId = await groupRepository.nextOwner(connection, conversationId);
        if (!nextOwnerId) {
          // Nobody left: delete the whole group (messages, attachment rows, settings cascade).
          const [files] = await connection.execute('SELECT storage_key, thumbnail_key FROM attachments WHERE conversation_id = ?', [conversationId]);
          await connection.execute('DELETE FROM conversations WHERE id = ?', [conversationId]);
          return { eventIds, deleted: true, fileKeys: files.flatMap((f) => [f.storage_key, f.thumbnail_key]).filter(Boolean) };
        }
        await groupRepository.setRole(conversationId, nextOwnerId, 'owner', connection);
        const nextOwner = await userRepository.findById(nextOwnerId);
        eventIds.push(await this.recordEvent(connection, { conversationId, actorId: userId, type: 'owner_changed', data: { user: snapshot(nextOwner) } }));
      }
      await groupRepository.removeMember(connection, conversationId, userId);
      eventIds.push(await this.recordEvent(connection, { conversationId, actorId: userId, type: 'member_left', data: { user: snapshot(me) } }));
      return { eventIds, deleted: false };
    });
    if (result.deleted) {
      await attachmentStorage.releaseFiles(result.fileKeys); // files no forwarded copy still uses
      await deleteAvatarFile(group.avatar_path); // the row is gone; use what we read before
    }
    return { ...change(conversationId, result.eventIds, participantsBefore, [userId]), deleted: result.deleted };
  },

  // ---- Invite links ----

  /** Create (or replace) the invite link. Replacing makes the old link stop working. */
  async createInvite(userId, conversationId) {
    await this.requireAdmin(userId, conversationId);
    const code = crypto.randomBytes(16).toString('base64url'); // 22 chars, 128 bits
    await groupRepository.update(conversationId, { invite_code: code });
    return { conversationId, inviteCode: code };
  },

  async revokeInvite(userId, conversationId) {
    await this.requireAdmin(userId, conversationId);
    await groupRepository.update(conversationId, { invite_code: null });
    return { conversationId, inviteCode: null };
  },

  /** What a link leads to (for the "Join group?" screen). Unknown links look the same as revoked ones. */
  async previewInvite(userId, code) {
    const group = await groupRepository.findByInviteCode(code);
    if (!group) throw AppError.notFound('This invite link is invalid or was reset');
    return {
      conversationId: group.conversation_id,
      name: group.name,
      description: group.description ?? null,
      avatarUrl: avatarUrl(group.avatar_path),
      memberCount: await groupRepository.countMembers(group.conversation_id),
      alreadyMember: Boolean(await groupRepository.role(group.conversation_id, userId)),
    };
  },

  async joinByInvite(userId, code) {
    const group = await groupRepository.findByInviteCode(code);
    if (!group) throw AppError.notFound('This invite link is invalid or was reset');
    const conversationId = group.conversation_id;
    if (await groupRepository.role(conversationId, userId)) {
      return change(conversationId, [], await conversationRepository.listParticipantIds(conversationId));
    }
    const me = await userRepository.findById(userId);
    const eventId = await inGroup(conversationId, async (connection) => {
      if ((await groupRepository.countMembers(conversationId, connection)) >= MAX_GROUP_MEMBERS) {
        throw AppError.badRequest('This group is full');
      }
      const latest = await conversationRepository.latestMessageId(conversationId);
      await groupRepository.addMembers(connection, { conversationId, userIds: [userId], addedBy: null, upToMessageId: latest });
      return this.recordEvent(connection, { conversationId, actorId: userId, type: 'joined_via_link', data: { user: snapshot(me) } });
    });
    return change(conversationId, [eventId], await conversationRepository.listParticipantIds(conversationId));
  },

  /** Full message objects for a change's system messages (for broadcasting). */
  async eventMessages(eventIds) {
    return (await Promise.all(eventIds.map((id) => messageService.broadcastCopy(id)))).filter(Boolean);
  },
};
