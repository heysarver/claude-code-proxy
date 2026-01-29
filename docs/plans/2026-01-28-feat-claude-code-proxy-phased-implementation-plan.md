---
title: "feat: Claude Code Proxy - Phased Implementation"
type: feat
date: 2026-01-28
---

# Claude Code Proxy: Phased Implementation Plan

## Overview

Build a ToS-compliant HTTP proxy that exposes Claude Code's capabilities via API by spawning actual `claude -p` CLI subprocesses. Unlike existing solutions that intercept OAuth tokens, this approach genuinely uses Claude Code, ensuring compliance with Anthropic's Terms of Service when using a Claude Max subscription.

## Problem Statement / Motivation

Current solutions for programmatic Claude Code access either:
1. Violate ToS by capturing OAuth tokens and making direct API calls (CLIProxyAPI)
2. Require separate API billing (Anthropic API keys)
3. Use deprecated approaches (old OAuth environment variables)

Users with Claude Max subscriptions need a compliant way to expose Claude Code to agents, CI/CD pipelines, and other tools without circumventing authentication.

## Technical Approach

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Claude Code Proxy                                │
│                                                                          │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────────────┐    │
│  │    HTTP      │     │   Request    │     │    Worker Pool       │    │
│  │   Server     │────▶│    Queue     │────▶│  (N concurrent)      │    │
│  │  (Express)   │     │  (p-queue)   │     │                      │    │
│  └──────────────┘     └──────────────┘     └──────────┬───────────┘    │
│         │                                              │                │
│         │                                              ▼                │
│  ┌──────┴──────┐                            ┌──────────────────────┐    │
│  │   Session   │                            │   claude -p ...      │    │
│  │    Store    │                            │   (subprocess)       │    │
│  │ (in-memory) │                            └──────────────────────┘    │
│  └─────────────┘                                                        │
└─────────────────────────────────────────────────────────────────────────┘

Endpoints:
  POST /api/run                 - Custom simple API (all phases)
  POST /v1/chat/completions     - OpenAI-compatible (Phase 4)
  GET  /health                  - Health check (Phase 1)
```

### Key Design Decisions (from Brainstorm)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Invocation | `claude -p --output-format json` | Only ToS-compliant method |
| Queue | p-queue (in-memory) | Simple, no external deps |
| Language | TypeScript/Node.js | Same ecosystem as Claude Code |
| Auth | API key header | Simple, widely understood |
| Sessions | `--resume` with ID tracking | Native Claude Code support |

---

## Implementation Phases

### Phase 1: MVP - Basic Proxy (Foundation)

**Goal**: Minimal working proxy that accepts requests and returns Claude Code output.

#### Acceptance Criteria

- [ ] Project bootstrapped with TypeScript, Express 5, proper tooling
- [ ] `POST /api/run` endpoint accepts `{prompt: string}` and returns Claude response
- [ ] API key authentication via `Authorization: Bearer <key>` header
- [ ] Single worker (no concurrency, no queue)
- [ ] Basic error handling for common failures
- [ ] `GET /health` endpoint returns server status
- [ ] Graceful shutdown on SIGTERM/SIGINT
- [ ] Environment-based configuration

#### Technical Specification

**Request Format:**
```typescript
// POST /api/run
// Headers: Authorization: Bearer <API_KEY>
interface RunRequest {
  prompt: string;
  allowedTools?: string[];  // Optional: --allowedTools flag
  workingDirectory?: string; // Optional: --cwd flag (validated)
}
```

**Response Format:**
```typescript
interface RunResponse {
  id: string;          // Request ID (UUID)
  result: string;      // Claude's text response
  sessionId?: string;  // Claude's session ID (for Phase 3)
  durationMs: number;  // Processing time
}

interface ErrorResponse {
  error: {
    code: string;      // e.g., "auth_error", "timeout", "cli_error"
    message: string;
    details?: unknown;
  };
}
```

**Configuration (Environment Variables):**
```bash
PORT=3000                    # Server port
PROXY_API_KEY=<required>     # API key for authentication
REQUEST_TIMEOUT_MS=300000    # 5 minute default
LOG_LEVEL=info               # debug, info, warn, error
```

#### Files to Create

```
claude-code-proxy/
├── package.json
├── tsconfig.json
├── .gitignore
├── .env.example
├── CLAUDE.md
├── src/
│   ├── index.ts              # Entry point, server setup
│   ├── config.ts             # Environment config with validation
│   ├── routes/
│   │   ├── api.ts            # /api/run endpoint
│   │   └── health.ts         # /health endpoint
│   ├── lib/
│   │   ├── claude-runner.ts  # Subprocess spawning logic
│   │   ├── auth.ts           # API key middleware
│   │   └── errors.ts         # Custom error classes
│   └── types/
│       └── index.ts          # TypeScript interfaces
└── tests/
    └── api.test.ts           # Integration tests
```

#### Implementation Notes

**Claude Runner (src/lib/claude-runner.ts):**
```typescript
// Key patterns from best practices research:
// - Use spawn() with shell: false for security
// - Handle both 'close' and 'error' events
// - Implement timeout with SIGTERM -> SIGKILL escalation
// - Capture both stdout and stderr
```

**Error Code Mapping:**
| Claude Exit | HTTP Status | Error Code |
|-------------|-------------|------------|
| 0 | 200 | (success) |
| 1 (general) | 500 | cli_error |
| Rate limit | 429 | rate_limit |
| Auth failed | 401 | upstream_auth_error |
| Timeout | 504 | timeout |
| Not found | 500 | cli_not_found |

---

### Phase 2: Worker Pool & Queue

**Goal**: Handle concurrent requests with configurable parallelism and request queueing.

#### Acceptance Criteria

- [ ] Configurable worker pool (default: 2 workers)
- [ ] Request queue with p-queue library
- [ ] Maximum queue depth with 429 response when exceeded
- [ ] Request timeout applies to queue wait + processing
- [ ] Queue metrics in health endpoint
- [ ] Request ID tracking through entire lifecycle
- [ ] Client disconnect detection (abort processing option)

#### Technical Specification

**Additional Configuration:**
```bash
WORKER_CONCURRENCY=2         # Number of concurrent claude processes
MAX_QUEUE_SIZE=100           # Maximum queued requests
QUEUE_TIMEOUT_MS=60000       # Max time in queue before timeout
```

**Health Response Enhancement:**
```typescript
interface HealthResponse {
  status: "ok" | "degraded";
  queue: {
    pending: number;     // Requests in queue
    processing: number;  // Active workers
    concurrency: number; // Max workers
  };
  uptime: number;
}
```

#### Files to Modify/Create

```
src/
├── lib/
│   ├── worker-pool.ts        # NEW: p-queue wrapper with metrics
│   └── claude-runner.ts      # MODIFY: Add abort controller support
├── routes/
│   └── api.ts                # MODIFY: Use worker pool
└── index.ts                  # MODIFY: Initialize worker pool
```

#### Implementation Notes

**Worker Pool Pattern (src/lib/worker-pool.ts):**
```typescript
// From best practices research:
// - Use p-queue for in-memory queuing
// - Set throwOnTimeout: true for automatic timeout errors
// - Track request IDs for debugging
// - Implement graceful shutdown: pause queue, wait for workers
// - Monitor queue.pending and queue.size for health
```

**Client Disconnect Handling:**
```typescript
// Detect client abort via req.on('close')
// Pass AbortController to worker
// Kill subprocess if client disconnects (optional, configurable)
```

---

### Phase 3: Session Management

**Goal**: Support multi-turn conversations using Claude Code's `--resume` flag.

#### Acceptance Criteria

- [ ] Responses include `sessionId` for continuation
- [ ] `sessionId` in request resumes existing conversation
- [ ] Session TTL with automatic cleanup (default: 1 hour)
- [ ] Sessions bound to API key (security isolation)
- [ ] Concurrent requests to same session are serialized
- [ ] `DELETE /api/sessions/:id` to explicitly end session
- [ ] `GET /api/sessions` lists active sessions (for API key)

#### Technical Specification

**Request Format (Extended):**
```typescript
interface RunRequest {
  prompt: string;
  sessionId?: string;        // Resume this session
  allowedTools?: string[];
  workingDirectory?: string;
}
```

**Session Storage:**
```typescript
interface Session {
  id: string;                 // External ID (UUID)
  claudeSessionId: string;    // Claude's internal session ID
  apiKey: string;             // Owner (hashed)
  createdAt: Date;
  lastAccessedAt: Date;
  locked: boolean;            // Prevents concurrent access
}
```

**Additional Configuration:**
```bash
SESSION_TTL_MS=3600000       # 1 hour default
MAX_SESSIONS_PER_KEY=10      # Per-API-key limit
SESSION_CLEANUP_INTERVAL=60000 # Run cleanup every minute
```

#### Files to Modify/Create

```
src/
├── lib/
│   ├── session-store.ts      # NEW: In-memory session management
│   └── claude-runner.ts      # MODIFY: Add --resume support
├── routes/
│   ├── api.ts                # MODIFY: Session handling
│   └── sessions.ts           # NEW: Session management endpoints
└── index.ts                  # MODIFY: Session cleanup timer
```

#### Implementation Notes

**Session Locking:**
```typescript
// Prevent race conditions:
// 1. Check if session is locked
// 2. If locked, queue the request (per-session queue)
// 3. Lock session before processing
// 4. Unlock after response complete
// 5. Process next queued request for that session
```

**Session ID Security:**
```typescript
// External IDs are UUIDv4 (unpredictable)
// Internal Claude session IDs are never exposed
// Sessions validated against API key hash
```

---

### Phase 4: OpenAI-Compatible Endpoint

**Goal**: Add `/v1/chat/completions` endpoint for drop-in compatibility with OpenAI SDKs.

#### Acceptance Criteria

- [ ] `POST /v1/chat/completions` accepts OpenAI chat format
- [ ] Messages array converted to Claude prompt
- [ ] Response formatted as OpenAI ChatCompletion
- [ ] Model parameter accepted but mapped to Claude
- [ ] Unsupported parameters (temperature, etc.) logged but ignored
- [ ] `GET /v1/models` returns available "models"
- [ ] OpenAI-style error responses
- [ ] Multi-turn via sessions (messages array → session continuation)

#### Technical Specification

**Request Format (OpenAI):**
```typescript
interface ChatCompletionRequest {
  model: string;             // Accepted but ignored/mapped
  messages: Message[];       // Required
  stream?: boolean;          // Deferred (returns error for now)
  temperature?: number;      // Logged, ignored
  max_tokens?: number;       // Logged, ignored
  // ... other OpenAI params ignored
}

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}
```

**Response Format (OpenAI):**
```typescript
interface ChatCompletionResponse {
  id: string;                // "chatcmpl-{uuid}"
  object: "chat.completion";
  created: number;           // Unix timestamp
  model: string;             // "claude-code-proxy"
  choices: [{
    index: 0;
    message: {
      role: "assistant";
      content: string;
    };
    finish_reason: "stop";
  }];
  usage: {
    prompt_tokens: 0;        // Not available from CLI
    completion_tokens: 0;
    total_tokens: 0;
  };
}
```

**Message Conversion:**
```typescript
// [system, user, assistant, user] →
// "System: {system}\n\nUser: {user}\n\nAssistant: {assistant}\n\nUser: {user}"
//
// OR use session continuation:
// First message → new session
// Subsequent in same request → continue session
```

#### Files to Modify/Create

```
src/
├── routes/
│   ├── openai.ts             # NEW: /v1/chat/completions, /v1/models
│   └── api.ts                # MODIFY: Share session logic
├── lib/
│   ├── openai-transformer.ts # NEW: Format conversion utilities
│   └── session-store.ts      # MODIFY: Support stateless multi-turn
└── types/
    └── openai.ts             # NEW: OpenAI type definitions
```

#### Implementation Notes

**Multi-message Handling Strategy:**
```typescript
// Option A: Concatenate messages into single prompt (simpler)
// - Pro: No session management needed
// - Con: Loses some context nuance

// Option B: Use sessions (chosen)
// - Create session, send each message in sequence
// - Return final response
// - Auto-cleanup session after request
// - Pro: True conversation continuation
// - Con: Slower, more complex
```

**Streaming (Deferred):**
```typescript
// If stream: true requested, return error:
// {
//   error: {
//     code: "streaming_not_supported",
//     message: "Streaming is not yet supported. Set stream: false."
//   }
// }
//
// Future: Use --output-format stream-json and SSE
```

---

## Quality Gates

### Functional Requirements

- [ ] All endpoints return correct status codes
- [ ] Authentication rejects invalid API keys
- [ ] Timeouts are enforced at all stages
- [ ] Graceful shutdown completes in-flight requests
- [ ] Sessions are properly isolated between API keys

### Non-Functional Requirements

- [ ] Response time < 100ms for request queueing (excluding Claude processing)
- [ ] Memory usage stable under sustained load
- [ ] No process leaks (zombie subprocesses)
- [ ] Logs include correlation IDs for tracing

### Quality Checklist

- [ ] Integration tests for each endpoint
- [ ] Error path tests (timeout, auth failure, CLI missing)
- [ ] Load test with concurrent requests
- [ ] Session cleanup verified
- [ ] Graceful shutdown tested

---

## Dependencies & Prerequisites

### Required Before Starting

1. **Claude Code CLI installed** on target machine
2. **Claude Code authenticated** (`claude login` completed)
3. **Node.js 18+** installed

### External Dependencies

| Package | Purpose | Phase |
|---------|---------|-------|
| express (5.x) | HTTP server | 1 |
| p-queue | Job queue | 2 |
| uuid | ID generation | 1 |
| helmet | Security headers | 1 |
| cors | CORS handling | 1 |
| tsx | Development runner | 1 |
| typescript (5.x) | Type safety | 1 |
| vitest | Testing | 1 |

---

## Risk Analysis & Mitigation

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Claude CLI rate limits | High | Medium | Queue with backoff, expose rate limit errors clearly |
| Claude CLI hangs | High | Low | Enforce timeout with SIGKILL fallback |
| Memory exhaustion from queue | Medium | Medium | Set max queue depth, reject with 429 |
| Session file accumulation | Low | High | TTL-based cleanup, document cleanup |
| Breaking CLI changes | High | Low | Pin Claude Code version, test on upgrade |

---

## Open Questions Resolved

From the brainstorm's open questions:

| Question | Decision |
|----------|----------|
| Session cleanup | TTL-based (1 hour default), configurable |
| Rate limiting | Rely on Claude's limits, expose errors clearly |
| Streaming | Deferred to v2, return error if requested |
| Working directory | Default to CWD, allow override with validation |
| Error handling | Structured errors with codes, map CLI exits to HTTP |

---

## Future Considerations

**Not in Scope (v1):**
- Redis/persistent session storage
- Horizontal scaling / distributed queue
- Streaming responses (SSE)
- Custom model selection
- Tool approval callbacks
- Container sandboxing per request

**Potential v2 Features:**
- SSE streaming via `--output-format stream-json`
- Redis session store for multi-instance deployment
- Docker-based request isolation
- Prometheus metrics endpoint
- WebSocket interface for real-time updates

---

## References & Research

### Internal References
- Brainstorm: `docs/brainstorms/2026-01-28-claude-code-proxy-brainstorm.md`
- User's patterns: `auth-api` project (Express 5, ES modules, tsx)

### External References
- [Claude Code Headless Docs](https://code.claude.com/docs/en/headless)
- [Node.js Child Process](https://nodejs.org/api/child_process.html)
- [p-queue](https://github.com/sindresorhus/p-queue)
- [Express 5 Error Handling](https://expressjs.com/en/guide/error-handling.html)
- [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat)

### Best Practices Applied
- spawn() over alternative methods for subprocess management
- Graceful shutdown with connection draining
- Request ID correlation through entire lifecycle
- TTL-based resource cleanup
- Security headers (helmet)
