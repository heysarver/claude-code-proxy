/**
 * OpenAI-compatible type definitions for /v1/chat/completions
 */

/**
 * Message in a chat conversation
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * OpenAI ChatCompletion request format
 */
export interface ChatCompletionRequest {
  /** Model to use (accepted but mapped to Claude) */
  model: string;
  /** Array of messages in the conversation */
  messages: ChatMessage[];
  /** Whether to stream the response (not yet supported) */
  stream?: boolean;
  /** Sampling temperature (logged, ignored) */
  temperature?: number;
  /** Maximum tokens to generate (logged, ignored) */
  max_tokens?: number;
  /** Number of completions to generate (logged, ignored) */
  n?: number;
  /** Stop sequences (logged, ignored) */
  stop?: string | string[];
  /** Presence penalty (logged, ignored) */
  presence_penalty?: number;
  /** Frequency penalty (logged, ignored) */
  frequency_penalty?: number;
  /** Logit bias (logged, ignored) */
  logit_bias?: Record<string, number>;
  /** User identifier (logged, ignored) */
  user?: string;
}

/**
 * Single choice in a ChatCompletion response
 */
export interface ChatCompletionChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string;
  };
  finish_reason: 'stop' | 'length' | 'content_filter' | null;
}

/**
 * Token usage statistics
 */
export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/**
 * OpenAI ChatCompletion response format
 */
export interface ChatCompletionResponse {
  /** Unique identifier for this completion */
  id: string;
  /** Object type */
  object: 'chat.completion';
  /** Unix timestamp of creation */
  created: number;
  /** Model used */
  model: string;
  /** Array of completion choices */
  choices: ChatCompletionChoice[];
  /** Token usage (not available from CLI, returns zeros) */
  usage: ChatCompletionUsage;
  /** Session ID for conversation continuation */
  session_id?: string;
}

/**
 * Model information for /v1/models endpoint
 */
export interface ModelInfo {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

/**
 * Response from /v1/models endpoint
 */
export interface ModelsResponse {
  object: 'list';
  data: ModelInfo[];
}

/**
 * OpenAI-style error response
 */
export interface OpenAIErrorResponse {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}
