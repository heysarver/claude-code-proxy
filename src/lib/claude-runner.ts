import { spawn, ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import type { ClaudeRunOptions, ClaudeRunResult, StreamChunk } from '../types/index.js';
import { Errors } from './errors.js';
import type { Logger, Config } from '../config.js';

/**
 * Default timeout for Claude CLI execution (5 minutes)
 */
const DEFAULT_TIMEOUT_MS = 300000;

/**
 * Grace period before SIGKILL after SIGTERM (5 seconds)
 */
const KILL_GRACE_PERIOD_MS = 5000;

/**
 * Run Claude CLI with the given options
 *
 * @param options - Options for Claude CLI execution
 * @param logger - Logger instance
 * @param config - Application configuration
 * @returns Promise resolving to Claude's response
 */
export async function runClaude(
  options: ClaudeRunOptions,
  logger: Logger,
  config: Config
): Promise<ClaudeRunResult> {
  const { prompt, model, allowedTools, workingDirectory, timeoutMs = DEFAULT_TIMEOUT_MS, resumeSessionId, abortSignal, stream, onChunk, maxTurns } = options;

  // Apply default workspace directory if none provided
  const effectiveWorkDir = workingDirectory || config.defaultWorkspaceDir;

  // Apply default model if none provided (normalize to lowercase)
  const effectiveModel = (model || config.defaultModel).toLowerCase();
  const usingDefaultModel = !model;
  logger.debug('Model selection', {
    requestedModel: model || '(none)',
    effectiveModel,
    source: usingDefaultModel ? 'default' : 'request',
  });

  // Validate against path traversal
  if (effectiveWorkDir && effectiveWorkDir.includes('..')) {
    throw Errors.invalidRequest(`Invalid working directory path: contains path traversal`);
  }

  // Create workspace directory if it doesn't exist
  if (effectiveWorkDir && !existsSync(effectiveWorkDir)) {
    try {
      mkdirSync(effectiveWorkDir, { recursive: true });
      logger.info('Created working directory', { path: effectiveWorkDir });
    } catch (err) {
      throw Errors.cliError(`Failed to create working directory: ${effectiveWorkDir}`, {
        path: effectiveWorkDir,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Check if already aborted
  if (abortSignal?.aborted) {
    throw Errors.cliError('Request was aborted', { reason: 'aborted_before_start' });
  }

  // Build command arguments
  // --dangerously-skip-permissions is required for headless/proxy operation
  // without it, Claude CLI waits for user input on permission prompts
  const outputFormat = stream ? 'stream-json' : 'json';
  const args: string[] = ['-p', prompt, '--output-format', outputFormat, '--dangerously-skip-permissions'];

  // Always include model flag since we have an effective model (either provided or default)
  args.push('--model', effectiveModel);

  if (allowedTools && allowedTools.length > 0) {
    args.push('--allowedTools', allowedTools.join(','));
  }

  if (resumeSessionId) {
    args.push('--resume', resumeSessionId);
  }

  if (maxTurns && maxTurns > 0) {
    args.push('--max-turns', String(maxTurns));
  }

  logger.debug('Spawning Claude CLI', {
    args: args.map((a, i) => (i === 1 ? '[prompt]' : a)), // Don't log full prompt
    workingDirectory: effectiveWorkDir,
    timeoutMs,
  });

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let killed = false;
    let aborted = false;
    let child: ChildProcess;

    try {
      child = spawn('claude', args, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: effectiveWorkDir,
        env: { ...process.env },
      });
    } catch (err) {
      // spawn itself threw (e.g., command not found on some systems)
      reject(Errors.cliNotFound());
      return;
    }

    // Handle timeout
    const timeout = setTimeout(() => {
      killed = true;
      logger.warn('Claude CLI timed out, sending SIGTERM', { timeoutMs });
      child.kill('SIGTERM');

      // Force kill after grace period
      setTimeout(() => {
        if (!child.killed) {
          logger.warn('Claude CLI did not respond to SIGTERM, sending SIGKILL');
          child.kill('SIGKILL');
        }
      }, KILL_GRACE_PERIOD_MS);
    }, timeoutMs);

    // Handle abort signal (client disconnect)
    const abortHandler = () => {
      if (!child.killed) {
        aborted = true;
        logger.info('Request aborted, killing Claude CLI process');
        child.kill('SIGTERM');

        // Force kill after grace period
        setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, KILL_GRACE_PERIOD_MS);
      }
    };

    if (abortSignal) {
      abortSignal.addEventListener('abort', abortHandler, { once: true });
    }

    // Collect stdout (with streaming support)
    let streamBuffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      const data = chunk.toString();
      stdout += data;

      // Handle streaming mode
      if (stream && onChunk) {
        streamBuffer += data;
        const lines = streamBuffer.split('\n');
        streamBuffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            // Transform CLI stream output to our StreamChunk format
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              onChunk({ type: 'content_block_delta', text: parsed.delta.text });
            } else if (parsed.type === 'message_stop' || parsed.type === 'message_end') {
              onChunk({ type: 'message_end', stopReason: parsed.message?.stop_reason || 'end_turn' });
            } else if (parsed.type === 'assistant' && parsed.message?.content) {
              // Initial message with content
              const text = typeof parsed.message.content === 'string'
                ? parsed.message.content
                : parsed.message.content[0]?.text || '';
              if (text) {
                onChunk({ type: 'content_block_delta', text });
              }
            }
          } catch (e) {
            logger.warn('Failed to parse streaming chunk', { line: line.substring(0, 100) });
          }
        }
      }
    });

    // Collect stderr
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Handle spawn errors (e.g., command not found)
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timeout);

      if (err.code === 'ENOENT') {
        reject(Errors.cliNotFound());
      } else {
        reject(Errors.cliError(`Failed to spawn Claude CLI: ${err.message}`, { code: err.code }));
      }
    });

    // Handle process completion
    child.on('close', (code, signal) => {
      clearTimeout(timeout);

      // Clean up abort listener
      if (abortSignal) {
        abortSignal.removeEventListener('abort', abortHandler);
      }

      logger.debug('Claude CLI exited', { code, signal, killed, aborted });

      // Handle abort
      if (aborted) {
        reject(Errors.cliError('Request was aborted', { reason: 'client_disconnect' }));
        return;
      }

      // Handle timeout kill
      if (killed) {
        reject(Errors.timeout(timeoutMs));
        return;
      }

      // Handle non-zero exit
      if (code !== 0) {
        // Try to detect specific error types from stderr
        const stderrLower = stderr.toLowerCase();

        if (stderrLower.includes('rate limit') || stderrLower.includes('too many requests')) {
          reject(Errors.rateLimit());
          return;
        }

        if (stderrLower.includes('authentication') || stderrLower.includes('not logged in') || stderrLower.includes('login')) {
          reject(Errors.upstreamAuthError());
          return;
        }

        // Detect memory errors (heap exhaustion, OOM)
        const memoryPatterns = ['out of memory', 'heap limit', 'allocation failed'];
        if (memoryPatterns.some(pattern => stderrLower.includes(pattern))) {
          reject(Errors.memoryError({
            exitCode: code,
            stderr: stderr.trim(),
            hint: 'Session may be too large. Try starting a new session.',
          }));
          return;
        }

        reject(Errors.cliError(`Claude CLI exited with code ${code}`, {
          exitCode: code,
          signal,
          stderr: stderr.trim(),
        }));
        return;
      }

      // Parse successful output
      try {
        const result = parseClaudeOutput(stdout, logger, effectiveModel);
        resolve(result);
      } catch (err) {
        reject(Errors.cliError('Failed to parse Claude CLI output', {
          parseError: err instanceof Error ? err.message : String(err),
          rawOutput: stdout.substring(0, 500),
        }));
      }
    });
  });
}

/**
 * Parse Claude CLI JSON output and extract the response text
 *
 * Claude --output-format json returns structured output.
 * We need to extract the text content from the response.
 */
function parseClaudeOutput(output: string, logger: Logger, effectiveModel: string): ClaudeRunResult {
  // Claude CLI with --output-format json returns the full response
  // The structure includes session_id and the result text
  const trimmed = output.trim();

  if (!trimmed) {
    throw new Error('Empty output from Claude CLI');
  }

  try {
    const parsed = JSON.parse(trimmed);

    // The JSON output structure from Claude CLI:
    // {
    //   "result": "text response",
    //   "session_id": "...",
    //   "is_error": false,
    //   ...
    // }

    if (parsed.is_error) {
      throw new Error(parsed.result || 'Claude returned an error');
    }

    const result = parsed.result || '';
    const sessionId = parsed.session_id;

    logger.debug('Parsed Claude response', {
      resultLength: result.length,
      hasSessionId: !!sessionId,
    });

    return {
      result,
      sessionId,
      rawOutput: trimmed,
      model: effectiveModel,
    };
  } catch (err) {
    // If not valid JSON, might be plain text output or error message
    logger.warn('Claude output is not valid JSON, treating as plain text');

    return {
      result: trimmed,
      sessionId: undefined,
      rawOutput: trimmed,
      model: effectiveModel,
    };
  }
}
