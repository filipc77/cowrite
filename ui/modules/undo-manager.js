// @ts-check

import { $ } from './utils.js';
import { state } from './state.js';
import { send } from './ws-client.js';

const undoBtn = /** @type {HTMLButtonElement} */ ($("#undoBtn"));

/**
 * Save the undo stack for a file to sessionStorage.
 * @param {string} file
 */
export function saveUndoStack(file) {
  try {
    sessionStorage.setItem("cowrite-undo:" + file, JSON.stringify(state.undoStack));
  } catch (e) {
    state.undoStack.splice(0, state.undoStack.length - 5);
    try { sessionStorage.setItem("cowrite-undo:" + file, JSON.stringify(state.undoStack)); } catch (_) {}
  }
}

/**
 * Load the undo stack for a file from sessionStorage.
 * @param {string} file
 * @returns {Array<{file: string, content: string}>}
 */
export function loadUndoStack(file) {
  try {
    const data = sessionStorage.getItem("cowrite-undo:" + file);
    if (data) {
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {}
  return [];
}

/**
 * Push the current content onto the undo stack.
 */
export function pushUndo() {
  if (!state.currentContent || !state.currentFile) return;
  state.undoStack.push({ file: state.currentFile, content: state.currentContent });
  if (state.undoStack.length > state.MAX_UNDO) state.undoStack.shift();
  undoBtn.disabled = false;
  saveUndoStack(state.currentFile);
}

function performUndo() {
  if (state.undoStack.length === 0) return;
  const snapshot = state.undoStack.pop();
  if (state.undoStack.length === 0) undoBtn.disabled = true;
  saveUndoStack(state.currentFile);

  send({
    type: "edit_apply",
    offset: 0,
    length: state.currentContent.length,
    newText: snapshot.content,
  });
}

export function initUndoManager() {
  undoBtn.addEventListener("click", performUndo);

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
      const tag = document.activeElement?.tagName?.toLowerCase();
      if (tag === "textarea" || tag === "input") return;
      if (document.activeElement?.contentEditable === "true") return;
      // Let ProseMirror handle undo when editor is focused
      if (document.activeElement?.closest('.ProseMirror')) return;

      e.preventDefault();
      performUndo();
    }
  });
}
