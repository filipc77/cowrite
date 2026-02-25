import * as vscode from "vscode";
import type { CommentFileStore } from "./comment-file-store";

export class StatusBarManager {
  private item: vscode.StatusBarItem;

  constructor(private store: CommentFileStore) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.item.command = "cowrite.refreshComments";
    this.item.show();
  }

  update(): void {
    const pending = this.store.getPendingCount();
    if (pending > 0) {
      this.item.text = `$(comment-discussion) Cowrite: ${pending} pending`;
      this.item.color = "#f9e2af";
    } else {
      this.item.text = "$(comment-discussion) Cowrite";
      this.item.color = undefined;
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
