# Cowrite

Live commenting plugin for coding agent sessions. Select text in a browser preview, leave comments, and your coding agent receives them in real time via MCP.

**The problem:** When working with AI coding agents, there's no way to give inline, contextual feedback on specific parts of a file while the agent is working. You either interrupt with a chat message (losing spatial context) or wait until the agent is done.

**The solution:** Cowrite opens a live preview of any text file where you can select text and leave comments. The comments propagate directly into the agent session via MCP tools — so the agent can act on your feedback immediately.

## How it works

```
Browser (Preview UI)          Node.js Process              Claude Code
┌─────────────────┐     ┌──────────────────────┐     ┌──────────────┐
│ File preview     │     │  HTTP + WebSocket    │     │              │
│ Text selection   │◄───►│  server (port 3377)  │     │  MCP tools:  │
│ Comment creation │     │                      │     │              │
│ Comment sidebar  │     │  ┌────────────────┐  │     │  get_pending │
└─────────────────┘     │  │ CommentStore   │  │     │  resolve     │
                         │  │ (shared memory)│  │     │  reply       │
                         │  └───────┬────────┘  │     │  get_annotated│
                         │          │           │     │              │
                         │  ┌───────▼────────┐  │     │              │
                         │  │ MCP Server     │◄─╋────►│              │
                         │  │ (stdio)        │  │     │              │
                         │  └────────────────┘  │     └──────────────┘
                         │                      │
                         │  File Watcher        │
                         └──────────────────────┘
```

A single Node.js process runs both the HTTP/WebSocket preview server and the MCP stdio server, sharing one in-memory comment store.

## Installation

```bash
npm install -g cowrite
```

Or use directly with `npx`:

```bash
npx cowrite preview ./README.md
```

## Quick Start

### 1. Add Cowrite as an MCP server in Claude Code

```bash
# Preview mode — opens browser preview + MCP server on stdio
claude mcp add cowrite -- npx cowrite preview ./README.md

# Or serve mode — MCP only, no preview UI
claude mcp add cowrite -- npx cowrite serve
```

### 2. Open the preview

When using preview mode, Cowrite starts an HTTP server at `http://localhost:3377`. Open it in your browser.

### 3. Select text and comment

Select any text in the preview and click the comment button that appears. Write your feedback and submit.

### 4. The agent sees your comments

The agent can use these MCP tools to read and respond to your comments:

- `get_pending_comments` — retrieve unresolved comments
- `resolve_comment` — mark a comment as addressed
- `reply_to_comment` — send a reply visible in the browser
- `get_file_with_annotations` — see the file with inline comment markers

## CLI Reference

```
cowrite preview <file> [--port N]   Open browser preview + start MCP server
cowrite serve                        MCP-only mode (stdio, no preview)

Options:
  --port, -p    Port for preview server (default: 3377)
  --help, -h    Show help
```

## MCP Tools

### `get_pending_comments`

Returns unresolved comments from the live preview.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `file` | string | — | Filter by file path (optional) |
| `status` | `"pending"` \| `"resolved"` \| `"all"` | `"pending"` | Filter by status |

### `resolve_comment`

Marks a comment as addressed. The browser UI updates to show the resolved state.

| Parameter | Type | Description |
|-----------|------|-------------|
| `commentId` | string | The comment ID to resolve |

### `reply_to_comment`

Sends a reply from the agent, visible in the browser comment sidebar.

| Parameter | Type | Description |
|-----------|------|-------------|
| `commentId` | string | The comment ID to reply to |
| `reply` | string | The reply text |

### `get_file_with_annotations`

Returns the file content with inline comment markers at the positions where comments are anchored:

```
Hello world, this is a test. [COMMENT #a1b2c3d4: "Should be uppercase"]
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `file` | string | File path to annotate |

## MCP Resources

| URI | Description |
|-----|-------------|
| `cowrite://comments` | Live list of all comments (subscribable) |

## Features

- **Live file watching** — Edit the file externally and the preview updates instantly. Comments re-anchor to their selected text automatically.
- **Markdown rendering** — `.md` files are rendered as formatted HTML. All other text files display with syntax-preserved plain text.
- **Persistent comments** — Comments are saved to `.cowrite-comments.json` in the project directory and survive restarts.
- **Offset-based anchoring** — Comments are anchored by character offset and selected text, not line numbers. When the file changes, Cowrite searches for the selected text near the original offset to re-anchor.
- **Agent replies** — The agent can reply to comments, and replies appear in the browser sidebar in real time.

## Using the `/review` Skill

Cowrite ships with a built-in skill. When working in Claude Code with Cowrite active, you can use:

```
/review
```

This instructs the agent to check all pending comments, address them, reply, and resolve each one.

## Development

```bash
git clone https://github.com/your-username/cowrite.git
cd cowrite
npm install

# Run in dev mode (uses tsx for live TS execution)
npm run dev -- preview ./README.md

# Run tests
npm test

# Type-check
npm run lint

# Build for distribution
npm run build
```

## Project Structure

```
cowrite/
├── bin/cowrite.ts              # CLI entry point
├── src/
│   ├── types.ts                # TypeScript interfaces
│   ├── comment-store.ts        # In-memory comment store with persistence
│   ├── mcp-server.ts           # MCP tools and resources
│   ├── preview-server.ts       # HTTP + WebSocket server
│   ├── file-watcher.ts         # File change detection
│   └── utils.ts                # Markdown rendering, annotation
├── ui/
│   ├── index.html              # Browser preview app
│   ├── styles.css              # Dark theme styles
│   └── client.js               # Selection handling, WebSocket client
├── skills/review/SKILL.md      # Agent skill for reviewing comments
└── test/                       # Vitest tests
```

## How Comments Flow

1. You select text in the browser and submit a comment
2. The browser sends a WebSocket message to the server
3. The server adds the comment to the shared `CommentStore`
4. The store emits a `"change"` event
5. The MCP server sends a `notifications/resources/updated` notification
6. The agent calls `get_pending_comments` to retrieve the comment
7. The agent makes changes, then calls `resolve_comment`
8. The browser receives the update via WebSocket and shows the resolved state

## License

MIT
