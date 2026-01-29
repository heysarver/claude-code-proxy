import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { Express, ErrorRequestHandler } from 'express';
import request from 'supertest';
import { createAuthMiddleware } from '../src/lib/auth.js';
import { createApiRouter } from '../src/routes/api.js';
import { createHealthRouter } from '../src/routes/health.js';
import { WorkerPool } from '../src/lib/worker-pool.js';
import { ApiError, Errors } from '../src/lib/errors.js';
import type { Config, Logger } from '../src/config.js';
import type { ClaudeRunResult } from '../src/types/index.js';

// Mock claude-runner module
vi.mock('../src/lib/claude-runner.js', () => ({
  runClaude: vi.fn(),
}));

import { runClaude } from '../src/lib/claude-runner.js';
const mockRunClaude = vi.mocked(runClaude);

// Mock config with Phase 2 options
const mockConfig: Config = {
  port: 3000,
  proxyApiKey: 'test-api-key',
  requestTimeoutMs: 5000,
  logLevel: 'error',
  workerConcurrency: 2,
  maxQueueSize: 10,
  queueTimeoutMs: 5000,
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

// Create test app with worker pool
function createTestApp(workerPool: WorkerPool): Express {
  const app = express();
  app.use(express.json());

  // Health (no auth) - with worker pool stats
  app.use(createHealthRouter(workerPool));

  // API routes (with auth)
  const authMiddleware = createAuthMiddleware(mockConfig.proxyApiKey);
  app.use('/api', authMiddleware, createApiRouter(workerPool, mockLogger));

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

  beforeEach(() => {
    workerPool = new WorkerPool(mockConfig, mockLogger);
  });

  afterEach(async () => {
    await workerPool.shutdown();
  });

  it('returns status ok with queue stats', async () => {
    const app = createTestApp(workerPool);
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.uptime).toBe('number');
    expect(res.body.queue).toBeDefined();
    expect(res.body.queue.pending).toBe(0);
    expect(res.body.queue.processing).toBe(0);
    expect(res.body.queue.concurrency).toBe(2);
  });

  // Note: Queue capacity and degraded status tests are in worker-pool.test.ts
  // as they require precise control over task execution timing
});

describe('Authentication', () => {
  let workerPool: WorkerPool;

  beforeEach(() => {
    workerPool = new WorkerPool(mockConfig, mockLogger);
  });

  afterEach(async () => {
    await workerPool.shutdown();
  });

  it('rejects requests without auth header', async () => {
    const app = createTestApp(workerPool);
    const res = await request(app).post('/api/run').send({ prompt: 'test' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('auth_error');
    expect(res.body.error.message).toContain('required');
  });

  it('rejects requests with invalid auth format', async () => {
    const app = createTestApp(workerPool);
    const res = await request(app)
      .post('/api/run')
      .set('Authorization', 'InvalidFormat')
      .send({ prompt: 'test' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('auth_error');
  });

  it('rejects requests with wrong API key', async () => {
    const app = createTestApp(workerPool);
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
  let app: Express;
  const authHeader = `Bearer ${mockConfig.proxyApiKey}`;

  beforeEach(() => {
    workerPool = new WorkerPool(mockConfig, mockLogger);
    app = createTestApp(workerPool);
  });

  afterEach(async () => {
    await workerPool.shutdown();
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

  beforeEach(() => {
    workerPool = new WorkerPool(mockConfig, mockLogger);
  });

  afterEach(async () => {
    await workerPool.shutdown();
  });

  it('processes requests through the queue', async () => {
    const app = createTestApp(workerPool);
    const authHeader = `Bearer ${mockConfig.proxyApiKey}`;

    const expectedResult: ClaudeRunResult = {
      result: 'Test response',
      sessionId: 'session-123',
      rawOutput: '{"result":"Test response","session_id":"session-123"}',
    };

    mockRunClaude.mockResolvedValueOnce(expectedResult);

    const res = await request(app)
      .post('/api/run')
      .set('Authorization', authHeader)
      .send({ prompt: 'Hello' });

    expect(res.status).toBe(200);
    expect(res.body.result).toBe('Test response');
    expect(res.body.sessionId).toBe('session-123');
    expect(typeof res.body.durationMs).toBe('number');
    expect(mockRunClaude).toHaveBeenCalledOnce();
  });

  it('respects concurrency limit', async () => {
    const app = createTestApp(workerPool);
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

  // Note: Queue full tests are in worker-pool.test.ts
  // as they require precise control over task execution timing

  it('rejects requests during shutdown', async () => {
    const app = createTestApp(workerPool);
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
});
