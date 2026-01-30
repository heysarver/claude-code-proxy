import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '../config.js';

/**
 * Initialize SQLite database for session storage
 */
export function createDatabase(dbPath: string, logger: Logger): Database.Database {
  // Create directory if needed (unless :memory:)
  if (dbPath !== ':memory:') {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent read/write performance
  db.pragma('journal_mode = WAL');

  // Create sessions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      claude_session_id TEXT NOT NULL,
      api_key_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_accessed_at TEXT NOT NULL
    )
  `);

  // Index for listing sessions by API key
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_api_key_hash
    ON sessions(api_key_hash)
  `);

  logger.info('Database initialized', { path: dbPath });

  return db;
}
