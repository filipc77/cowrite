import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CommentStore } from "../src/comment-store.js";
import { createMcpServer } from "../src/mcp-server.js";
import { createPreviewServer } from "../src/preview-server.js";
import { FileWatcher } from "../src/file-watcher.js";

const USAGE = `
cowrite — Live commenting plugin for coding agent sessions

Usage:
  cowrite preview <file> [--port N]   Open browser preview + start MCP server
  cowrite serve                        MCP-only mode (stdio, no preview)

Options:
  --port, -p    Port for preview server (default: 3377)
  --help, -h    Show this help
`;

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      port: { type: "string", short: "p", default: "3377" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help || positionals.length === 0) {
    process.stderr.write(USAGE);
    process.exit(positionals.length === 0 && !values.help ? 1 : 0);
  }

  const command = positionals[0];
  const projectDir = process.cwd();

  if (command === "serve") {
    // MCP-only mode
    const store = new CommentStore(projectDir);
    await store.load();
    await store.startWatching();
    const mcpServer = createMcpServer(store, projectDir);
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    process.stderr.write("Cowrite MCP server running on stdio\n");
  } else if (command === "preview") {
    const filePath = positionals[1];
    if (!filePath) {
      process.stderr.write("Error: preview command requires a file path\n");
      process.stderr.write(USAGE);
      process.exit(1);
    }

    const resolvedFile = resolve(projectDir, filePath);
    const port = parseInt(values.port as string, 10);

    const store = new CommentStore(projectDir);
    await store.load();
    await store.startWatching();

    // Start file watcher
    const watcher = new FileWatcher(resolvedFile);
    await watcher.start();

    // Start preview server
    const preview = createPreviewServer(store, watcher, port);
    await preview.start();

    // Start MCP server on stdio
    const mcpServer = createMcpServer(store, projectDir);
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);

    process.stderr.write(`Cowrite MCP server running on stdio\n`);
    process.stderr.write(`Preview: http://localhost:${port}\n`);

    // Graceful shutdown
    const shutdown = async () => {
      process.stderr.write("Shutting down...\n");
      await store.stopWatching();
      await watcher.stop();
      await preview.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } else {
    process.stderr.write(`Unknown command: ${command}\n`);
    process.stderr.write(USAGE);
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  process.exit(1);
});
