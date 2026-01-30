/**
 * Application configuration loaded from environment variables
 */
export interface Config {
  /** Server port */
  port: number;
  /** API key for authenticating proxy requests */
  proxyApiKey: string;
  /** Request timeout in milliseconds */
  requestTimeoutMs: number;
  /** Log level */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Number of concurrent Claude processes (Phase 2) */
  workerConcurrency: number;
  /** Maximum requests in queue before rejecting (Phase 2) */
  maxQueueSize: number;
  /** Maximum time a request can wait in queue in ms (Phase 2) */
  queueTimeoutMs: number;
  /** Session TTL in milliseconds (Phase 3) */
  sessionTtlMs: number;
  /** Maximum sessions per API key (Phase 3) */
  maxSessionsPerKey: number;
  /** Session cleanup interval in milliseconds (Phase 3) */
  sessionCleanupIntervalMs: number;
  /** Path to SQLite database file for session persistence */
  sessionDbPath: string;
}

/**
 * Load and validate configuration from environment variables
 */
export function loadConfig(): Config {
  const port = parseInt(process.env.PORT || '6789', 10);
  const proxyApiKey = process.env.PROXY_API_KEY;
  const requestTimeoutMs = parseInt(process.env.REQUEST_TIMEOUT_MS || '300000', 10);
  const logLevel = (process.env.LOG_LEVEL || 'info') as Config['logLevel'];
  const workerConcurrency = parseInt(process.env.WORKER_CONCURRENCY || '2', 10);
  const maxQueueSize = parseInt(process.env.MAX_QUEUE_SIZE || '100', 10);
  const queueTimeoutMs = parseInt(process.env.QUEUE_TIMEOUT_MS || '60000', 10);
  const sessionTtlMs = parseInt(process.env.SESSION_TTL_MS || '3600000', 10);
  const maxSessionsPerKey = parseInt(process.env.MAX_SESSIONS_PER_KEY || '10', 10);
  const sessionCleanupIntervalMs = parseInt(process.env.SESSION_CLEANUP_INTERVAL_MS || '60000', 10);
  const sessionDbPath = process.env.SESSION_DB_PATH || './data/sessions.db';

  // Validation
  if (!proxyApiKey) {
    throw new Error('PROXY_API_KEY environment variable is required');
  }

  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be a valid port number (1-65535)');
  }

  if (isNaN(requestTimeoutMs) || requestTimeoutMs < 1000) {
    throw new Error('REQUEST_TIMEOUT_MS must be at least 1000ms');
  }

  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    throw new Error('LOG_LEVEL must be one of: debug, info, warn, error');
  }

  if (isNaN(workerConcurrency) || workerConcurrency < 1) {
    throw new Error('WORKER_CONCURRENCY must be at least 1');
  }

  if (isNaN(maxQueueSize) || maxQueueSize < 1) {
    throw new Error('MAX_QUEUE_SIZE must be at least 1');
  }

  if (isNaN(queueTimeoutMs) || queueTimeoutMs < 1000) {
    throw new Error('QUEUE_TIMEOUT_MS must be at least 1000ms');
  }

  if (isNaN(sessionTtlMs) || sessionTtlMs < 60000) {
    throw new Error('SESSION_TTL_MS must be at least 60000ms (1 minute)');
  }

  if (isNaN(maxSessionsPerKey) || maxSessionsPerKey < 1) {
    throw new Error('MAX_SESSIONS_PER_KEY must be at least 1');
  }

  if (isNaN(sessionCleanupIntervalMs) || sessionCleanupIntervalMs < 1000) {
    throw new Error('SESSION_CLEANUP_INTERVAL_MS must be at least 1000ms');
  }

  return {
    port,
    proxyApiKey,
    requestTimeoutMs,
    logLevel,
    workerConcurrency,
    maxQueueSize,
    queueTimeoutMs,
    sessionTtlMs,
    maxSessionsPerKey,
    sessionCleanupIntervalMs,
    sessionDbPath,
  };
}

/**
 * Simple logger that respects log level
 */
export function createLogger(level: Config['logLevel']) {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  const currentLevel = levels[level];

  const log = (msgLevel: Config['logLevel'], message: string, data?: Record<string, unknown>) => {
    if (levels[msgLevel] >= currentLevel) {
      const timestamp = new Date().toISOString();
      const logData = data ? ` ${JSON.stringify(data)}` : '';
      console.log(`[${timestamp}] [${msgLevel.toUpperCase()}] ${message}${logData}`);
    }
  };

  return {
    debug: (message: string, data?: Record<string, unknown>) => log('debug', message, data),
    info: (message: string, data?: Record<string, unknown>) => log('info', message, data),
    warn: (message: string, data?: Record<string, unknown>) => log('warn', message, data),
    error: (message: string, data?: Record<string, unknown>) => log('error', message, data),
  };
}

export type Logger = ReturnType<typeof createLogger>;
