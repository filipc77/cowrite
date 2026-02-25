# Cowrite

Live commenting plugin for coding agent sessions. Users open a file preview in the browser, select text, leave comments — and the agent receives them via MCP tools in real time.

## Tech Stack
- TypeScript (strict), Node.js >= 18
- MCP SDK (`@modelcontextprotocol/sdk`) for Claude Code integration
- `ws` for WebSocket, `chokidar` for file watching, `marked` for markdown
- No frontend framework — plain HTML/CSS/JS in `ui/`

## Project Layout
- `bin/cowrite.ts` — CLI entry point (preview + serve commands)
- `src/` — Core: types, comment-store, mcp-server, preview-server, file-watcher, utils
- `ui/` — Browser preview: index.html, styles.css, client.js
- `skills/` — Agent skills (e.g., review comments)
- `test/` — vitest tests

## Key Commands
- `npm run dev` — run preview in dev mode
- `npm test` — run vitest
- `npm run build` — tsup build to dist/
- `npm run lint` — tsc --noEmit

## Architecture Rules
- Single process runs MCP (stdio) + HTTP/WS preview server, sharing one CommentStore
- stdout is RESERVED for MCP JSON-RPC — all logging goes to stderr
- Comments persist to `.cowrite-comments.json` (gitignored)
- Comment anchoring uses character offsets, not line numbers
- UI has no build step — plain JS served directly
