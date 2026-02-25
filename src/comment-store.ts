import { EventEmitter } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import type { Comment, Reply } from "./types.js";

const PERSIST_FILE = ".cowrite-comments.json";

export class CommentStore extends EventEmitter {
  private comments: Map<string, Comment> = new Map();
  private persistPath: string;
  private lastWriteTime = 0;
  private watcher: FSWatcher | null = null;

  constructor(projectDir: string) {
    super();
    this.persistPath = join(resolve(projectDir), PERSIST_FILE);
  }

  async load(): Promise<void> {
    try {
      const data = await readFile(this.persistPath, "utf-8");
      const arr: Comment[] = JSON.parse(data);
      for (const c of arr) {
        this.comments.set(c.id, c);
      }
    } catch {
      // No existing file, start fresh
    }
  }

  private async persist(): Promise<void> {
    this.lastWriteTime = Date.now();
    const arr = Array.from(this.comments.values());
    await writeFile(this.persistPath, JSON.stringify(arr, null, 2), "utf-8");
  }

  async reload(): Promise<void> {
    try {
      const data = await readFile(this.persistPath, "utf-8");
      const arr: Comment[] = JSON.parse(data);
      const oldIds = new Set(this.comments.keys());
      this.comments.clear();
      for (const c of arr) {
        this.comments.set(c.id, c);
      }
      // Emit "new_comment" for comments that didn't exist before
      for (const c of arr) {
        if (!oldIds.has(c.id)) {
          this.emit("new_comment", c);
        }
      }
      this.emit("change", null);
    } catch {
      // File missing or invalid, clear state
      this.comments.clear();
      this.emit("change", null);
    }
  }

  async startWatching(): Promise<void> {
    if (this.watcher) return;
    this.watcher = chokidarWatch(this.persistPath, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });
    this.watcher.on("change", async () => {
      if (Date.now() - this.lastWriteTime < 200) return;
      await this.reload();
    });
    this.watcher.on("add", async () => {
      if (Date.now() - this.lastWriteTime < 200) return;
      await this.reload();
    });
  }

  async stopWatching(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  add(params: {
    file: string;
    offset: number;
    length: number;
    selectedText: string;
    comment: string;
  }): Comment {
    const comment: Comment = {
      id: randomUUID(),
      file: params.file,
      offset: params.offset,
      length: params.length,
      selectedText: params.selectedText,
      comment: params.comment,
      status: "pending",
      replies: [],
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };
    this.comments.set(comment.id, comment);
    this.emit("change", comment);
    this.emit("new_comment", comment);
    this.persist().catch((err) => process.stderr.write(`Persist error: ${err}\n`));
    return comment;
  }

  resolve(commentId: string): Comment | null {
    const comment = this.comments.get(commentId);
    if (!comment) return null;
    comment.status = "resolved";
    comment.resolvedAt = new Date().toISOString();
    this.emit("change", comment);
    this.persist().catch((err) => process.stderr.write(`Persist error: ${err}\n`));
    return comment;
  }

  addReply(commentId: string, from: "user" | "agent", text: string): Reply | null {
    const comment = this.comments.get(commentId);
    if (!comment) return null;
    const reply: Reply = {
      id: randomUUID(),
      from,
      text,
      createdAt: new Date().toISOString(),
    };
    comment.replies.push(reply);
    this.emit("change", comment);
    this.persist().catch((err) => process.stderr.write(`Persist error: ${err}\n`));
    return reply;
  }

  get(commentId: string): Comment | null {
    return this.comments.get(commentId) ?? null;
  }

  getAll(filter?: { file?: string; status?: "pending" | "resolved" | "all" }): Comment[] {
    let results = Array.from(this.comments.values());
    if (filter?.file) {
      results = results.filter((c) => c.file === filter.file);
    }
    if (filter?.status && filter.status !== "all") {
      results = results.filter((c) => c.status === filter.status);
    }
    return results.sort((a, b) => a.offset - b.offset);
  }

  getForFile(file: string): Comment[] {
    return this.getAll({ file });
  }

  /** Adjust comment offsets when file content changes */
  adjustOffsets(file: string, oldContent: string, newContent: string): void {
    const fileComments = this.getForFile(file);
    if (fileComments.length === 0) return;

    for (const comment of fileComments) {
      // Try to find the selected text in the new content near original offset
      const searchStart = Math.max(0, comment.offset - 200);
      const searchEnd = Math.min(newContent.length, comment.offset + comment.length + 200);
      const searchRegion = newContent.slice(searchStart, searchEnd);
      const idx = searchRegion.indexOf(comment.selectedText);
      if (idx !== -1) {
        comment.offset = searchStart + idx;
      }
      // If not found, leave offset as-is (orphaned comment)
    }

    this.emit("change", null);
    this.persist().catch((err) => process.stderr.write(`Persist error: ${err}\n`));
  }

  clear(): void {
    this.comments.clear();
    this.emit("change", null);
    this.persist().catch((err) => process.stderr.write(`Persist error: ${err}\n`));
  }
}
