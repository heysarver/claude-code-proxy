import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { WorkerPool } from '../lib/worker-pool.js';
import type { SessionStore } from '../lib/session-store.js';
import { ApiError, Errors } from '../lib/errors.js';
import type { Logger } from '../config.js';
import type { StreamChunk } from '../types/index.js';

// ─── Types (inlined, not separate file) ───────────────────────────

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;  // Only support string content (not ContentBlock[])
}

interface MessagesRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  system?: string;
  stream?: boolean;
  // Ignored but logged: temperature, top_p, top_k, stop_sequences
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
}

interface MessagesResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<{ type: 'text'; text: string }>;
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | null;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

// ─── Helpers ──────────────────────────────────────────────────────

function messagesToPrompt(request: MessagesRequest): string {
  const parts: string[] = [];

  if (request.system) {
    parts.push(`System: ${request.system}`);
  }

  for (const msg of request.messages) {
    const label = msg.role === 'user' ? 'User' : 'Assistant';
    parts.push(`${label}: ${msg.content}`);
  }

  return parts.join('\n\n');
}

function createResponse(content: string, model: string): MessagesResponse {
  return {
    id: `msg_${uuidv4()}`,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: content }],
    model,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },  // Not available from CLI
  };
}

function validateRequest(req: MessagesRequest): string | null {
  if (!req.messages?.length) return 'messages is required and cannot be empty';
  if (!req.max_tokens) return 'max_tokens is required';
  for (let i = 0; i < req.messages.length; i++) {
    const msg = req.messages[i];
    if (!['user', 'assistant'].includes(msg.role)) {
      return `messages[${i}].role must be user or assistant`;
    }
    if (typeof msg.content !== 'string') {
      return `messages[${i}].content must be a string`;
    }
  }
  return null;
}

function toAnthropicError(error: ApiError) {
  return {
    type: 'error',
    error: {
      type: error.code === 'invalid_request' ? 'invalid_request_error' : 'api_error',
      message: error.message,
    },
  };
}

function extractApiKey(req: Request): string {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw Errors.authRequired();
  }
  return authHeader.substring(7);
}

// ─── Router ───────────────────────────────────────────────────────

export function createAnthropicRouter(
  workerPool: WorkerPool,
  sessionStore: SessionStore,
  logger: Logger
): Router {
  const router = Router();

  /**
   * POST /v1/messages
   * Create a message (Anthropic Messages API compatible)
   */
  router.post('/messages', async (req: Request, res: Response, next: NextFunction) => {
    const requestId = uuidv4();
    const startTime = Date.now();
    const body = req.body as MessagesRequest;

    logger.info('Received Anthropic messages request', { requestId });

    // Validate request
    const validationError = validateRequest(body);
    if (validationError) {
      const error = Errors.invalidRequest(validationError);
      res.status(error.statusCode).json(toAnthropicError(error));
      return;
    }

    // Log unsupported params
    const unsupported = ['temperature', 'top_p', 'top_k', 'stop_sequences']
      .filter(p => body[p as keyof MessagesRequest] !== undefined);
    if (unsupported.length) {
      logger.debug('Ignoring unsupported Anthropic params', { params: unsupported });
    }

    const apiKey = extractApiKey(req);
    const prompt = messagesToPrompt(body);

    logger.debug('Converted messages to prompt', {
      requestId,
      model: body.model,
      messageCount: body.messages.length,
      promptLength: prompt.length,
      hasSystem: !!body.system,
    });

    // Create abort controller for client disconnect handling
    const abortController = new AbortController();
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

        // Send message_start event
        res.write(`event: message_start\ndata: ${JSON.stringify({
          type: 'message_start',
          message: {
            id: `msg_${uuidv4()}`,
            type: 'message',
            role: 'assistant',
            content: [],
            model: body.model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          }
        })}\n\n`);

        // Send content_block_start event
        res.write(`event: content_block_start\ndata: ${JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' }
        })}\n\n`);

        await workerPool.submit({
          prompt,
          model: body.model,
          stream: true,
          abortSignal: abortController.signal,
          onChunk: (chunk: StreamChunk) => {
            if (chunk.type === 'content_block_delta') {
              res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: chunk.text }
              })}\n\n`);
            } else if (chunk.type === 'message_end') {
              // Send content_block_stop
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                type: 'content_block_stop',
                index: 0
              })}\n\n`);

              // Send message_delta with stop_reason
              res.write(`event: message_delta\ndata: ${JSON.stringify({
                type: 'message_delta',
                delta: { stop_reason: chunk.stopReason, stop_sequence: null },
                usage: { output_tokens: 0 }
              })}\n\n`);

              // Send message_stop
              res.write(`event: message_stop\ndata: ${JSON.stringify({
                type: 'message_stop'
              })}\n\n`);

              res.end();
            }
          },
        }, requestId);

        return;
      }

      // Non-streaming request
      const result = await workerPool.submit({
        prompt,
        model: body.model,
        abortSignal: abortController.signal,
      }, requestId);

      const durationMs = Date.now() - startTime;

      // Create session if Claude returned one
      let responseSessionId: string | undefined;
      if (result.sessionId) {
        const session = sessionStore.createSession(result.sessionId, apiKey);
        responseSessionId = session.id;
      }

      logger.info('Anthropic messages request completed', {
        requestId,
        durationMs,
        resultLength: result.result.length,
        sessionId: responseSessionId,
      });

      const response = createResponse(result.result, body.model);
      res.json(response);
    } catch (err) {
      // For streaming, send error event if headers already sent
      if (body.stream && res.headersSent) {
        res.write(`event: error\ndata: ${JSON.stringify({
          type: 'error',
          error: { message: err instanceof Error ? err.message : 'Unknown error' }
        })}\n\n`);
        res.end();
        return;
      }

      // Convert errors to Anthropic format
      if (err instanceof ApiError) {
        res.status(err.statusCode).json(toAnthropicError(err));
        return;
      }
      next(err);
    } finally {
      res.off('close', onClose);
    }
  });

  return router;
}
