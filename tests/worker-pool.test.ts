import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkerPool } from '../src/lib/worker-pool.js';
import { Errors, isRetryableError } from '../src/lib/errors.js';
import type { Config, Logger } from '../src/config.js';
import type { ClaudeRunResult } from '../src/types/index.js';

// Mock claude-runner module
vi.mock('../src/lib/claude-runner.js', () => ({
  runClaude: vi.fn(),
}));

import { runClaude } from '../src/lib/claude-runner.js';
const mockRunClaude = vi.mocked(runClaude);

// Mock config with Phase 2 and Phase 3 options
const mockConfig: Config = {
  port: 6789,
  proxyApiKey: 'test-api-key',
  requestTimeoutMs: 5000,
  logLevel: 'error',
  workerConcurrency: 2,
  maxQueueSize: 10,
  queueTimeoutMs: 5000,
  sessionTtlMs: 3600000,
  maxSessionsPerKey: 10,
  sessionCleanupIntervalMs: 60000,
  sessionDbPath: ':memory:',
};

// Mock logger
const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

// Reset mocks before each test
beforeEach(() => {
  vi.clearAllMocks();
});

describe('WorkerPool', () => {
  let workerPool: WorkerPool;

  beforeEach(() => {
    workerPool = new WorkerPool(mockConfig, mockLogger);
  });

  afterEach(async () => {
    await workerPool.shutdown();
  });

  describe('submit', () => {
    it('processes requests successfully', async () => {
      const expectedResult: ClaudeRunResult = {
        result: 'Test response',
        sessionId: 'session-123',
        rawOutput: '{"result":"Test response","session_id":"session-123"}',
      };

      mockRunClaude.mockResolvedValueOnce(expectedResult);

      const result = await workerPool.submit({ prompt: 'Hello' }, 'req-1');

      expect(result).toEqual(expectedResult);
      expect(mockRunClaude).toHaveBeenCalledOnce();
    });

    it('passes options to runClaude', async () => {
      mockRunClaude.mockResolvedValueOnce({
        result: 'done',
        sessionId: undefined,
        rawOutput: 'done',
      });

      const abortController = new AbortController();
      await workerPool.submit(
        {
          prompt: 'test prompt',
          allowedTools: ['Read', 'Write'],
          workingDirectory: '/test/dir',
          abortSignal: abortController.signal,
        },
        'req-1'
      );

      expect(mockRunClaude).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'test prompt',
          allowedTools: ['Read', 'Write'],
          workingDirectory: '/test/dir',
          abortSignal: abortController.signal,
          timeoutMs: mockConfig.requestTimeoutMs,
        }),
        mockLogger
      );
    });

    it('rejects requests during shutdown', async () => {
      // Start shutdown
      const shutdownPromise = workerPool.shutdown();

      // Try to submit a request
      await expect(workerPool.submit({ prompt: 'test' }, 'req-1')).rejects.toThrow('shutting down');

      await shutdownPromise;
    });
  });

  describe('concurrency', () => {
    it('respects concurrency limit', async () => {
      let activeCount = 0;
      let maxActive = 0;

      mockRunClaude.mockImplementation(async () => {
        activeCount++;
        maxActive = Math.max(maxActive, activeCount);
        await new Promise((r) => setTimeout(r, 50));
        activeCount--;
        return { result: 'done', sessionId: undefined, rawOutput: 'done' };
      });

      // Submit 4 requests (concurrency is 2)
      const requests = Array(4)
        .fill(null)
        .map((_, i) => workerPool.submit({ prompt: `test-${i}` }, `req-${i}`));

      await Promise.all(requests);

      // Max concurrent should be at most 2
      expect(maxActive).toBeLessThanOrEqual(2);
      expect(mockRunClaude).toHaveBeenCalledTimes(4);
    });
  });

  describe('queue capacity', () => {
    it('rejects requests when queue is full', async () => {
      // Create a pool with small queue
      const smallConfig: Config = {
        ...mockConfig,
        maxQueueSize: 1, // Only 1 item can wait in queue
        workerConcurrency: 1, // Only 1 can run at a time
      };
      const smallPool = new WorkerPool(smallConfig, mockLogger);

      // Mock that takes 100ms to complete
      mockRunClaude.mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 100));
        return { result: 'done', sessionId: undefined, rawOutput: 'done' };
      });

      // Task 1: starts immediately (pending=1, size=0)
      const task1Promise = smallPool.submit({ prompt: 'test1' }, 'req-1');

      // Wait for task1 to start
      await new Promise((r) => setTimeout(r, 20));

      // Task 2: goes into queue (pending=1, size=1) - queue is now full
      const task2Promise = smallPool.submit({ prompt: 'test2' }, 'req-2');

      // Wait a bit for task2 to be queued
      await new Promise((r) => setTimeout(r, 10));

      // Task 3: should be rejected (size >= maxQueueSize)
      await expect(smallPool.submit({ prompt: 'test3' }, 'req-3')).rejects.toThrow('queue size');

      // Clean up
      await Promise.all([task1Promise, task2Promise]);
      await smallPool.shutdown();
    });
  });

  describe('getStats', () => {
    it('returns correct initial stats', () => {
      const stats = workerPool.getStats();

      expect(stats.pending).toBe(0);
      expect(stats.processing).toBe(0);
      expect(stats.concurrency).toBe(2);
      expect(stats.maxQueueSize).toBe(10);
      expect(stats.isPaused).toBe(false);
    });

    it('reflects running tasks', async () => {
      let resolveTask: () => void;

      mockRunClaude.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveTask = () => resolve({ result: 'done', sessionId: undefined, rawOutput: 'done' });
          })
      );

      const taskPromise = workerPool.submit({ prompt: 'test' }, 'req-1');

      // Wait for task to start
      await new Promise((r) => setTimeout(r, 10));

      const stats = workerPool.getStats();
      expect(stats.pending).toBe(1);
      expect(stats.processing).toBe(1);

      // Clean up
      resolveTask!();
      await taskPromise;
    });
  });

  describe('isHealthy', () => {
    it('returns true when below capacity threshold', () => {
      expect(workerPool.isHealthy()).toBe(true);
    });

    it('returns false when at or above 90% capacity', async () => {
      // Create a pool with small queue (maxQueueSize=10, threshold at 90% = 9)
      // We need size >= 9 to trigger unhealthy
      const smallConfig: Config = {
        ...mockConfig,
        maxQueueSize: 10,
        workerConcurrency: 1,
      };
      const smallPool = new WorkerPool(smallConfig, mockLogger);

      // Mock that takes 200ms - long enough for all to queue
      mockRunClaude.mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { result: 'done', sessionId: undefined, rawOutput: 'done' };
      });

      // Submit 10 tasks: 1 runs immediately, 9 queue up (size=9 >= 9 threshold)
      const tasks = Array(10)
        .fill(null)
        .map((_, i) => smallPool.submit({ prompt: `test-${i}` }, `req-${i}`));

      // Wait for all to be queued
      await new Promise((r) => setTimeout(r, 50));

      // Should be unhealthy at size=9 (>= 90% of 10)
      expect(smallPool.isHealthy()).toBe(false);

      // Clean up - wait for all tasks
      await Promise.all(tasks);
      await smallPool.shutdown();
    }, 10000); // Extend timeout for this test
  });

  describe('shutdown', () => {
    it('pauses queue and clears waiting items', async () => {
      let resolveTask: () => void;

      mockRunClaude.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveTask = () => resolve({ result: 'done', sessionId: undefined, rawOutput: 'done' });
          })
      );

      // Start a task
      const taskPromise = workerPool.submit({ prompt: 'test' }, 'req-1');

      // Wait for it to start
      await new Promise((r) => setTimeout(r, 10));

      // Start shutdown
      const shutdownPromise = workerPool.shutdown();

      // Stats should show paused
      const stats = workerPool.getStats();
      expect(stats.isPaused).toBe(true);

      // Complete the task
      resolveTask!();
      await taskPromise;
      await shutdownPromise;
    });

    it('is idempotent', async () => {
      await workerPool.shutdown();
      await workerPool.shutdown(); // Second call should not throw
    });
  });

  describe('size and pending getters', () => {
    it('returns queue size', async () => {
      let resolveTask: () => void;

      mockRunClaude.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveTask = () => resolve({ result: 'done', sessionId: undefined, rawOutput: 'done' });
          })
      );

      // Initially empty
      expect(workerPool.size).toBe(0);
      expect(workerPool.pending).toBe(0);

      // Start a task
      const taskPromise = workerPool.submit({ prompt: 'test' }, 'req-1');

      // Wait for it to start
      await new Promise((r) => setTimeout(r, 10));

      // Task is running, so pending=1
      expect(workerPool.pending).toBe(1);

      // Clean up
      resolveTask!();
      await taskPromise;
    });
  });

  describe('retry logic', () => {
    it('retries on timeout error', async () => {
      // First call fails with timeout, second succeeds
      mockRunClaude
        .mockRejectedValueOnce(Errors.timeout(5000))
        .mockResolvedValueOnce({ result: 'success', sessionId: undefined, rawOutput: 'success' });

      const result = await workerPool.submit({ prompt: 'test' }, 'req-1');

      expect(result.result).toBe('success');
      expect(mockRunClaude).toHaveBeenCalledTimes(2);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Retrying request',
        expect.objectContaining({ attempt: 1 })
      );
    });

    it('retries on rate limit error', async () => {
      // First call fails with rate limit, second succeeds
      mockRunClaude
        .mockRejectedValueOnce(Errors.rateLimit())
        .mockResolvedValueOnce({ result: 'success', sessionId: undefined, rawOutput: 'success' });

      const result = await workerPool.submit({ prompt: 'test' }, 'req-1');

      expect(result.result).toBe('success');
      expect(mockRunClaude).toHaveBeenCalledTimes(2);
    });

    it('does not retry on auth error', async () => {
      mockRunClaude.mockRejectedValueOnce(Errors.authInvalid());

      await expect(workerPool.submit({ prompt: 'test' }, 'req-1')).rejects.toThrow('Invalid API key');
      expect(mockRunClaude).toHaveBeenCalledTimes(1);
    });

    it('does not retry on invalid request error', async () => {
      mockRunClaude.mockRejectedValueOnce(Errors.invalidRequest('Bad input'));

      await expect(workerPool.submit({ prompt: 'test' }, 'req-1')).rejects.toThrow('Bad input');
      expect(mockRunClaude).toHaveBeenCalledTimes(1);
    });

    it('stops retrying after max attempts', async () => {
      mockRunClaude.mockRejectedValue(Errors.timeout(5000));

      await expect(workerPool.submit({ prompt: 'test' }, 'req-1')).rejects.toThrow('timed out');
      // 3 total attempts (initial + 2 retries)
      expect(mockRunClaude).toHaveBeenCalledTimes(3);
    });

    it('abort signal cancels retries', async () => {
      const abortController = new AbortController();

      // First call fails, then abort before retry
      mockRunClaude.mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 50));
        throw Errors.timeout(5000);
      });

      const promise = workerPool.submit({ prompt: 'test', abortSignal: abortController.signal }, 'req-1');

      // Abort after first failure starts retry delay
      setTimeout(() => abortController.abort(), 100);

      await expect(promise).rejects.toThrow('aborted');
    });

    it('does not retry streaming requests', async () => {
      mockRunClaude.mockRejectedValueOnce(Errors.timeout(5000));

      await expect(workerPool.submit({ prompt: 'test', stream: true }, 'req-1')).rejects.toThrow('timed out');
      // Only 1 attempt for streaming (no retries)
      expect(mockRunClaude).toHaveBeenCalledTimes(1);
    });
  });
});

describe('isRetryableError', () => {
  it('returns true for timeout errors', () => {
    expect(isRetryableError(Errors.timeout(5000))).toBe(true);
  });

  it('returns true for rate limit errors', () => {
    expect(isRetryableError(Errors.rateLimit())).toBe(true);
  });

  it('returns false for auth errors', () => {
    expect(isRetryableError(Errors.authInvalid())).toBe(false);
  });

  it('returns false for invalid request errors', () => {
    expect(isRetryableError(Errors.invalidRequest('bad'))).toBe(false);
  });

  it('returns false for CLI not found errors', () => {
    expect(isRetryableError(Errors.cliNotFound())).toBe(false);
  });

  it('returns true for ECONNRESET errors', () => {
    const error = new Error('read ECONNRESET');
    expect(isRetryableError(error)).toBe(true);
  });

  it('returns false for generic errors', () => {
    const error = new Error('Something went wrong');
    expect(isRetryableError(error)).toBe(false);
  });
});
