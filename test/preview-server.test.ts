import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createPreviewServer } from "../src/preview-server.js";
import { CommentStore } from "../src/comment-store.js";
import { tmpdir } from "node:os";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";

describe("Preview Server", () => {
  let store: CommentStore;
  let server: { start: () => Promise<void>; stop: () => Promise<void> };
  let tempDir: string;
  let testFile: string;
  const port = 13377; // Use high port to avoid conflicts

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cowrite-preview-test-"));
    testFile = join(tempDir, "test.md");
    await writeFile(testFile, "# Hello\n\nThis is a test.", "utf-8");

    store = new CommentStore(tempDir);
  });

  afterEach(async () => {
    await server.stop();
  });

  describe("with initial file (preview mode)", () => {
    beforeEach(async () => {
      server = createPreviewServer(store, tempDir, port, testFile);
      await server.start();
    });

    it("should serve the API state endpoint", async () => {
      const res = await fetch(`http://localhost:${port}/api/state?file=test.md`);
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

    it("should accept WebSocket connections and send initial state for initial file", async () => {
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

  describe("without initial file (serve mode)", () => {
    beforeEach(async () => {
      server = createPreviewServer(store, tempDir, port);
      await server.start();
    });

    it("should list project files", async () => {
      const res = await fetch(`http://localhost:${port}/api/files`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.files).toContain("test.md");
    });

    it("should require file param for /api/state", async () => {
      const res = await fetch(`http://localhost:${port}/api/state`);
      expect(res.status).toBe(400);
    });

    it("should not send initial state on WebSocket connect without initial file", async () => {
      const ws = new WebSocket(`ws://localhost:${port}`);

      const messages: any[] = [];
      await new Promise<void>((resolve) => {
        ws.on("open", () => {
          // Give a short window for any messages
          setTimeout(() => resolve(), 200);
        });
        ws.on("message", (data) => {
          messages.push(JSON.parse(data.toString()));
        });
      });

      // No initial messages should be sent
      expect(messages).toHaveLength(0);

      ws.close();
    });

    it("should handle switch_file via WebSocket", async () => {
      const ws = new WebSocket(`ws://localhost:${port}`);

      await new Promise<void>((resolve) => {
        ws.on("open", () => resolve());
      });

      // Switch to test file
      ws.send(JSON.stringify({ type: "switch_file", file: "test.md" }));

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

      ws.close();
    });

    it("should reject paths outside project", async () => {
      const ws = new WebSocket(`ws://localhost:${port}`);

      await new Promise<void>((resolve) => {
        ws.on("open", () => resolve());
      });

      ws.send(JSON.stringify({ type: "switch_file", file: "../../etc/passwd" }));

      const msg = await new Promise<any>((resolve) => {
        ws.on("message", (data) => {
          resolve(JSON.parse(data.toString()));
        });
      });

      expect(msg.type).toBe("error");
      expect(msg.message).toContain("outside project");

      ws.close();
    });

    it("should exclude dotfiles and node_modules from file listing", async () => {
      await mkdir(join(tempDir, ".hidden"), { recursive: true });
      await writeFile(join(tempDir, ".hidden", "secret.txt"), "secret", "utf-8");
      await mkdir(join(tempDir, "node_modules", "pkg"), { recursive: true });
      await writeFile(join(tempDir, "node_modules", "pkg", "index.js"), "module", "utf-8");
      await writeFile(join(tempDir, "visible.txt"), "hello", "utf-8");

      const res = await fetch(`http://localhost:${port}/api/files`);
      const data = await res.json();

      expect(data.files).toContain("visible.txt");
      expect(data.files).toContain("test.md");
      expect(data.files.some((f: string) => f.includes(".hidden"))).toBe(false);
      expect(data.files.some((f: string) => f.includes("node_modules"))).toBe(false);
    });
  });
});
