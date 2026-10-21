import { pool } from '../db/pool.js';

const COLUMN_NAMES = [
  'id', 'uploader_id', 'conversation_id', 'message_id', 'kind', 'mime_type', 'original_name', 'size_bytes',
  'storage_key', 'thumbnail_key', 'width', 'height', 'duration_ms', 'page_count', 'encrypted', 'created_at',
];
const columns = (alias) => COLUMN_NAMES.map((name) => (alias ? `${alias}.${name}` : name)).join(', ');
const COLUMNS = columns();

/** Gallery filters: which kinds each tab shows. */
const GALLERY_KINDS = { media: ['image', 'video'], files: ['file'], audio: ['audio', 'voice'] };

export const attachmentRepository = {
  async insert(row) {
    const [result] = await pool.execute(
      `INSERT INTO attachments
         (uploader_id, conversation_id, kind, mime_type, original_name, size_bytes, storage_key, thumbnail_key, width, height, duration_ms, page_count, encrypted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.uploaderId,
        row.conversationId,
        row.kind,
        row.mimeType,
        row.originalName,
        row.sizeBytes,
        row.storageKey,
        row.thumbnailKey ?? null,
        row.width ?? null,
        row.height ?? null,
        row.durationMs ?? null,
        row.pageCount ?? null,
        row.encrypted ? 1 : 0,
      ],
    );
    return result.insertId;
  },

  async findById(id) {
    const [rows] = await pool.execute(`SELECT ${COLUMNS} FROM attachments WHERE id = ? LIMIT 1`, [id]);
    return rows[0] ?? null;
  },

  /**
   * Attach uploads to a message. Only the uploader's own, still-unlinked uploads
   * for the same conversation qualify. Returns how many rows were linked.
   */
  async link(connection, { ids, messageId, uploaderId, conversationId }) {
    const [result] = await connection.query(
      `UPDATE attachments SET message_id = ?
        WHERE id IN (?) AND message_id IS NULL AND uploader_id = ? AND conversation_id = ?`,
      [messageId, ids, uploaderId, conversationId],
    );
    return result.affectedRows;
  },

  /** Map of messageId -> rows (in upload order). */
  async listFor(messageIds) {
    const result = new Map();
    if (messageIds.length === 0) return result;
    const [rows] = await pool.query(`SELECT ${COLUMNS} FROM attachments WHERE message_id IN (?) ORDER BY id ASC`, [messageIds]);
    for (const row of rows) {
      if (!result.has(row.message_id)) result.set(row.message_id, []);
      result.get(row.message_id).push(row);
    }
    return result;
  },

  /** Media/files/audio of a conversation visible to `viewerId`, newest first. */
  /** Bytes a user uploaded since `since` (for the daily quota). */
  async uploadedBytesSince(userId, since) {
    const [rows] = await pool.execute(
      'SELECT COALESCE(SUM(size_bytes), 0) AS total FROM attachments WHERE uploader_id = ? AND created_at >= ?',
      [userId, since],
    );
    return Number(rows[0].total);
  },

  async gallery({ conversationId, viewerId, type, before, limit }) {
    const params = [conversationId, GALLERY_KINDS[type], viewerId];
    let range = '';
    if (before) {
      range = 'AND a.id < ?';
      params.push(before);
    }
    params.push(limit);
    const [rows] = await pool.query(
      `SELECT ${columns('a')}, m.sender_id, m.created_at AS message_created_at,
              (SELECT su.name FROM users su WHERE su.id = m.sender_id) AS sender_name
         FROM attachments a
         JOIN messages m ON m.id = a.message_id
        WHERE a.conversation_id = ? AND a.kind IN (?) AND m.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = ?)
          ${range}
        ORDER BY a.id DESC
        LIMIT ?`,
      params,
    );
    return rows;
  },

  /** Delete a message's attachments; returns the storage keys they used. */
  async deleteForMessage(connection, messageId) {
    const [rows] = await connection.execute('SELECT storage_key, thumbnail_key FROM attachments WHERE message_id = ?', [messageId]);
    await connection.execute('DELETE FROM attachments WHERE message_id = ?', [messageId]);
    return rows.flatMap((row) => [row.storage_key, row.thumbnail_key]).filter(Boolean);
  },

  /** Copy a message's attachments onto another message (forwarding). The files are shared, not copied. */
  async duplicate(connection, { fromMessageId, toMessageId, conversationId, uploaderId }) {
    await connection.execute(
      `INSERT INTO attachments
         (uploader_id, conversation_id, message_id, kind, mime_type, original_name, size_bytes, storage_key, thumbnail_key, width, height, duration_ms, page_count, encrypted)
       SELECT ?, ?, ?, kind, mime_type, original_name, size_bytes, storage_key, thumbnail_key, width, height, duration_ms, page_count, encrypted
         FROM attachments WHERE message_id = ? ORDER BY id`,
      [uploaderId, conversationId, toMessageId, fromMessageId],
    );
  },

  /**
   * A new, unsent attachment for `uploaderId` that shares an existing file (sending a
   * recent GIF or a saved sticker again). Returns the new id.
   */
  async insertShared({ uploaderId, conversationId, kind, mimeType, originalName, sizeBytes, storageKey, width, height, encrypted = false }) {
    return this.insert({ uploaderId, conversationId, kind, mimeType, originalName, sizeBytes, storageKey, width, height, encrypted });
  },

  /** GIFs I sent recently, one per file, newest first. */
  async recentGifs(userId, limit = 30) {
    const [rows] = await pool.query(
      `SELECT ${COLUMNS} FROM attachments
        WHERE id IN (SELECT MAX(id) FROM attachments
                      WHERE uploader_id = ? AND mime_type = 'image/gif' AND message_id IS NOT NULL
                      GROUP BY storage_key)
        ORDER BY id DESC LIMIT ?`,
      [userId, limit],
    );
    return rows;
  },

  /** Is a stored file still used by an attachment or a saved sticker? (Then it must not be deleted.) */
  async isKeyInUse(key) {
    const [rows] = await pool.execute(
      `SELECT 1 FROM attachments WHERE storage_key = ? OR thumbnail_key = ?
       UNION ALL SELECT 1 FROM user_stickers WHERE storage_key = ? LIMIT 1`,
      [key, key, key],
    );
    return rows.length > 0;
  },

  /** Uploads never attached to a message. */
  async listOrphans(createdBefore, limit = 500) {
    const [rows] = await pool.query(
      'SELECT id, storage_key, thumbnail_key FROM attachments WHERE message_id IS NULL AND created_at < ? LIMIT ?',
      [createdBefore, limit],
    );
    return rows;
  },

  async deleteByIds(ids) {
    if (ids.length === 0) return;
    await pool.query('DELETE FROM attachments WHERE id IN (?)', [ids]);
  },
};
