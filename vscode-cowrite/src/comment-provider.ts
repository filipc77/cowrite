import * as vscode from "vscode";
import type { CommentFileStore } from "./comment-file-store";
import type { Comment } from "./types";
import { offsetToRange, offsetToRangeFromContent } from "./offset-utils";
import { readFileSync } from "node:fs";

export class CowriteCommentProvider {
  private controller: vscode.CommentController;
  private threads: vscode.CommentThread[] = [];

  constructor(private store: CommentFileStore) {
    this.controller = vscode.comments.createCommentController("cowrite", "Cowrite");
    this.controller.commentingRangeProvider = {
      provideCommentingRanges(document: vscode.TextDocument): vscode.Range[] {
        return [new vscode.Range(0, 0, document.lineCount - 1, 0)];
      },
    };
  }

  refresh(): void {
    // Dispose existing threads
    for (const thread of this.threads) {
      thread.dispose();
    }
    this.threads = [];

    const comments = this.store.getAll();
    // Group by file
    const byFile = new Map<string, Comment[]>();
    for (const c of comments) {
      const arr = byFile.get(c.file) ?? [];
      arr.push(c);
      byFile.set(c.file, arr);
    }

    for (const [filePath, fileComments] of byFile) {
      const uri = vscode.Uri.file(filePath);

      // Try to get the document if it's open, otherwise read from disk
      const openDoc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === filePath
      );
      let fileContent: string | null = null;
      if (!openDoc) {
        try {
          fileContent = readFileSync(filePath, "utf-8");
        } catch {
          // File not accessible, skip
          continue;
        }
      }

      for (const comment of fileComments) {
        let range: vscode.Range;

        if (openDoc) {
          range = offsetToRange(openDoc, comment.offset, comment.length);
        } else {
          const pos = offsetToRangeFromContent(fileContent!, comment.offset, comment.length);
          range = new vscode.Range(pos.startLine, pos.startChar, pos.endLine, pos.endChar);
        }

        const vsComments: vscode.Comment[] = [
          {
            body: new vscode.MarkdownString(comment.comment),
            mode: vscode.CommentMode.Preview,
            author: { name: "You" },
          },
        ];

        for (const reply of comment.replies) {
          vsComments.push({
            body: new vscode.MarkdownString(reply.text),
            mode: vscode.CommentMode.Preview,
            author: { name: reply.from === "agent" ? "Agent" : "You" },
          });
        }

        const thread = this.controller.createCommentThread(uri, range, vsComments);
        thread.canReply = comment.status === "pending";
        thread.state = comment.status === "resolved"
          ? vscode.CommentThreadState.Resolved
          : vscode.CommentThreadState.Unresolved;
        thread.contextValue = comment.id;
        thread.label = comment.status === "resolved" ? "Resolved" : undefined;

        this.threads.push(thread);
      }
    }
  }

  dispose(): void {
    for (const thread of this.threads) {
      thread.dispose();
    }
    this.threads = [];
    this.controller.dispose();
  }
}
