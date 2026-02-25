import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createPreviewServer } from "../src/preview-server.js";
import { CommentStore } from "../src/comment-store.js";
import { FileWatcher } from "../src/file-watcher.js";
import { tmpdir } from "node:os";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";

describe("Preview Server", () => {
  let store: CommentStore;
  let watcher: FileWatcher;
  let server: { start: () => Promise<void>; stop: () => Promise<void> };
  let tempDir: string;
  let testFile: string;
  const port = 13377; // Use high port to avoid conflicts

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cowrite-preview-test-"));
    testFile = join(tempDir, "test.md");
    await writeFile(testFile, "# Hello\n\nThis is a test.", "utf-8");

    store = new CommentStore(tempDir);
    watcher = new FileWatcher(testFile);
    await watcher.start();

    server = createPreviewServer(store, watcher, port);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    await watcher.stop();
  });

  it("should serve the API state endpoint", async () => {
    const res = await fetch(`http://localhost:${port}/api/state`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.file).toBe(testFile);
    expect(data.content).toContain("# Hello");
    expect(data.html).toContain("Hello");
    expect(data.comments).toEqual([]);
  });

  it("should return 404 for unknown routes", async () => {
    const res = await fetch(`http://localhost:${port}/nonexistent`);
    expect(res.status).toBe(404);
  });

  it("should accept WebSocket connections and send initial state", async () => {
    const ws = new WebSocket(`ws://localhost:${port}`);

    const messages: any[] = [];
    await new Promise<void>((resolve) => {
      ws.on("message", (data) => {
        messages.push(JSON.parse(data.toString()));
        if (messages.length >= 2) resolve();
      });
    });

    expect(messages[0].type).toBe("file_update");
    expect(messages[0].content).toContain("# Hello");
    expect(messages[1].type).toBe("comments_update");
    expect(messages[1].comments).toEqual([]);

    ws.close();
  });

  it("should handle comment_add via WebSocket", async () => {
    const ws = new WebSocket(`ws://localhost:${port}`);

    await new Promise<void>((resolve) => {
      let count = 0;
      ws.on("message", () => {
        count++;
        if (count >= 2) resolve(); // Wait for initial messages
      });
    });

    // Send a comment
    ws.send(JSON.stringify({
      type: "comment_add",
      file: testFile,
      offset: 2,
      length: 5,
      selectedText: "Hello",
      comment: "Great heading!",
    }));

    // Wait for the comments_update broadcast
    const updateMsg = await new Promise<any>((resolve) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "comments_update") resolve(msg);
      });
    });

    expect(updateMsg.comments).toHaveLength(1);
    expect(updateMsg.comments[0].comment).toBe("Great heading!");

    ws.close();
  });
});
