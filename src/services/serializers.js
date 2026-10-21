import { presenceService } from './presenceService.js';

const iso = (value) => (value ? new Date(value).toISOString() : null);

/** Public URL of a stored profile photo (served by Express under /uploads/avatars). */
export const avatarUrl = (avatarPath) => (avatarPath ? `/uploads/avatars/${avatarPath}` : null);

/**
 * Can the viewer see this user's "online" and "last seen"? `row` carries the
 * relation flags from relationColumns(): never across a block; otherwise their
 * "last seen & online" setting decides —
 *   everyone: anyone I saved, who saved me, or I chat with one-to-one
 *   contacts: only people they saved
 *   nobody:   no one
 */
export function canSeePresence(row) {
  if (Number(row.blocked_by_me) || Number(row.blocked_me)) return false;
  switch (row.last_seen_visibility ?? 'everyone') {
    case 'nobody':
      return false;
    case 'contacts':
      return Boolean(Number(row.saved_me));
    default:
      return Boolean(Number(row.is_contact) || Number(row.saved_me) || Number(row.is_partner));
  }
}

/** Email addresses are personal: only people this user saved as a contact see it. */
export const canSeeEmail = (row) => Boolean(Number(row.saved_me)) && !Number(row.blocked_me);

/**
 * Privacy rules applied to everything we send about another user:
 * - Online / last seen: see canSeePresence.
 * - They blocked me → I also don't see their photo, about or status.
 */
function profileFields(row) {
  const blockedMe = Boolean(Number(row.blocked_me));
  const showPresence = canSeePresence(row);
  return {
    about: blockedMe ? null : (row.about ?? null),
    status: blockedMe ? 'available' : (row.status ?? 'available'),
    avatarUrl: blockedMe ? null : avatarUrl(row.avatar_path),
    isOnline: showPresence ? presenceService.isOnline(row.id) : false,
    lastSeenAt: showPresence ? iso(row.last_seen_at) : null,
    isBlocked: Boolean(Number(row.blocked_by_me)),
  };
}

/** The signed-in user's own account. */
export function toUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    about: row.about ?? null,
    status: row.status ?? 'available',
    avatarUrl: avatarUrl(row.avatar_path),
    emailVerified: Boolean(row.email_verified_at),
    createdAt: iso(row.created_at),
  };
}

/** Another user's profile as seen by the viewer (search results, profile page). */
export function toPublicUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: canSeeEmail(row) ? row.email : null,
    isContact: Boolean(Number(row.is_contact)),
    ...profileFields(row),
  };
}

export const toSearchResult = toPublicUser;

export function toContact(row) {
  return {
    id: row.id,
    name: row.name,
    email: canSeeEmail(row) ? row.email : null,
    ...profileFields(row),
    addedAt: iso(row.added_at),
    conversationId: row.conversation_id ?? null,
  };
}

export function toBlockedUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: canSeeEmail(row) ? row.email : null,
    avatarUrl: avatarUrl(row.avatar_path),
    blockedAt: iso(row.blocked_at),
  };
}

export function messageStatus(row) {
  if (row.read_at) return 'read';
  if (row.delivered_at) return 'delivered';
  return 'sent';
}

const PREVIEW_LENGTH = 200;
const preview = (body) => (body.length > PREVIEW_LENGTH ? `${body.slice(0, PREVIEW_LENGTH)}…` : body);

/**
 * Encrypted payload of a message row, or null for plaintext/deleted messages.
 * `keys`: { [deviceId]: { wrapped, salt, iv } } (only the requesting device's, or all for broadcasts).
 */
export function toE2ee(row, keys, deleted = Boolean(row.deleted_at)) {
  if (!Number(row.encrypted) || deleted || !row.ciphertext) return null;
  return {
    v: 1,
    ciphertext: row.ciphertext,
    iv: row.cipher_iv,
    senderDeviceId: row.sender_device_id ?? null,
    senderPublicKey: row.sender_device_key ?? null,
    keys: keys ?? {},
  };
}

/**
 * A message. `extras` adds related data: { attachments, reactions, starred }.
 * Deleted messages keep their place in the history but carry no content.
 */
/** Previews (chat list, pins) carry only the first attachment as "kind:durationMs:name" plus a count. */
function attachmentSummaryOf(row) {
  if (!row.first_attachment) return null;
  const [kind, duration, ...name] = row.first_attachment.split(':');
  return { kind, count: Number(row.attachment_count ?? 1), durationMs: duration ? Number(duration) : null, name: name.join(':') };
}

/** event_data comes back as text from MariaDB (JSON is an alias of LONGTEXT there). */
function parseEventData(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

/**
 * A message. `extras` adds related data: { attachments, location, reactions, starred,
 * status } — `status` overrides the per-message ticks (used for groups).
 */
export function toMessage(row, extras = {}) {
  const attachmentSummary = attachmentSummaryOf(row);
  const deleted = Boolean(row.deleted_at);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    senderName: row.sender_name ?? null,
    clientId: row.client_id ?? null,
    body: deleted ? '' : row.body,
    // A built-in sticker ("blob:love", "emoji:😂"); custom stickers are attachments of kind 'sticker'.
    sticker: deleted ? null : (row.sticker ?? null),
    // End-to-end encrypted content: only devices holding one of `keys` can read it.
    e2ee: toE2ee(row, extras.keys, deleted),
    // System messages ("Alice added Bob"): rendered from type + data, never from body.
    event: row.event_type ? { type: row.event_type, data: parseEventData(row.event_data) } : null,
    createdAt: iso(row.created_at),
    deliveredAt: iso(row.delivered_at),
    readAt: iso(row.read_at),
    status: extras.status ?? messageStatus(row),
    forwarded: Boolean(row.forwarded),
    editedAt: deleted ? null : iso(row.edited_at),
    deletedAt: iso(row.deleted_at),
    replyTo:
      row.reply_to_id && !deleted
        ? {
            id: row.reply_to_id,
            senderId: row.reply_sender_id ?? null,
            senderName: row.reply_sender_name ?? null,
            body: row.reply_deleted_at || row.reply_body == null ? '' : preview(row.reply_body),
            sticker: row.reply_deleted_at ? null : (row.reply_sticker ?? null),
            // The quoted text of an encrypted message travels inside the reply's own ciphertext.
            encrypted: Boolean(Number(row.reply_encrypted ?? 0)),
            deleted: Boolean(row.reply_deleted_at) || row.reply_body == null,
            attachmentKind: row.reply_deleted_at ? null : (row.reply_attachment_kind ?? null),
            locationKind: row.reply_deleted_at ? null : (row.reply_location_kind ?? null),
          }
        : null,
    attachments: deleted ? [] : (extras.attachments ?? []),
    attachmentSummary: deleted ? null : attachmentSummary,
    // Full location in histories; previews (chat list, pins) only know whether it was live.
    location: deleted ? null : (extras.location ?? (row.location_kind ? { live: row.location_kind === 'live', summaryOnly: true } : null)),
    reactions: extras.reactions ?? [],
    starred: Boolean(extras.starred),
  };
}

/**
 * An attachment. URLs point at the authenticated download endpoint (never a
 * public path); the browser sends the media cookie with them.
 */
export function toAttachment(row) {
  return {
    id: row.id,
    kind: row.kind,
    mimeType: row.mime_type,
    name: row.original_name,
    size: Number(row.size_bytes),
    width: row.width ?? null,
    height: row.height ?? null,
    durationMs: row.duration_ms ?? null,
    pageCount: row.page_count ?? null,
    // Encrypted files: name, type, size details and the key are inside the encrypted message.
    encrypted: Boolean(Number(row.encrypted ?? 0)),
    url: `/api/attachments/${row.id}`,
    thumbnailUrl: row.thumbnail_key ? `/api/attachments/${row.id}/thumbnail` : null,
  };
}

/** A shared location. `active` = live and still being updated. */
export function toLocation(row, now = new Date()) {
  const live = Boolean(row.is_live);
  const encrypted = Boolean(row.cipher);
  return {
    // Encrypted live locations carry their position only as ciphertext (decrypted on devices).
    latitude: encrypted ? null : Number(row.latitude),
    longitude: encrypted ? null : Number(row.longitude),
    accuracy: encrypted ? null : (row.accuracy_m ?? null),
    encrypted: encrypted ? { cipher: row.cipher, iv: row.cipher_iv } : null,
    live,
    liveUntil: iso(row.live_until),
    stoppedAt: iso(row.stopped_at),
    updatedAt: iso(row.updated_at),
    active: live && !row.stopped_at && new Date(row.live_until) > now,
  };
}

/** A pinned message, as shown in the pinned bar. */
export function toPin(row, keys) {
  return {
    messageId: row.message_id,
    pinnedBy: row.pinned_by ?? null,
    pinnedAt: iso(row.pinned_at),
    senderId: row.sender_id,
    senderName: row.sender_name ?? null,
    body: row.deleted_at ? '' : preview(row.body),
    sticker: row.deleted_at ? null : (row.sticker ?? null),
    e2ee: toE2ee(row, keys),
    attachmentSummary: row.deleted_at ? null : attachmentSummaryOf(row),
    location: !row.deleted_at && row.location_kind ? { live: row.location_kind === 'live', summaryOnly: true } : null,
    createdAt: iso(row.created_at),
  };
}

/** Ticks for a group message, from the lowest read/delivered watermark of the other members. */
export function groupStatus(messageId, { minRead, minDelivered }) {
  if (messageId <= minRead) return 'read';
  if (messageId <= minDelivered) return 'delivered';
  return 'sent';
}

/** `keys`: the requesting device's wrapped keys for the last message, when it is encrypted. */
export function toConversation(row, keys = {}) {
  const isGroup = row.type === 'group';
  return {
    id: row.id,
    type: row.type,
    createdAt: iso(row.created_at),
    lastMessageAt: iso(row.last_message_at),
    unreadCount: Number(row.unread_count ?? 0),
    // Only a mute that is still running counts.
    mutedUntil: row.muted_until && new Date(row.muted_until) > new Date() ? iso(row.muted_until) : null,
    wallpaper: row.wallpaper ?? null, // mine only; null = my default wallpaper
    peer: isGroup
      ? null
      : {
          id: row.peer_id,
          name: row.peer_name,
          isContact: Boolean(Number(row.peer_is_contact)),
          ...(() => {
            const peer = {
              id: row.peer_id,
              about: row.peer_about,
              status: row.peer_status,
              avatar_path: row.peer_avatar_path,
              last_seen_at: row.peer_last_seen_at,
              is_contact: row.peer_is_contact,
              saved_me: row.peer_saved_me,
              is_partner: 1, // a one-to-one chat by definition
              blocked_by_me: row.peer_blocked_by_me,
              blocked_me: row.peer_blocked_me,
              last_seen_visibility: row.peer_last_seen_visibility,
            };
            return { email: canSeeEmail(peer) ? row.peer_email : null, ...profileFields(peer) };
          })(),
        },
    group: isGroup
      ? {
          name: row.group_name,
          description: row.group_description ?? null,
          avatarUrl: avatarUrl(row.group_avatar_path),
          memberCount: Number(row.member_count ?? 0),
          myRole: row.my_role,
          sendPermission: row.group_send_permission,
          editPermission: row.group_edit_permission,
        }
      : null,
    lastMessage: row.lm_id
      ? toMessage(
          {
            id: row.lm_id,
            conversation_id: row.lm_conversation_id,
            sender_id: row.lm_sender_id,
            sender_name: row.lm_sender_name,
            client_id: row.lm_client_id,
            body: row.lm_body,
            sticker: row.lm_sticker,
            encrypted: row.lm_encrypted,
            ciphertext: row.lm_ciphertext,
            cipher_iv: row.lm_cipher_iv,
            sender_device_id: row.lm_sender_device_id,
            sender_device_key: row.lm_sender_device_key,
            created_at: row.lm_created_at,
            delivered_at: row.lm_delivered_at,
            read_at: row.lm_read_at,
            forwarded: row.lm_forwarded,
            edited_at: row.lm_edited_at,
            deleted_at: row.lm_deleted_at,
            event_type: row.lm_event_type,
            event_data: row.lm_event_data,
            attachment_count: row.lm_attachment_count,
            first_attachment: row.lm_first_attachment,
            location_kind: row.lm_location_kind,
          },
          {
            keys,
            ...(isGroup
              ? { status: groupStatus(row.lm_id, { minRead: Number(row.group_min_read ?? 0), minDelivered: Number(row.group_min_delivered ?? 0) }) }
              : {}),
          },
        )
      : null,
  };
}

/**
 * Live profile change pushed to other users. `hidden` (sent to someone the user
 * blocked) strips the photo, about and status, matching what the API returns them.
 */
export function toProfileUpdate(row, { hidden = false } = {}) {
  return {
    id: row.id,
    name: row.name,
    about: hidden ? null : (row.about ?? null),
    status: hidden ? 'available' : (row.status ?? 'available'),
    avatarUrl: hidden ? null : avatarUrl(row.avatar_path),
  };
}
