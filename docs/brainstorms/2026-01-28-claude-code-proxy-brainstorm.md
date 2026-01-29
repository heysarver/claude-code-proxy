---
date: 2026-01-28
topic: claude-code-proxy
---

# Claude Code Proxy: Session-Aware API Gateway

## What We're Building

A ToS-compliant proxy server that exposes Claude Code's capabilities via HTTP APIs. Unlike existing solutions (CLIProxyAPI, etc.) that intercept OAuth tokens and make direct API calls—violating Anthropic's Terms of Service—this proxy actually invokes the installed Claude Code CLI using `claude -p` subprocess spawning.

The proxy will:
- Accept requests via OpenAI-compatible endpoints AND a simpler custom REST API
- Queue requests and process them through a configurable worker pool
- Support multi-turn conversations using Claude Code's `--resume` flag with session tracking
- Authenticate consumers via API key headers
- Run directly on the host initially (designed to support containerized sandboxing later)

## Why This Approach

### Approaches Considered

1. **Simple Queue-Based Proxy** - Stateless request/response only
2. **Session-Aware Proxy** ← CHOSEN - Adds conversation continuation via session IDs
3. **Full Agent Gateway** - Complete workspace isolation and tool policies

### Why Session-Aware

The session-aware approach balances simplicity with the practical need for multi-turn agent interactions. Claude Code natively supports `--resume <session_id>` for conversation continuation, making this straightforward to implement without significant added complexity.

Key deciding factors:
- **Claude Max requirement**: Must use actual Claude Code install for OAuth/subscription compliance
- **Agent support**: Primary consumers (AI agents) benefit from conversation context
- **YAGNI applied**: Full workspace isolation can be added later; session tracking is the minimum viable feature set for useful agent interactions

### ToS Compliance

Existing tools like CLIProxyAPI work by:
1. Capturing Claude Code's OAuth tokens from `~/.cli-proxy-api/`
2. Making direct API calls to Anthropic, pretending to be Claude Code

This violates ToS because third-party developers are not allowed to apply Claude.ai rate limits for their products.

Our approach:
1. Spawn actual `claude -p` processes
2. Let Claude Code handle its own authentication
3. Simply proxy the input/output

This is ToS-compliant because we're genuinely using Claude Code, not impersonating it.

## Key Decisions

- **Invocation method**: `claude -p --output-format json` subprocess spawning
  - *Rationale*: Direct CLI invocation is the only ToS-compliant way to use Claude Max subscription programmatically

- **API format**: OpenAI-compatible (`/v1/chat/completions`) + custom REST (`/api/run`)
  - *Rationale*: OpenAI compat enables drop-in use with existing tools; custom endpoint provides flexibility for agent-specific features

- **Concurrency model**: Queued with configurable worker pool
  - *Rationale*: Prevents overwhelming rate limits while allowing controlled parallelism

- **Language**: TypeScript/Node.js
  - *Rationale*: Same ecosystem as Claude Code; excellent subprocess and async support

- **Proxy authentication**: API key header (Bearer token or X-API-Key)
  - *Rationale*: Simple, widely understood, sufficient for initial use cases

- **Session management**: Track session IDs, support `--resume` for continuation
  - *Rationale*: Enables multi-turn agent conversations without complexity of full REPL management

- **Sandboxing**: Direct execution initially, designed for future container support
  - *Rationale*: Get working quickly; architecture should not preclude adding isolation later

## Open Questions

- **Session cleanup**: How long should sessions be kept? TTL-based expiration? Max sessions per consumer?
- **Rate limiting**: Should the proxy implement its own rate limiting on top of Claude's?
- **Streaming**: Should we support SSE streaming via `--output-format stream-json`? (Deferred for v1)
- **Working directory**: How to handle workspace context—fixed directory, per-request, or per-session?
- **Error handling**: How to surface Claude Code failures (auth errors, rate limits) to consumers?

## Architecture Sketch

```
┌─────────────────┐     ┌──────────────────────────────────────┐
│   Consumer      │     │         Claude Code Proxy            │
│  (Agent/App)    │     │                                      │
└────────┬────────┘     │  ┌─────────────┐  ┌──────────────┐  │
         │              │  │   HTTP      │  │   Session    │  │
         │  HTTP        │  │   Server    │  │   Store      │  │
         ▼              │  │  (Express)  │  │  (in-memory) │  │
    ┌────────────┐      │  └──────┬──────┘  └──────────────┘  │
    │ /v1/chat/  │──────│─────────▼                           │
    │ completions│      │  ┌─────────────┐                    │
    └────────────┘      │  │   Request   │                    │
    ┌────────────┐      │  │   Queue     │                    │
    │ /api/run   │──────│─────────┬──────┘                    │
    └────────────┘      │         │                           │
                        │         ▼                           │
                        │  ┌─────────────────────────────┐    │
                        │  │      Worker Pool            │    │
                        │  │  ┌───────┐ ┌───────┐       │    │
                        │  │  │Worker1│ │Worker2│ ...   │    │
                        │  │  └───┬───┘ └───┬───┘       │    │
                        │  └──────┼─────────┼───────────┘    │
                        └─────────┼─────────┼────────────────┘
                                  ▼         ▼
                           ┌──────────────────────┐
                           │   claude -p ...      │
                           │   (subprocess)       │
                           └──────────────────────┘
```

## Next Steps

→ `/workflows:plan` for implementation details and file structure
