import { Router, Request, Response } from 'express';
import type { HealthResponse } from '../types/index.js';
import type { WorkerPool } from '../lib/worker-pool.js';
import type { SessionStore } from '../lib/session-store.js';

// Track server start time
const startTime = Date.now();

/**
 * Create health router with worker pool and session store access
 */
export function createHealthRouter(workerPool?: WorkerPool, sessionStore?: SessionStore): Router {
  const router = Router();

  /**
   * GET /health
   * Returns server health status. No authentication required.
   */
  router.get('/health', (_req: Request, res: Response) => {
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);

    // Determine status based on worker pool health
    const isHealthy = workerPool ? workerPool.isHealthy() : true;

    const response: HealthResponse = {
      status: isHealthy ? 'ok' : 'degraded',
      uptime: uptimeSeconds,
    };

    // Add queue stats if worker pool is available
    if (workerPool) {
      const stats = workerPool.getStats();
      response.queue = {
        pending: stats.pending,
        processing: stats.processing,
        concurrency: stats.concurrency,
      };
    }

    // Add session stats if session store is available
    if (sessionStore) {
      const stats = sessionStore.getStats();
      response.sessions = {
        total: stats.totalSessions,
        locked: stats.lockedSessions,
      };
    }

    res.json(response);
  });

  return router;
}
