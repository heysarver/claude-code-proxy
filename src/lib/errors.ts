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
};
