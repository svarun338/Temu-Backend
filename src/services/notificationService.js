import { blockRepository } from '../repositories/blockRepository.js';
import { groupRepository } from '../repositories/groupRepository.js';
import { notificationRepository } from '../repositories/notificationRepository.js';
import { settingsRepository } from '../repositories/settingsRepository.js';
import { userRepository } from '../repositories/userRepository.js';
import { realtime } from '../sockets/realtime.js';
import { logger } from '../utils/logger.js';
import { presenceService } from './presenceService.js';
import { pushService } from './pushService.js';
import { avatarUrl } from './serializers.js';

const iso = (value) => (value ? new Date(value).toISOString() : null);
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does `body` @mention someone called `name` (full name or first name)? */
export function mentions(body, name) {
  if (!body || !name) return false;
  const first = name.trim().split(/\s+/)[0];
  const names = [...new Set([name.trim(), first])].map(escapeRegExp).join('|');
  return new RegExp(`(^|[^\\w@])@(${names})(?![\\w])`, 'iu').test(body);
}

/** Short notification text for a message. Callers decide whether previews may be shown at all. */
export function messageSummary(message) {
  if (message.location) return message.location.live ? '📍 Live location' : '📍 Location';
  const first = message.attachments?.[0];
  const isGif = first?.mimeType === 'image/gif';
  const label = message.sticker
    ? 'Sticker'
    : first
      ? isGif
        ? 'GIF'
        : { image: '📷 Photo', video: '🎥 Video', voice: '🎤 Voice message', audio: '🎵 Audio', file: `📄 ${first.name}`, sticker: 'Sticker' }[first.kind]
      : '';
  if (message.e2ee) return '🔒 New message'; // end-to-end encrypted: no preview possible
  const text = message.body ? (message.body.length > 120 ? `${message.body.slice(0, 120)}…` : message.body) : '';
  return [label, text].filter(Boolean).join(' ') || 'New message';
}

export function toNotification(row) {
  return {
    id: row.id,
    type: row.type,
    actor: row.actor_id ? { id: row.actor_id, name: row.actor_name, avatarUrl: avatarUrl(row.actor_avatar_path) } : null,
    conversationId: row.conversation_id ?? null,
    messageId: row.message_id ?? null,
    preview: row.message_body ? (row.message_body.length > 120 ? `${row.message_body.slice(0, 120)}…` : row.message_body) : null,
    read: Boolean(row.read_at),
    createdAt: iso(row.created_at),
  };
}

const isMuted = (mutedUntil, now) => Boolean(mutedUntil) && new Date(mutedUntil) > now;

export const notificationService = {
  /**
   * After a message is saved and broadcast: record @mentions, and send a push
   * to recipients who have no open TEMU tab — unless they muted the chat or
   * turned notifications off (a mention still gets through a mute).
   */
  async afterMessageCreated({ message, participantIds, mentions: mentionedIds = [] }) {
    if (message.event) return; // system messages are handled by afterGroupEvent
    const recipients = participantIds.filter((id) => id !== message.senderId);
    if (recipients.length === 0) return;
    const now = new Date();
    const [sender, settings, group] = await Promise.all([
      userRepository.findById(message.senderId),
      settingsRepository.getUserSettingsMany(recipients),
      groupRepository.find(message.conversationId),
    ]);
    const muted = await settingsRepository.mutedUntilFor(message.conversationId, recipients);

    for (const recipientId of recipients) {
      const recipient = await userRepository.findById(recipientId);
      if (!recipient) continue;
      // Encrypted messages declare who they @mention (the server can't read the text).
      const mentioned = message.e2ee ? mentionedIds.includes(recipientId) : mentions(message.body, recipient.name);

      if (mentioned) {
        const id = await notificationRepository.create({
          userId: recipientId,
          type: 'mention',
          actorId: message.senderId,
          conversationId: message.conversationId,
          messageId: message.id,
        });
        realtime.emitToUsers([recipientId], 'notification:new', {
          id,
          type: 'mention',
          actor: { id: sender.id, name: sender.name, avatarUrl: avatarUrl(sender.avatar_path) },
          conversationId: message.conversationId,
          messageId: message.id,
          preview: message.e2ee ? '' : message.body.slice(0, 120),
          read: false,
          createdAt: now.toISOString(),
        });
      }

      const prefs = settings.get(recipientId);
      const silenced = !prefs.notifications_enabled || (isMuted(muted.get(recipientId), now) && !mentioned);
      // Open tabs show their own notifications from the socket event.
      if (silenced || presenceService.isOnline(recipientId)) continue;
      const text = prefs.message_preview ? messageSummary(message) : 'New message';
      await pushService.sendToUser(recipientId, {
        // Groups: "Family" / "Alice: hi". Direct: "Alice" / "hi".
        title: group ? (mentioned ? `${sender.name} mentioned you in ${group.name}` : group.name) : mentioned ? `${sender.name} mentioned you` : sender.name,
        body: group && !mentioned ? `${sender.name}: ${text}` : text,
        tag: `conversation-${message.conversationId}`,
        url: `/c/${message.conversationId}`,
      });
    }
  },

  /** Group system messages: tell people who were just added (and are offline) by push. */
  async afterGroupEvent({ message }) {
    if (message.event?.type !== 'members_added') return;
    const addedIds = (message.event.data.users ?? []).map((u) => u.id).filter((id) => id !== message.senderId);
    if (addedIds.length === 0) return;
    const [group, actor, settings] = await Promise.all([
      groupRepository.find(message.conversationId),
      userRepository.findById(message.senderId),
      settingsRepository.getUserSettingsMany(addedIds),
    ]);
    if (!group || !actor) return;
    for (const userId of addedIds) {
      if (!settings.get(userId).notifications_enabled || presenceService.isOnline(userId)) continue;
      await pushService.sendToUser(userId, {
        title: group.name,
        body: `${actor.name} added you to the group`,
        tag: `conversation-${message.conversationId}`,
        url: `/c/${message.conversationId}`,
      });
    }
  },

  /** Ringing someone with no TEMU tab open: a push lets them open it and answer. */
  async callRinging({ call, calleeId }) {
    if (presenceService.isOnline(calleeId)) return; // their open tabs ring by themselves
    const settings = await settingsRepository.getUserSettingsMany([calleeId]);
    if (!settings.get(calleeId).notifications_enabled) return;
    await pushService.sendToUser(calleeId, {
      title: call.caller.name,
      body: `Incoming ${call.type} call`,
      tag: `call-${call.id}`,
      url: `/c/${call.conversationId}`,
    });
  },

  /** Replaces the "incoming call" push with "missed call". */
  async callMissed({ call, calleeId }) {
    if (presenceService.isOnline(calleeId)) return;
    const settings = await settingsRepository.getUserSettingsMany([calleeId]);
    if (!settings.get(calleeId).notifications_enabled) return;
    await pushService.sendToUser(calleeId, {
      title: call.caller.name,
      body: `Missed ${call.type} call`,
      tag: `call-${call.id}`,
      url: `/c/${call.conversationId}`,
    });
  },

  /** "X added you as a contact" (not across a block). */
  async contactAdded(userId, contactUserId) {
    if (await blockRepository.existsBetween(userId, contactUserId)) return;
    const actor = await userRepository.findById(userId);
    const id = await notificationRepository.create({ userId: contactUserId, type: 'contact_added', actorId: userId });
    realtime.emitToUsers([contactUserId], 'notification:new', {
      id,
      type: 'contact_added',
      actor: { id: actor.id, name: actor.name, avatarUrl: avatarUrl(actor.avatar_path) },
      conversationId: null,
      messageId: null,
      preview: null,
      read: false,
      createdAt: new Date().toISOString(),
    });
    const prefs = await settingsRepository.getUserSettings(contactUserId);
    if (prefs.notifications_enabled && !presenceService.isOnline(contactUserId)) {
      await pushService.sendToUser(contactUserId, { title: 'TEMU', body: `${actor.name} added you as a contact`, tag: 'contacts', url: '/' });
    }
  },

  async list(userId, { before, limit }) {
    const [rows, unread] = await Promise.all([notificationRepository.list(userId, { before, limit }), notificationRepository.countUnread(userId)]);
    return { notifications: rows.map(toNotification), unread, hasMore: rows.length === (limit ?? 30) };
  },

  async markRead(userId, ids) {
    await notificationRepository.markRead(userId, ids, new Date());
    return { unread: await notificationRepository.countUnread(userId) };
  },

  /** Fire-and-forget wrapper: notification failures never break sending a message. */
  run(task, context) {
    Promise.resolve()
      .then(task)
      .catch((error) => logger.error('Notification failed', { ...context, error }));
  },
};
