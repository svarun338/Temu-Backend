import { pool } from '../db/pool.js';
import { relationColumns, userColumns } from './userRepository.js';

const CONTACT_SELECT = `
  SELECT ${userColumns('u')}, ct.created_at AS added_at, cv.id AS conversation_id,
         ${relationColumns('u', 'ct.user_id')}
    FROM contacts ct
    JOIN users u ON u.id = ct.contact_user_id
    LEFT JOIN conversations cv
           ON cv.direct_key = CONCAT(LEAST(ct.user_id, ct.contact_user_id), ':', GREATEST(ct.user_id, ct.contact_user_id))`;

export const contactRepository = {
  /** Idempotent: adding an existing contact is a no-op. Returns true if a row was created. */
  async add(userId, contactUserId) {
    // Not ON DUPLICATE KEY: mysql2's FOUND_ROWS flag makes that report 1 row for duplicates too.
    const [result] = await pool.execute('INSERT IGNORE INTO contacts (user_id, contact_user_id) VALUES (?, ?)', [
      userId,
      contactUserId,
    ]);
    return result.affectedRows === 1;
  },

  async remove(userId, contactUserId) {
    const [result] = await pool.execute('DELETE FROM contacts WHERE user_id = ? AND contact_user_id = ?', [
      userId,
      contactUserId,
    ]);
    return result.affectedRows > 0;
  },

  async exists(userId, contactUserId) {
    const [rows] = await pool.execute('SELECT 1 FROM contacts WHERE user_id = ? AND contact_user_id = ? LIMIT 1', [
      userId,
      contactUserId,
    ]);
    return rows.length > 0;
  },

  async listForUser(userId) {
    const [rows] = await pool.execute(`${CONTACT_SELECT} WHERE ct.user_id = ? ORDER BY u.name ASC`, [userId]);
    return rows;
  },

  async findOne(userId, contactUserId) {
    const [rows] = await pool.execute(`${CONTACT_SELECT} WHERE ct.user_id = ? AND ct.contact_user_id = ? LIMIT 1`, [
      userId,
      contactUserId,
    ]);
    return rows[0] ?? null;
  },

  /** Users who saved `userId` as a contact (they receive this user's presence updates). */
  /** Ids of the people this user saved. */
  async listContactIds(userId) {
    const [rows] = await pool.execute('SELECT contact_user_id FROM contacts WHERE user_id = ?', [userId]);
    return rows.map((row) => row.contact_user_id);
  },

  async listUserIdsWhoSaved(userId) {
    const [rows] = await pool.execute('SELECT user_id FROM contacts WHERE contact_user_id = ?', [userId]);
    return rows.map((row) => row.user_id);
  },
};
