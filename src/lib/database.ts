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
  // Avoid immediate SQLITE_BUSY when another process is writing
  db.pragma('busy_timeout = 5000');

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

  // Create tasks table (Phase 6 - Background Tasks)
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
      api_key_hash TEXT NOT NULL,
      prompt TEXT NOT NULL,
      model TEXT,
      allowed_tools TEXT,
      working_directory TEXT,
      session_id TEXT,
      max_turns INTEGER,
      result TEXT,
      failure_reason TEXT,
      claude_session_id TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      duration_ms INTEGER
    )
  `);

  // Index for listing tasks by API key
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_api_key_hash
    ON tasks(api_key_hash)
  `);

  // Index for TTL cleanup queries
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_status_completed
    ON tasks(status, completed_at)
  `);

  logger.info('Database initialized', { path: dbPath });

  return db;
}
