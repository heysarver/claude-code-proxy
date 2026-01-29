import { v4 as uuidv4 } from 'uuid';
import type {
  ChatMessage,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChoice,
} from '../types/openai.js';
import type { Logger } from '../config.js';

/**
 * Model name returned in responses
 */
export const PROXY_MODEL_NAME = 'claude-code-proxy';

/**
 * Convert an array of chat messages to a single Claude prompt
 *
 * Strategy: Concatenate messages with role prefixes
 * - System messages are prefixed with "System: "
 * - User messages are prefixed with "User: "
 * - Assistant messages are prefixed with "Assistant: "
 */
export function messagesToPrompt(messages: ChatMessage[]): string {
  if (messages.length === 0) {
    return '';
  }

  // If there's only one user message, return it directly
  if (messages.length === 1 && messages[0].role === 'user') {
    return messages[0].content;
  }

  // For multi-message conversations, format with role prefixes
  const parts: string[] = [];

  for (const message of messages) {
    const roleLabel = message.role.charAt(0).toUpperCase() + message.role.slice(1);
    parts.push(`${roleLabel}: ${message.content}`);
  }

  return parts.join('\n\n');
}

/**
 * Create an OpenAI-compatible ChatCompletion response
 */
export function createChatCompletionResponse(
  content: string,
  sessionId?: string
): ChatCompletionResponse {
  const choice: ChatCompletionChoice = {
    index: 0,
    message: {
      role: 'assistant',
      content,
    },
    finish_reason: 'stop',
  };

  return {
    id: `chatcmpl-${uuidv4()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: PROXY_MODEL_NAME,
    choices: [choice],
    usage: {
      prompt_tokens: 0, // Not available from CLI
      completion_tokens: 0,
      total_tokens: 0,
    },
    ...(sessionId && { session_id: sessionId }),
  };
}

/**
 * Log unsupported parameters that were provided in the request
 */
export function logUnsupportedParams(
  request: ChatCompletionRequest,
  logger: Logger
): void {
  const unsupported: string[] = [];

  if (request.temperature !== undefined) unsupported.push(`temperature=${request.temperature}`);
  if (request.max_tokens !== undefined) unsupported.push(`max_tokens=${request.max_tokens}`);
  if (request.n !== undefined) unsupported.push(`n=${request.n}`);
  if (request.stop !== undefined) unsupported.push('stop');
  if (request.presence_penalty !== undefined) unsupported.push(`presence_penalty=${request.presence_penalty}`);
  if (request.frequency_penalty !== undefined) unsupported.push(`frequency_penalty=${request.frequency_penalty}`);
  if (request.logit_bias !== undefined) unsupported.push('logit_bias');
  if (request.user !== undefined) unsupported.push(`user=${request.user}`);

  if (unsupported.length > 0) {
    logger.debug('Ignoring unsupported OpenAI parameters', {
      params: unsupported,
    });
  }
}

/**
 * Validate a ChatCompletionRequest
 * Returns an error message if invalid, null if valid
 */
export function validateChatCompletionRequest(
  request: ChatCompletionRequest
): string | null {
  if (!request.messages || !Array.isArray(request.messages)) {
    return 'messages is required and must be an array';
  }

  if (request.messages.length === 0) {
    return 'messages array cannot be empty';
  }

  for (let i = 0; i < request.messages.length; i++) {
    const message = request.messages[i];

    if (!message.role || !['system', 'user', 'assistant'].includes(message.role)) {
      return `messages[${i}].role must be one of: system, user, assistant`;
    }

    if (typeof message.content !== 'string') {
      return `messages[${i}].content must be a string`;
    }
  }

  return null;
}
