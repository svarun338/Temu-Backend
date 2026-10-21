import bcrypt from 'bcrypt';
import { pool, withTransaction } from '../db/pool.js';
import { conversationRepository } from '../repositories/conversationRepository.js';
import { userRepository } from '../repositories/userRepository.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { attachmentStorage } from './attachmentStorage.js';
import { blockService } from './blockService.js';
import { callService } from './callService.js';
import { contactService } from './contactService.js';
import { groupService } from './groupService.js';
import { deleteAvatarFile } from './profileService.js';
import { recordingService } from './recordingService.js';
import { toUser } from './serializers.js';
import { settingsService } from './settingsService.js';
import { wallpaperService } from './wallpaperService.js';

const iso = (value) => (value ? new Date(value).toISOString() : null);

async function assertPassword(userId, password) {
  const user = await userRepository.findById(userId);
  const withHash = user && (await userRepository.findByEmailWithPassword(user.email));
  if (!withHash || !(await bcrypt.compare(password, withHash.password_hash))) {
    throw new AppError(403, 'WRONG_PASSWORD', 'That password is not correct');
  }
  return user;
}

export const accountService = {
  /**
   * "Download my data": everything TEMU stores about me, as JSON. Other
   * people's messages are not included; their names appear only where they
   * are part of my own data (my contacts, my chats).
   */
  async exportData(userId) {
    const user = await userRepository.findById(userId);
    const [settings, contacts, blocked] = await Promise.all([settingsService.get(userId), contactService.list(userId), blockService.list(userId)]);
    const [conversations] = await pool.execute(
      `SELECT c.id, c.type, p.joined_at, p.role, g.name AS group_name,
              (SELECT u.name FROM conversation_participants op JOIN users u ON u.id = op.user_id
                WHERE c.type = 'direct' AND op.conversation_id = c.id AND op.user_id <> p.user_id LIMIT 1) AS with_name
         FROM conversation_participants p
         JOIN conversations c ON c.id = p.conversation_id
         LEFT JOIN chat_groups g ON g.conversation_id = c.id
        WHERE p.user_id = ?
        ORDER BY c.id`,
      [userId],
    );
    const [messages] = await pool.execute(
      `SELECT m.id, m.conversation_id, m.body, m.sticker, m.encrypted, m.created_at, m.edited_at, m.deleted_at, m.forwarded,
              (SELECT GROUP_CONCAT(a.original_name SEPARATOR ' | ') FROM attachments a WHERE a.message_id = m.id) AS files,
              (SELECT CONCAT(l.latitude, ',', l.longitude) FROM message_locations l WHERE l.message_id = m.id) AS location
         FROM messages m
        WHERE m.sender_id = ? AND m.event_type IS NULL
        ORDER BY m.id`,
      [userId],
    );
    const [calls] = await pool.execute(
      `SELECT cl.id, cl.type, cl.status, cl.created_at, cl.answered_at, cl.ended_at,
              IF(cl.caller_id = ?, 'outgoing', 'incoming') AS direction, u.name AS with_name
         FROM calls cl JOIN users u ON u.id = IF(cl.caller_id = ?, cl.callee_id, cl.caller_id)
        WHERE cl.caller_id = ? OR cl.callee_id = ?
        ORDER BY cl.id`,
      [userId, userId, userId, userId],
    );
    const [sessions] = await pool.execute(
      'SELECT created_at, updated_at, expires_at, revoked_at, user_agent, ip_address FROM sessions WHERE user_id = ? ORDER BY id',
      [userId],
    );
    const [notifications] = await pool.execute(
      'SELECT type, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY id',
      [userId],
    );
    const [wallpapers] = await pool.execute('SELECT created_at FROM user_wallpapers WHERE user_id = ?', [userId]);
    const [[push]] = await pool.execute('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', [userId]);

    return {
      exportedAt: new Date().toISOString(),
      account: { ...toUser(user), lastSeenAt: iso(user.last_seen_at) },
      settings: { ...settings, push: undefined },
      contacts: contacts.map((c) => ({ id: c.id, name: c.name, email: c.email, addedAt: c.addedAt })),
      blockedUsers: blocked.map((b) => ({ id: b.id, name: b.name, blockedAt: b.blockedAt })),
      conversations: conversations.map((c) => ({
        id: c.id,
        type: c.type,
        with: c.type === 'group' ? c.group_name : c.with_name,
        role: c.role ?? undefined,
        joinedAt: iso(c.joined_at),
      })),
      messagesSent: messages.map((m) => ({
        id: m.id,
        conversationId: m.conversation_id,
        // End-to-end encrypted messages exist on the server only as ciphertext it can't read.
        text: m.deleted_at || m.encrypted ? null : m.body,
        endToEndEncrypted: Boolean(m.encrypted) || undefined,
        sticker: m.deleted_at ? null : (m.sticker ?? undefined),
        files: m.deleted_at || !m.files ? [] : m.files.split(' | '),
        location: m.deleted_at ? null : m.location,
        forwarded: Boolean(m.forwarded),
        sentAt: iso(m.created_at),
        editedAt: iso(m.edited_at),
        deletedForEveryoneAt: iso(m.deleted_at),
      })),
      calls: calls.map((c) => ({
        id: c.id,
        type: c.type,
        direction: c.direction,
        status: c.status,
        with: c.with_name,
        startedAt: iso(c.created_at),
        answeredAt: iso(c.answered_at),
        endedAt: iso(c.ended_at),
      })),
      loginSessions: sessions.map((s) => ({
        createdAt: iso(s.created_at),
        lastUsedAt: iso(s.updated_at),
        expiresAt: iso(s.expires_at),
        signedOutAt: iso(s.revoked_at),
        device: s.user_agent,
        ipAddress: s.ip_address,
      })),
      notifications: notifications.map((n) => ({ type: n.type, createdAt: iso(n.created_at), readAt: iso(n.read_at) })),
      uploadedWallpapers: wallpapers.length,
      pushSubscriptions: Number(push.n),
    };
  },

  /**
   * Permanently delete my account and what belongs to it. Groups continue
   * without me (ownership passes on); one-to-one chats are deleted for both
   * sides; my messages, files, contacts, settings and sessions are erased.
   * Returns who must be told: { sessionIds, partnerChats: [{ conversationId, userId }], groupChanges, affectedUserIds }.
   */
  async deleteAccount(userId, password) {
    const user = await assertPassword(userId, password);
    await callService.endAllFor(userId).catch((error) => logger.warn('Ending call on account deletion failed', { userId, error }));
    // My call recordings' files (in S3 or on disk); their rows go with the account.
    await recordingService.removeAllBy(userId);

    // Leave every group first, so each one keeps an owner (or is deleted if I was the last member).
    const ids = await conversationRepository.listIdsForUser(userId);
    const types = await conversationRepository.typesFor(ids);
    const groupChanges = [];
    for (const id of ids.filter((cid) => types.get(cid) === 'group')) {
      groupChanges.push(await groupService.leave(userId, id));
    }
    const directIds = ids.filter((cid) => types.get(cid) === 'direct');

    // Everyone who may have me on screen (to refresh their lists).
    const [related] = await pool.query(
      `SELECT DISTINCT user_id FROM (
         SELECT user_id FROM contacts WHERE contact_user_id = ?
         UNION SELECT contact_user_id FROM contacts WHERE user_id = ?
         UNION SELECT op.user_id FROM conversation_participants me
                JOIN conversation_participants op ON op.conversation_id = me.conversation_id AND op.user_id <> me.user_id
               WHERE me.user_id = ?
       ) x`,
      [userId, userId, userId],
    );
    const [partners] = directIds.length
      ? await pool.query('SELECT conversation_id, user_id FROM conversation_participants WHERE conversation_id IN (?) AND user_id <> ?', [directIds, userId])
      : [[]];
    const [files] = await pool.query(
      `SELECT storage_key, thumbnail_key FROM attachments
        WHERE uploader_id = ? ${directIds.length ? 'OR conversation_id IN (?)' : ''}`,
      directIds.length ? [userId, directIds] : [userId],
    );
    const [wallpapers] = await pool.execute('SELECT file_name FROM user_wallpapers WHERE user_id = ?', [userId]);
    const [savedStickers] = await pool.execute('SELECT storage_key FROM user_stickers WHERE user_id = ?', [userId]);
    const [sessions] = await pool.execute('SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL', [userId]);

    await withTransaction(async (connection) => {
      if (directIds.length) await connection.query('DELETE FROM conversations WHERE id IN (?)', [directIds]);
      // Cascades: messages, reactions, stars, contacts (both ways), blocks, sessions, settings, notifications, calls…
      await connection.execute('DELETE FROM users WHERE id = ?', [userId]);
    });

    // Files last: only once nothing in the database points at them (forwarded copies keep theirs).
    await attachmentStorage.releaseFiles([
      ...files.flatMap((f) => [f.storage_key, f.thumbnail_key]).filter(Boolean),
      ...savedStickers.map((s) => s.storage_key),
    ]);
    await deleteAvatarFile(user.avatar_path);
    for (const { file_name: fileName } of wallpapers) {
      await wallpaperService.deleteFile(fileName);
    }
    logger.info('Account deleted', { userId });

    return {
      sessionIds: sessions.map((s) => s.id),
      partnerChats: partners.map((p) => ({ conversationId: p.conversation_id, userId: p.user_id })),
      groupChanges,
      affectedUserIds: related.map((r) => r.user_id),
    };
  },
};
