import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionStore } from '../src/lib/session-store.js';
import { Errors } from '../src/lib/errors.js';
import type { Config, Logger } from '../src/config.js';

// Mock config
const mockConfig: Config = {
  port: 6789,
  proxyApiKey: 'test-api-key',
  requestTimeoutMs: 5000,
  logLevel: 'error',
  workerConcurrency: 2,
  maxQueueSize: 10,
  queueTimeoutMs: 5000,
  sessionTtlMs: 3600000, // 1 hour
  maxSessionsPerKey: 3,
  sessionCleanupIntervalMs: 60000,
};

// Mock logger
const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('SessionStore', () => {
  let sessionStore: SessionStore;

  beforeEach(() => {
    sessionStore = new SessionStore(mockConfig, mockLogger);
    vi.clearAllMocks();
  });

  afterEach(() => {
    sessionStore.shutdown();
  });

  describe('createSession', () => {
    it('creates a new session with correct properties', () => {
      const session = sessionStore.createSession('claude-internal-123', 'api-key-1');

      expect(session.id).toBeDefined();
      expect(session.id).toMatch(/^[0-9a-f-]{36}$/); // UUID format
      expect(session.claudeSessionId).toBe('claude-internal-123');
      expect(session.apiKeyHash).toBeDefined();
      expect(session.apiKeyHash).not.toBe('api-key-1'); // Should be hashed
      expect(session.createdAt).toBeInstanceOf(Date);
      expect(session.lastAccessedAt).toBeInstanceOf(Date);
      expect(session.locked).toBe(false);
    });

    it('enforces per-API-key session limit', () => {
      // Create sessions up to limit
      sessionStore.createSession('claude-1', 'api-key-1');
      sessionStore.createSession('claude-2', 'api-key-1');
      sessionStore.createSession('claude-3', 'api-key-1');

      // Fourth session should fail
      expect(() => {
        sessionStore.createSession('claude-4', 'api-key-1');
      }).toThrow('Maximum sessions per API key');
    });

    it('allows different API keys to have their own sessions', () => {
      // Fill up api-key-1
      sessionStore.createSession('claude-1', 'api-key-1');
      sessionStore.createSession('claude-2', 'api-key-1');
      sessionStore.createSession('claude-3', 'api-key-1');

      // api-key-2 should still be able to create sessions
      const session = sessionStore.createSession('claude-4', 'api-key-2');
      expect(session).toBeDefined();
    });
  });

  describe('getSession', () => {
    it('returns session for correct API key', () => {
      const created = sessionStore.createSession('claude-123', 'api-key-1');
      const retrieved = sessionStore.getSession(created.id, 'api-key-1');

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(created.id);
    });

    it('returns null for wrong API key', () => {
      const created = sessionStore.createSession('claude-123', 'api-key-1');
      const retrieved = sessionStore.getSession(created.id, 'api-key-2');

      expect(retrieved).toBeNull();
    });

    it('returns null for non-existent session', () => {
      const retrieved = sessionStore.getSession('non-existent-id', 'api-key-1');
      expect(retrieved).toBeNull();
    });
  });

  describe('touchSession', () => {
    it('updates lastAccessedAt time', async () => {
      const session = sessionStore.createSession('claude-123', 'api-key-1');
      const originalAccessedAt = session.lastAccessedAt;

      // Wait a bit
      await new Promise((r) => setTimeout(r, 10));

      sessionStore.touchSession(session.id);

      const retrieved = sessionStore.getSession(session.id, 'api-key-1');
      expect(retrieved?.lastAccessedAt.getTime()).toBeGreaterThan(originalAccessedAt.getTime());
    });
  });

  describe('deleteSession', () => {
    it('deletes session for correct API key', () => {
      const session = sessionStore.createSession('claude-123', 'api-key-1');

      const deleted = sessionStore.deleteSession(session.id, 'api-key-1');
      expect(deleted).toBe(true);

      const retrieved = sessionStore.getSession(session.id, 'api-key-1');
      expect(retrieved).toBeNull();
    });

    it('returns false for wrong API key', () => {
      const session = sessionStore.createSession('claude-123', 'api-key-1');

      const deleted = sessionStore.deleteSession(session.id, 'api-key-2');
      expect(deleted).toBe(false);

      // Session should still exist
      const retrieved = sessionStore.getSession(session.id, 'api-key-1');
      expect(retrieved).not.toBeNull();
    });

    it('returns false for non-existent session', () => {
      const deleted = sessionStore.deleteSession('non-existent', 'api-key-1');
      expect(deleted).toBe(false);
    });
  });

  describe('listSessions', () => {
    it('lists all sessions for API key', () => {
      sessionStore.createSession('claude-1', 'api-key-1');
      sessionStore.createSession('claude-2', 'api-key-1');
      sessionStore.createSession('claude-3', 'api-key-2');

      const sessionsKey1 = sessionStore.listSessions('api-key-1');
      expect(sessionsKey1).toHaveLength(2);

      const sessionsKey2 = sessionStore.listSessions('api-key-2');
      expect(sessionsKey2).toHaveLength(1);
    });

    it('returns public session info only', () => {
      sessionStore.createSession('claude-123', 'api-key-1');

      const sessions = sessionStore.listSessions('api-key-1');
      expect(sessions[0]).toHaveProperty('id');
      expect(sessions[0]).toHaveProperty('createdAt');
      expect(sessions[0]).toHaveProperty('lastAccessedAt');
      expect(sessions[0]).not.toHaveProperty('claudeSessionId');
      expect(sessions[0]).not.toHaveProperty('apiKeyHash');
      expect(sessions[0]).not.toHaveProperty('locked');
    });
  });

  describe('locking', () => {
    it('acquires lock on unlocked session', async () => {
      const session = sessionStore.createSession('claude-123', 'api-key-1');

      await sessionStore.acquireLock(session.id);

      const retrieved = sessionStore.getSession(session.id, 'api-key-1');
      expect(retrieved?.locked).toBe(true);
    });

    it('releases lock', async () => {
      const session = sessionStore.createSession('claude-123', 'api-key-1');

      await sessionStore.acquireLock(session.id);
      sessionStore.releaseLock(session.id);

      const retrieved = sessionStore.getSession(session.id, 'api-key-1');
      expect(retrieved?.locked).toBe(false);
    });

    it('queues requests for locked session', async () => {
      const session = sessionStore.createSession('claude-123', 'api-key-1');
      const order: number[] = [];

      // First request acquires lock
      await sessionStore.acquireLock(session.id);
      order.push(1);

      // Second request waits
      const secondLock = sessionStore.acquireLock(session.id).then(() => {
        order.push(2);
      });

      // Third request also waits
      const thirdLock = sessionStore.acquireLock(session.id).then(() => {
        order.push(3);
      });

      // Give time for queuing
      await new Promise((r) => setTimeout(r, 10));

      // Release first lock - second should acquire
      sessionStore.releaseLock(session.id);
      await secondLock;

      // Release second lock - third should acquire
      sessionStore.releaseLock(session.id);
      await thirdLock;

      expect(order).toEqual([1, 2, 3]);
    });

    it('throws error when acquiring lock on non-existent session', async () => {
      await expect(sessionStore.acquireLock('non-existent')).rejects.toThrow('Session not found');
    });
  });

  describe('getStats', () => {
    it('returns correct statistics', async () => {
      sessionStore.createSession('claude-1', 'api-key-1');
      sessionStore.createSession('claude-2', 'api-key-1');

      let stats = sessionStore.getStats();
      expect(stats.totalSessions).toBe(2);
      expect(stats.lockedSessions).toBe(0);

      // Lock a session
      const sessions = sessionStore.listSessions('api-key-1');
      await sessionStore.acquireLock(sessions[0].id);

      stats = sessionStore.getStats();
      expect(stats.totalSessions).toBe(2);
      expect(stats.lockedSessions).toBe(1);
    });
  });

  describe('cleanup', () => {
    it('starts and stops cleanup timer', () => {
      sessionStore.startCleanup();
      // Starting again should be idempotent
      sessionStore.startCleanup();

      sessionStore.stopCleanup();
      // Stopping again should be idempotent
      sessionStore.stopCleanup();
    });

    it('removes expired sessions during cleanup', async () => {
      // Create a store with very short TTL for testing
      const shortTtlConfig: Config = {
        ...mockConfig,
        sessionTtlMs: 50, // 50ms TTL
        sessionCleanupIntervalMs: 25, // 25ms cleanup interval
      };
      const shortTtlStore = new SessionStore(shortTtlConfig, mockLogger);
      shortTtlStore.startCleanup();

      // Create a session
      const session = shortTtlStore.createSession('claude-123', 'api-key-1');

      // Session should exist
      expect(shortTtlStore.getSession(session.id, 'api-key-1')).not.toBeNull();

      // Wait for TTL + cleanup interval
      await new Promise((r) => setTimeout(r, 100));

      // Session should be cleaned up
      expect(shortTtlStore.getSession(session.id, 'api-key-1')).toBeNull();

      shortTtlStore.shutdown();
    });
  });

  describe('hashApiKey', () => {
    it('produces consistent hashes', () => {
      const hash1 = sessionStore.hashApiKey('test-key');
      const hash2 = sessionStore.hashApiKey('test-key');

      expect(hash1).toBe(hash2);
    });

    it('produces different hashes for different keys', () => {
      const hash1 = sessionStore.hashApiKey('test-key-1');
      const hash2 = sessionStore.hashApiKey('test-key-2');

      expect(hash1).not.toBe(hash2);
    });
  });
});
