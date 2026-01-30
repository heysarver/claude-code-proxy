import { Router, Request, Response } from 'express';
import type { Task, TaskCreateRequest } from '../types/index.js';
import { Errors } from '../lib/errors.js';
import type { TaskStore } from '../lib/task-store.js';
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
 * Format a Task for API response
 */
function formatTaskResponse(task: Task): Record<string, unknown> {
  const response: Record<string, unknown> = {
    taskId: task.id,
    status: task.status,
    createdAt: task.createdAt.toISOString(),
  };

  if (task.startedAt) response.startedAt = task.startedAt.toISOString();
  if (task.completedAt) response.completedAt = task.completedAt.toISOString();
  if (task.durationMs !== undefined) response.durationMs = task.durationMs;
  if (task.result) response.result = task.result;
  if (task.claudeSessionId) response.sessionId = task.claudeSessionId;
  if (task.failureReason) response.failureReason = task.failureReason;

  return response;
}

/**
 * Execute a task in the background
 */
async function executeTask(
  taskId: string,
  apiKey: string,
  taskStore: TaskStore,
  workerPool: WorkerPool,
  sessionStore: SessionStore,
  logger: Logger
): Promise<void> {
  const task = taskStore.getTask(taskId, apiKey);
  if (!task) {
    logger.error('Task not found for execution', { taskId });
    return;
  }

  const abortController = taskStore.getAbortController(taskId);
  if (!abortController) {
    logger.error('AbortController not found for task', { taskId });
    return;
  }

  logger.info('Starting background task execution', { taskId });

  try {
    // Look up existing session if provided
    let resumeSessionId: string | undefined;
    if (task.sessionId) {
      const existingSession = sessionStore.getSession(task.sessionId, apiKey);
      if (existingSession) {
        resumeSessionId = existingSession.claudeSessionId;
      }
    }

    // Submit to worker pool
    const result = await workerPool.submit(
      {
        prompt: task.prompt,
        model: task.model,
        allowedTools: task.allowedTools,
        workingDirectory: task.workingDirectory,
        resumeSessionId,
        abortSignal: abortController.signal,
        maxTurns: task.maxTurns,
        stream: false,
      },
      taskId
    );

    // Handle session creation if Claude returned one
    let responseSessionId: string | undefined;
    if (result.sessionId) {
      const session = sessionStore.createSession(result.sessionId, apiKey);
      responseSessionId = session.id;
    }

    taskStore.setCompleted(taskId, result.result, responseSessionId);
  } catch (error) {
    // Check if task was cancelled (abort signal triggered)
    if (abortController.signal.aborted) {
      logger.debug('Task was cancelled', { taskId });
      return;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Task execution failed', { taskId, error: errorMessage });
    taskStore.setFailed(taskId, `error: ${errorMessage}`);
  }
}

/**
 * Create tasks router for background task execution
 */
export function createTasksRouter(
  taskStore: TaskStore,
  workerPool: WorkerPool,
  sessionStore: SessionStore,
  logger: Logger
): Router {
  const router = Router();

  /**
   * POST /api/tasks
   * Submit a new background task
   */
  router.post('/', async (req: Request, res: Response) => {
    const apiKey = extractApiKey(req);

    // Validate request body
    const body = req.body as TaskCreateRequest;

    if (!body || typeof body.prompt !== 'string') {
      throw Errors.invalidRequest('Request body must include a "prompt" string');
    }

    if (body.prompt.trim().length === 0) {
      throw Errors.invalidRequest('Prompt cannot be empty');
    }

    // Validate optional fields
    if (body.allowedTools !== undefined) {
      if (!Array.isArray(body.allowedTools)) {
        throw Errors.invalidRequest('allowedTools must be an array of strings');
      }
      if (!body.allowedTools.every((t) => typeof t === 'string')) {
        throw Errors.invalidRequest('allowedTools must contain only strings');
      }
    }

    if (body.workingDirectory !== undefined) {
      if (typeof body.workingDirectory !== 'string') {
        throw Errors.invalidRequest('workingDirectory must be a string');
      }
      if (body.workingDirectory.includes('..')) {
        throw Errors.invalidRequest('workingDirectory cannot contain ".."');
      }
    }

    if (body.sessionId !== undefined && typeof body.sessionId !== 'string') {
      throw Errors.invalidRequest('sessionId must be a string');
    }

    if (body.maxTurns !== undefined) {
      if (!Number.isInteger(body.maxTurns) || body.maxTurns < 1) {
        throw Errors.invalidRequest('maxTurns must be a positive integer');
      }
    }

    // Create task record
    const task = taskStore.createTask(body, apiKey);

    logger.info('Task submitted', { taskId: task.id });

    // Execute in background with explicit error handling
    void executeTask(task.id, apiKey, taskStore, workerPool, sessionStore, logger).catch(
      (error) => {
        logger.error('Background task execution failed unexpectedly', {
          taskId: task.id,
          error: error instanceof Error ? error.message : String(error),
        });
        taskStore.setFailed(task.id, `error: ${String(error)}`);
      }
    );

    // Return immediately with 202 Accepted
    res.status(202).json({
      taskId: task.id,
      status: task.status,
      createdAt: task.createdAt.toISOString(),
    });
  });

  /**
   * GET /api/tasks/:id
   * Get task status and result
   */
  router.get('/:id', (req: Request, res: Response) => {
    const apiKey = extractApiKey(req);
    const taskId = req.params.id as string;

    const task = taskStore.getTask(taskId, apiKey);
    if (!task) {
      throw Errors.taskNotFound(taskId);
    }

    res.json(formatTaskResponse(task));
  });

  /**
   * DELETE /api/tasks/:id
   * Cancel a running task
   */
  router.delete('/:id', (req: Request, res: Response) => {
    const apiKey = extractApiKey(req);
    const taskId = req.params.id as string;

    const task = taskStore.getTask(taskId, apiKey);
    if (!task) {
      throw Errors.taskNotFound(taskId);
    }

    // Only running tasks can be cancelled
    if (task.status !== 'running') {
      throw Errors.taskNotFound(taskId); // 404 per plan: DELETE on terminal states
    }

    const cancelled = taskStore.cancelTask(taskId);
    if (!cancelled) {
      throw Errors.taskNotFound(taskId);
    }

    logger.info('Task cancelled', { taskId });

    res.json({
      taskId,
      status: 'failed',
      failureReason: 'cancelled',
    });
  });

  return router;
}
