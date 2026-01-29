import { Router, Request, Response } from 'express';
import { Errors } from '../lib/errors.js';
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
 * Create sessions router for session management endpoints
 */
export function createSessionsRouter(sessionStore: SessionStore, logger: Logger): Router {
  const router = Router();

  /**
   * GET /api/sessions
   * List all active sessions for the authenticated API key
   */
  router.get('/', (req: Request, res: Response) => {
    const apiKey = extractApiKey(req);

    const sessions = sessionStore.listSessions(apiKey);

    logger.debug('Listed sessions', {
      count: sessions.length,
    });

    res.json({
      sessions,
    });
  });

  /**
   * DELETE /api/sessions/:id
   * Delete a specific session
   */
  router.delete('/:id', (req: Request, res: Response) => {
    const apiKey = extractApiKey(req);
    const sessionId = req.params.id as string;

    const deleted = sessionStore.deleteSession(sessionId, apiKey);

    if (!deleted) {
      throw Errors.sessionNotFound(sessionId);
    }

    logger.info('Session deleted via API', { sessionId });

    res.json({
      message: 'Session deleted',
      sessionId,
    });
  });

  return router;
}
