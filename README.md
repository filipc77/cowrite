# Cowrite

Live commenting plugin for coding agent sessions. Select text in a browser preview, leave comments, and your coding agent receives them in real time via MCP. Works with any MCP-compatible coding agent — optimized for Claude Code with auto-installed hooks and skills.

**The problem:** When working with AI coding agents, there's no way to give inline, contextual feedback on specific parts of a file while the agent is working. You either interrupt with a chat message (losing spatial context) or wait until the agent is done.

**The solution:** Cowrite opens a live preview of any text file where you can select text and leave comments. The comments propagate directly into the agent session via MCP tools — so the agent can act on your feedback immediately. Any agent that supports MCP can use Cowrite's tools (`get_pending_comments`, `resolve_comment`, etc.). Claude Code users get additional integration: auto-installed hooks that surface comments on every prompt, and `/review` + `/watch` skills.

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
                         │          │           │     │  wait_for_comment│
                         │  ┌───────▼────────┐  │     │              │
                         │  │ MCP Server     │◄─╋────►│              │
                         │  │ (stdio)        │  │     │              │
                         │  └────────────────┘  │     └──────────────┘
                         │                      │
                         │  File Watcher        │
                         └──────────────────────┘
```

A single Node.js process runs both the HTTP/WebSocket preview server and the MCP stdio server, sharing one in-memory comment store.

## Quick Start

### 1. Add Cowrite as an MCP server in Claude Code

No install required — `npx` downloads and runs it automatically:

```bash
claude mcp add -s user cowrite -- npx -y @filipc77/cowrite serve
```

### 2. Open the preview

Ask the agent "what's the cowrite preview URL?" — it will call the `get_preview_url` tool and give you the link. The default port is `3377`, but if it's in use (e.g. running cowrite in multiple repos), it automatically picks the next available port.

Open the URL in your browser, pick a file, and you'll see a live preview.

### 3. Select text and comment

Select any text in the preview. A **Comment** button appears — click it to open the comment form. Your text selection stays intact, so you can still copy-paste normally.

### 4. Start the background watcher (recommended)

In your Claude Code session, type:

```
/watch
```

This starts a background watcher that handles comments as they arrive — without blocking your main conversation. You only need to do this once per session.

### 5. The agent handles your comments

Even without `/watch`, comments reach the agent through auto-installed hooks:

- **`UserPromptSubmit` hook** — Whenever you send any message, pending comments are injected into the agent's context. The agent makes the change, replies in the browser preview, and resolves the comment.
- **`Stop` hook** — When the agent finishes any task, it checks for pending comments before going idle. Catches comments that arrive while the agent is busy.

### 6. Auto-installed integration

On first run, `cowrite serve` installs into your project's `.claude/` directory:
- **Hooks** (`UserPromptSubmit` + `Stop`) — surface pending comments to the agent automatically
- **Skills** (`/review` + `/watch`) — manual and background comment handling
- Hooks are merged into existing `settings.json` — your other settings are preserved

## CLI Reference

```
cowrite preview <file> [--port N]   Open browser preview for a specific file + start MCP server
cowrite serve [--port N]             Start MCP server + preview server (browse any file)

Options:
  --port, -p    Port for preview server (default: 3377)
  --help, -h    Show help
```

## MCP Tools

### `get_preview_url`

Returns the URL of the live preview server. Ask the agent for this to know which port to open.

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

### `wait_for_comment`

Blocks until a new comment is posted in the live preview, then returns it. If pending comments already exist, returns the latest one immediately. Times out after 30 seconds by default.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `timeout` | number | 30 | Max seconds to wait |

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
- **Auto-port selection** — If port 3377 is in use (e.g. running cowrite in multiple repos), it automatically tries the next port (3378, 3379, etc.).
- **Auto-installed hooks** — `cowrite serve` automatically installs Claude Code `UserPromptSubmit` and `Stop` hooks that surface pending comments to the agent. Merges with existing settings.

## Skills

Cowrite ships with two built-in Claude Code skills (auto-installed to `.claude/skills/`):

- **`/review`** — Check all pending comments, make changes, reply in the preview, and resolve each one.
- **`/watch`** — Start a background watcher that handles comments as they arrive. Does **not** block the main conversation — you can keep working normally while comments are handled in the background.

## How Comments Flow

1. You select text in the browser and submit a comment
2. The browser sends a WebSocket message to the server
3. The server adds the comment to the shared `CommentStore`
4. The store persists to `.cowrite-comments.json` and emits events
5. The agent receives the comment via one of:
   - The `Stop` hook catching it when the agent finishes its current task
   - The `UserPromptSubmit` hook injecting it on the next user message
   - `wait_for_comment` returning immediately (if `/watch` is active)
   - The agent calling `get_pending_comments` directly
6. The agent makes the change, calls `reply_to_comment` (visible in the browser), then `resolve_comment`
7. The browser receives the update via WebSocket and shows the reply and resolved state

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
├── bin/cowrite.ts              # CLI entry point (auto-installs hooks)
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
├── .claude/
│   ├── skills/                 # Agent skills (review, watch)
│   └── hooks/                  # Auto-installed comment injection hook
└── test/                       # Vitest tests
```

## License

MIT
