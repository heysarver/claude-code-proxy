/**
 * Request body for POST /api/run
 */
export interface RunRequest {
  /** The prompt to send to Claude Code */
  prompt: string;
  /** Optional list of tools to allow (passed to --allowedTools) */
  allowedTools?: string[];
  /** Optional working directory for Claude Code execution */
  workingDirectory?: string;
}

/**
 * Successful response from POST /api/run
 */
export interface RunResponse {
  /** Unique request identifier */
  id: string;
  /** Claude's text response */
  result: string;
  /** Claude's session ID for conversation continuation (Phase 3) */
  sessionId?: string;
  /** Processing time in milliseconds */
  durationMs: number;
}

/**
 * Error response structure
 */
export interface ErrorResponse {
  error: {
    /** Error code for programmatic handling */
    code: string;
    /** Human-readable error message */
    message: string;
    /** Additional error details */
    details?: unknown;
  };
}

/**
 * Health check response
 */
export interface HealthResponse {
  /** Server status */
  status: 'ok' | 'degraded';
  /** Server uptime in seconds */
  uptime: number;
}

/**
 * Result from Claude CLI execution
 */
export interface ClaudeRunResult {
  /** The text response from Claude */
  result: string;
  /** Claude's session ID for resumption */
  sessionId?: string;
  /** Raw JSON output from Claude CLI */
  rawOutput: string;
}

/**
 * Options for running Claude CLI
 */
export interface ClaudeRunOptions {
  /** The prompt to send */
  prompt: string;
  /** Tools to allow */
  allowedTools?: string[];
  /** Working directory */
  workingDirectory?: string;
  /** Timeout in milliseconds */
  timeoutMs?: number;
  /** Session ID to resume (Phase 3) */
  resumeSessionId?: string;
}
