import * as vscode from "vscode";
import type { CommentFileStore } from "./comment-file-store";
import { offsetToRange } from "./offset-utils";

export class DecorationManager {
  private pendingType: vscode.TextEditorDecorationType;
  private resolvedType: vscode.TextEditorDecorationType;

  constructor(
    private store: CommentFileStore,
    private extensionUri: vscode.Uri
  ) {
    this.pendingType = vscode.window.createTextEditorDecorationType({
      backgroundColor: "rgba(249, 226, 175, 0.2)",
      borderWidth: "0 0 2px 0",
      borderStyle: "solid",
      borderColor: "#f9e2af",
      overviewRulerColor: "#f9e2af",
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      gutterIconPath: vscode.Uri.joinPath(extensionUri, "resources", "comment-pending.svg"),
      gutterIconSize: "contain",
    });

    this.resolvedType = vscode.window.createTextEditorDecorationType({
      backgroundColor: "rgba(166, 227, 161, 0.1)",
      borderWidth: "0 0 2px 0",
      borderStyle: "solid",
      borderColor: "#a6e3a1",
      overviewRulerColor: "#a6e3a1",
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      gutterIconPath: vscode.Uri.joinPath(extensionUri, "resources", "comment-resolved.svg"),
      gutterIconSize: "contain",
    });
  }

  updateDecorations(editor: vscode.TextEditor): void {
    const filePath = editor.document.uri.fsPath;
    const comments = this.store.getForFile(filePath);

    const pendingRanges: vscode.DecorationOptions[] = [];
    const resolvedRanges: vscode.DecorationOptions[] = [];

    for (const comment of comments) {
      const range = offsetToRange(editor.document, comment.offset, comment.length);

      const hoverParts: string[] = [
        `**${comment.status === "pending" ? "Pending" : "Resolved"}** — ${comment.comment}`,
      ];
      for (const reply of comment.replies) {
        const label = reply.from === "agent" ? "Agent" : "You";
        hoverParts.push(`> **${label}:** ${reply.text}`);
      }

      const hoverMessage = new vscode.MarkdownString(hoverParts.join("\n\n"));
      hoverMessage.isTrusted = true;

      const decoration: vscode.DecorationOptions = { range, hoverMessage };

      if (comment.status === "pending") {
        pendingRanges.push(decoration);
      } else {
        resolvedRanges.push(decoration);
      }
    }

    editor.setDecorations(this.pendingType, pendingRanges);
    editor.setDecorations(this.resolvedType, resolvedRanges);
  }

  refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.updateDecorations(editor);
    }
  }

  dispose(): void {
    this.pendingType.dispose();
    this.resolvedType.dispose();
  }
}
