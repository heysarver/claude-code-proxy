/**
 * Request body for POST /api/run
 */
export interface RunRequest {
  /** The prompt to send to Claude Code */
  prompt: string;
  /** Optional model to use (e.g., 'opus', 'sonnet', 'haiku') */
  model?: string;
  /** Optional list of tools to allow (passed to --allowedTools) */
  allowedTools?: string[];
  /** Optional working directory for Claude Code execution */
  workingDirectory?: string;
  /** Optional session ID to resume an existing conversation (Phase 3) */
  sessionId?: string;
  /** Optional maximum agentic turns to prevent runaway loops */
  maxTurns?: number;
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
  /** Queue statistics (Phase 2) */
  queue?: {
    /** Requests waiting in queue */
    pending: number;
    /** Requests currently being processed */
    processing: number;
    /** Maximum concurrent workers */
    concurrency: number;
  };
  /** Session statistics (Phase 3) */
  sessions?: {
    /** Total active sessions */
    total: number;
    /** Sessions currently being processed */
    locked: number;
  };
}

/**
 * Worker pool statistics (Phase 2)
 */
export interface WorkerPoolStats {
  /** Requests waiting in queue */
  pending: number;
  /** Requests currently being processed */
  processing: number;
  /** Maximum concurrent workers */
  concurrency: number;
  /** Maximum queue size */
  maxQueueSize: number;
  /** Whether the pool is paused */
  isPaused: boolean;
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
 * Streaming chunk types (discriminated union for type safety)
 */
export type StreamChunk =
  | { type: 'content_block_delta'; text: string }
  | { type: 'message_end'; stopReason: string };

/**
 * Options for running Claude CLI
 */
export interface ClaudeRunOptions {
  /** The prompt to send */
  prompt: string;
  /** Model to use (e.g., 'opus', 'sonnet', 'haiku') */
  model?: string;
  /** Tools to allow */
  allowedTools?: string[];
  /** Working directory */
  workingDirectory?: string;
  /** Timeout in milliseconds */
  timeoutMs?: number;
  /** Session ID to resume (Phase 3) */
  resumeSessionId?: string;
  /** Abort signal for cancellation (Phase 2) */
  abortSignal?: AbortSignal;
  /** Enable streaming output (Phase 5) */
  stream?: boolean;
  /** Callback for streaming chunks (Phase 5) */
  onChunk?: (chunk: StreamChunk) => void;
  /** Maximum agentic turns. Prevents runaway loops. */
  maxTurns?: number;
}

/**
 * Session storage record (Phase 3)
 */
export interface Session {
  /** External session ID (UUID) */
  id: string;
  /** Claude's internal session ID for --resume */
  claudeSessionId: string;
  /** Hashed API key that owns this session */
  apiKeyHash: string;
  /** When the session was created */
  createdAt: Date;
  /** When the session was last accessed */
  lastAccessedAt: Date;
  /** Whether the session is currently being processed */
  locked: boolean;
}

/**
 * Public session info returned to API clients (Phase 3)
 */
export interface SessionInfo {
  /** External session ID */
  id: string;
  /** When the session was created */
  createdAt: string;
  /** When the session was last accessed */
  lastAccessedAt: string;
}

/**
 * Task status (Phase 6 - Background Tasks)
 */
export type TaskStatus = 'running' | 'completed' | 'failed';

/**
 * Background task record
 */
export interface Task {
  /** External task ID (UUID) */
  id: string;
  /** Current task status */
  status: TaskStatus;
  /** Hashed API key that owns this task */
  apiKeyHash: string;
  /** The prompt sent to Claude */
  prompt: string;
  /** Model to use */
  model?: string;
  /** Allowed tools */
  allowedTools?: string[];
  /** Working directory for execution */
  workingDirectory?: string;
  /** Session ID for --resume */
  sessionId?: string;
  /** Maximum agentic turns */
  maxTurns?: number;
  /** Claude's response (completed only) */
  result?: string;
  /** Failure reason: cancelled, timeout, error:..., server_restart */
  failureReason?: string;
  /** Claude's session ID returned after execution */
  claudeSessionId?: string;
  /** When the task was created */
  createdAt: Date;
  /** When execution started */
  startedAt?: Date;
  /** When task completed/failed */
  completedAt?: Date;
  /** Execution duration in milliseconds */
  durationMs?: number;
}

/**
 * Request body for POST /api/tasks
 */
export interface TaskCreateRequest {
  /** The prompt to send to Claude */
  prompt: string;
  /** Optional model to use */
  model?: string;
  /** Optional list of tools to allow */
  allowedTools?: string[];
  /** Optional working directory */
  workingDirectory?: string;
  /** Optional session ID to resume */
  sessionId?: string;
  /** Optional maximum agentic turns */
  maxTurns?: number;
}
