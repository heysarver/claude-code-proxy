# Claude Code Proxy

A simple HTTP proxy that wraps the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) so you can call it via REST APIs. Supports OpenAI and Anthropic API formats, including streaming.

## Why?

Sometimes you want to hit Claude Code from tools that speak HTTP instead of running CLI commands directly. This lets you do that.

## Requirements

- Node.js 20.6+
- Claude Code CLI installed and logged in

## Setup

```bash
npm install

# Create .env with your API key
echo "PROXY_API_KEY=pick-something-secret" > .env

# Run it
npm run dev
```

The server starts on port 6789 by default.

## Configuration

Set these in `.env` if you want to change defaults:

| Variable | Default | What it does |
|----------|---------|--------------|
| `PROXY_API_KEY` | required | Your auth key for the proxy |
| `PORT` | `6789` | Server port |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `REQUEST_TIMEOUT_MS` | `300000` | 5 min timeout (Claude can be slow) |
| `WORKER_CONCURRENCY` | `2` | How many Claude processes run at once |
| `MAX_QUEUE_SIZE` | `100` | Requests queued before rejecting |

## API

All endpoints need `Authorization: Bearer <your-proxy-api-key>` except `/health`.

### Health Check

```
GET /health
```

Returns status, uptime, and queue stats. No auth needed.

### OpenAI Format

Works with tools that expect OpenAI's API.

```bash
# List models
curl http://localhost:6789/v1/models \
  -H "Authorization: Bearer $API_KEY"

# Chat completion
curl http://localhost:6789/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sonnet",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Streaming (use -N to disable buffering)
curl -N http://localhost:6789/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sonnet",
    "stream": true,
    "messages": [{"role": "user", "content": "Write a haiku"}]
  }'
```

### Anthropic Format

```bash
curl http://localhost:6789/v1/messages \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Direct API

If you want more control (tool restrictions, working directory, sessions):

```bash
curl http://localhost:6789/api/run \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "List files here",
    "allowedTools": ["Bash", "Read"],
    "workingDirectory": "/some/path"
  }'
```

### Sessions

List and delete conversation sessions:

```bash
# List sessions
curl http://localhost:6789/api/sessions \
  -H "Authorization: Bearer $API_KEY"

# Delete a session
curl -X DELETE http://localhost:6789/api/sessions/session-id \
  -H "Authorization: Bearer $API_KEY"
```

## Testing with Insomnia

Import `insomnia-collection.json` for a ready-to-go collection with all the endpoints.

**Note:** Insomnia's default 30s timeout is too short for Claude. Go to Preferences → General → Request timeout and bump it up or set to 0 (unlimited).

## Development

```bash
npm run dev      # Dev mode with hot reload
npm test         # Run tests
npm run lint     # Lint
npm run build    # Build for production
```

## How it Works

```
Your App → HTTP Request → Proxy → spawns claude CLI → Response back
```

The proxy manages a pool of workers so multiple requests can run concurrently. Failed requests retry automatically with backoff (timeouts, rate limits). Streaming pipes chunks back as SSE.

## Limitations

- Token counts are always 0 (CLI doesn't expose them)
- Some params like `temperature` are ignored (logged but not used)
- Sessions are in-memory only, lost on restart

## License

MIT
