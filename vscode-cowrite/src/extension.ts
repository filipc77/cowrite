import * as vscode from "vscode";
import { CommentFileStore } from "./comment-file-store";
import { CowriteCommentProvider } from "./comment-provider";
import { DecorationManager } from "./decoration-manager";
import { StatusBarManager } from "./status-bar";
import { rangeToOffset } from "./offset-utils";

let store: CommentFileStore;
let provider: CowriteCommentProvider;
let decorationManager: DecorationManager;
let statusBar: StatusBarManager;

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    return;
  }

  store = new CommentFileStore(workspaceRoot);
  store.load();
  store.startWatching();

  provider = new CowriteCommentProvider(store);
  decorationManager = new DecorationManager(store, context.extensionUri);
  statusBar = new StatusBarManager(store);

  // Initial render
  refreshAll();

  // React to store changes (external file edits from MCP server)
  store.on("change", () => {
    refreshAll();
  });

  // React to editor switches
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        decorationManager.updateDecorations(editor);
      }
    })
  );

  // Command: Add Comment
  context.subscriptions.push(
    vscode.commands.registerCommand("cowrite.addComment", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const selection = editor.selection;
      if (selection.isEmpty) {
        vscode.window.showWarningMessage("Select text before adding a comment.");
        return;
      }

      const commentText = await vscode.window.showInputBox({
        prompt: "Enter your comment",
        placeHolder: "What should the agent know about this code?",
      });
      if (!commentText) return;

      const { offset, length } = rangeToOffset(editor.document, selection);
      const selectedText = editor.document.getText(selection);
      const filePath = editor.document.uri.fsPath;

      store.add({
        file: filePath,
        offset,
        length,
        selectedText,
        comment: commentText,
      });
    })
  );

  // Command: Reply (Comment API handler)
  context.subscriptions.push(
    vscode.commands.registerCommand("cowrite.createNote", (reply: vscode.CommentReply) => {
      const commentId = reply.thread.contextValue;
      if (!commentId) return;
      store.addReply(commentId, "user", reply.text);
    })
  );

  // Command: Resolve Thread
  context.subscriptions.push(
    vscode.commands.registerCommand("cowrite.resolveThread", (thread: vscode.CommentThread) => {
      const commentId = thread.contextValue;
      if (!commentId) return;
      store.resolve(commentId);
    })
  );

  // Command: Unresolve Thread
  context.subscriptions.push(
    vscode.commands.registerCommand("cowrite.unresolveThread", (thread: vscode.CommentThread) => {
      const commentId = thread.contextValue;
      if (!commentId) return;
      store.unresolve(commentId);
    })
  );

  // Command: Refresh Comments
  context.subscriptions.push(
    vscode.commands.registerCommand("cowrite.refreshComments", () => {
      store.reload();
    })
  );

  // Push disposables
  context.subscriptions.push({
    dispose() {
      store.stopWatching();
      provider.dispose();
      decorationManager.dispose();
      statusBar.dispose();
    },
  });
}

function refreshAll(): void {
  provider.refresh();
  decorationManager.refreshAll();
  statusBar.update();
}

export function deactivate(): void {
  store?.stopWatching();
}
