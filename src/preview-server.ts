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

/**
 * Strip common markdown inline formatting markers (**, __, ~~) and build a
 * position mapping from stripped text indices back to raw content indices.
 * Used to match ProseMirror flat text against raw markdown file content.
 */
function stripMarkdownFormatting(raw: string): { plain: string; toRaw: number[] } {
  const toRaw: number[] = [];
  let plain = "";
  let i = 0;

  while (i < raw.length) {
    // Skip **, __, ~~
    if (i + 1 < raw.length) {
      const pair = raw[i] + raw[i + 1];
      if (pair === "**" || pair === "__" || pair === "~~") {
        i += 2;
        continue;
      }
    }

    toRaw.push(i);
    plain += raw[i];
    i++;
  }

  return { plain, toRaw };
}

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
          anchor: msg.anchor,
        });
        break;
      }
      case "comment_reply":
        store.addReply(msg.commentId, "user", msg.text);
        break;
      case "comment_resolve":
        store.resolve(msg.commentId);
        break;
      case "comment_reopen":
        store.reopen(msg.commentId);
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
        watcher.setContent(newContent);
        break;
      }
      case "proposal_apply": {
        const comment = store.get(msg.commentId);
        if (!comment) {
          send(ws, { type: "error", message: "Comment not found" });
          break;
        }
        const reply = comment.replies.find((r) => r.id === msg.replyId);
        if (!reply?.proposal || reply.proposal.status !== "pending") {
          send(ws, { type: "error", message: "Proposal not found or not pending" });
          break;
        }
        const pFile = comment.file;
        const pWatcher = watchers.get(pFile);
        if (!pWatcher) {
          send(ws, { type: "error", message: "File not being watched" });
          break;
        }
        const pContent = pWatcher.getContent();
        // Find the selected text in file content — the stored offset may be
        // ProseMirror-based (flat text) rather than raw file offset, so we
        // search near the stored offset first, then fall back to global search.
        const oldText = reply.proposal.oldText || comment.selectedText;
        let replaceStart = -1;
        let replaceEnd = -1;

        // Strategy 1: direct search in raw content (works for non-markdown files)
        let pIdx = pContent.indexOf(oldText, Math.max(0, comment.offset - 200));
        if (pIdx === -1 || Math.abs(pIdx - comment.offset) > 500) {
          pIdx = pContent.indexOf(oldText);
        }
        if (pIdx !== -1) {
          replaceStart = pIdx;
          replaceEnd = pIdx + oldText.length;
        }

        // Strategy 2: markdown-aware search — strip inline formatting markers
        // and search for ProseMirror flat text in the stripped content
        if (replaceStart === -1) {
          const { plain, toRaw } = stripMarkdownFormatting(pContent);
          let plainIdx = plain.indexOf(oldText, Math.max(0, comment.offset - 200));
          if (plainIdx === -1 || Math.abs(plainIdx - comment.offset) > 500) {
            plainIdx = plain.indexOf(oldText);
          }
          if (plainIdx !== -1 && plainIdx + oldText.length - 1 < toRaw.length) {
            replaceStart = toRaw[plainIdx];
            replaceEnd = toRaw[plainIdx + oldText.length - 1] + 1;
            // Expand boundaries to include adjacent formatting markers (**, ~~, etc.)
            while (replaceStart > 0 && "*_~".includes(pContent[replaceStart - 1])) replaceStart--;
            while (replaceEnd < pContent.length && "*_~".includes(pContent[replaceEnd])) replaceEnd++;
          }
        }

        if (replaceStart === -1) {
          send(ws, { type: "error", message: "File content has changed — selected text no longer found" });
          break;
        }
        const pNewContent = pContent.slice(0, replaceStart) + reply.proposal.newText + pContent.slice(replaceEnd);
        await writeFile(pFile, pNewContent, "utf-8");
        // Suppress chokidar echo and handle adjustments + broadcast manually
        // to avoid racing persist() calls between adjustOffsets and updateProposalStatus
        pWatcher.setContent(pNewContent);
        store.adjustOffsets(pFile, pContent, pNewContent);
        store.updateProposalStatus(msg.commentId, msg.replyId, "applied");
        // Broadcast file update to clients (since chokidar echo is suppressed)
        const pHtml = renderToHtml(pNewContent, pFile);
        for (const [ws2, f] of clientFiles) {
          if (f === pFile) {
            send(ws2, { type: "file_update", file: pFile, content: pNewContent, html: pHtml });
          }
        }
        break;
      }
      case "proposal_reject": {
        store.updateProposalStatus(msg.commentId, msg.replyId, "rejected");
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
