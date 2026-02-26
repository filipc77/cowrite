import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync, unlinkSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CommentStore } from "../src/comment-store.js";
import { createMcpServer } from "../src/mcp-server.js";
import { createPreviewServer } from "../src/preview-server.js";
import { openBrowser } from "../src/utils.js";
import updateNotifier from "update-notifier";
import { createRequire } from "node:module";

declare const __COWRITE_VERSION__: string | undefined;
const version: string = typeof __COWRITE_VERSION__ !== "undefined"
  ? __COWRITE_VERSION__
  : (createRequire(import.meta.url)("../package.json") as { version: string }).version;

const USAGE = `
cowrite — Live commenting plugin for coding agent sessions

Usage:
  cowrite init                         Install hooks and skills into .claude/ (run once per project)
  cowrite serve [--port N]             Start MCP server + preview server (browse any file)
  cowrite preview <file> [--port N]    Open browser preview for a specific file + start MCP server
  cowrite open [--port N]              Open the browser to the preview URL

Options:
  --port, -p    Port for preview server (default: 3377)
  --no-open     Don't auto-open the browser
  --help, -h    Show this help
`;

const PORT_FILE = ".cowrite-port";

function writePortFile(projectDir: string, port: number): void {
  writeFileSync(join(projectDir, PORT_FILE), String(port), "utf-8");
}

function removePortFile(projectDir: string): void {
  try { unlinkSync(join(projectDir, PORT_FILE)); } catch {}
}

function readPortFile(projectDir: string): number | null {
  try {
    const content = readFileSync(join(projectDir, PORT_FILE), "utf-8").trim();
    const port = parseInt(content, 10);
    return isNaN(port) ? null : port;
  } catch {
    return null;
  }
}

function setupShutdown(store: CommentStore, preview: { stop: () => Promise<void>; [k: string]: any }, projectDir: string) {
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) {
      // Second signal — force exit immediately
      process.exit(1);
    }
    shuttingDown = true;
    process.stderr.write("Shutting down...\n");
    removePortFile(projectDir);
    // Best-effort cleanup with a hard timeout
    Promise.allSettled([store.stopWatching(), preview.stop()])
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const HOOK_SCRIPT = `#!/bin/bash
# Auto-installed by cowrite — injects pending comments into Claude Code context.
# Only outputs when there are pending comments. Silent otherwise.
COMMENTS_FILE="\${CLAUDE_PROJECT_DIR:-.}/.cowrite-comments.json"
if [ ! -f "$COMMENTS_FILE" ] || [ ! -s "$COMMENTS_FILE" ]; then exit 0; fi
PENDING=$(jq '[.[] | select(.status == "pending")] | length' "$COMMENTS_FILE" 2>/dev/null || echo 0)
if [ "$PENDING" -eq 0 ]; then exit 0; fi
jq -r '[.[] | select(.status == "pending")] | "COWRITE: \\(length) pending comment(s) from the live preview. For EACH comment: (1) make the requested change, (2) call reply_to_comment to explain what you did. Your reply automatically marks it as answered. The user will review and resolve it.\\n" + ([.[] | "- [\\(.id)] File: \\(.file | split("/") | last) | Text: \\"\\(.selectedText)\\" | Comment: \\(.comment)"] | join("\\n"))' "$COMMENTS_FILE" 2>/dev/null
`;

const HOOK_ENTRY = {
  matcher: "",
  hooks: [{
    type: "command",
    command: `bash "$CLAUDE_PROJECT_DIR/.claude/hooks/inject-comments.sh"`,
  }],
};

const HOOK_SETTINGS = {
  hooks: {
    UserPromptSubmit: [HOOK_ENTRY],
    Stop: [HOOK_ENTRY],
  },
};

const SKILL_REVIEW = `---
name: review
description: Check and address cowrite comments left by the user in the live preview
user_invocable: true
---

# Review Cowrite Comments

Check for any pending comments left in the Cowrite live preview and address them.

## Steps

1. Call the \`get_pending_comments\` tool to retrieve all unresolved comments.
2. For each pending comment:
   a. Read the comment text and the selected text it refers to.
   b. Use \`get_file_with_annotations\` to see the comment in context.
   c. Make the requested change or reply explaining why you can't.
   d. Call \`reply_to_comment\` to acknowledge the feedback. Your reply automatically marks it as "answered". The user will review and resolve it.
3. Summarize what was done.
`;

const SKILL_WATCH = `---
name: watch
description: Start a background watcher for cowrite comments — does not block the main conversation
user_invocable: true
---

# Watch for Live Comments (Background)

Start a background agent that watches for cowrite comments and handles them as they arrive. The main conversation stays free for other work.

## Steps

1. First, handle any existing pending comments:
   a. Call \`get_pending_comments\` to check for unresolved comments.
   b. For each pending comment, use \`get_file_with_annotations\` to see context, make the change, and call \`reply_to_comment\`. Your reply automatically marks it as "answered".

2. Then, launch a **background** watcher using the Task tool:
   - Use \`subagent_type: "general-purpose"\` and \`run_in_background: true\`
   - The background agent should call \`wait_for_comment\` in a loop
   - When a comment arrives, it handles it (read file, make change, reply)
   - On timeout, it re-calls \`wait_for_comment\` immediately
   - The loop continues until the user says stop

3. Tell the user the background watcher is running and they can continue working normally. Comments will be handled automatically.
`;

function installClaudeIntegration(projectDir: string): void {
  const claudeDir = join(projectDir, ".claude");
  const hooksDir = join(claudeDir, "hooks");
  const hookPath = join(hooksDir, "inject-comments.sh");
  const settingsPath = join(claudeDir, "settings.json");
  const reviewDir = join(claudeDir, "skills", "review");
  const watchDir = join(claudeDir, "skills", "watch");

  // Create directories
  for (const dir of [hooksDir, reviewDir, watchDir]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  // Write hook script (always overwrite to keep in sync with cowrite version)
  writeFileSync(hookPath, HOOK_SCRIPT, "utf-8");
  chmodSync(hookPath, 0o755);

  // Write skills (always overwrite to keep in sync)
  writeFileSync(join(reviewDir, "SKILL.md"), SKILL_REVIEW, "utf-8");
  writeFileSync(join(watchDir, "SKILL.md"), SKILL_WATCH, "utf-8");

  // Merge cowrite hooks into settings.json (preserve existing settings)
  let settings: any = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      // Corrupt JSON — overwrite
    }
  }
  if (!settings.hooks) settings.hooks = {};
  let changed = false;
  for (const eventType of ["UserPromptSubmit", "Stop"] as const) {
    if (!Array.isArray(settings.hooks[eventType])) settings.hooks[eventType] = [];
    const hasCowriteHook = settings.hooks[eventType].some((entry: any) =>
      entry.hooks?.some((h: any) => h.command?.includes("inject-comments.sh"))
    );
    if (!hasCowriteHook) {
      settings.hooks[eventType].push(HOOK_ENTRY);
      changed = true;
    }
  }
  if (changed) {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      port: { type: "string", short: "p", default: "3377" },
      "no-open": { type: "boolean", default: false },
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

  updateNotifier({ pkg: { name: "@filipc77/cowrite", version } }).notify({ isGlobal: true });

  const projectDir = process.cwd();
  const port = parseInt(values.port as string, 10);

  // Auto-install Claude Code hooks for comment propagation
  installClaudeIntegration(projectDir);

  if (command === "serve") {
    const store = new CommentStore(projectDir);
    await store.load();
    await store.startWatching();

    // Start preview server (non-fatal — MCP works even if port is taken)
    const preview = createPreviewServer(store, projectDir, port);
    let previewRunning = false;
    try {
      await preview.start();
      previewRunning = true;
      writePortFile(projectDir, preview.port);
      const previewUrl = `http://localhost:${preview.port}`;
      process.stderr.write(`Preview: ${previewUrl}\n`);
      if (!values["no-open"]) openBrowser(previewUrl);
    } catch (err) {
      process.stderr.write(`Preview server failed: ${err}\n`);
      process.stderr.write(`MCP server will still run — comments sync via .cowrite-comments.json\n`);
    }

    // Start MCP server on stdio
    const mcpServer = createMcpServer(store, projectDir, () => previewRunning ? preview.port : null);
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);

    process.stderr.write(`Cowrite MCP server running on stdio\n`);

    setupShutdown(store, preview, projectDir);
  } else if (command === "preview") {
    const filePath = positionals[1];
    if (!filePath) {
      process.stderr.write("Error: preview command requires a file path\n");
      process.stderr.write(USAGE);
      process.exit(1);
    }

    const resolvedFile = resolve(projectDir, filePath);

    const store = new CommentStore(projectDir);
    await store.load();
    await store.startWatching();

    // Start preview server (non-fatal — MCP works even if port is taken)
    const preview = createPreviewServer(store, projectDir, port, resolvedFile);
    let previewRunning2 = false;
    try {
      await preview.start();
      previewRunning2 = true;
      writePortFile(projectDir, preview.port);
      const previewUrl = `http://localhost:${preview.port}`;
      process.stderr.write(`Preview: ${previewUrl}\n`);
      if (!values["no-open"]) openBrowser(previewUrl);
    } catch (err) {
      process.stderr.write(`Preview server failed: ${err}\n`);
      process.stderr.write(`MCP server will still run — comments sync via .cowrite-comments.json\n`);
    }

    // Start MCP server on stdio
    const mcpServer = createMcpServer(store, projectDir, () => previewRunning2 ? preview.port : null);
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);

    process.stderr.write(`Cowrite MCP server running on stdio\n`);

    setupShutdown(store, preview, projectDir);
  } else if (command === "init") {
    process.stderr.write("Installed cowrite hooks and skills into .claude/\n");
  } else if (command === "open") {
    const discoveredPort = readPortFile(projectDir) ?? port;
    const url = `http://localhost:${discoveredPort}`;
    process.stderr.write(`Opening ${url}\n`);
    await openBrowser(url);
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
