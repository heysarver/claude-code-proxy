import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { Task, TaskCreateRequest, TaskStatus } from '../types/index.js';
import type { Logger } from '../config.js';

// Hard-coded configuration (per plan simplification)
const TASK_TTL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute

// Database row type
interface TaskRow {
  id: string;
  status: string;
  api_key_hash: string;
  prompt: string;
  model: string | null;
  allowed_tools: string | null;
  working_directory: string | null;
  session_id: string | null;
  max_turns: number | null;
  result: string | null;
  failure_reason: string | null;
  claude_session_id: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
}

/**
 * SQLite-backed task store for background task execution
 */
export class TaskStore {
  private db: Database.Database;
  private logger: Logger;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private runningTasks = new Map<string, AbortController>();

  // Prepared statements
  private stmtInsert: Database.Statement;
  private stmtGetById: Database.Statement;
  private stmtGetByIdAndApiKey: Database.Statement;
  private stmtSetCompleted: Database.Statement;
  private stmtSetFailed: Database.Statement;
  private stmtCleanupExpired: Database.Statement;
  private stmtMarkOrphaned: Database.Statement;

  constructor(db: Database.Database, logger: Logger) {
    this.db = db;
    this.logger = logger;

    // Prepare statements once for performance
    this.stmtInsert = this.db.prepare(`
      INSERT INTO tasks (id, status, api_key_hash, prompt, model, allowed_tools,
        working_directory, session_id, max_turns, created_at, started_at)
      VALUES (?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtGetById = this.db.prepare(`
      SELECT * FROM tasks WHERE id = ?
    `);

    this.stmtGetByIdAndApiKey = this.db.prepare(`
      SELECT * FROM tasks WHERE id = ? AND api_key_hash = ?
    `);

    this.stmtSetCompleted = this.db.prepare(`
      UPDATE tasks SET status = 'completed', result = ?, claude_session_id = ?,
        completed_at = ?, duration_ms = ? WHERE id = ?
    `);

    this.stmtSetFailed = this.db.prepare(`
      UPDATE tasks SET status = 'failed', failure_reason = ?,
        completed_at = ?, duration_ms = ? WHERE id = ?
    `);

    this.stmtCleanupExpired = this.db.prepare(`
      DELETE FROM tasks WHERE status IN ('completed', 'failed') AND completed_at < ?
    `);

    this.stmtMarkOrphaned = this.db.prepare(`
      UPDATE tasks SET status = 'failed', failure_reason = 'server_restart',
        completed_at = ? WHERE status = 'running'
    `);
  }

  /**
   * Hash an API key for storage
   */
  private hashApiKey(apiKey: string): string {
    return createHash('sha256').update(apiKey).digest('hex');
  }

  /**
   * Convert database row to Task object
   */
  private rowToTask(row: TaskRow): Task {
    return {
      id: row.id,
      status: row.status as TaskStatus,
      apiKeyHash: row.api_key_hash,
      prompt: row.prompt,
      model: row.model ?? undefined,
      allowedTools: row.allowed_tools ? JSON.parse(row.allowed_tools) : undefined,
      workingDirectory: row.working_directory ?? undefined,
      sessionId: row.session_id ?? undefined,
      maxTurns: row.max_turns ?? undefined,
      result: row.result ?? undefined,
      failureReason: row.failure_reason ?? undefined,
      claudeSessionId: row.claude_session_id ?? undefined,
      createdAt: new Date(row.created_at),
      startedAt: row.started_at ? new Date(row.started_at) : undefined,
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
      durationMs: row.duration_ms ?? undefined,
    };
  }

  /**
   * Create a new task and register its abort controller
   */
  createTask(request: TaskCreateRequest, apiKey: string): Task {
    const id = uuidv4();
    const apiKeyHash = this.hashApiKey(apiKey);
    const now = new Date();
    const abortController = new AbortController();

    this.stmtInsert.run(
      id,
      apiKeyHash,
      request.prompt,
      request.model ?? null,
      request.allowedTools ? JSON.stringify(request.allowedTools) : null,
      request.workingDirectory ?? null,
      request.sessionId ?? null,
      request.maxTurns ?? null,
      now.toISOString(),
      now.toISOString()
    );

    this.runningTasks.set(id, abortController);

    this.logger.debug('Task created', { taskId: id });

    return {
      id,
      status: 'running',
      apiKeyHash,
      prompt: request.prompt,
      model: request.model,
      allowedTools: request.allowedTools,
      workingDirectory: request.workingDirectory,
      sessionId: request.sessionId,
      maxTurns: request.maxTurns,
      createdAt: now,
      startedAt: now,
    };
  }

  /**
   * Get a task by ID, validating ownership
   */
  getTask(taskId: string, apiKey: string): Task | null {
    const apiKeyHash = this.hashApiKey(apiKey);
    const row = this.stmtGetByIdAndApiKey.get(taskId, apiKeyHash) as TaskRow | undefined;
    if (!row) return null;
    return this.rowToTask(row);
  }

  /**
   * Get the abort controller for a running task
   */
  getAbortController(taskId: string): AbortController | undefined {
    return this.runningTasks.get(taskId);
  }

  /**
   * Mark a task as completed
   */
  setCompleted(taskId: string, result: string, claudeSessionId?: string): void {
    const now = new Date();
    const row = this.stmtGetById.get(taskId) as TaskRow | undefined;
    const durationMs = row?.started_at
      ? now.getTime() - new Date(row.started_at).getTime()
      : null;

    this.stmtSetCompleted.run(
      result,
      claudeSessionId ?? null,
      now.toISOString(),
      durationMs,
      taskId
    );

    this.runningTasks.delete(taskId);
    this.logger.info('Task completed', { taskId, durationMs });
  }

  /**
   * Mark a task as failed
   */
  setFailed(taskId: string, reason: string): void {
    const now = new Date();
    const row = this.stmtGetById.get(taskId) as TaskRow | undefined;
    const durationMs = row?.started_at
      ? now.getTime() - new Date(row.started_at).getTime()
      : null;

    this.stmtSetFailed.run(reason, now.toISOString(), durationMs, taskId);

    this.runningTasks.delete(taskId);
    this.logger.info('Task failed', { taskId, reason, durationMs });
  }

  /**
   * Cancel a running task
   * @returns true if task was cancelled, false if not found or not running
   */
  cancelTask(taskId: string): boolean {
    const controller = this.runningTasks.get(taskId);
    if (!controller) return false;

    controller.abort();
    this.setFailed(taskId, 'cancelled');
    return true;
  }

  /**
   * Mark any tasks left in 'running' state as failed (called on startup)
   */
  markOrphanedTasksFailed(): void {
    const result = this.stmtMarkOrphaned.run(new Date().toISOString());

    if (result.changes > 0) {
      this.logger.warn('Marked orphaned tasks as failed', {
        count: result.changes,
      });
    }
  }

  /**
   * Start the cleanup timer for expired tasks
   */
  startCleanup(): void {
    if (this.cleanupTimer) return;

    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredTasks();
    }, CLEANUP_INTERVAL_MS);

    this.logger.info('Task cleanup timer started', {
      intervalMs: CLEANUP_INTERVAL_MS,
      ttlMs: TASK_TTL_MS,
    });
  }

  /**
   * Stop the cleanup timer
   */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      this.logger.info('Task cleanup timer stopped');
    }
  }

  /**
   * Delete expired completed/failed tasks
   */
  private cleanupExpiredTasks(): void {
    const cutoff = new Date(Date.now() - TASK_TTL_MS).toISOString();
    const result = this.stmtCleanupExpired.run(cutoff);

    if (result.changes > 0) {
      this.logger.info('Expired tasks cleaned up', {
        count: result.changes,
      });
    }
  }
}
