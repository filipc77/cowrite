import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createPreviewServer } from "../src/preview-server.js";
import { CommentStore } from "../src/comment-store.js";
import { tmpdir } from "node:os";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
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

    it("should apply proposal for multi-paragraph markdown text", async () => {
      // Raw markdown has \n\n between paragraphs
      const mdContent = "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n";
      await writeFile(testFile, mdContent, "utf-8");

      // ProseMirror's textBetween uses \n between blocks (not \n\n)
      const proseMirrorText = "First paragraph.\nSecond paragraph.";

      // Add comment with ProseMirror-style selectedText
      const comment = store.add({
        file: testFile,
        offset: 8, // approximate ProseMirror offset
        length: proseMirrorText.length,
        selectedText: proseMirrorText,
        comment: "Rewrite these paragraphs",
      });

      // Add a proposal reply
      store.addProposalReply(comment.id, "Rewritten first.\n\nRewritten second.", "Rewrote both paragraphs");
      const reply = store.get(comment.id)!.replies[0];

      const ws = new WebSocket(`ws://localhost:${port}`);

      // Wait for initial messages (file_update + comments_update)
      await new Promise<void>((resolve) => {
        let count = 0;
        ws.on("message", () => { count++; if (count >= 2) resolve(); });
      });

      // Apply the proposal
      ws.send(JSON.stringify({
        type: "proposal_apply",
        commentId: comment.id,
        replyId: reply.id,
      }));

      // Wait for file_update broadcast
      await new Promise<void>((resolve) => {
        ws.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === "file_update") resolve();
        });
      });

      const updatedContent = await readFile(testFile, "utf-8");
      expect(updatedContent).toContain("Rewritten first.");
      expect(updatedContent).toContain("Rewritten second.");
      expect(updatedContent).not.toContain("First paragraph.");
      expect(updatedContent).not.toContain("Second paragraph.");
      // Third paragraph should be preserved
      expect(updatedContent).toContain("Third paragraph.");

      ws.close();
    });

    it("should apply proposal for text with markdown formatting", async () => {
      const mdContent = "# Title\n\nThis has **bold text** here.\n";
      await writeFile(testFile, mdContent, "utf-8");

      // ProseMirror strips ** markers
      const comment = store.add({
        file: testFile,
        offset: 10,
        length: 23, // "This has bold text here."
        selectedText: "This has bold text here.",
        comment: "Fix it",
      });

      store.addProposalReply(comment.id, "This has strong text here.", "Changed bold to strong");
      const reply = store.get(comment.id)!.replies[0];

      const ws = new WebSocket(`ws://localhost:${port}`);
      await new Promise<void>((resolve) => {
        let count = 0;
        ws.on("message", () => { count++; if (count >= 2) resolve(); });
      });

      ws.send(JSON.stringify({
        type: "proposal_apply",
        commentId: comment.id,
        replyId: reply.id,
      }));

      await new Promise<void>((resolve) => {
        ws.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === "file_update") resolve();
        });
      });

      const updatedContent = await readFile(testFile, "utf-8");
      expect(updatedContent).toContain("This has strong text here.");
      expect(updatedContent).not.toContain("bold text");

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
