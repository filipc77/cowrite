// @ts-check

/** @typedef {import('../../src/types.js').Comment} Comment */
/** @typedef {import('../../src/types.js').WSServerMessage} WSServerMessage */

import { $ } from './utils.js';
import { state } from './state.js';
import { initPreferences } from './preferences.js';
import { initWebSocket, send } from './ws-client.js';
import { initFilePicker, loadFileList } from './file-picker.js';
import { initCommentSidebar, renderComments } from './comment-sidebar.js';
import { initCommentHighlights, applyHighlights, createCommentHighlightExtension } from './comment-highlight.js';
import { initToolbar, showToolbarForSelection } from './toolbar.js';
import { initUndoManager, loadUndoStack } from './undo-manager.js';
import { createEditor, getEditor, isMarkdownFile, isProgrammaticContentUpdate } from './editor.js';
import { handleFileUpdate, applyPendingUpdate, submitEdit, reRenderContent } from './markdown-sync.js';
import { createSlashCommandExtension, blockCommandInProgress } from './block-menu.js';

const commentCountEl = $("#commentCount");
const undoBtn = /** @type {HTMLButtonElement} */ ($("#undoBtn"));
const fileContentEl = $("#fileContent");

// Initialize preferences (sidebar resize, theme, font size)
// Pass reRenderContent as callback for theme changes that need to re-render mermaid/highlights
initPreferences(reRenderContent);

// Initialize all modules
initFilePicker();
initCommentSidebar();
initCommentHighlights();
initToolbar();
initUndoManager();

// Create the TipTap editor, mounting it into #fileContent
createEditor(fileContentEl, {
  extensions: [createCommentHighlightExtension(), createSlashCommandExtension()],
  onUpdate(markdown) {
    if (isProgrammaticContentUpdate()) return;
    state.editorDirty = true;
  },
  onSelectionUpdate({ editor }) {
    if (isMarkdownFile(state.currentFile)) {
      showToolbarForSelection(editor);
    }
  },
});

// Wire editor blur to apply pending updates and submit edits
fileContentEl.addEventListener('focusout', (e) => {
  // Only act when focus leaves the ProseMirror editor entirely
  // (not when focus moves within it, e.g. between nodes)
  setTimeout(() => {
    if (blockCommandInProgress) return;
    const proseMirror = fileContentEl.querySelector('.ProseMirror');
    if (proseMirror && proseMirror.contains(document.activeElement)) return;
    submitEdit();           // Send user changes first
    applyPendingUpdate();   // Then apply queued server update
  }, 100);
});

// Initialize WebSocket and wire up message handlers
initWebSocket({
  onFileUpdate(msg) {
    handleFileUpdate(msg);
  },

  onCommentsUpdate(msg) {
    state.comments = msg.comments;
    commentCountEl.textContent = String(state.comments.filter(c => c.status !== "resolved").length);
    renderComments();
    applyHighlights(getEditor(), isMarkdownFile(state.currentFile));
  },

  onError(msg) {
    console.error("Server error:", msg.message);
  },

  onOpen() {
    // If URL has ?file= param, switch to that file
    const params = new URLSearchParams(location.search);
    const fileParam = params.get("file");
    if (fileParam) {
      send({ type: "switch_file", file: fileParam });
      state.undoStack = loadUndoStack(fileParam);
      undoBtn.disabled = state.undoStack.length === 0;
    }

    loadFileList();
  },
});
