import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CommentStore } from "../src/comment-store.js";
import { tmpdir } from "node:os";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

describe("CommentStore", () => {
  let store: CommentStore;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cowrite-test-"));
    store = new CommentStore(tempDir);
  });

  it("should add a comment", () => {
    const comment = store.add({
      file: "/test/file.md",
      offset: 10,
      length: 5,
      selectedText: "hello",
      comment: "Fix this",
    });

    expect(comment.id).toBeDefined();
    expect(comment.file).toBe("/test/file.md");
    expect(comment.offset).toBe(10);
    expect(comment.length).toBe(5);
    expect(comment.selectedText).toBe("hello");
    expect(comment.comment).toBe("Fix this");
    expect(comment.status).toBe("pending");
    expect(comment.replies).toEqual([]);
    expect(comment.resolvedAt).toBeNull();
  });

  it("should emit change event on add", () => {
    const handler = vi.fn();
    store.on("change", handler);
    store.add({
      file: "/test/file.md",
      offset: 0,
      length: 3,
      selectedText: "abc",
      comment: "test",
    });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("should resolve a comment", () => {
    const comment = store.add({
      file: "/test/file.md",
      offset: 0,
      length: 3,
      selectedText: "abc",
      comment: "test",
    });

    const resolved = store.resolve(comment.id);
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.resolvedAt).toBeDefined();
  });

  it("should return null when resolving unknown comment", () => {
    expect(store.resolve("nonexistent")).toBeNull();
  });

  it("should add a reply", () => {
    const comment = store.add({
      file: "/test/file.md",
      offset: 0,
      length: 3,
      selectedText: "abc",
      comment: "test",
    });

    const reply = store.addReply(comment.id, "agent", "Done!");
    expect(reply?.from).toBe("agent");
    expect(reply?.text).toBe("Done!");

    const updated = store.get(comment.id);
    expect(updated?.replies).toHaveLength(1);
  });

  it("should return null when replying to unknown comment", () => {
    expect(store.addReply("nonexistent", "user", "hello")).toBeNull();
  });

  it("should filter by file", () => {
    store.add({ file: "/a.md", offset: 0, length: 1, selectedText: "a", comment: "x" });
    store.add({ file: "/b.md", offset: 0, length: 1, selectedText: "b", comment: "y" });

    expect(store.getAll({ file: "/a.md" })).toHaveLength(1);
    expect(store.getAll({ file: "/b.md" })).toHaveLength(1);
    expect(store.getAll()).toHaveLength(2);
  });

  it("should filter by status", () => {
    const c1 = store.add({ file: "/a.md", offset: 0, length: 1, selectedText: "a", comment: "x" });
    store.add({ file: "/a.md", offset: 5, length: 1, selectedText: "b", comment: "y" });
    store.resolve(c1.id);

    expect(store.getAll({ status: "pending" })).toHaveLength(1);
    expect(store.getAll({ status: "resolved" })).toHaveLength(1);
    expect(store.getAll({ status: "all" })).toHaveLength(2);
  });

  it("should sort by offset", () => {
    store.add({ file: "/a.md", offset: 20, length: 1, selectedText: "b", comment: "second" });
    store.add({ file: "/a.md", offset: 5, length: 1, selectedText: "a", comment: "first" });

    const all = store.getAll();
    expect(all[0].comment).toBe("first");
    expect(all[1].comment).toBe("second");
  });

  it("should adjust offsets when file changes", () => {
    const comment = store.add({
      file: "/test.md",
      offset: 10,
      length: 5,
      selectedText: "world",
      comment: "check this",
    });

    const oldContent = "hello hey world foo";
    const newContent = "hello hey there world foo bar";

    store.adjustOffsets("/test.md", oldContent, newContent);

    const updated = store.get(comment.id);
    expect(updated?.offset).toBe(16); // "world" moved to index 16
  });

  it("should persist and load", async () => {
    store.add({ file: "/a.md", offset: 0, length: 1, selectedText: "a", comment: "persisted" });

    // Wait for async persist
    await new Promise((r) => setTimeout(r, 50));

    const store2 = new CommentStore(tempDir);
    await store2.load();
    expect(store2.getAll()).toHaveLength(1);
    expect(store2.getAll()[0].comment).toBe("persisted");
  });

  it("should clear all comments", () => {
    store.add({ file: "/a.md", offset: 0, length: 1, selectedText: "a", comment: "x" });
    store.add({ file: "/b.md", offset: 0, length: 1, selectedText: "b", comment: "y" });
    store.clear();
    expect(store.getAll()).toHaveLength(0);
  });

  describe("reload", () => {
    it("should replace in-memory state from file", async () => {
      store.add({ file: "/a.md", offset: 0, length: 1, selectedText: "a", comment: "original" });

      // Wait for persist
      await new Promise((r) => setTimeout(r, 50));

      // Write a different state to the file
      const externalComments = [
        {
          id: "ext-1",
          file: "/b.md",
          offset: 5,
          length: 3,
          selectedText: "foo",
          comment: "external comment",
          status: "pending",
          replies: [],
          createdAt: new Date().toISOString(),
          resolvedAt: null,
        },
      ];
      await writeFile(
        join(tempDir, ".cowrite-comments.json"),
        JSON.stringify(externalComments, null, 2),
        "utf-8"
      );

      await store.reload();

      expect(store.getAll()).toHaveLength(1);
      expect(store.getAll()[0].comment).toBe("external comment");
      expect(store.getAll()[0].file).toBe("/b.md");
      expect(store.get("ext-1")).not.toBeNull();
    });

    it("should clear state when file is deleted or missing", async () => {
      store.add({ file: "/a.md", offset: 0, length: 1, selectedText: "a", comment: "x" });

      // Point to a non-existent path for reload
      const emptyStore = new CommentStore(join(tempDir, "nonexistent"));
      emptyStore.add({ file: "/a.md", offset: 0, length: 1, selectedText: "a", comment: "x" });
      await emptyStore.reload();
      expect(emptyStore.getAll()).toHaveLength(0);
    });

    it("should emit change event on reload", async () => {
      store.add({ file: "/a.md", offset: 0, length: 1, selectedText: "a", comment: "x" });
      await new Promise((r) => setTimeout(r, 50));

      const handler = vi.fn();
      store.on("change", handler);
      await store.reload();
      expect(handler).toHaveBeenCalled();
    });
  });

  describe("watching", () => {
    afterEach(async () => {
      await store.stopWatching();
    });

    it("should start and stop watching without error", async () => {
      await store.startWatching();
      await store.stopWatching();
    });

    it("should detect external file writes and reload", async () => {
      store.add({ file: "/a.md", offset: 0, length: 1, selectedText: "a", comment: "initial" });

      // Wait for persist + debounce window (200ms) to expire
      await new Promise((r) => setTimeout(r, 300));

      await store.startWatching();

      // Simulate external write
      const externalComments = [
        {
          id: "watch-1",
          file: "/c.md",
          offset: 0,
          length: 2,
          selectedText: "hi",
          comment: "from external",
          status: "pending",
          replies: [],
          createdAt: new Date().toISOString(),
          resolvedAt: null,
        },
      ];
      await writeFile(
        join(tempDir, ".cowrite-comments.json"),
        JSON.stringify(externalComments, null, 2),
        "utf-8"
      );

      // Wait for chokidar to detect and reload
      await new Promise((r) => setTimeout(r, 500));

      expect(store.getAll()).toHaveLength(1);
      expect(store.getAll()[0].comment).toBe("from external");
    });

    it("should not reload on self-writes (debounce)", async () => {
      await store.startWatching();

      const reloadSpy = vi.fn();
      store.on("change", reloadSpy);

      // This triggers persist internally (self-write)
      store.add({ file: "/a.md", offset: 0, length: 1, selectedText: "a", comment: "self" });

      // Wait for potential false reload
      await new Promise((r) => setTimeout(r, 500));

      // Only the add's "change" event, not an additional reload
      expect(reloadSpy).toHaveBeenCalledTimes(1);
      expect(store.getAll()).toHaveLength(1);
      expect(store.getAll()[0].comment).toBe("self");
    });
  });
});
