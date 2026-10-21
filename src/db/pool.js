import mysql from 'mysql2/promise';
import { config } from '../config/index.js';

/**
 * Shared connection pool. Every query in the app goes through parameterised
 * placeholders (`?`), so user input is never concatenated into SQL.
 */
export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  connectionLimit: config.db.connectionLimit,
  waitForConnections: true,
  // All DATETIME values are stored and read as UTC.
  timezone: 'Z',
  dateStrings: false,
  supportBigNumbers: true,
  bigNumberStrings: false,
  charset: 'utf8mb4',
  ssl: config.db.ssl,
});

// Make CURRENT_TIMESTAMP defaults UTC as well, regardless of server time zone.
pool.pool.on('connection', (connection) => {
  connection.query("SET time_zone = '+00:00'");
});

/** Run `fn(connection)` inside a transaction; commits on success, rolls back on error. */
export async function withTransaction(fn) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await fn(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function closePool() {
  await pool.end();
}
