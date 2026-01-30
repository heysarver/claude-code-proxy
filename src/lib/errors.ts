/**
 * Error codes used throughout the application
 */
export const ErrorCodes = {
  /** Authentication failed */
  AUTH_ERROR: 'auth_error',
  /** Request timed out */
  TIMEOUT: 'timeout',
  /** Claude CLI returned an error */
  CLI_ERROR: 'cli_error',
  /** Claude CLI not found */
  CLI_NOT_FOUND: 'cli_not_found',
  /** Rate limit exceeded */
  RATE_LIMIT: 'rate_limit',
  /** Upstream (Claude) authentication error */
  UPSTREAM_AUTH_ERROR: 'upstream_auth_error',
  /** Invalid request */
  INVALID_REQUEST: 'invalid_request',
  /** Internal server error */
  INTERNAL_ERROR: 'internal_error',
  /** Queue is full (Phase 2) */
  QUEUE_FULL: 'queue_full',
  /** Request waited too long in queue (Phase 2) */
  QUEUE_TIMEOUT: 'queue_timeout',
  /** Session not found (Phase 3) */
  SESSION_NOT_FOUND: 'session_not_found',
  /** Session limit reached for API key (Phase 3) */
  SESSION_LIMIT_REACHED: 'session_limit_reached',
  /** Streaming not supported (Phase 4) */
  STREAMING_NOT_SUPPORTED: 'streaming_not_supported',
  /** Claude CLI ran out of memory */
  MEMORY_ERROR: 'memory_error',
  /** Task not found (Phase 6) */
  TASK_NOT_FOUND: 'task_not_found',
  /** Invalid model specified */
  INVALID_MODEL: 'invalid_model',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/**
 * Custom API error class with HTTP status code and error code
 */
export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode;
  public readonly details?: unknown;

  constructor(statusCode: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;

    // Maintains proper stack trace for where error was thrown
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Convert to JSON response format
   */
  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined && { details: this.details }),
      },
    };
  }
}

/**
 * Factory functions for common errors
 */
export const Errors = {
  authRequired: () =>
    new ApiError(401, ErrorCodes.AUTH_ERROR, 'Authorization header is required'),

  authInvalid: () =>
    new ApiError(401, ErrorCodes.AUTH_ERROR, 'Invalid API key'),

  timeout: (timeoutMs: number) =>
    new ApiError(504, ErrorCodes.TIMEOUT, `Request timed out after ${timeoutMs}ms`),

  cliNotFound: () =>
    new ApiError(500, ErrorCodes.CLI_NOT_FOUND, 'Claude CLI not found. Ensure claude is installed and in PATH.'),

  cliError: (message: string, details?: unknown) =>
    new ApiError(500, ErrorCodes.CLI_ERROR, message, details),

  rateLimit: () =>
    new ApiError(429, ErrorCodes.RATE_LIMIT, 'Rate limit exceeded. Please try again later.'),

  upstreamAuthError: () =>
    new ApiError(401, ErrorCodes.UPSTREAM_AUTH_ERROR, 'Claude authentication failed. Run "claude login" to authenticate.'),

  invalidRequest: (message: string) =>
    new ApiError(400, ErrorCodes.INVALID_REQUEST, message),

  internalError: (message: string = 'An unexpected error occurred') =>
    new ApiError(500, ErrorCodes.INTERNAL_ERROR, message),

  queueFull: (maxSize: number) =>
    new ApiError(429, ErrorCodes.QUEUE_FULL, `Server is at capacity. Maximum queue size (${maxSize}) reached.`),

  queueTimeout: (timeoutMs: number) =>
    new ApiError(504, ErrorCodes.QUEUE_TIMEOUT, `Request waited too long in queue (${timeoutMs}ms)`),

  sessionNotFound: (sessionId: string) =>
    new ApiError(404, ErrorCodes.SESSION_NOT_FOUND, `Session not found: ${sessionId}`),

  sessionLimitReached: (limit: number) =>
    new ApiError(429, ErrorCodes.SESSION_LIMIT_REACHED, `Maximum sessions per API key (${limit}) reached. Delete an existing session first.`),

  streamingNotSupported: () =>
    new ApiError(400, ErrorCodes.STREAMING_NOT_SUPPORTED, 'Streaming is not yet supported. Set stream: false or omit the stream parameter.'),

  memoryError: (details?: Record<string, unknown>) =>
    new ApiError(500, ErrorCodes.MEMORY_ERROR, 'Claude CLI ran out of memory', details),

  taskNotFound: (taskId: string) =>
    new ApiError(404, ErrorCodes.TASK_NOT_FOUND, `Task not found: ${taskId}`),

  invalidModel: (model: string) =>
    new ApiError(400, ErrorCodes.INVALID_MODEL, `Invalid model: ${model}. Must be one of: opus, sonnet, haiku`),
};

/**
 * Check if an error should trigger a retry
 * Only transient errors (timeout, rate limit) are retryable
 * Auth errors, invalid requests, etc. should fail immediately
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof ApiError) {
    // Only retry transient errors
    return error.code === ErrorCodes.TIMEOUT || error.code === ErrorCodes.RATE_LIMIT;
  }
  // Network errors are retryable
  if (error instanceof Error && error.message.includes('ECONNRESET')) {
    return true;
  }
  return false;
}
