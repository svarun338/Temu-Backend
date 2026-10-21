import { pool } from '../db/pool.js';
import { escapeLike } from '../utils/text.js';

/** Message columns plus a preview of the message it replies to. */
const SELECT = `
  SELECT m.id, m.conversation_id, m.sender_id, m.client_id, m.body, m.sticker, m.reply_to_id, m.forwarded,
         m.encrypted, m.ciphertext, m.cipher_iv, m.sender_device_id,
         (SELECT sd.public_key FROM user_devices sd WHERE sd.id = m.sender_device_id) AS sender_device_key,
         r.encrypted AS reply_encrypted,
         m.edited_at, m.deleted_at, m.created_at, m.delivered_at, m.read_at, m.event_type, m.event_data,
         (SELECT su.name FROM users su WHERE su.id = m.sender_id) AS sender_name,
         r.sender_id AS reply_sender_id, r.body AS reply_body, r.sticker AS reply_sticker, r.deleted_at AS reply_deleted_at,
         (SELECT rs.name FROM users rs WHERE rs.id = r.sender_id) AS reply_sender_name,
         (SELECT ra.kind FROM attachments ra WHERE ra.message_id = r.id ORDER BY ra.id LIMIT 1) AS reply_attachment_kind,
         (SELECT IF(rl.is_live, 'live', 'static') FROM message_locations rl WHERE rl.message_id = r.id) AS reply_location_kind
    FROM messages m
    LEFT JOIN messages r ON r.id = m.reply_to_id`;

/** Search reads plaintext messages only; left to itself the planner walks every message instead. */
const SEARCH_SELECT = SELECT.replace('FROM messages m', 'FROM messages m FORCE INDEX (idx_messages_plain)');

/** Excludes messages the viewer deleted "for me". Takes the viewer id as its parameter. */
const VISIBLE_TO = 'NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = ?)';

export const messageRepository = {
  async insert(connection, { conversationId, senderId, clientId, body, sticker = null, replyToId = null, forwarded = false, encrypted = null, at }) {
    const [result] = await connection.execute(
      `INSERT INTO messages
         (conversation_id, sender_id, client_id, body, sticker, encrypted, ciphertext, cipher_iv, sender_device_id, reply_to_id, forwarded, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        conversationId,
        senderId,
        clientId ?? null,
        body,
        sticker,
        encrypted ? 1 : 0,
        encrypted?.ciphertext ?? null,
        encrypted?.iv ?? null,
        encrypted?.senderDeviceId ?? null,
        replyToId,
        forwarded ? 1 : 0,
        at,
        at,
      ],
    );
    return result.insertId;
  },

  /** The message key, wrapped for each device that may read the message. */
  async insertKeys(connection, messageId, keys) {
    if (keys.length === 0) return;
    await connection.query('INSERT INTO message_keys (message_id, device_id, wrapped, salt, iv) VALUES ?', [
      keys.map((k) => [messageId, k.deviceId, k.wrapped, k.salt, k.iv]),
    ]);
  },

  /** An edited encrypted message: new ciphertext and freshly wrapped keys. */
  async replaceEncrypted(connection, id, { ciphertext, iv, senderDeviceId, keys }, at) {
    const [result] = await connection.execute(
      'UPDATE messages SET ciphertext = ?, cipher_iv = ?, sender_device_id = ?, edited_at = ? WHERE id = ? AND deleted_at IS NULL',
      [ciphertext, iv, senderDeviceId, at, id],
    );
    await connection.execute('DELETE FROM message_keys WHERE message_id = ?', [id]);
    await this.insertKeys(connection, id, keys);
    return result.affectedRows === 1;
  },

  /**
   * Wrapped keys for messages: Map messageId -> { [deviceId]: { wrapped, salt, iv } }.
   * With a deviceId only that device's keys are returned (API responses); without, all (broadcasts).
   */
  async keysFor(messageIds, deviceId = null) {
    const result = new Map();
    if (messageIds.length === 0 || deviceId === 0) return result;
    const [rows] = deviceId
      ? await pool.query('SELECT message_id, device_id, wrapped, salt, iv FROM message_keys WHERE message_id IN (?) AND device_id = ?', [messageIds, deviceId])
      : await pool.query('SELECT message_id, device_id, wrapped, salt, iv FROM message_keys WHERE message_id IN (?)', [messageIds]);
    for (const row of rows) {
      if (!result.has(row.message_id)) result.set(row.message_id, {});
      result.get(row.message_id)[row.device_id] = { wrapped: row.wrapped, salt: row.salt, iv: row.iv };
    }
    return result;
  },

  /** A system message ("Alice added Bob"): no text, an event type and its data (names are snapshotted). */
  async insertEvent(connection, { conversationId, actorId, type, data = {}, at }) {
    const [result] = await connection.execute(
      `INSERT INTO messages (conversation_id, sender_id, body, event_type, event_data, created_at, updated_at)
       VALUES (?, ?, '', ?, ?, ?, ?)`,
      [conversationId, actorId, type, JSON.stringify(data), at, at],
    );
    return result.insertId;
  },

  async findById(id) {
    const [rows] = await pool.execute(`${SELECT} WHERE m.id = ? LIMIT 1`, [id]);
    return rows[0] ?? null;
  },

  async findBySenderAndClientId(senderId, clientId) {
    const [rows] = await pool.execute(`${SELECT} WHERE m.sender_id = ? AND m.client_id = ? LIMIT 1`, [senderId, clientId]);
    return rows[0] ?? null;
  },

  /**
   * Page through a conversation as seen by `viewerId`. Results are always oldest → newest.
   *  - before: messages older than this id (scrolling up)
   *  - after:  messages newer than this id (catching up after a reconnect)
   *  - neither: the latest page
   */
  async list(conversationId, viewerId, { before, after, limit }) {
    if (after) {
      const [rows] = await pool.query(
        `${SELECT} WHERE m.conversation_id = ? AND m.id > ? AND ${VISIBLE_TO} ORDER BY m.id ASC LIMIT ?`,
        [conversationId, after, viewerId, limit],
      );
      return rows;
    }
    const [rows] = before
      ? await pool.query(
          `${SELECT} WHERE m.conversation_id = ? AND m.id < ? AND ${VISIBLE_TO} ORDER BY m.id DESC LIMIT ?`,
          [conversationId, before, viewerId, limit],
        )
      : await pool.query(`${SELECT} WHERE m.conversation_id = ? AND ${VISIBLE_TO} ORDER BY m.id DESC LIMIT ?`, [
          conversationId,
          viewerId,
          limit,
        ]);
    return rows.reverse();
  },

  async updateBody(id, body, at) {
    const [result] = await pool.execute(
      'UPDATE messages SET body = ?, edited_at = ? WHERE id = ? AND deleted_at IS NULL',
      [body, at, id],
    );
    return result.affectedRows === 1;
  },

  /** "Delete for everyone": erase the content and everything attached to it. */
  async softDelete(connection, id, at) {
    await connection.execute(
      "UPDATE messages SET body = '', sticker = NULL, ciphertext = NULL, cipher_iv = NULL, deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
      [at, id],
    );
    await connection.execute('DELETE FROM message_keys WHERE message_id = ?', [id]);
    await connection.execute('DELETE FROM message_reactions WHERE message_id = ?', [id]);
    await connection.execute('DELETE FROM message_stars WHERE message_id = ?', [id]);
    await connection.execute('DELETE FROM conversation_pins WHERE message_id = ?', [id]);
  },

  /** "Delete for me". Idempotent. */
  async hideForUser(messageId, userId) {
    await pool.execute('INSERT IGNORE INTO message_hidden (message_id, user_id) VALUES (?, ?)', [messageId, userId]);
  },

  /**
   * Full-text-ish search over messages the user can see (their conversations,
   * not deleted, not hidden), newest first. Optionally within one conversation.
   * Encrypted messages are skipped: the server only has their ciphertext (they are
   * searched on the device), and their files are all named "encrypted".
   */
  async search({ userId, query, conversationId, limit }) {
    const pattern = `%${escapeLike(query)}%`;
    const params = [userId, pattern, pattern, userId];
    let scope = '';
    if (conversationId) {
      scope = 'AND m.conversation_id = ?';
      params.push(conversationId);
    }
    params.push(limit);
    const [rows] = await pool.query(
      `${SEARCH_SELECT}
         JOIN conversation_participants p ON p.conversation_id = m.conversation_id AND p.user_id = ?
        WHERE m.encrypted = 0
          AND m.deleted_at IS NULL
          AND (m.body LIKE ? OR EXISTS (SELECT 1 FROM attachments fa WHERE fa.message_id = m.id AND fa.original_name LIKE ?))
          AND ${VISIBLE_TO} ${scope}
        ORDER BY m.id DESC
        LIMIT ?`,
      params,
    );
    return rows;
  },

  /**
   * Mark messages addressed to `recipientId` as delivered or read, up to `upToId`
   * (or all of them). Returns the highest affected message id, or null if nothing changed.
   */
  async markReceipt({ conversationId, recipientId, upToId, at, kind }, connection = pool) {
    const column = kind === 'read' ? 'read_at' : 'delivered_at';
    const rangeSql = upToId ? 'AND id <= ?' : '';
    const rangeParams = upToId ? [upToId] : [];

    const [rows] = await connection.query(
      `SELECT MAX(id) AS max_id FROM messages
        WHERE conversation_id = ? AND sender_id <> ? AND ${column} IS NULL ${rangeSql}`,
      [conversationId, recipientId, ...rangeParams],
    );
    const maxId = rows[0]?.max_id ?? null;
    if (!maxId) return null;

    const assignments = kind === 'read' ? 'read_at = ?, delivered_at = COALESCE(delivered_at, ?)' : 'delivered_at = ?';
    const assignmentParams = kind === 'read' ? [at, at] : [at];
    await connection.query(
      `UPDATE messages SET ${assignments}
        WHERE conversation_id = ? AND sender_id <> ? AND ${column} IS NULL AND id <= ?`,
      [...assignmentParams, conversationId, recipientId, maxId],
    );
    return maxId;
  },

  /** Conversations containing messages that have not yet reached `userId`. */
  async listUndeliveredConversations(userId) {
    // Direct chats only: groups track delivery with per-member watermarks.
    const [rows] = await pool.execute(
      `SELECT m.conversation_id, MAX(m.id) AS max_id
         FROM messages m
         JOIN conversation_participants p ON p.conversation_id = m.conversation_id AND p.user_id = ?
         JOIN conversations c ON c.id = m.conversation_id AND c.type = 'direct'
        WHERE m.sender_id <> ? AND m.delivered_at IS NULL
        GROUP BY m.conversation_id`,
      [userId, userId],
    );
    return rows;
  },
};
