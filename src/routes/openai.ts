import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { ChatCompletionRequest, ModelsResponse, OpenAIErrorResponse } from '../types/openai.js';
import {
  messagesToPrompt,
  createChatCompletionResponse,
  logUnsupportedParams,
  validateChatCompletionRequest,
  CLAUDE_MODELS,
} from '../lib/openai-transformer.js';
import { ApiError, Errors } from '../lib/errors.js';
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
 * Convert ApiError to OpenAI-style error response
 */
function toOpenAIError(error: ApiError): OpenAIErrorResponse {
  return {
    error: {
      message: error.message,
      type: 'invalid_request_error',
      param: null,
      code: error.code,
    },
  };
}

/**
 * Create OpenAI-compatible routes
 */
export function createOpenAIRouter(
  workerPool: WorkerPool,
  sessionStore: SessionStore,
  logger: Logger
): Router {
  const router = Router();

  /**
   * GET /v1/models
   * List available Claude models (matches CLI aliases)
   */
  router.get('/models', (_req: Request, res: Response) => {
    const response: ModelsResponse = {
      object: 'list',
      data: CLAUDE_MODELS.map((model) => ({
        id: model.id,
        object: 'model' as const,
        created: Math.floor(Date.now() / 1000),
        owned_by: 'anthropic',
      })),
    };

    res.json(response);
  });

  /**
   * POST /v1/chat/completions
   * Create a chat completion (OpenAI-compatible)
   */
  router.post('/chat/completions', async (req: Request, res: Response) => {
    const requestId = uuidv4();
    const startTime = Date.now();
    const apiKey = extractApiKey(req);

    logger.info('Received OpenAI chat completion request', { requestId });

    const body = req.body as ChatCompletionRequest;

    // Check for streaming (not yet supported)
    if (body.stream === true) {
      const error = Errors.streamingNotSupported();
      res.status(error.statusCode).json(toOpenAIError(error));
      return;
    }

    // Validate request
    const validationError = validateChatCompletionRequest(body);
    if (validationError) {
      const error = Errors.invalidRequest(validationError);
      res.status(error.statusCode).json(toOpenAIError(error));
      return;
    }

    // Log unsupported parameters
    logUnsupportedParams(body, logger);

    // Convert messages to a single prompt
    const prompt = messagesToPrompt(body.messages);

    logger.debug('Converted messages to prompt', {
      requestId,
      messageCount: body.messages.length,
      promptLength: prompt.length,
    });

    // Create abort controller for client disconnect handling
    const abortController = new AbortController();

    const onClose = () => {
      logger.info('Client disconnected, aborting request', { requestId });
      abortController.abort();
    };
    req.on('close', onClose);

    try {
      // Submit to worker pool
      const result = await workerPool.submit(
        {
          prompt,
          abortSignal: abortController.signal,
        },
        requestId
      );

      const durationMs = Date.now() - startTime;

      // Create session if Claude returned one
      let responseSessionId: string | undefined;
      if (result.sessionId) {
        const session = sessionStore.createSession(result.sessionId, apiKey);
        responseSessionId = session.id;
      }

      logger.info('OpenAI chat completion request completed', {
        requestId,
        durationMs,
        resultLength: result.result.length,
        sessionId: responseSessionId,
      });

      // Format as OpenAI response
      const response = createChatCompletionResponse(result.result, responseSessionId);
      res.json(response);
    } catch (err) {
      // Convert errors to OpenAI format
      if (err instanceof ApiError) {
        res.status(err.statusCode).json(toOpenAIError(err));
        return;
      }
      throw err;
    } finally {
      req.off('close', onClose);
    }
  });

  return router;
}
