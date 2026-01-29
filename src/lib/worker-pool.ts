import PQueue from 'p-queue';
import { runClaude } from './claude-runner.js';
import { Errors, isRetryableError } from './errors.js';
import type { ClaudeRunOptions, ClaudeRunResult, WorkerPoolStats } from '../types/index.js';
import type { Config, Logger } from '../config.js';

// Retry configuration (hardcoded - YAGNI)
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_DELAYS = [1000, 2000, 4000]; // Exponential: 1s, 2s, 4s

/**
 * Worker pool that manages concurrent Claude CLI executions
 * using p-queue for job queuing and concurrency control.
 */
export class WorkerPool {
  private queue: PQueue;
  private config: Config;
  private logger: Logger;
  private isShuttingDown = false;

  constructor(config: Config, logger: Logger) {
    this.config = config;
    this.logger = logger;

    this.queue = new PQueue({
      concurrency: config.workerConcurrency,
      timeout: config.requestTimeoutMs + config.queueTimeoutMs, // Total time including queue wait
    });

    this.logger.info('Worker pool initialized', {
      concurrency: config.workerConcurrency,
      maxQueueSize: config.maxQueueSize,
      queueTimeoutMs: config.queueTimeoutMs,
    });
  }

  /**
   * Submit a Claude CLI execution request to the worker pool
   * Includes retry logic with exponential backoff + jitter for transient failures
   *
   * @param options - Claude run options
   * @param requestId - Request ID for logging/tracking
   * @returns Promise resolving to Claude's response
   * @throws ApiError if queue is full or request times out
   */
  async submit(options: ClaudeRunOptions, requestId: string): Promise<ClaudeRunResult> {
    // Check if shutting down
    if (this.isShuttingDown) {
      throw Errors.cliError('Server is shutting down', { reason: 'shutdown' });
    }

    // Streaming requests don't retry (fail fast)
    if (options.stream) {
      return this.executeWithQueue(options, requestId);
    }

    // Retry loop for non-streaming requests
    let lastError: unknown;
    for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
      // Check abort before each attempt
      if (options.abortSignal?.aborted) {
        throw Errors.cliError('Request was aborted');
      }

      try {
        return await this.executeWithQueue(options, requestId);
      } catch (error) {
        lastError = error;

        // Don't retry non-retryable errors or on last attempt
        if (!isRetryableError(error) || attempt >= RETRY_MAX_ATTEMPTS - 1) {
          throw error;
        }

        // Exponential backoff with jitter (±15%)
        const baseDelay = RETRY_DELAYS[attempt] ?? RETRY_DELAYS[RETRY_DELAYS.length - 1];
        const jitter = baseDelay * 0.15 * (Math.random() * 2 - 1);
        const delay = Math.round(baseDelay + jitter);

        this.logger.info('Retrying request', {
          requestId,
          attempt: attempt + 1,
          maxAttempts: RETRY_MAX_ATTEMPTS,
          delayMs: delay,
          error: error instanceof Error ? error.message : 'Unknown',
        });

        // Abortable delay
        await new Promise<void>((resolve, reject) => {
          const timeoutId = setTimeout(resolve, delay);
          const abortHandler = () => {
            clearTimeout(timeoutId);
            reject(Errors.cliError('Request was aborted during retry'));
          };
          if (options.abortSignal) {
            options.abortSignal.addEventListener('abort', abortHandler, { once: true });
          }
        });
      }
    }

    throw lastError;
  }

  /**
   * Execute a request through the queue (internal method)
   */
  private async executeWithQueue(options: ClaudeRunOptions, requestId: string): Promise<ClaudeRunResult> {
    // Check queue capacity
    if (this.queue.size >= this.config.maxQueueSize) {
      this.logger.warn('Queue capacity exceeded, rejecting request', {
        requestId,
        queueSize: this.queue.size,
        maxQueueSize: this.config.maxQueueSize,
      });
      throw Errors.queueFull(this.config.maxQueueSize);
    }

    const queuedAt = Date.now();
    this.logger.debug('Request queued', {
      requestId,
      queuePosition: this.queue.size,
      pending: this.queue.pending,
    });

    try {
      const result = await this.queue.add(
        async () => {
          const queueWaitMs = Date.now() - queuedAt;
          this.logger.debug('Request starting execution', {
            requestId,
            queueWaitMs,
          });

          // Check if queue wait exceeded timeout
          if (queueWaitMs > this.config.queueTimeoutMs) {
            throw Errors.queueTimeout(this.config.queueTimeoutMs);
          }

          // Adjust timeout for remaining time after queue wait
          const remainingTimeoutMs = this.config.requestTimeoutMs;

          return runClaude(
            { ...options, timeoutMs: remainingTimeoutMs },
            this.logger
          );
        }
      );

      return result as ClaudeRunResult;
    } catch (err) {
      // Handle p-queue timeout (queue wait + execution timeout)
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw Errors.timeout(this.config.requestTimeoutMs + this.config.queueTimeoutMs);
      }
      throw err;
    }
  }

  /**
   * Get current worker pool statistics
   */
  getStats(): WorkerPoolStats {
    return {
      pending: this.queue.pending,
      processing: this.queue.pending, // p-queue: pending = currently running
      concurrency: this.config.workerConcurrency,
      maxQueueSize: this.config.maxQueueSize,
      isPaused: this.queue.isPaused,
    };
  }

  /**
   * Get queue size (waiting + processing)
   */
  get size(): number {
    return this.queue.size;
  }

  /**
   * Get number of requests currently being processed
   */
  get pending(): number {
    return this.queue.pending;
  }

  /**
   * Check if the pool is healthy (not at capacity)
   */
  isHealthy(): boolean {
    return this.queue.size < this.config.maxQueueSize * 0.9; // 90% threshold
  }

  /**
   * Gracefully shutdown the worker pool
   * - Stop accepting new requests
   * - Wait for current requests to complete
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    this.logger.info('Shutting down worker pool', {
      pending: this.queue.pending,
      size: this.queue.size,
    });

    // Pause the queue to stop processing new items
    this.queue.pause();

    // Clear waiting items (they haven't started yet)
    this.queue.clear();

    // Wait for currently running tasks to complete
    await this.queue.onIdle();

    this.logger.info('Worker pool shutdown complete');
  }
}
