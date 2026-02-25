import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { CommentStore } from "./comment-store.js";
import type { FileWatcher } from "./file-watcher.js";
import { renderToHtml } from "./utils.js";
import type { WSClientMessage, WSServerMessage } from "./types.js";

const UI_DIR = join(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..", "ui");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
};

export function createPreviewServer(
  store: CommentStore,
  watcher: FileWatcher,
  port: number
): { start: () => Promise<void>; stop: () => Promise<void> } {
  const clients = new Set<WebSocket>();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;

    // Serve static UI files
    const ext = pathname.slice(pathname.lastIndexOf("."));
    const mimeType = MIME_TYPES[ext];
    if (mimeType) {
      try {
        // Resolve UI_DIR properly for both dev (tsx) and built (dist) modes
        let uiDir: string;
        if (import.meta.dirname) {
          uiDir = join(import.meta.dirname, "..", "ui");
        } else {
          uiDir = join(new URL(".", import.meta.url).pathname, "..", "ui");
        }
        const filePath = join(uiDir, pathname);
        const content = await readFile(filePath, "utf-8");
        res.writeHead(200, { "Content-Type": mimeType });
        res.end(content);
        return;
      } catch {
        // Fall through to 404
      }
    }

    // API: GET /api/state — initial state for the client
    if (pathname === "/api/state") {
      const fileContent = watcher.getContent();
      const html = renderToHtml(fileContent, watcher.getFilePath());
      const comments = store.getForFile(watcher.getFilePath());
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        file: watcher.getFilePath(),
        content: fileContent,
        html,
        comments,
      }));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws: WebSocket) => {
    clients.add(ws);

    // Send initial state
    const fileContent = watcher.getContent();
    const html = renderToHtml(fileContent, watcher.getFilePath());
    const comments = store.getForFile(watcher.getFilePath());

    send(ws, { type: "file_update", file: watcher.getFilePath(), content: fileContent, html });
    send(ws, { type: "comments_update", comments });

    ws.on("message", (data) => {
      try {
        const msg: WSClientMessage = JSON.parse(data.toString());
        handleClientMessage(msg);
      } catch (err) {
        send(ws, { type: "error", message: `Invalid message: ${err}` });
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
    });
  });

  function handleClientMessage(msg: WSClientMessage): void {
    switch (msg.type) {
      case "comment_add":
        store.add({
          file: watcher.getFilePath(),
          offset: msg.offset,
          length: msg.length,
          selectedText: msg.selectedText,
          comment: msg.comment,
        });
        break;
      case "comment_reply":
        store.addReply(msg.commentId, "user", msg.text);
        break;
      case "comment_resolve":
        store.resolve(msg.commentId);
        break;
    }
  }

  // Broadcast updates when comments change
  store.on("change", () => {
    const comments = store.getForFile(watcher.getFilePath());
    broadcast({ type: "comments_update", comments });
  });

  // Broadcast file changes
  watcher.on("change", (event: { file: string; content: string; oldContent: string }) => {
    store.adjustOffsets(event.file, event.oldContent, event.content);
    const html = renderToHtml(event.content, event.file);
    broadcast({ type: "file_update", file: event.file, content: event.content, html });
  });

  function send(ws: WebSocket, msg: WSServerMessage): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function broadcast(msg: WSServerMessage): void {
    for (const client of clients) {
      send(client, msg);
    }
  }

  return {
    start: () =>
      new Promise<void>((resolve) => {
        httpServer.listen(port, () => {
          process.stderr.write(`Cowrite preview server running at http://localhost:${port}\n`);
          resolve();
        });
      }),
    stop: () =>
      new Promise<void>((resolvePromise, reject) => {
        for (const client of clients) {
          client.close();
        }
        httpServer.close((err) => {
          if (err) reject(err);
          else resolvePromise();
        });
      }),
  };
}
