import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { RunRequest, RunResponse } from '../types/index.js';
import { Errors } from '../lib/errors.js';
import type { WorkerPool } from '../lib/worker-pool.js';
import type { SessionStore } from '../lib/session-store.js';
import type { Logger } from '../config.js';

/**
 * Extract API key from Authorization header
 */
function extractApiKey(req: Request): string {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw Errors.authRequired();
  }
  return authHeader.substring(7);
}

/**
 * Create API router with run endpoint
 */
export function createApiRouter(
  workerPool: WorkerPool,
  sessionStore: SessionStore,
  logger: Logger
): Router {
  const router = Router();

  /**
   * POST /api/run
   * Execute a prompt with Claude Code via worker pool
   */
  router.post('/run', async (req: Request, res: Response) => {
    const requestId = uuidv4();
    const startTime = Date.now();
    const apiKey = extractApiKey(req);

    logger.info('Received run request', { requestId });

    // Validate request body
    const body = req.body as RunRequest;

    if (!body || typeof body.prompt !== 'string') {
      throw Errors.invalidRequest('Request body must include a "prompt" string');
    }

    if (body.prompt.trim().length === 0) {
      throw Errors.invalidRequest('Prompt cannot be empty');
    }

    // Validate optional fields
    if (body.allowedTools !== undefined) {
      if (!Array.isArray(body.allowedTools)) {
        throw Errors.invalidRequest('allowedTools must be an array of strings');
      }
      if (!body.allowedTools.every((t) => typeof t === 'string')) {
        throw Errors.invalidRequest('allowedTools must contain only strings');
      }
    }

    if (body.workingDirectory !== undefined) {
      if (typeof body.workingDirectory !== 'string') {
        throw Errors.invalidRequest('workingDirectory must be a string');
      }
      // Basic security: prevent traversal attempts
      if (body.workingDirectory.includes('..')) {
        throw Errors.invalidRequest('workingDirectory cannot contain ".."');
      }
    }

    if (body.sessionId !== undefined && typeof body.sessionId !== 'string') {
      throw Errors.invalidRequest('sessionId must be a string');
    }

    // Look up existing session if provided
    let existingSession = null;
    let resumeSessionId: string | undefined;

    if (body.sessionId) {
      existingSession = sessionStore.getSession(body.sessionId, apiKey);
      if (!existingSession) {
        throw Errors.sessionNotFound(body.sessionId);
      }
      resumeSessionId = existingSession.claudeSessionId;

      // Acquire lock for this session (serializes concurrent requests)
      await sessionStore.acquireLock(body.sessionId);
    }

    logger.debug('Submitting to worker pool', {
      requestId,
      model: body.model,
      promptLength: body.prompt.length,
      allowedTools: body.allowedTools,
      workingDirectory: body.workingDirectory,
      sessionId: body.sessionId,
      queueSize: workerPool.size,
    });

    // Create abort controller for client disconnect handling
    const abortController = new AbortController();

    // Abort if client disconnects prematurely
    const onClose = () => {
      // Only abort if the response hasn't been sent yet
      if (!res.writableEnded) {
        logger.info('Client disconnected, aborting request', { requestId });
        abortController.abort();
      }
    };
    req.on('close', onClose);

    try {
      // Submit to worker pool
      const result = await workerPool.submit(
        {
          prompt: body.prompt,
          model: body.model,
          allowedTools: body.allowedTools,
          workingDirectory: body.workingDirectory,
          resumeSessionId,
          abortSignal: abortController.signal,
        },
        requestId
      );

      const durationMs = Date.now() - startTime;

      // Handle session creation/update
      let responseSessionId: string | undefined;

      if (existingSession) {
        // Update existing session
        sessionStore.touchSession(existingSession.id);
        responseSessionId = existingSession.id;
      } else if (result.sessionId) {
        // Create new session from Claude's response
        const newSession = sessionStore.createSession(result.sessionId, apiKey);
        responseSessionId = newSession.id;
      }

      logger.info('Run request completed', {
        requestId,
        durationMs,
        resultLength: result.result.length,
        sessionId: responseSessionId,
      });

      const response: RunResponse = {
        id: requestId,
        result: result.result,
        sessionId: responseSessionId,
        durationMs,
      };

      res.json(response);
    } finally {
      // Clean up close listener
      req.off('close', onClose);

      // Release session lock if we acquired one
      if (existingSession) {
        sessionStore.releaseLock(existingSession.id);
      }
    }
  });

  return router;
}
