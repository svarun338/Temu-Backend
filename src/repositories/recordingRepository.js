import { pool } from '../db/pool.js';

const SELECT = `
  SELECT r.id, r.call_id, r.conversation_id, r.recorder_id, r.kind, r.mime_type, r.status,
         r.storage_driver, r.storage_key, r.next_seq, r.size_bytes, r.duration_ms,
         r.started_at, r.finished_at, u.name AS recorder_name
    FROM call_recordings r
    JOIN users u ON u.id = r.recorder_id`;

export const recordingRepository = {
  async insert({ callId, conversationId, recorderId, kind, mimeType, startedAt }) {
    const [result] = await pool.execute(
      `INSERT INTO call_recordings (call_id, conversation_id, recorder_id, kind, mime_type, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [callId, conversationId, recorderId, kind, mimeType, startedAt],
    );
    return result.insertId;
  },

  async findById(id) {
    const [rows] = await pool.execute(`${SELECT} WHERE r.id = ? LIMIT 1`, [id]);
    return rows[0] ?? null;
  },

  /** The recording this user is making in this call, if any. */
  async findActive(callId, recorderId) {
    const [rows] = await pool.execute(`${SELECT} WHERE r.call_id = ? AND r.recorder_id = ? AND r.status = 'recording' LIMIT 1`, [
      callId,
      recorderId,
    ]);
    return rows[0] ?? null;
  },

  async listActiveForCall(callId) {
    const [rows] = await pool.execute(`${SELECT} WHERE r.call_id = ? AND r.status = 'recording'`, [callId]);
    return rows;
  },

  async listActive() {
    const [rows] = await pool.query(`${SELECT} WHERE r.status = 'recording'`);
    return rows;
  },

  async listReadyForCall(callId) {
    const [rows] = await pool.execute(`${SELECT} WHERE r.call_id = ? AND r.status = 'ready' ORDER BY r.id`, [callId]);
    return rows;
  },

  async listStoredBy(recorderId) {
    const [rows] = await pool.execute(
      "SELECT id, storage_driver, storage_key FROM call_recordings WHERE recorder_id = ? AND storage_key IS NOT NULL",
      [recorderId],
    );
    return rows;
  },

  /** A chunk was appended: the next expected chunk number and the size so far. */
  async advance(id, { nextSeq, sizeBytes }) {
    await pool.execute("UPDATE call_recordings SET next_seq = ?, size_bytes = ? WHERE id = ? AND status = 'recording'", [nextSeq, sizeBytes, id]);
  },

  async markReady(id, { driver, key, durationMs, at }) {
    const [result] = await pool.execute(
      `UPDATE call_recordings SET status = 'ready', storage_driver = ?, storage_key = ?, duration_ms = ?, finished_at = ?
        WHERE id = ? AND status = 'recording'`,
      [driver, key, durationMs, at, id],
    );
    return result.affectedRows === 1;
  },

  async markFailed(id, at) {
    await pool.execute("UPDATE call_recordings SET status = 'failed', finished_at = ? WHERE id = ? AND status = 'recording'", [at, id]);
  },

  async delete(id) {
    await pool.execute('DELETE FROM call_recordings WHERE id = ?', [id]);
  },
};
