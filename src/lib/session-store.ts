import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { Session, SessionInfo } from '../types/index.js';
import type { Config, Logger } from '../config.js';
import { Errors } from './errors.js';
import { createDatabase } from './database.js';

// Database row types
interface SessionRow {
  id: string;
  claude_session_id: string;
  api_key_hash: string;
  created_at: string;
  last_accessed_at: string;
}

interface CountRow {
  count: number;
}

/**
 * SQLite-backed session store with TTL cleanup and per-API-key isolation
 */
export class SessionStore {
  private db: Database.Database;
  private sessionQueues = new Map<string, (() => void)[]>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private config: Config;
  private logger: Logger;

  // Prepared statements
  private stmtInsert: Database.Statement;
  private stmtGetById: Database.Statement;
  private stmtUpdateLastAccessed: Database.Statement;
  private stmtDelete: Database.Statement;
  private stmtListByApiKey: Database.Statement;
  private stmtCountByApiKey: Database.Statement;
  private stmtCleanupExpired: Database.Statement;
  private stmtCountAll: Database.Statement;

  constructor(config: Config, logger: Logger) {
    this.config = config;
    this.logger = logger;

    // Initialize database
    this.db = createDatabase(config.sessionDbPath, logger);

    // Prepare statements once for performance
    this.stmtInsert = this.db.prepare(`
      INSERT INTO sessions (id, claude_session_id, api_key_hash, created_at, last_accessed_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    this.stmtGetById = this.db.prepare(`
      SELECT * FROM sessions WHERE id = ?
    `);

    this.stmtUpdateLastAccessed = this.db.prepare(`
      UPDATE sessions SET last_accessed_at = ? WHERE id = ?
    `);

    this.stmtDelete = this.db.prepare(`
      DELETE FROM sessions WHERE id = ?
    `);

    this.stmtListByApiKey = this.db.prepare(`
      SELECT id, created_at, last_accessed_at FROM sessions WHERE api_key_hash = ?
    `);

    this.stmtCountByApiKey = this.db.prepare(`
      SELECT COUNT(*) as count FROM sessions WHERE api_key_hash = ?
    `);

    this.stmtCleanupExpired = this.db.prepare(`
      DELETE FROM sessions WHERE last_accessed_at < ?
    `);

    this.stmtCountAll = this.db.prepare(`
      SELECT COUNT(*) as count FROM sessions
    `);
  }

  /**
   * Start the session cleanup timer
   */
  startCleanup(): void {
    if (this.cleanupTimer) return;

    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredSessions();
    }, this.config.sessionCleanupIntervalMs);

    this.logger.info('Session cleanup timer started', {
      intervalMs: this.config.sessionCleanupIntervalMs,
      ttlMs: this.config.sessionTtlMs,
    });
  }

  /**
   * Stop the session cleanup timer
   */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      this.logger.info('Session cleanup timer stopped');
    }
  }

  /**
   * Hash an API key for storage (we don't store raw keys)
   */
  hashApiKey(apiKey: string): string {
    return createHash('sha256').update(apiKey).digest('hex');
  }

  /**
   * Convert database row to Session object
   */
  private rowToSession(row: SessionRow): Session {
    return {
      id: row.id,
      claudeSessionId: row.claude_session_id,
      apiKeyHash: row.api_key_hash,
      createdAt: new Date(row.created_at),
      lastAccessedAt: new Date(row.last_accessed_at),
      locked: this.sessionQueues.has(row.id), // Derive from runtime state
    };
  }

  /**
   * Create a new session
   */
  createSession(claudeSessionId: string, apiKey: string): Session {
    const apiKeyHash = this.hashApiKey(apiKey);

    // Check per-key limit
    const countRow = this.stmtCountByApiKey.get(apiKeyHash) as CountRow;
    if (countRow.count >= this.config.maxSessionsPerKey) {
      this.logger.warn('Session limit reached for API key', {
        limit: this.config.maxSessionsPerKey,
        existing: countRow.count,
      });
      throw Errors.sessionLimitReached(this.config.maxSessionsPerKey);
    }

    const now = new Date();
    const session: Session = {
      id: uuidv4(),
      claudeSessionId,
      apiKeyHash,
      createdAt: now,
      lastAccessedAt: now,
      locked: false,
    };

    this.stmtInsert.run(
      session.id,
      session.claudeSessionId,
      session.apiKeyHash,
      session.createdAt.toISOString(),
      session.lastAccessedAt.toISOString()
    );

    this.logger.debug('Session created', {
      sessionId: session.id,
    });

    return session;
  }

  /**
   * Get a session by ID, validating ownership
   */
  getSession(sessionId: string, apiKey: string): Session | null {
    const row = this.stmtGetById.get(sessionId) as SessionRow | undefined;
    if (!row) return null;

    // Validate ownership
    const apiKeyHash = this.hashApiKey(apiKey);
    if (row.api_key_hash !== apiKeyHash) {
      this.logger.warn('Session access denied - wrong API key', { sessionId });
      return null;
    }

    return this.rowToSession(row);
  }

  /**
   * Update session's last accessed time
   */
  touchSession(sessionId: string): void {
    this.stmtUpdateLastAccessed.run(new Date().toISOString(), sessionId);
  }

  /**
   * Acquire a lock on a session for exclusive access
   * Returns a promise that resolves when the lock is acquired
   */
  async acquireLock(sessionId: string): Promise<void> {
    const row = this.stmtGetById.get(sessionId) as SessionRow | undefined;
    if (!row) {
      throw Errors.sessionNotFound(sessionId);
    }

    // Check if session is currently locked (has active queue)
    const queue = this.sessionQueues.get(sessionId);
    if (!queue || queue.length === 0) {
      // Not locked, create empty queue to mark as locked
      this.sessionQueues.set(sessionId, []);
      return;
    }

    // Session is locked, queue up and wait
    return new Promise((resolve) => {
      queue.push(resolve);

      this.logger.debug('Request queued for locked session', {
        sessionId,
        queuePosition: queue.length,
      });
    });
  }

  /**
   * Release a lock on a session
   */
  releaseLock(sessionId: string): void {
    const queue = this.sessionQueues.get(sessionId);
    if (!queue) return;

    if (queue.length > 0) {
      // Give lock to next in queue
      const next = queue.shift()!;
      this.logger.debug('Session lock passed to queued request', { sessionId });
      next(); // Resolve their promise
    } else {
      // No one waiting, remove the lock
      this.sessionQueues.delete(sessionId);
    }
  }

  /**
   * Delete a session
   */
  deleteSession(sessionId: string, apiKey: string): boolean {
    const session = this.getSession(sessionId, apiKey);
    if (!session) return false;

    // Clear any pending queue for this session
    this.sessionQueues.delete(sessionId);

    this.stmtDelete.run(sessionId);
    this.logger.debug('Session deleted', { sessionId });
    return true;
  }

  /**
   * Get all sessions for an API key (public info only)
   */
  listSessions(apiKey: string): SessionInfo[] {
    const apiKeyHash = this.hashApiKey(apiKey);
    const rows = this.stmtListByApiKey.all(apiKeyHash) as Array<{
      id: string;
      created_at: string;
      last_accessed_at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      lastAccessedAt: row.last_accessed_at,
    }));
  }

  /**
   * Clean up expired sessions
   */
  private cleanupExpiredSessions(): void {
    const cutoff = new Date(Date.now() - this.config.sessionTtlMs).toISOString();
    const result = this.stmtCleanupExpired.run(cutoff);

    if (result.changes > 0) {
      this.logger.info('Expired sessions cleaned up', {
        count: result.changes,
      });
    }
  }

  /**
   * Get store statistics
   */
  getStats(): { totalSessions: number; lockedSessions: number } {
    const countRow = this.stmtCountAll.get() as CountRow;
    return {
      totalSessions: countRow.count,
      lockedSessions: this.sessionQueues.size,
    };
  }

  /**
   * Shutdown the session store
   */
  shutdown(): void {
    this.stopCleanup();
    this.sessionQueues.clear();
    this.db.close();
    this.logger.info('Session store shutdown complete');
  }
}
