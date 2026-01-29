import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { RunRequest, RunResponse } from '../types/index.js';
import { Errors } from '../lib/errors.js';
import type { WorkerPool } from '../lib/worker-pool.js';
import type { Logger } from '../config.js';

/**
 * Create API router with run endpoint
 */
export function createApiRouter(workerPool: WorkerPool, logger: Logger): Router {
  const router = Router();

  /**
   * POST /api/run
   * Execute a prompt with Claude Code via worker pool
   */
  router.post('/run', async (req: Request, res: Response) => {
    const requestId = uuidv4();
    const startTime = Date.now();

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

    logger.debug('Submitting to worker pool', {
      requestId,
      promptLength: body.prompt.length,
      allowedTools: body.allowedTools,
      workingDirectory: body.workingDirectory,
      queueSize: workerPool.size,
    });

    // Create abort controller for client disconnect handling
    const abortController = new AbortController();

    // Abort if client disconnects
    const onClose = () => {
      logger.info('Client disconnected, aborting request', { requestId });
      abortController.abort();
    };
    req.on('close', onClose);

    try {
      // Submit to worker pool
      const result = await workerPool.submit(
        {
          prompt: body.prompt,
          allowedTools: body.allowedTools,
          workingDirectory: body.workingDirectory,
          abortSignal: abortController.signal,
        },
        requestId
      );

      const durationMs = Date.now() - startTime;

      logger.info('Run request completed', {
        requestId,
        durationMs,
        resultLength: result.result.length,
      });

      const response: RunResponse = {
        id: requestId,
        result: result.result,
        sessionId: result.sessionId,
        durationMs,
      };

      res.json(response);
    } finally {
      // Clean up close listener
      req.off('close', onClose);
    }
  });

  return router;
}
