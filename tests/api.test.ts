import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express, { Express, ErrorRequestHandler } from 'express';
import request from 'supertest';
import { createAuthMiddleware } from '../src/lib/auth.js';
import { createApiRouter } from '../src/routes/api.js';
import healthRouter from '../src/routes/health.js';
import { ApiError, Errors } from '../src/lib/errors.js';
import type { Config, Logger } from '../src/config.js';

// Mock config
const mockConfig: Config = {
  port: 3000,
  proxyApiKey: 'test-api-key',
  requestTimeoutMs: 5000,
  logLevel: 'error',
};

// Mock logger
const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

// Create test app
function createTestApp(): Express {
  const app = express();
  app.use(express.json());

  // Health (no auth)
  app.use(healthRouter);

  // API routes (with auth)
  const authMiddleware = createAuthMiddleware(mockConfig.proxyApiKey);
  app.use('/api', authMiddleware, createApiRouter(mockConfig, mockLogger));

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
  const app = createTestApp();

  it('returns status ok', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.uptime).toBe('number');
  });
});

describe('Authentication', () => {
  const app = createTestApp();

  it('rejects requests without auth header', async () => {
    const res = await request(app).post('/api/run').send({ prompt: 'test' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('auth_error');
    expect(res.body.error.message).toContain('required');
  });

  it('rejects requests with invalid auth format', async () => {
    const res = await request(app)
      .post('/api/run')
      .set('Authorization', 'InvalidFormat')
      .send({ prompt: 'test' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('auth_error');
  });

  it('rejects requests with wrong API key', async () => {
    const res = await request(app)
      .post('/api/run')
      .set('Authorization', 'Bearer wrong-key')
      .send({ prompt: 'test' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('auth_error');
  });
});

describe('Request Validation', () => {
  const app = createTestApp();
  const authHeader = `Bearer ${mockConfig.proxyApiKey}`;

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
});
