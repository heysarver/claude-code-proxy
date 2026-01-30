import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { Express, ErrorRequestHandler } from 'express';
import request from 'supertest';
import { createAuthMiddleware } from '../src/lib/auth.js';
import { createAnthropicRouter } from '../src/routes/anthropic.js';
import { WorkerPool } from '../src/lib/worker-pool.js';
import { SessionStore } from '../src/lib/session-store.js';
import { ApiError } from '../src/lib/errors.js';
import type { Config, Logger } from '../src/config.js';
import type { ClaudeRunResult } from '../src/types/index.js';

// Mock claude-runner module
vi.mock('../src/lib/claude-runner.js', () => ({
  runClaude: vi.fn(),
}));

import { runClaude } from '../src/lib/claude-runner.js';
const mockRunClaude = vi.mocked(runClaude);

// Mock config
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

// Create test app with Anthropic routes
function createTestApp(workerPool: WorkerPool, sessionStore: SessionStore): Express {
  const app = express();
  app.use(express.json());

  // Anthropic routes (with auth)
  const authMiddleware = createAuthMiddleware(mockConfig.proxyApiKey);
  app.use('/v1', authMiddleware, createAnthropicRouter(workerPool, sessionStore, mockLogger));

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

describe('Anthropic Routes', () => {
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

  describe('POST /v1/messages', () => {
    it('processes valid request', async () => {
      const expectedResult: ClaudeRunResult = {
        result: 'Hello! How can I help you?',
        sessionId: 'claude-session-456',
        rawOutput: '{"result":"Hello! How can I help you?"}',
      };
      mockRunClaude.mockResolvedValueOnce(expectedResult);

      const res = await request(app)
        .post('/v1/messages')
        .set('Authorization', authHeader)
        .send({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          messages: [{ role: 'user', content: 'Hello' }],
        });

      expect(res.status).toBe(200);
      expect(res.body.type).toBe('message');
      expect(res.body.role).toBe('assistant');
      expect(res.body.content).toHaveLength(1);
      expect(res.body.content[0].type).toBe('text');
      expect(res.body.content[0].text).toBe('Hello! How can I help you?');
      expect(res.body.stop_reason).toBe('end_turn');
      expect(res.body.id).toMatch(/^msg_/);
    });

    it('handles system messages correctly', async () => {
      const expectedResult: ClaudeRunResult = {
        result: 'I am a helpful assistant.',
        sessionId: undefined,
        rawOutput: '{"result":"I am a helpful assistant."}',
      };
      mockRunClaude.mockResolvedValueOnce(expectedResult);

      await request(app)
        .post('/v1/messages')
        .set('Authorization', authHeader)
        .send({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          system: 'You are a helpful assistant.',
          messages: [{ role: 'user', content: 'Who are you?' }],
        });

      // Verify the prompt includes system message
      expect(mockRunClaude).toHaveBeenCalledOnce();
      const callArgs = mockRunClaude.mock.calls[0][0];
      expect(callArgs.prompt).toContain('System: You are a helpful assistant.');
      expect(callArgs.prompt).toContain('User: Who are you?');
    });

    it('requires authentication', async () => {
      const res = await request(app)
        .post('/v1/messages')
        .send({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          messages: [{ role: 'user', content: 'Hello' }],
        });

      expect(res.status).toBe(401);
    });

    it('validates messages array is required', async () => {
      const res = await request(app)
        .post('/v1/messages')
        .set('Authorization', authHeader)
        .send({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
        });

      expect(res.status).toBe(400);
      expect(res.body.type).toBe('error');
      expect(res.body.error.type).toBe('invalid_request_error');
      expect(res.body.error.message).toContain('messages');
    });

    it('validates max_tokens is required', async () => {
      const res = await request(app)
        .post('/v1/messages')
        .set('Authorization', authHeader)
        .send({
          model: 'claude-sonnet-4-20250514',
          messages: [{ role: 'user', content: 'Hello' }],
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('max_tokens');
    });

    it('validates message roles', async () => {
      const res = await request(app)
        .post('/v1/messages')
        .set('Authorization', authHeader)
        .send({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          messages: [{ role: 'invalid', content: 'Hello' }],
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('role');
    });

    it('validates message content is string', async () => {
      const res = await request(app)
        .post('/v1/messages')
        .set('Authorization', authHeader)
        .send({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          messages: [{ role: 'user', content: 123 }],
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('content');
    });

    it('returns Anthropic-style error format', async () => {
      const res = await request(app)
        .post('/v1/messages')
        .set('Authorization', authHeader)
        .send({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          messages: [],
        });

      expect(res.status).toBe(400);
      expect(res.body.type).toBe('error');
      expect(res.body.error).toBeDefined();
      expect(res.body.error.type).toBe('invalid_request_error');
      expect(res.body.error.message).toBeDefined();
    });

    it('logs unsupported parameters', async () => {
      const expectedResult: ClaudeRunResult = {
        result: 'Response',
        sessionId: undefined,
        rawOutput: '{"result":"Response"}',
      };
      mockRunClaude.mockResolvedValueOnce(expectedResult);

      await request(app)
        .post('/v1/messages')
        .set('Authorization', authHeader)
        .send({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          messages: [{ role: 'user', content: 'Hello' }],
          temperature: 0.7,
          top_p: 0.9,
        });

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Ignoring unsupported Anthropic params',
        expect.objectContaining({
          params: expect.arrayContaining(['temperature', 'top_p']),
        })
      );
    });

    it('passes model to Claude CLI', async () => {
      const expectedResult: ClaudeRunResult = {
        result: 'Response',
        sessionId: undefined,
        rawOutput: '{"result":"Response"}',
      };
      mockRunClaude.mockResolvedValueOnce(expectedResult);

      await request(app)
        .post('/v1/messages')
        .set('Authorization', authHeader)
        .send({
          model: 'claude-opus-4-20250514',
          max_tokens: 1024,
          messages: [{ role: 'user', content: 'Hello' }],
        });

      expect(mockRunClaude).toHaveBeenCalledOnce();
      const callArgs = mockRunClaude.mock.calls[0][0];
      expect(callArgs.model).toBe('claude-opus-4-20250514');
    });

    it('converts multi-turn conversations', async () => {
      const expectedResult: ClaudeRunResult = {
        result: 'I see the context',
        sessionId: undefined,
        rawOutput: '{"result":"I see the context"}',
      };
      mockRunClaude.mockResolvedValueOnce(expectedResult);

      await request(app)
        .post('/v1/messages')
        .set('Authorization', authHeader)
        .send({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          messages: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there!' },
            { role: 'user', content: 'How are you?' },
          ],
        });

      // Verify the prompt was converted correctly
      expect(mockRunClaude).toHaveBeenCalledOnce();
      const callArgs = mockRunClaude.mock.calls[0][0];
      expect(callArgs.prompt).toContain('User: Hello');
      expect(callArgs.prompt).toContain('Assistant: Hi there!');
      expect(callArgs.prompt).toContain('User: How are you?');
    });
  });
});
