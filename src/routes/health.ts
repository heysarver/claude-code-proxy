import { Router, Request, Response } from 'express';
import type { HealthResponse } from '../types/index.js';

const router = Router();

// Track server start time
const startTime = Date.now();

/**
 * GET /health
 * Returns server health status. No authentication required.
 */
router.get('/health', (_req: Request, res: Response) => {
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);

  const response: HealthResponse = {
    status: 'ok',
    uptime: uptimeSeconds,
  };

  res.json(response);
});

export default router;
