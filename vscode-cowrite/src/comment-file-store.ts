import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { Comment, Reply } from "./types";

const PERSIST_FILE = ".cowrite-comments.json";

export class CommentFileStore extends EventEmitter {
  private comments: Map<string, Comment> = new Map();
  private persistPath: string;
  private lastWriteTime = 0;
  private fileWatcher: vscode.FileSystemWatcher | null = null;

  constructor(private workspaceRoot: string) {
    super();
    this.persistPath = join(workspaceRoot, PERSIST_FILE);
  }

  load(): void {
    try {
      if (!existsSync(this.persistPath)) return;
      const data = readFileSync(this.persistPath, "utf-8");
      const arr: Comment[] = JSON.parse(data);
      for (const c of arr) {
        this.comments.set(c.id, c);
      }
    } catch {
      // No existing file or invalid JSON, start fresh
    }
  }

  private persist(): void {
    this.lastWriteTime = Date.now();
    const arr = Array.from(this.comments.values());
    writeFileSync(this.persistPath, JSON.stringify(arr, null, 2), "utf-8");
  }

  reload(): void {
    try {
      if (!existsSync(this.persistPath)) {
        this.comments.clear();
        this.emit("change");
        return;
      }
      const data = readFileSync(this.persistPath, "utf-8");
      const arr: Comment[] = JSON.parse(data);
      this.comments.clear();
      for (const c of arr) {
        this.comments.set(c.id, c);
      }
      this.emit("change");
    } catch {
      this.comments.clear();
      this.emit("change");
    }
  }

  startWatching(): void {
    if (this.fileWatcher) return;
    const pattern = new vscode.RelativePattern(this.workspaceRoot, PERSIST_FILE);
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

    const onExternalChange = () => {
      if (Date.now() - this.lastWriteTime < 200) return;
      this.reload();
    };

    this.fileWatcher.onDidChange(onExternalChange);
    this.fileWatcher.onDidCreate(onExternalChange);
    this.fileWatcher.onDidDelete(() => {
      if (Date.now() - this.lastWriteTime < 200) return;
      this.comments.clear();
      this.emit("change");
    });
  }

  stopWatching(): void {
    if (this.fileWatcher) {
      this.fileWatcher.dispose();
      this.fileWatcher = null;
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
    this.persist();
    this.emit("change");
    return comment;
  }

  resolve(commentId: string): Comment | null {
    const comment = this.comments.get(commentId);
    if (!comment) return null;
    comment.status = "resolved";
    comment.resolvedAt = new Date().toISOString();
    this.persist();
    this.emit("change");
    return comment;
  }

  unresolve(commentId: string): Comment | null {
    const comment = this.comments.get(commentId);
    if (!comment) return null;
    comment.status = "pending";
    comment.resolvedAt = null;
    this.persist();
    this.emit("change");
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
    this.persist();
    this.emit("change");
    return reply;
  }

  get(commentId: string): Comment | null {
    return this.comments.get(commentId) ?? null;
  }

  getAll(): Comment[] {
    return Array.from(this.comments.values()).sort((a, b) => a.offset - b.offset);
  }

  getForFile(filePath: string): Comment[] {
    return this.getAll().filter((c) => c.file === filePath);
  }

  getPendingCount(): number {
    return Array.from(this.comments.values()).filter((c) => c.status === "pending").length;
  }

  clear(): void {
    this.comments.clear();
    this.persist();
    this.emit("change");
  }
}
