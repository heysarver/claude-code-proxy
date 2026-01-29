import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { ChatCompletionRequest, ModelsResponse, OpenAIErrorResponse } from '../types/openai.js';
import {
  messagesToPrompt,
  createChatCompletionResponse,
  logUnsupportedParams,
  validateChatCompletionRequest,
  createStreamChunk,
  createStreamEnd,
  CLAUDE_MODELS,
} from '../lib/openai-transformer.js';
import type { StreamChunk } from '../types/index.js';
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

    // Validate request first (before streaming check)
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
      model: body.model,
      messageCount: body.messages.length,
      promptLength: prompt.length,
    });

    // Create abort controller for client disconnect handling
    const abortController = new AbortController();

    // Abort if client disconnects prematurely (before response is sent)
    const onClose = () => {
      if (!res.writableFinished) {
        logger.info('Client disconnected, aborting request', { requestId });
        abortController.abort();
      }
    };
    res.on('close', onClose);

    try {
      // Handle streaming
      if (body.stream === true) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        await workerPool.submit({
          prompt,
          model: body.model,
          stream: true,
          abortSignal: abortController.signal,
          onChunk: (chunk: StreamChunk) => {
            if (chunk.type === 'content_block_delta') {
              res.write(createStreamChunk(chunk.text));
            } else if (chunk.type === 'message_end') {
              res.write(createStreamChunk('', true));
              res.write(createStreamEnd());
              res.end();
            }
          },
        }, requestId);

        return;
      }

      // Non-streaming: submit to worker pool with model selection
      const result = await workerPool.submit(
        {
          prompt,
          model: body.model,
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
      // For streaming, send error event if headers already sent
      if (body.stream && res.headersSent) {
        res.write(`data: ${JSON.stringify({ error: { message: err instanceof Error ? err.message : 'Unknown error' } })}\n\n`);
        res.end();
        return;
      }

      // Convert errors to OpenAI format
      if (err instanceof ApiError) {
        res.status(err.statusCode).json(toOpenAIError(err));
        return;
      }
      throw err;
    } finally {
      res.off('close', onClose);
    }
  });

  return router;
}
