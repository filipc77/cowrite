import { EventEmitter } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import type { Comment, CommentAnchor, Proposal, Reply } from "./types.js";

const PERSIST_FILE = ".cowrite-comments.json";

/** Count matching chars from end of both strings (for prefix comparison) */
function countMatchingCharsFromEnd(a: string, b: string): number {
  let count = 0;
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i++) {
    if (a[a.length - 1 - i] === b[b.length - 1 - i]) count++;
    else break;
  }
  return count;
}

/** Count matching chars from start of both strings (for suffix comparison) */
function countMatchingCharsFromStart(a: string, b: string): number {
  let count = 0;
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i++) {
    if (a[i] === b[i]) count++;
    else break;
  }
  return count;
}

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
    anchor?: CommentAnchor;
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
      anchor: params.anchor,
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

  reopen(commentId: string): Comment | null {
    const comment = this.comments.get(commentId);
    if (!comment || comment.status !== "resolved") return null;
    comment.status = "pending";
    comment.resolvedAt = null;
    this.emit("change", comment);
    this.emit("comment_reopened", comment);
    this.persist().catch((err) => process.stderr.write(`Persist error: ${err}\n`));
    return comment;
  }

  delete(commentId: string): boolean {
    const existed = this.comments.delete(commentId);
    if (existed) {
      this.emit("change", null);
      this.persist().catch((err) => process.stderr.write(`Persist error: ${err}\n`));
    }
    return existed;
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
    // Agent reply on pending → answered
    if (from === "agent" && comment.status === "pending") {
      comment.status = "answered";
    }
    // User reply on answered → back to pending (re-opens conversation)
    if (from === "user" && comment.status === "answered") {
      comment.status = "pending";
      this.emit("comment_reopened", comment);
    }
    this.emit("change", comment);
    this.persist().catch((err) => process.stderr.write(`Persist error: ${err}\n`));
    return reply;
  }

  addProposalReply(commentId: string, newText: string, explanation: string): Reply | null {
    const comment = this.comments.get(commentId);
    if (!comment) return null;
    const proposal: Proposal = {
      oldText: comment.selectedText,
      newText,
      explanation,
      status: "pending",
    };
    const reply: Reply = {
      id: randomUUID(),
      from: "agent",
      text: explanation,
      createdAt: new Date().toISOString(),
      proposal,
    };
    comment.replies.push(reply);
    if (comment.status === "pending") {
      comment.status = "answered";
    }
    this.emit("change", comment);
    this.persist().catch((err) => process.stderr.write(`Persist error: ${err}\n`));
    return reply;
  }

  updateProposalStatus(commentId: string, replyId: string, status: "applied" | "rejected"): boolean {
    const comment = this.comments.get(commentId);
    if (!comment) return false;
    const reply = comment.replies.find((r) => r.id === replyId);
    if (!reply?.proposal) return false;
    reply.proposal.status = status;
    // When applied, update the comment's anchor to match the new text
    if (status === "applied") {
      comment.selectedText = reply.proposal.newText;
      comment.length = reply.proposal.newText.length;
      if (comment.anchor) {
        comment.anchor.textQuote.exact = reply.proposal.newText;
        comment.anchor.length = reply.proposal.newText.length;
      }
    }
    this.emit("change", comment);
    this.persist().catch((err) => process.stderr.write(`Persist error: ${err}\n`));
    return true;
  }

  get(commentId: string): Comment | null {
    return this.comments.get(commentId) ?? null;
  }

  getAll(filter?: { file?: string; status?: "pending" | "answered" | "resolved" | "all" }): Comment[] {
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
      if (!comment.selectedText) continue;  // file comments don't re-anchor

      // Try text quote selector first if available
      if (comment.anchor?.textQuote) {
        const exact = comment.anchor.textQuote.exact;
        const searchStart = Math.max(0, comment.offset - 200);
        const searchEnd = Math.min(newContent.length, comment.offset + exact.length + 200);
        const searchRegion = newContent.slice(searchStart, searchEnd);

        // Find all occurrences of exact text in the search window
        const matches: number[] = [];
        let pos = 0;
        while (pos < searchRegion.length) {
          const idx = searchRegion.indexOf(exact, pos);
          if (idx === -1) break;
          matches.push(searchStart + idx);
          pos = idx + 1;
        }

        if (matches.length > 0) {
          // Score each match by prefix/suffix similarity
          let bestOffset = -1;
          let bestScore = -1;
          let bestDist = Infinity;

          for (const matchOffset of matches) {
            const prefixInContent = newContent.slice(Math.max(0, matchOffset - 30), matchOffset);
            const suffixInContent = newContent.slice(matchOffset + exact.length, matchOffset + exact.length + 30);

            const prefixScore = countMatchingCharsFromEnd(comment.anchor.textQuote.prefix, prefixInContent);
            const suffixScore = countMatchingCharsFromStart(comment.anchor.textQuote.suffix, suffixInContent);
            const score = prefixScore + suffixScore;
            const dist = Math.abs(matchOffset - comment.offset);

            if (score > bestScore || (score === bestScore && dist < bestDist)) {
              bestScore = score;
              bestOffset = matchOffset;
              bestDist = dist;
            }
          }

          if (bestOffset !== -1) {
            comment.offset = bestOffset;
            comment.anchor.offset = bestOffset;
            comment.length = comment.anchor.length;
            continue;
          }
        }
        // Fall through to legacy logic if no text quote match found
      }

      // Legacy: find all occurrences in the search window and pick the closest to original offset
      const searchStart = Math.max(0, comment.offset - 200);
      const searchEnd = Math.min(newContent.length, comment.offset + comment.length + 200);
      const searchRegion = newContent.slice(searchStart, searchEnd);
      let bestOffset = -1;
      let bestDist = Infinity;
      let pos = 0;
      while (pos < searchRegion.length) {
        const idx = searchRegion.indexOf(comment.selectedText, pos);
        if (idx === -1) break;
        const absOffset = searchStart + idx;
        const dist = Math.abs(absOffset - comment.offset);
        if (dist < bestDist) {
          bestDist = dist;
          bestOffset = absOffset;
        }
        pos = idx + 1;
      }
      if (bestOffset !== -1) {
        comment.offset = bestOffset;
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
