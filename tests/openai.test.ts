import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { Express, ErrorRequestHandler } from 'express';
import request from 'supertest';
import { createAuthMiddleware } from '../src/lib/auth.js';
import { createOpenAIRouter } from '../src/routes/openai.js';
import { WorkerPool } from '../src/lib/worker-pool.js';
import { SessionStore } from '../src/lib/session-store.js';
import { ApiError, Errors } from '../src/lib/errors.js';
import type { Config, Logger } from '../src/config.js';
import type { ClaudeRunResult } from '../src/types/index.js';
import {
  messagesToPrompt,
  createChatCompletionResponse,
  validateChatCompletionRequest,
  PROXY_MODEL_NAME,
  CLAUDE_MODELS,
} from '../src/lib/openai-transformer.js';
import type { ChatCompletionRequest } from '../src/types/openai.js';

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

// Create test app with OpenAI routes
function createTestApp(workerPool: WorkerPool, sessionStore: SessionStore): Express {
  const app = express();
  app.use(express.json());

  // OpenAI routes (with auth)
  const authMiddleware = createAuthMiddleware(mockConfig.proxyApiKey);
  app.use('/v1', authMiddleware, createOpenAIRouter(workerPool, sessionStore, mockLogger));

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

describe('OpenAI Transformer Utilities', () => {
  describe('messagesToPrompt', () => {
    it('returns empty string for empty array', () => {
      expect(messagesToPrompt([])).toBe('');
    });

    it('returns content directly for single user message', () => {
      const messages = [{ role: 'user' as const, content: 'Hello' }];
      expect(messagesToPrompt(messages)).toBe('Hello');
    });

    it('formats multiple messages with role prefixes', () => {
      const messages = [
        { role: 'system' as const, content: 'You are helpful' },
        { role: 'user' as const, content: 'Hello' },
        { role: 'assistant' as const, content: 'Hi there!' },
        { role: 'user' as const, content: 'How are you?' },
      ];

      const result = messagesToPrompt(messages);
      expect(result).toBe(
        'System: You are helpful\n\nUser: Hello\n\nAssistant: Hi there!\n\nUser: How are you?'
      );
    });

    it('capitalizes role labels', () => {
      const messages = [
        { role: 'user' as const, content: 'test' },
        { role: 'assistant' as const, content: 'response' },
      ];

      const result = messagesToPrompt(messages);
      expect(result).toContain('User:');
      expect(result).toContain('Assistant:');
    });
  });

  describe('createChatCompletionResponse', () => {
    it('creates valid OpenAI response format', () => {
      const response = createChatCompletionResponse('Hello!');

      expect(response.object).toBe('chat.completion');
      expect(response.model).toBe(PROXY_MODEL_NAME);
      expect(response.choices).toHaveLength(1);
      expect(response.choices[0].message.role).toBe('assistant');
      expect(response.choices[0].message.content).toBe('Hello!');
      expect(response.choices[0].finish_reason).toBe('stop');
      expect(response.choices[0].index).toBe(0);
    });

    it('includes session_id when provided', () => {
      const response = createChatCompletionResponse('Hello!', 'session-123');
      expect(response.session_id).toBe('session-123');
    });

    it('excludes session_id when not provided', () => {
      const response = createChatCompletionResponse('Hello!');
      expect(response.session_id).toBeUndefined();
    });

    it('generates unique IDs', () => {
      const response1 = createChatCompletionResponse('Hello!');
      const response2 = createChatCompletionResponse('Hello!');
      expect(response1.id).not.toBe(response2.id);
      expect(response1.id).toMatch(/^chatcmpl-/);
    });

    it('sets created timestamp', () => {
      const before = Math.floor(Date.now() / 1000);
      const response = createChatCompletionResponse('Hello!');
      const after = Math.floor(Date.now() / 1000);

      expect(response.created).toBeGreaterThanOrEqual(before);
      expect(response.created).toBeLessThanOrEqual(after);
    });

    it('includes usage with zeros (not available from CLI)', () => {
      const response = createChatCompletionResponse('Hello!');
      expect(response.usage).toEqual({
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      });
    });
  });

  describe('validateChatCompletionRequest', () => {
    it('returns null for valid request', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
      };
      expect(validateChatCompletionRequest(request)).toBeNull();
    });

    it('returns error for missing messages', () => {
      const request = { model: 'gpt-4' } as ChatCompletionRequest;
      expect(validateChatCompletionRequest(request)).toContain('messages');
    });

    it('returns error for empty messages array', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [],
      };
      expect(validateChatCompletionRequest(request)).toContain('empty');
    });

    it('returns error for invalid role', () => {
      const request = {
        model: 'gpt-4',
        messages: [{ role: 'invalid', content: 'Hello' }],
      } as unknown as ChatCompletionRequest;
      expect(validateChatCompletionRequest(request)).toContain('role');
    });

    it('returns error for non-string content', () => {
      const request = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 123 }],
      } as unknown as ChatCompletionRequest;
      expect(validateChatCompletionRequest(request)).toContain('content');
    });

    it('validates all messages in array', () => {
      const request = {
        model: 'gpt-4',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'invalid', content: 'World' },
        ],
      } as unknown as ChatCompletionRequest;
      expect(validateChatCompletionRequest(request)).toContain('messages[1]');
    });
  });
});

describe('OpenAI Routes', () => {
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

  describe('GET /v1/models', () => {
    it('returns all Claude models', async () => {
      const res = await request(app)
        .get('/v1/models')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.object).toBe('list');
      expect(res.body.data).toHaveLength(3);

      // Verify all models are present
      const modelIds = res.body.data.map((m: { id: string }) => m.id);
      expect(modelIds).toContain('opus');
      expect(modelIds).toContain('sonnet');
      expect(modelIds).toContain('haiku');

      // Verify model format
      for (const model of res.body.data) {
        expect(model.object).toBe('model');
        expect(model.owned_by).toBe('anthropic');
        expect(typeof model.created).toBe('number');
      }
    });

    it('returns models matching CLI aliases', async () => {
      const res = await request(app)
        .get('/v1/models')
        .set('Authorization', authHeader);

      // Model IDs should match the CLAUDE_MODELS constant
      const expectedIds = CLAUDE_MODELS.map(m => m.id);
      const actualIds = res.body.data.map((m: { id: string }) => m.id);
      expect(actualIds).toEqual(expectedIds);
    });

    it('requires authentication', async () => {
      const res = await request(app).get('/v1/models');

      expect(res.status).toBe(401);
    });
  });

  describe('POST /v1/chat/completions', () => {
    it('processes valid request', async () => {
      const expectedResult: ClaudeRunResult = {
        result: 'Hello! How can I help you?',
        sessionId: 'claude-session-456',
        rawOutput: '{"result":"Hello! How can I help you?"}',
      };
      mockRunClaude.mockResolvedValueOnce(expectedResult);

      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', authHeader)
        .send({
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'Hello' }],
        });

      expect(res.status).toBe(200);
      expect(res.body.object).toBe('chat.completion');
      expect(res.body.choices[0].message.content).toBe('Hello! How can I help you?');
      expect(res.body.choices[0].finish_reason).toBe('stop');
      expect(res.body.model).toBe(PROXY_MODEL_NAME);
    });

    it('creates session on first request', async () => {
      const expectedResult: ClaudeRunResult = {
        result: 'Response',
        sessionId: 'claude-session-789',
        rawOutput: '{"result":"Response"}',
      };
      mockRunClaude.mockResolvedValueOnce(expectedResult);

      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', authHeader)
        .send({
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'Hello' }],
        });

      expect(res.status).toBe(200);
      expect(res.body.session_id).toBeDefined();
    });

    it('converts multi-message conversations', async () => {
      const expectedResult: ClaudeRunResult = {
        result: 'I see the context',
        sessionId: undefined,
        rawOutput: '{"result":"I see the context"}',
      };
      mockRunClaude.mockResolvedValueOnce(expectedResult);

      await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', authHeader)
        .send({
          model: 'gpt-4',
          messages: [
            { role: 'system', content: 'You are helpful' },
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi!' },
            { role: 'user', content: 'How are you?' },
          ],
        });

      // Verify the prompt was converted correctly
      expect(mockRunClaude).toHaveBeenCalledOnce();
      const callArgs = mockRunClaude.mock.calls[0][0];
      expect(callArgs.prompt).toContain('System:');
      expect(callArgs.prompt).toContain('User:');
      expect(callArgs.prompt).toContain('Assistant:');
    });

    it('requires authentication', async () => {
      const res = await request(app)
        .post('/v1/chat/completions')
        .send({
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'Hello' }],
        });

      expect(res.status).toBe(401);
    });

    it('rejects streaming requests', async () => {
      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', authHeader)
        .send({
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('streaming_not_supported');
      expect(res.body.error.type).toBe('invalid_request_error');
    });

    it('validates messages array', async () => {
      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', authHeader)
        .send({
          model: 'gpt-4',
          messages: [],
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_request');
    });

    it('validates message roles', async () => {
      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', authHeader)
        .send({
          model: 'gpt-4',
          messages: [{ role: 'invalid', content: 'Hello' }],
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_request');
    });

    it('returns OpenAI-style error format', async () => {
      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', authHeader)
        .send({
          model: 'gpt-4',
          messages: [],
        });

      expect(res.body.error).toBeDefined();
      expect(res.body.error.message).toBeDefined();
      expect(res.body.error.type).toBe('invalid_request_error');
      expect(res.body.error.param).toBeNull();
      expect(res.body.error.code).toBeDefined();
    });

    it('logs unsupported parameters', async () => {
      const expectedResult: ClaudeRunResult = {
        result: 'Response',
        sessionId: undefined,
        rawOutput: '{"result":"Response"}',
      };
      mockRunClaude.mockResolvedValueOnce(expectedResult);

      await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', authHeader)
        .send({
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'Hello' }],
          temperature: 0.7,
          max_tokens: 100,
          presence_penalty: 0.5,
        });

      // Should have logged the unsupported params
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Ignoring unsupported OpenAI parameters',
        expect.objectContaining({
          params: expect.arrayContaining([
            'temperature=0.7',
            'max_tokens=100',
            'presence_penalty=0.5',
          ]),
        })
      );
    });

    it('passes model to Claude CLI', async () => {
      const expectedResult: ClaudeRunResult = {
        result: 'Response from Opus',
        sessionId: undefined,
        rawOutput: '{"result":"Response from Opus"}',
      };
      mockRunClaude.mockResolvedValueOnce(expectedResult);

      await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', authHeader)
        .send({
          model: 'opus',
          messages: [{ role: 'user', content: 'Hello' }],
        });

      // Verify the model was passed to runClaude
      expect(mockRunClaude).toHaveBeenCalledOnce();
      const callArgs = mockRunClaude.mock.calls[0][0];
      expect(callArgs.model).toBe('opus');
    });

    it('accepts any model string and passes it through', async () => {
      const expectedResult: ClaudeRunResult = {
        result: 'Response',
        sessionId: undefined,
        rawOutput: '{"result":"Response"}',
      };
      mockRunClaude.mockResolvedValueOnce(expectedResult);

      // User can specify full model name or alias
      await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', authHeader)
        .send({
          model: 'claude-sonnet-4-20250514',
          messages: [{ role: 'user', content: 'Hello' }],
        });

      const callArgs = mockRunClaude.mock.calls[0][0];
      expect(callArgs.model).toBe('claude-sonnet-4-20250514');
    });
  });
});
