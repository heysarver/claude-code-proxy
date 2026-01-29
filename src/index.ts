import express, { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { createServer, Server } from 'node:http';
import { loadConfig, createLogger } from './config.js';
import { createAuthMiddleware } from './lib/auth.js';
import { createApiRouter } from './routes/api.js';
import { createHealthRouter } from './routes/health.js';
import { WorkerPool } from './lib/worker-pool.js';
import { ApiError, Errors } from './lib/errors.js';

// Load configuration
const config = loadConfig();
const logger = createLogger(config.logLevel);

// Create worker pool (Phase 2)
const workerPool = new WorkerPool(config, logger);

// Create Express app
const app = express();

// Security middleware
app.use(helmet());
app.use(cors());

// Body parsing
app.use(express.json({ limit: '1mb' }));

// Request ID middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const requestId = req.headers['x-request-id'] as string || crypto.randomUUID();
  res.setHeader('X-Request-ID', requestId);
  next();
});

// Health check (no auth required) - with worker pool stats
app.use(createHealthRouter(workerPool));

// API routes (auth required)
const authMiddleware = createAuthMiddleware(config.proxyApiKey);
app.use('/api', authMiddleware, createApiRouter(workerPool, logger));

// 404 handler
app.use((_req: Request, _res: Response, next: NextFunction) => {
  next(Errors.invalidRequest('Endpoint not found'));
});

// Global error handler
const errorHandler: ErrorRequestHandler = (err: Error, _req: Request, res: Response, _next: NextFunction): void => {
  // Log the error
  logger.error('Request error', {
    error: err.message,
    stack: config.logLevel === 'debug' ? err.stack : undefined,
  });

  // Handle ApiError
  if (err instanceof ApiError) {
    res.status(err.statusCode).json(err.toJSON());
    return;
  }

  // Handle unexpected errors
  const internalError = Errors.internalError();
  res.status(internalError.statusCode).json(internalError.toJSON());
};

app.use(errorHandler);

// Create HTTP server
const server: Server = createServer(app);

// Track active connections for graceful shutdown
const connections = new Set<import('net').Socket>();

server.on('connection', (conn) => {
  connections.add(conn);
  conn.on('close', () => connections.delete(conn));
});

// Graceful shutdown handler
let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal}, starting graceful shutdown...`);

  // Stop accepting new connections
  server.close(() => {
    logger.info('HTTP server closed');
  });

  // Set connection-close headers for keep-alive connections
  connections.forEach((conn) => {
    conn.end();
  });

  // Shutdown worker pool (wait for active tasks)
  await workerPool.shutdown();

  // Give existing connections time to drain
  const drainTimeout = 30000; // 30 seconds
  const forceTimeout = 35000; // 35 seconds

  // Force exit timeout
  const forceTimer = setTimeout(() => {
    logger.error('Forced shutdown due to timeout');
    process.exit(1);
  }, forceTimeout);

  // Wait for connections to drain
  const drainInterval = setInterval(() => {
    if (connections.size === 0) {
      clearInterval(drainInterval);
      clearTimeout(forceTimer);
      logger.info('Graceful shutdown complete');
      process.exit(0);
    }
  }, 100);

  // Drain timeout
  setTimeout(() => {
    clearInterval(drainInterval);
    if (connections.size > 0) {
      logger.warn(`Force closing ${connections.size} remaining connections`);
      connections.forEach((conn) => conn.destroy());
    }
  }, drainTimeout);
}

// Register signal handlers
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
  // Don't shutdown on unhandled rejection, just log
});

// Start server
server.listen(config.port, () => {
  logger.info(`Claude Code Proxy listening on port ${config.port}`, {
    nodeVersion: process.version,
    logLevel: config.logLevel,
    workerConcurrency: config.workerConcurrency,
    maxQueueSize: config.maxQueueSize,
  });
});
