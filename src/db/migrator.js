import fs from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { config } from '../config/index.js';

const MIGRATIONS_DIR = path.join(config.rootDir, 'migrations');

/**
 * Parse a migration file into { up: string[], down: string[] }.
 * Files contain `-- migrate:up` and `-- migrate:down` sections; statements end with `;` at end of line.
 */
export function parseMigration(sql) {
  const sections = { up: [], down: [] };
  let current = null;
  let buffer = [];

  const flush = () => {
    const statement = buffer.join('\n').trim();
    if (statement && current) sections[current].push(statement);
    buffer = [];
  };

  for (const line of sql.split(/\r?\n/)) {
    const marker = line.trim().toLowerCase();
    if (marker === '-- migrate:up' || marker === '-- migrate:down') {
      flush();
      current = marker.endsWith('up') ? 'up' : 'down';
      continue;
    }
    if (!current || line.trim().startsWith('--')) continue;
    if (line.trimEnd().endsWith(';')) {
      buffer.push(line.trimEnd().slice(0, -1));
      flush();
    } else {
      buffer.push(line);
    }
  }
  flush();

  if (sections.up.length === 0) throw new Error('Migration has no "-- migrate:up" statements');
  return sections;
}

async function connect({ withDatabase = true } = {}) {
  const connection = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    // A separate account with CREATE/ALTER rights may run migrations (DB_MIGRATION_USER).
    user: config.db.migrationUser || config.db.user,
    password: config.db.migrationUser ? config.db.migrationPassword : config.db.password,
    database: withDatabase ? config.db.database : undefined,
    ssl: config.db.ssl,
    charset: 'utf8mb4',
  });
  await connection.query("SET time_zone = '+00:00'");
  return connection;
}

async function ensureMigrationsTable(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
      name       VARCHAR(255) NOT NULL,
      run_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_schema_migrations_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function listMigrationFiles() {
  const files = await fs.readdir(MIGRATIONS_DIR);
  return files.filter((file) => file.endsWith('.sql')).sort();
}

async function appliedMigrations(connection) {
  const [rows] = await connection.query('SELECT name FROM schema_migrations ORDER BY id');
  return rows.map((row) => row.name);
}

export async function createDatabase() {
  const connection = await connect({ withDatabase: false });
  try {
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS ${mysql.escapeId(config.db.database)}
       CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    return config.db.database;
  } finally {
    await connection.end();
  }
}

export async function migrateUp({ log = console.log } = {}) {
  const connection = await connect();
  try {
    await ensureMigrationsTable(connection);
    const applied = new Set(await appliedMigrations(connection));
    const pending = (await listMigrationFiles()).filter((file) => !applied.has(file));

    for (const file of pending) {
      const { up } = parseMigration(await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8'));
      for (const statement of up) await connection.query(statement);
      await connection.query('INSERT INTO schema_migrations (name) VALUES (?)', [file]);
      log(`  ✔ applied ${file}`);
    }
    if (pending.length === 0) log('  Database is up to date.');
    return pending;
  } finally {
    await connection.end();
  }
}

export async function migrateDown({ log = console.log, steps = 1 } = {}) {
  const connection = await connect();
  try {
    await ensureMigrationsTable(connection);
    const applied = (await appliedMigrations(connection)).reverse().slice(0, steps);
    for (const file of applied) {
      const { down } = parseMigration(await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8'));
      for (const statement of down) await connection.query(statement);
      await connection.query('DELETE FROM schema_migrations WHERE name = ?', [file]);
      log(`  ✔ reverted ${file}`);
    }
    if (applied.length === 0) log('  Nothing to revert.');
    return applied;
  } finally {
    await connection.end();
  }
}

export async function migrationStatus() {
  const connection = await connect();
  try {
    await ensureMigrationsTable(connection);
    const applied = new Set(await appliedMigrations(connection));
    return (await listMigrationFiles()).map((file) => ({ file, applied: applied.has(file) }));
  } finally {
    await connection.end();
  }
}
