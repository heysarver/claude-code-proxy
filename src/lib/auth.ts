import type { Request, Response, NextFunction } from 'express';
import { Errors } from './errors.js';

/**
 * Express middleware that validates API key authentication
 * Expects: Authorization: Bearer <api_key>
 */
export function createAuthMiddleware(apiKey: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      throw Errors.authRequired();
    }

    // Expect "Bearer <token>" format
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
      throw Errors.authInvalid();
    }

    const token = parts[1];
    if (token !== apiKey) {
      throw Errors.authInvalid();
    }

    next();
  };
}
