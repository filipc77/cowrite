# Cowrite — VS Code Extension

Live commenting for coding agent sessions. Select text in your editor, leave comments, and the agent receives them via MCP tools in real time.

## Features

- **Inline comments** — Select text, right-click → "Cowrite: Add Comment"
- **Native Comment API** — Uses VS Code's built-in comment threads with reply/resolve
- **Real-time sync** — Comments sync via `.cowrite-comments.json` — no server required
- **Decorations** — Highlighted ranges with gutter icons (yellow=pending, green=resolved)
- **Status bar** — Shows pending comment count

## How It Works

The extension reads and writes `.cowrite-comments.json` in your workspace root. The Cowrite MCP server watches the same file. Changes from either side are detected via file system watchers.

```
VS Code Extension ←→ .cowrite-comments.json ←→ MCP Server (cowrite serve)
```

## Commands

| Command | Description |
|---------|-------------|
| `Cowrite: Add Comment` | Add a comment on selected text (also in right-click menu) |
| `Cowrite: Refresh Comments` | Manually reload comments from file |

## Getting Started

1. Install the extension
2. Open a workspace that has (or will have) a `.cowrite-comments.json` file
3. Select text and use "Cowrite: Add Comment" from the right-click menu
4. Run `cowrite serve` to start the MCP server — it will pick up your comments

## Development

```bash
cd vscode-cowrite
npm install
npm run build    # Bundle with esbuild
npm run watch    # Watch mode
npm run lint     # Type check
```
