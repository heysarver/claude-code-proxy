import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import type { Session, SessionInfo } from '../types/index.js';
import type { Config, Logger } from '../config.js';
import { Errors } from './errors.js';

/**
 * In-memory session store with TTL cleanup and per-API-key isolation
 */
export class SessionStore {
  private sessions = new Map<string, Session>();
  private sessionQueues = new Map<string, (() => void)[]>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private config: Config;
  private logger: Logger;

  constructor(config: Config, logger: Logger) {
    this.config = config;
    this.logger = logger;
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
   * Create a new session
   */
  createSession(claudeSessionId: string, apiKey: string): Session {
    const apiKeyHash = this.hashApiKey(apiKey);

    // Check per-key limit
    const existingSessions = this.getSessionsForApiKey(apiKeyHash);
    if (existingSessions.length >= this.config.maxSessionsPerKey) {
      this.logger.warn('Session limit reached for API key', {
        limit: this.config.maxSessionsPerKey,
        existing: existingSessions.length,
      });
      throw Errors.sessionLimitReached(this.config.maxSessionsPerKey);
    }

    const session: Session = {
      id: uuidv4(),
      claudeSessionId,
      apiKeyHash,
      createdAt: new Date(),
      lastAccessedAt: new Date(),
      locked: false,
    };

    this.sessions.set(session.id, session);

    this.logger.debug('Session created', {
      sessionId: session.id,
      totalSessions: this.sessions.size,
    });

    return session;
  }

  /**
   * Get a session by ID, validating ownership
   */
  getSession(sessionId: string, apiKey: string): Session | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    // Validate ownership
    const apiKeyHash = this.hashApiKey(apiKey);
    if (session.apiKeyHash !== apiKeyHash) {
      this.logger.warn('Session access denied - wrong API key', { sessionId });
      return null;
    }

    return session;
  }

  /**
   * Update session's last accessed time
   */
  touchSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastAccessedAt = new Date();
    }
  }

  /**
   * Acquire a lock on a session for exclusive access
   * Returns a promise that resolves when the lock is acquired
   */
  async acquireLock(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw Errors.sessionNotFound(sessionId);
    }

    if (!session.locked) {
      session.locked = true;
      return;
    }

    // Session is locked, queue up and wait
    return new Promise((resolve) => {
      const queue = this.sessionQueues.get(sessionId) || [];
      queue.push(resolve);
      this.sessionQueues.set(sessionId, queue);

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
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Check if there are queued requests
    const queue = this.sessionQueues.get(sessionId);
    if (queue && queue.length > 0) {
      // Give lock to next in queue
      const next = queue.shift()!;
      if (queue.length === 0) {
        this.sessionQueues.delete(sessionId);
      }
      this.logger.debug('Session lock passed to queued request', { sessionId });
      next(); // Resolve their promise
    } else {
      // No one waiting, just unlock
      session.locked = false;
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

    this.sessions.delete(sessionId);
    this.logger.debug('Session deleted', { sessionId });
    return true;
  }

  /**
   * Get all sessions for an API key (public info only)
   */
  listSessions(apiKey: string): SessionInfo[] {
    const apiKeyHash = this.hashApiKey(apiKey);
    return this.getSessionsForApiKey(apiKeyHash).map((session) => ({
      id: session.id,
      createdAt: session.createdAt.toISOString(),
      lastAccessedAt: session.lastAccessedAt.toISOString(),
    }));
  }

  /**
   * Get sessions for an API key hash (internal)
   */
  private getSessionsForApiKey(apiKeyHash: string): Session[] {
    const sessions: Session[] = [];
    for (const session of this.sessions.values()) {
      if (session.apiKeyHash === apiKeyHash) {
        sessions.push(session);
      }
    }
    return sessions;
  }

  /**
   * Clean up expired sessions
   */
  private cleanupExpiredSessions(): void {
    const now = Date.now();
    const expiredIds: string[] = [];

    for (const [id, session] of this.sessions) {
      const age = now - session.lastAccessedAt.getTime();
      if (age > this.config.sessionTtlMs) {
        expiredIds.push(id);
      }
    }

    for (const id of expiredIds) {
      this.sessionQueues.delete(id);
      this.sessions.delete(id);
    }

    if (expiredIds.length > 0) {
      this.logger.info('Expired sessions cleaned up', {
        count: expiredIds.length,
        remaining: this.sessions.size,
      });
    }
  }

  /**
   * Get store statistics
   */
  getStats(): { totalSessions: number; lockedSessions: number } {
    let lockedSessions = 0;
    for (const session of this.sessions.values()) {
      if (session.locked) lockedSessions++;
    }
    return {
      totalSessions: this.sessions.size,
      lockedSessions,
    };
  }

  /**
   * Shutdown the session store
   */
  shutdown(): void {
    this.stopCleanup();
    this.sessions.clear();
    this.sessionQueues.clear();
    this.logger.info('Session store shutdown complete');
  }
}
