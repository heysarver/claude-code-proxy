import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { Express, ErrorRequestHandler } from 'express';
import request from 'supertest';
import { createAuthMiddleware } from '../src/lib/auth.js';
import { createApiRouter } from '../src/routes/api.js';
import { createHealthRouter } from '../src/routes/health.js';
import { WorkerPool } from '../src/lib/worker-pool.js';
import { SessionStore } from '../src/lib/session-store.js';
import { ApiError, Errors } from '../src/lib/errors.js';
import type { Config, Logger } from '../src/config.js';
import type { ClaudeRunResult } from '../src/types/index.js';

// Mock claude-runner module
vi.mock('../src/lib/claude-runner.js', () => ({
  runClaude: vi.fn(),
}));

import { runClaude } from '../src/lib/claude-runner.js';
const mockRunClaude = vi.mocked(runClaude);

// Mock config with Phase 2 and Phase 3 options
const mockConfig: Config = {
  port: 6789,
  proxyApiKey: 'test-api-key',
  requestTimeoutMs: 5000,
  logLevel: 'error',
  workerConcurrency: 2,
  maxQueueSize: 10,
  queueTimeoutMs: 5000,
  sessionTtlMs: 3600000,
  maxSessionsPerKey: 10,
  sessionCleanupIntervalMs: 60000,
  sessionDbPath: ':memory:',
  defaultWorkspaceDir: '/tmp/test-workspace',
};

// Mock logger
const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

// Reset mocks before each test
beforeEach(() => {
  vi.clearAllMocks();
});

// Create test app with worker pool and session store
function createTestApp(workerPool: WorkerPool, sessionStore: SessionStore): Express {
  const app = express();
  app.use(express.json());

  // Health (no auth) - with worker pool and session stats
  app.use(createHealthRouter(workerPool, sessionStore));

  // API routes (with auth)
  const authMiddleware = createAuthMiddleware(mockConfig.proxyApiKey);
  app.use('/api', authMiddleware, createApiRouter(workerPool, sessionStore, mockLogger));

  // Error handler
  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof ApiError) {
      res.status(err.statusCode).json(err.toJSON());
      return;
    }
    res.status(500).json({ error: { code: 'internal_error', message: 'Internal error' } });
  };
  app.use(errorHandler);

  return app;
}

describe('Health Endpoint', () => {
  let workerPool: WorkerPool;
  let sessionStore: SessionStore;

  beforeEach(() => {
    workerPool = new WorkerPool(mockConfig, mockLogger);
    sessionStore = new SessionStore(mockConfig, mockLogger);
  });

  afterEach(async () => {
    await workerPool.shutdown();
    sessionStore.shutdown();
  });

  it('returns status ok with queue and session stats', async () => {
    const app = createTestApp(workerPool, sessionStore);
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.uptime).toBe('number');
    expect(res.body.queue).toBeDefined();
    expect(res.body.queue.pending).toBe(0);
    expect(res.body.queue.processing).toBe(0);
    expect(res.body.queue.concurrency).toBe(2);
    expect(res.body.sessions).toBeDefined();
    expect(res.body.sessions.total).toBe(0);
    expect(res.body.sessions.locked).toBe(0);
  });

  // Note: Queue capacity and degraded status tests are in worker-pool.test.ts
  // as they require precise control over task execution timing
});

describe('Authentication', () => {
  let workerPool: WorkerPool;
  let sessionStore: SessionStore;

  beforeEach(() => {
    workerPool = new WorkerPool(mockConfig, mockLogger);
    sessionStore = new SessionStore(mockConfig, mockLogger);
  });

  afterEach(async () => {
    await workerPool.shutdown();
    sessionStore.shutdown();
  });

  it('rejects requests without auth header', async () => {
    const app = createTestApp(workerPool, sessionStore);
    const res = await request(app).post('/api/run').send({ prompt: 'test' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('auth_error');
    expect(res.body.error.message).toContain('required');
  });

  it('rejects requests with invalid auth format', async () => {
    const app = createTestApp(workerPool, sessionStore);
    const res = await request(app)
      .post('/api/run')
      .set('Authorization', 'InvalidFormat')
      .send({ prompt: 'test' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('auth_error');
  });

  it('rejects requests with wrong API key', async () => {
    const app = createTestApp(workerPool, sessionStore);
    const res = await request(app)
      .post('/api/run')
      .set('Authorization', 'Bearer wrong-key')
      .send({ prompt: 'test' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('auth_error');
  });
});

describe('Request Validation', () => {
  let workerPool: WorkerPool;
  let sessionStore: SessionStore;
  let app: Express;
  const authHeader = `Bearer ${mockConfig.proxyApiKey}`;

  beforeEach(() => {
    workerPool = new WorkerPool(mockConfig, mockLogger);
    sessionStore = new SessionStore(mockConfig, mockLogger);
    app = createTestApp(workerPool, sessionStore);
  });

  afterEach(async () => {
    await workerPool.shutdown();
    sessionStore.shutdown();
  });

  it('rejects requests without prompt', async () => {
    const res = await request(app)
      .post('/api/run')
      .set('Authorization', authHeader)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
    expect(res.body.error.message).toContain('prompt');
  });

  it('rejects requests with empty prompt', async () => {
    const res = await request(app)
      .post('/api/run')
      .set('Authorization', authHeader)
      .send({ prompt: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('rejects requests with non-array allowedTools', async () => {
    const res = await request(app)
      .post('/api/run')
      .set('Authorization', authHeader)
      .send({ prompt: 'test', allowedTools: 'Read' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('rejects workingDirectory with path traversal', async () => {
    const res = await request(app)
      .post('/api/run')
      .set('Authorization', authHeader)
      .send({ prompt: 'test', workingDirectory: '../../../etc' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });
});

describe('Worker Pool', () => {
  let workerPool: WorkerPool;
  let sessionStore: SessionStore;

  beforeEach(() => {
    workerPool = new WorkerPool(mockConfig, mockLogger);
    sessionStore = new SessionStore(mockConfig, mockLogger);
  });

  afterEach(async () => {
    await workerPool.shutdown();
    sessionStore.shutdown();
  });

  it('processes requests through the queue', async () => {
    const app = createTestApp(workerPool, sessionStore);
    const authHeader = `Bearer ${mockConfig.proxyApiKey}`;

    const expectedResult: ClaudeRunResult = {
      result: 'Test response',
      sessionId: 'claude-internal-session-123',
      rawOutput: '{"result":"Test response","session_id":"claude-internal-session-123"}',
    };

    mockRunClaude.mockResolvedValueOnce(expectedResult);

    const res = await request(app)
      .post('/api/run')
      .set('Authorization', authHeader)
      .send({ prompt: 'Hello' });

    expect(res.status).toBe(200);
    expect(res.body.result).toBe('Test response');
    // Session ID should be a UUID (our external ID), not Claude's internal ID
    expect(res.body.sessionId).toBeDefined();
    expect(res.body.sessionId).not.toBe('claude-internal-session-123');
    expect(typeof res.body.durationMs).toBe('number');
    expect(mockRunClaude).toHaveBeenCalledOnce();
  });

  it('respects concurrency limit', async () => {
    const app = createTestApp(workerPool, sessionStore);
    const authHeader = `Bearer ${mockConfig.proxyApiKey}`;

    // Track when each request starts and ends
    let activeCount = 0;
    let maxActive = 0;

    mockRunClaude.mockImplementation(async () => {
      activeCount++;
      maxActive = Math.max(maxActive, activeCount);
      await new Promise((r) => setTimeout(r, 50));
      activeCount--;
      return { result: 'done', sessionId: undefined, rawOutput: 'done' };
    });

    // Send 4 requests concurrently (concurrency is 2)
    const requests = Array(4).fill(null).map(() =>
      request(app)
        .post('/api/run')
        .set('Authorization', authHeader)
        .send({ prompt: 'test' })
    );

    await Promise.all(requests);

    // Max concurrent should be at most 2 (the concurrency limit)
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it('does not abort when request completes normally with delay', async () => {
    // This test ensures the close event handler doesn't cause false aborts
    // when the response is sent before the close event fires
    const app = createTestApp(workerPool, sessionStore);
    const authHeader = `Bearer ${mockConfig.proxyApiKey}`;

    mockRunClaude.mockImplementation(async () => {
      // Simulate a slow CLI call
      await new Promise((r) => setTimeout(r, 100));
      return { result: 'Success after delay', sessionId: undefined, rawOutput: 'Success after delay' };
    });

    const res = await request(app)
      .post('/api/run')
      .set('Authorization', authHeader)
      .send({ prompt: 'test' });

    // Should succeed, not abort
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('Success after delay');
    expect(res.body.error).toBeUndefined();
  });

  // Note: Queue full tests are in worker-pool.test.ts
  // as they require precise control over task execution timing

  it('rejects requests during shutdown', async () => {
    const app = createTestApp(workerPool, sessionStore);
    const authHeader = `Bearer ${mockConfig.proxyApiKey}`;

    // Start shutdown
    const shutdownPromise = workerPool.shutdown();

    // Try to submit a request
    const res = await request(app)
      .post('/api/run')
      .set('Authorization', authHeader)
      .send({ prompt: 'test' });

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('cli_error');
    expect(res.body.error.message).toContain('shutting down');

    await shutdownPromise;
  });

  it('provides accurate stats', async () => {
    const stats = workerPool.getStats();

    expect(stats.pending).toBe(0);
    expect(stats.processing).toBe(0);
    expect(stats.concurrency).toBe(2);
    expect(stats.maxQueueSize).toBe(10);
    expect(stats.isPaused).toBe(false);
  });

  it('reports healthy when below capacity', () => {
    expect(workerPool.isHealthy()).toBe(true);
  });
});

describe('Error Classes', () => {
  it('ApiError serializes correctly', () => {
    const error = new ApiError(400, 'invalid_request', 'Test message', { field: 'test' });

    expect(error.statusCode).toBe(400);
    expect(error.code).toBe('invalid_request');
    expect(error.message).toBe('Test message');

    const json = error.toJSON();
    expect(json.error.code).toBe('invalid_request');
    expect(json.error.message).toBe('Test message');
    expect(json.error.details).toEqual({ field: 'test' });
  });

  it('Error factories create correct errors', () => {
    const authError = Errors.authRequired();
    expect(authError.statusCode).toBe(401);
    expect(authError.code).toBe('auth_error');

    const timeoutError = Errors.timeout(5000);
    expect(timeoutError.statusCode).toBe(504);
    expect(timeoutError.code).toBe('timeout');

    const cliNotFound = Errors.cliNotFound();
    expect(cliNotFound.statusCode).toBe(500);
    expect(cliNotFound.code).toBe('cli_not_found');
  });

  it('Phase 2 error factories create correct errors', () => {
    const queueFull = Errors.queueFull(100);
    expect(queueFull.statusCode).toBe(429);
    expect(queueFull.code).toBe('queue_full');
    expect(queueFull.message).toContain('100');

    const queueTimeout = Errors.queueTimeout(60000);
    expect(queueTimeout.statusCode).toBe(504);
    expect(queueTimeout.code).toBe('queue_timeout');
    expect(queueTimeout.message).toContain('60000');
  });

  it('Phase 3 error factories create correct errors', () => {
    const sessionNotFound = Errors.sessionNotFound('test-session');
    expect(sessionNotFound.statusCode).toBe(404);
    expect(sessionNotFound.code).toBe('session_not_found');
    expect(sessionNotFound.message).toContain('test-session');

    const sessionLimit = Errors.sessionLimitReached(10);
    expect(sessionLimit.statusCode).toBe(429);
    expect(sessionLimit.code).toBe('session_limit_reached');
    expect(sessionLimit.message).toContain('10');
  });
});
