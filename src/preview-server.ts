import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { CommentStore } from "./comment-store.js";
import { FileWatcher } from "./file-watcher.js";
import { renderToHtml } from "./utils.js";
import type { WSClientMessage, WSServerMessage } from "./types.js";

// In dev (tsx): import.meta.dirname is src/, so ../ui works.
// In built (dist/bin/cowrite.js): import.meta.dirname is dist/bin/, so ../../ui.
// We find ui/ by checking which path actually contains index.html.
function findUiDir(): string {
  const dir = import.meta.dirname ?? new URL(".", import.meta.url).pathname;
  // Try common locations relative to this file
  const candidates = [
    join(dir, "..", "ui"),       // dev: src/../ui
    join(dir, "..", "..", "ui"), // built: dist/bin/../../ui
  ];
  return candidates.find((d) => {
    try { return existsSync(join(d, "index.html")); } catch { return false; }
  }) ?? candidates[0];
}
const UI_DIR = findUiDir();

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
};

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", ".next", ".cache", "coverage", "__pycache__"]);

export function createPreviewServer(
  store: CommentStore,
  projectDir: string,
  port: number,
  initialFile?: string
): { port: number; start: () => Promise<void>; stop: () => Promise<void> } {
  const clients = new Set<WebSocket>();
  const clientFiles = new Map<WebSocket, string>(); // ws -> absolute file path
  const watchers = new Map<string, FileWatcher>(); // absolute path -> watcher
  const watcherListeners = new Map<string, (...args: any[]) => void>(); // path -> change listener

  const resolvedProjectDir = resolve(projectDir);

  function isInsideProject(filePath: string): boolean {
    const resolved = resolve(resolvedProjectDir, filePath);
    return resolved.startsWith(resolvedProjectDir);
  }

  async function getOrCreateWatcher(absPath: string): Promise<FileWatcher> {
    let watcher = watchers.get(absPath);
    if (!watcher) {
      watcher = new FileWatcher(absPath);
      await watcher.start();
      watchers.set(absPath, watcher);

      // Subscribe to file changes and broadcast to relevant clients
      const listener = (event: { file: string; content: string; oldContent: string }) => {
        store.adjustOffsets(event.file, event.oldContent, event.content);
        const html = renderToHtml(event.content, event.file);
        for (const [ws, file] of clientFiles) {
          if (file === absPath) {
            send(ws, { type: "file_update", file: event.file, content: event.content, html });
          }
        }
      };
      watcher.on("change", listener);
      watcherListeners.set(absPath, listener);
    }
    return watcher;
  }

  async function listFiles(dir: string, prefix = ""): Promise<string[]> {
    const files: string[] = [];
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          const sub = await listFiles(join(dir, entry.name), relPath);
          files.push(...sub);
        } else {
          files.push(relPath);
        }
      }
    } catch {
      // Permission denied or gone — skip
    }
    return files;
  }

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;

    // Serve static UI files
    const ext = pathname.slice(pathname.lastIndexOf("."));
    const mimeType = MIME_TYPES[ext];
    if (mimeType) {
      try {
        const filePath = join(UI_DIR, pathname);
        const content = await readFile(filePath, "utf-8");
        res.writeHead(200, { "Content-Type": mimeType });
        res.end(content);
        return;
      } catch {
        // Fall through to 404
      }
    }

    // API: GET /api/files — list project files for the file picker
    if (pathname === "/api/files") {
      const files = await listFiles(resolvedProjectDir);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ files }));
      return;
    }

    // API: GET /api/state?file=... — state for a specific file
    if (pathname === "/api/state") {
      const fileParam = url.searchParams.get("file");
      if (!fileParam) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing file parameter" }));
        return;
      }
      const absPath = resolve(resolvedProjectDir, fileParam);
      if (!isInsideProject(absPath)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Path outside project" }));
        return;
      }
      try {
        const content = await readFile(absPath, "utf-8");
        const html = renderToHtml(content, absPath);
        const comments = store.getForFile(absPath);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ file: absPath, content, html, comments }));
      } catch {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "File not found" }));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  const wss = new WebSocketServer({ server: httpServer });

  // Prevent unhandled WSS errors from crashing the process (e.g. EADDRINUSE)
  wss.on("error", () => {});

  wss.on("connection", async (ws: WebSocket) => {
    clients.add(ws);

    // If there's an initial file (preview mode), auto-assign it
    if (initialFile) {
      const absPath = resolve(resolvedProjectDir, initialFile);
      await switchClientFile(ws, absPath);
    }

    ws.on("message", async (data) => {
      try {
        const msg: WSClientMessage = JSON.parse(data.toString());
        await handleClientMessage(ws, msg);
      } catch (err) {
        send(ws, { type: "error", message: `Invalid message: ${err}` });
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
      clientFiles.delete(ws);
    });
  });

  async function switchClientFile(ws: WebSocket, absPath: string): Promise<void> {
    if (!isInsideProject(absPath)) {
      send(ws, { type: "error", message: "Path outside project" });
      return;
    }
    try {
      const watcher = await getOrCreateWatcher(absPath);
      clientFiles.set(ws, absPath);
      const content = watcher.getContent();
      const html = renderToHtml(content, absPath);
      const comments = store.getForFile(absPath);
      send(ws, { type: "file_update", file: absPath, content, html });
      send(ws, { type: "comments_update", comments });
    } catch (err) {
      send(ws, { type: "error", message: `Cannot open file: ${err}` });
    }
  }

  async function handleClientMessage(ws: WebSocket, msg: WSClientMessage): Promise<void> {
    switch (msg.type) {
      case "switch_file": {
        const absPath = resolve(resolvedProjectDir, msg.file);
        await switchClientFile(ws, absPath);
        break;
      }
      case "comment_add": {
        const file = clientFiles.get(ws);
        if (!file) break;
        store.add({
          file,
          offset: msg.offset,
          length: msg.length,
          selectedText: msg.selectedText,
          comment: msg.comment,
        });
        break;
      }
      case "comment_reply":
        store.addReply(msg.commentId, "user", msg.text);
        break;
      case "comment_resolve":
        store.resolve(msg.commentId);
        break;
      case "comment_delete":
        store.delete(msg.commentId);
        break;
      case "edit_apply": {
        const file = clientFiles.get(ws);
        if (!file) break;
        const watcher = watchers.get(file);
        if (!watcher) break;
        const content = watcher.getContent();
        if (msg.offset < 0 || msg.offset + msg.length > content.length) {
          send(ws, { type: "error", message: "Edit offset/length out of bounds" });
          break;
        }
        const newContent = content.slice(0, msg.offset) + msg.newText + content.slice(msg.offset + msg.length);
        await writeFile(file, newContent, "utf-8");
        break;
      }
    }
  }

  // Broadcast comment updates to clients viewing the affected file
  store.on("change", (comment: any) => {
    for (const [ws, file] of clientFiles) {
      // If we know which file changed, only notify relevant clients
      // If comment is null (e.g. adjustOffsets, reload), notify all
      if (!comment || comment.file === file) {
        const comments = store.getForFile(file);
        send(ws, { type: "comments_update", comments });
      }
    }
  });

  function send(ws: WebSocket, msg: WSServerMessage): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  let actualPort = port;

  return {
    get port() { return actualPort; },
    start: () => {
      const maxRetries = 10;
      const tryListen = (p: number, attempt: number): Promise<void> =>
        new Promise<void>((res, rej) => {
          const onError = (err: NodeJS.ErrnoException) => {
            if (err.code === "EADDRINUSE" && attempt < maxRetries) {
              httpServer.removeListener("error", onError);
              res(tryListen(p + 1, attempt + 1));
            } else {
              rej(err);
            }
          };
          httpServer.on("error", onError);
          httpServer.listen(p, () => {
            httpServer.removeListener("error", onError);
            actualPort = p;
            process.stderr.write(`Cowrite preview server running at http://localhost:${p}\n`);
            res();
          });
        });
      return tryListen(port, 0);
    },
    stop: async () => {
      for (const client of clients) {
        client.close();
      }
      for (const [path, watcher] of watchers) {
        const listener = watcherListeners.get(path);
        if (listener) watcher.off("change", listener);
        await watcher.stop();
      }
      watchers.clear();
      watcherListeners.clear();
      await new Promise<void>((resolvePromise, reject) => {
        httpServer.close((err) => {
          if (err) reject(err);
          else resolvePromise();
        });
      });
    },
  };
}
