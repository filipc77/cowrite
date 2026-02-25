# Contributing to Cowrite

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/your-username/cowrite.git
cd cowrite
npm install
```

## Running Locally

```bash
# Dev mode with live TypeScript execution
npm run dev -- preview ./README.md

# Run tests
npm test

# Watch mode for tests
npm run test:watch

# Type-check without emitting
npm run lint
```

## Project Architecture

Cowrite is a single Node.js process that runs two servers sharing one in-memory `CommentStore`:

1. **MCP Server** (stdio) — Exposes tools (`get_pending_comments`, `resolve_comment`, `reply_to_comment`, `get_file_with_annotations`) and resources to the coding agent.
2. **Preview Server** (HTTP + WebSocket) — Serves the browser UI and handles real-time comment updates.

Key constraint: **stdout is reserved for MCP JSON-RPC**. All logging must go to `stderr` via `process.stderr.write()`.

### Source Layout

| Directory | Purpose |
|-----------|---------|
| `bin/` | CLI entry point |
| `src/` | Core TypeScript modules |
| `ui/` | Browser UI (plain HTML/CSS/JS, no build step) |
| `test/` | Vitest tests |
| `skills/` | Agent skills |

### Key Modules

- **`comment-store.ts`** — CRUD operations, EventEmitter for change notifications, JSON file persistence, offset re-anchoring on file changes.
- **`mcp-server.ts`** — Registers MCP tools and resources using the official SDK. Wires store change events to MCP resource update notifications.
- **`preview-server.ts`** — HTTP server for static UI files + `/api/state` endpoint. WebSocket server for real-time comment and file-change updates.
- **`file-watcher.ts`** — Uses chokidar to watch the target file. Emits change events with old and new content for offset adjustment.

## Guidelines

- Keep the UI dependency-free — plain HTML/CSS/JS, no bundler or framework.
- All new features should have tests.
- Comments use character offsets (not line numbers) for anchoring.
- Use `process.stderr.write()` for any logging — never `console.log()`.

## Running Tests

```bash
npm test
```

Tests use vitest with in-memory MCP transports and temporary directories. No external services are needed.

## Submitting Changes

1. Fork the repo and create a feature branch.
2. Make your changes with tests.
3. Run `npm test` and `npm run lint` to verify.
4. Open a pull request with a clear description.
