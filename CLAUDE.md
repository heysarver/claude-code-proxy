# Claude Code Proxy

A ToS-compliant HTTP proxy that exposes Claude Code capabilities via API by spawning actual `claude -p` CLI subprocesses.

## Project Structure

```
src/
├── index.ts           # Entry point, Express app setup, graceful shutdown
├── config.ts          # Environment configuration and logger
├── routes/
│   ├── api.ts         # /api/run endpoint (POST)
│   └── health.ts      # /health endpoint (GET)
├── lib/
│   ├── auth.ts        # API key authentication middleware
│   ├── claude-runner.ts # Claude CLI subprocess management
│   └── errors.ts      # Custom error classes and factory functions
└── types/
    └── index.ts       # TypeScript interfaces
```

## Development

```bash
# Install dependencies
npm install

# Run in development mode (hot reload)
npm run dev

# Build for production
npm run build

# Run production build
npm start

# Run tests
npm test
```

## ES Module Requirements

This project uses ES modules (`"type": "module"` in package.json). **All imports MUST use `.js` extensions**, even for TypeScript files:

```typescript
// ✅ Correct
import { foo } from './lib/foo.js';

// ❌ Wrong - will fail at runtime
import { foo } from './lib/foo';
import { foo } from './lib/foo.ts';
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | 3000 | Server port |
| `PROXY_API_KEY` | **Yes** | - | API key for authentication |
| `REQUEST_TIMEOUT_MS` | No | 300000 | Request timeout (5 min) |
| `LOG_LEVEL` | No | info | debug, info, warn, error |

## API Endpoints

### `GET /health`
No authentication. Returns server status.

### `POST /api/run`
Requires `Authorization: Bearer <API_KEY>` header.

Request body:
```json
{
  "prompt": "Your prompt here",
  "allowedTools": ["Read", "Write"],  // optional
  "workingDirectory": "/path/to/dir"  // optional
}
```

## Prerequisites

- Node.js 18+
- Claude Code CLI installed (`npm install -g @anthropic-ai/claude-code`)
- Claude Code authenticated (`claude login`)

## Code Conventions

- Use `async/await` for async operations
- All errors should use the `ApiError` class from `lib/errors.ts`
- Use the logger from `config.ts` for all logging
- Express 5 handles async errors automatically - no try/catch needed in route handlers
