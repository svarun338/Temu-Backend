import { pool } from '../db/pool.js';

export function directKey(userA, userB) {
  return `${Math.min(userA, userB)}:${Math.max(userA, userB)}`;
}

/**
 * Messages that count as unread for `me` (direct: per-message read flag; group: my read watermark).
 * System notes don't count, except calls I missed.
 */
const UNREAD_COUNT = `
  (SELECT COUNT(*) FROM messages um
    WHERE um.conversation_id = c.id AND um.sender_id <> me.user_id AND um.deleted_at IS NULL
      AND (um.event_type IS NULL OR (um.event_type = 'call' AND JSON_VALUE(um.event_data, '$.status') IN ('missed', 'busy')))
      AND (CASE WHEN c.type = 'group' THEN um.id > COALESCE(me.last_read_message_id, 0) ELSE um.read_at IS NULL END)
      AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = um.id AND h.user_id = me.user_id))`;

/**
 * Conversation rows as seen by `me`: the other person (direct chats) or the
 * group details, the last message, and my unread count. Always filtered by my
 * participation, so one row per conversation.
 */
const CONVERSATION_SELECT = `
  SELECT c.id, c.type, c.created_at, c.last_message_at,
         me.role AS my_role,
         u.id AS peer_id, u.name AS peer_name, u.email AS peer_email, u.last_seen_at AS peer_last_seen_at,
         u.about AS peer_about, u.status AS peer_status, u.avatar_path AS peer_avatar_path,
         EXISTS(SELECT 1 FROM blocks b WHERE b.blocker_id = me.user_id AND b.blocked_id = u.id) AS peer_blocked_by_me,
         EXISTS(SELECT 1 FROM blocks b WHERE b.blocker_id = u.id AND b.blocked_id = me.user_id) AS peer_blocked_me,
         EXISTS(SELECT 1 FROM contacts ct WHERE ct.user_id = me.user_id AND ct.contact_user_id = u.id) AS peer_is_contact,
         EXISTS(SELECT 1 FROM contacts ct WHERE ct.user_id = u.id AND ct.contact_user_id = me.user_id) AS peer_saved_me,
         COALESCE((SELECT us.last_seen_visibility FROM user_settings us WHERE us.user_id = u.id), 'everyone') AS peer_last_seen_visibility,
         g.name AS group_name, g.description AS group_description, g.avatar_path AS group_avatar_path,
         g.send_permission AS group_send_permission, g.edit_permission AS group_edit_permission,
         (SELECT COUNT(*) FROM conversation_participants gp WHERE gp.conversation_id = c.id) AS member_count,
         (SELECT MIN(COALESCE(gp.last_read_message_id, 0)) FROM conversation_participants gp
           WHERE gp.conversation_id = c.id AND gp.user_id <> me.user_id) AS group_min_read,
         (SELECT MIN(COALESCE(gp.last_delivered_message_id, 0)) FROM conversation_participants gp
           WHERE gp.conversation_id = c.id AND gp.user_id <> me.user_id) AS group_min_delivered,
         m.id AS lm_id, m.conversation_id AS lm_conversation_id, m.sender_id AS lm_sender_id,
         ms.name AS lm_sender_name,
         m.client_id AS lm_client_id, m.body AS lm_body, m.sticker AS lm_sticker,
         m.encrypted AS lm_encrypted, m.ciphertext AS lm_ciphertext, m.cipher_iv AS lm_cipher_iv,
         m.sender_device_id AS lm_sender_device_id,
         (SELECT sd.public_key FROM user_devices sd WHERE sd.id = m.sender_device_id) AS lm_sender_device_key, m.created_at AS lm_created_at,
         m.delivered_at AS lm_delivered_at, m.read_at AS lm_read_at,
         m.forwarded AS lm_forwarded, m.edited_at AS lm_edited_at, m.deleted_at AS lm_deleted_at,
         m.event_type AS lm_event_type, m.event_data AS lm_event_data,
         (SELECT COUNT(*) FROM attachments la WHERE la.message_id = m.id) AS lm_attachment_count,
         (SELECT CONCAT(la.kind, ':', COALESCE(la.duration_ms, ''), ':', la.original_name)
            FROM attachments la WHERE la.message_id = m.id ORDER BY la.id LIMIT 1) AS lm_first_attachment,
         (SELECT IF(ll.is_live, 'live', 'static') FROM message_locations ll WHERE ll.message_id = m.id) AS lm_location_kind,
         (SELECT cs.muted_until FROM chat_settings cs WHERE cs.user_id = me.user_id AND cs.conversation_id = c.id) AS muted_until,
         (SELECT cs.wallpaper FROM chat_settings cs WHERE cs.user_id = me.user_id AND cs.conversation_id = c.id) AS wallpaper,
         ${UNREAD_COUNT} AS unread_count
    FROM conversation_participants me
    JOIN conversations c ON c.id = me.conversation_id
    -- The other person exists only in direct chats.
    LEFT JOIN conversation_participants op ON c.type = 'direct' AND op.conversation_id = c.id AND op.user_id <> me.user_id
    LEFT JOIN users u ON u.id = op.user_id
    LEFT JOIN chat_groups g ON c.type = 'group' AND g.conversation_id = c.id
    -- Latest message this user can still see (skips "deleted for me").
    LEFT JOIN messages m ON m.id = (
      SELECT MAX(v.id) FROM messages v
       WHERE v.conversation_id = c.id
         AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = v.id AND h.user_id = me.user_id))
    LEFT JOIN users ms ON ms.id = m.sender_id`;

export const conversationRepository = {
  async findIdByDirectKey(key) {
    const [rows] = await pool.execute('SELECT id FROM conversations WHERE direct_key = ? LIMIT 1', [key]);
    return rows[0]?.id ?? null;
  },

  /** Create a direct conversation and both participant rows (call inside a transaction). */
  async createDirect(connection, { key, createdBy, userIds }) {
    const [result] = await connection.execute(
      "INSERT INTO conversations (type, direct_key, created_by) VALUES ('direct', ?, ?)",
      [key, createdBy],
    );
    const conversationId = result.insertId;
    for (const userId of userIds) {
      await connection.execute('INSERT INTO conversation_participants (conversation_id, user_id) VALUES (?, ?)', [
        conversationId,
        userId,
      ]);
    }
    return conversationId;
  },

  /** Create the conversation row of a group (call inside a transaction). */
  async createGroupConversation(connection, createdBy) {
    const [result] = await connection.execute("INSERT INTO conversations (type, created_by) VALUES ('group', ?)", [createdBy]);
    return result.insertId;
  },

  /** Map conversationId -> 'direct' | 'group'. */
  async typesFor(conversationIds) {
    const result = new Map();
    if (conversationIds.length === 0) return result;
    const [rows] = await pool.query('SELECT id, type FROM conversations WHERE id IN (?)', [conversationIds]);
    for (const row of rows) result.set(row.id, row.type);
    return result;
  },

  async getType(conversationId) {
    const [rows] = await pool.execute('SELECT type FROM conversations WHERE id = ? LIMIT 1', [conversationId]);
    return rows[0]?.type ?? null;
  },

  async isParticipant(conversationId, userId) {
    const [rows] = await pool.execute(
      'SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ? LIMIT 1',
      [conversationId, userId],
    );
    return rows.length > 0;
  },

  async listParticipantIds(conversationId) {
    const [rows] = await pool.execute('SELECT user_id FROM conversation_participants WHERE conversation_id = ?', [
      conversationId,
    ]);
    return rows.map((row) => row.user_id);
  },

  /**
   * Conversations of a user, newest activity first. Empty direct chats are only
   * listed for the person who opened them, so recipients never see blank chats.
   * Groups always show (their creation is a system message anyway).
   */
  async listForUser(userId) {
    const [rows] = await pool.query(
      `${CONVERSATION_SELECT}
        WHERE me.user_id = ? AND (c.type = 'group' OR c.last_message_id IS NOT NULL OR c.created_by = me.user_id)
        ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC
        LIMIT 500`,
      [userId],
    );
    return rows;
  },

  async findForUser(conversationId, userId) {
    const [rows] = await pool.execute(`${CONVERSATION_SELECT} WHERE me.user_id = ? AND c.id = ? LIMIT 1`, [
      userId,
      conversationId,
    ]);
    return rows[0] ?? null;
  },

  async listIdsForUser(userId) {
    const [rows] = await pool.execute('SELECT conversation_id FROM conversation_participants WHERE user_id = ?', [
      userId,
    ]);
    return rows.map((row) => row.conversation_id);
  },

  /** People with a direct chat with `userId` (they see each other's presence; group co-members don't). */
  /** Do these two users have any conversation (one-to-one or group) together? */
  async shareConversation(userA, userB) {
    const [rows] = await pool.execute(
      `SELECT 1 FROM conversation_participants a
         JOIN conversation_participants b ON b.conversation_id = a.conversation_id
        WHERE a.user_id = ? AND b.user_id = ? LIMIT 1`,
      [userA, userB],
    );
    return rows.length > 0;
  },

  async listPartnerIds(userId) {
    const [rows] = await pool.execute(
      `SELECT DISTINCT op.user_id
         FROM conversation_participants me
         JOIN conversations c ON c.id = me.conversation_id AND c.type = 'direct'
         JOIN conversation_participants op ON op.conversation_id = me.conversation_id AND op.user_id <> me.user_id
        WHERE me.user_id = ?`,
      [userId],
    );
    return rows.map((row) => row.user_id);
  },

  /**
   * Lock the conversation row for the rest of the transaction. Every write to a
   * chat's messages (sends, receipts) takes this lock first, so concurrent writes
   * queue up instead of locking rows in different orders and deadlocking — e.g. a
   * message INSERT's foreign-key check share-locks this row before setLastMessage.
   */
  async lockForUpdate(connection, conversationId) {
    await connection.execute('SELECT id FROM conversations WHERE id = ? FOR UPDATE', [conversationId]);
  },

  async setLastMessage(connection, { conversationId, messageId, at }) {
    await connection.execute(
      `UPDATE conversations SET last_message_id = ?, last_message_at = ?
        WHERE id = ? AND (last_message_id IS NULL OR last_message_id < ?)`,
      [messageId, at, conversationId, messageId],
    );
  },

  // ---- Group receipt watermarks ----

  /** Move my read/delivered watermark forward (never back). Returns true if anything changed. */
  async advanceWatermark({ conversationId, userId, upToId, kind }, connection = pool) {
    const sql =
      kind === 'read'
        ? `UPDATE conversation_participants
              SET last_read_message_id = ?, last_delivered_message_id = GREATEST(COALESCE(last_delivered_message_id, 0), ?)
            WHERE conversation_id = ? AND user_id = ? AND COALESCE(last_read_message_id, 0) < ?`
        : `UPDATE conversation_participants SET last_delivered_message_id = ?
            WHERE conversation_id = ? AND user_id = ? AND COALESCE(last_delivered_message_id, 0) < ?`;
    const params = kind === 'read' ? [upToId, upToId, conversationId, userId, upToId] : [upToId, conversationId, userId, upToId];
    const [result] = await connection.execute(sql, params);
    return result.affectedRows > 0;
  },

  /** Lowest watermark across all members: every message up to it was read/delivered by everyone. */
  async groupWatermarks(conversationId) {
    const [rows] = await pool.execute(
      `SELECT MIN(COALESCE(last_read_message_id, 0)) AS min_read, MIN(COALESCE(last_delivered_message_id, 0)) AS min_delivered
         FROM conversation_participants WHERE conversation_id = ?`,
      [conversationId],
    );
    return { minRead: Number(rows[0].min_read ?? 0), minDelivered: Number(rows[0].min_delivered ?? 0) };
  },

  /** Watermarks of everyone except `viewerId` (for the ticks on the viewer's own messages). */
  async groupWatermarksExcept(conversationId, viewerId) {
    const [rows] = await pool.execute(
      `SELECT MIN(COALESCE(last_read_message_id, 0)) AS min_read, MIN(COALESCE(last_delivered_message_id, 0)) AS min_delivered
         FROM conversation_participants WHERE conversation_id = ? AND user_id <> ?`,
      [conversationId, viewerId],
    );
    return { minRead: Number(rows[0].min_read ?? 0), minDelivered: Number(rows[0].min_delivered ?? 0) };
  },

  async latestMessageId(conversationId) {
    const [rows] = await pool.execute('SELECT MAX(id) AS id FROM messages WHERE conversation_id = ?', [conversationId]);
    return rows[0]?.id ?? null;
  },

  /** Groups where messages from others haven't reached `userId` yet. */
  async listGroupsWithUndelivered(userId) {
    const [rows] = await pool.execute(
      `SELECT p.conversation_id, (SELECT MAX(m.id) FROM messages m WHERE m.conversation_id = p.conversation_id) AS max_id
         FROM conversation_participants p
         JOIN conversations c ON c.id = p.conversation_id AND c.type = 'group'
        WHERE p.user_id = ?
       HAVING max_id IS NOT NULL`,
      [userId],
    );
    return rows;
  },
};
