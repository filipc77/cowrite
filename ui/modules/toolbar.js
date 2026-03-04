// @ts-check

import { $ } from './utils.js';
import { state } from './state.js';
import { send } from './ws-client.js';
import { pushUndo } from './undo-manager.js';
import { getEditor, isMarkdownFile } from './editor.js';
import { createAnchor } from './comment-anchoring.js';

const fileContentEl = $("#fileContent");
const popup = $("#commentPopup");
const popupSelection = $("#popupSelection");
const commentInput = /** @type {HTMLTextAreaElement} */ ($("#commentInput"));
const selectionToolbar = $("#selectionToolbar");
const commentTrigger = $("#commentTrigger");
const formatButtons = $("#formatButtons");
const fileCommentBtn = $("#fileCommentBtn");

// --- Rich text formatting (markdown files only) ---

const FORMAT_SYNTAX = {
  bold:          { prefix: "**", suffix: "**" },
  italic:        { prefix: "*",  suffix: "*" },
  strikethrough: { prefix: "~~", suffix: "~~" },
  code:          { prefix: "`",  suffix: "`" },
};

function computeOffset(selection, text) {
  const range = selection.getRangeAt(0);
  const startNode = range.startContainer;
  const startCharOffset = range.startOffset;

  // Walk up from the range start to find a [data-offset] element
  let lineEl = startNode.nodeType === Node.TEXT_NODE ? startNode.parentElement : startNode;
  while (lineEl && !lineEl.dataset?.offset && lineEl !== fileContentEl) {
    lineEl = lineEl.parentElement;
  }

  if (lineEl?.dataset?.offset) {
    // Plain text mode: use data-offset directly
    const lineOffset = parseInt(lineEl.dataset.offset, 10);
    // Count characters before the selection start within this line span
    let charsBefore = 0;
    const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (walker.currentNode === startNode) {
        charsBefore += startCharOffset;
        break;
      }
      charsBefore += walker.currentNode.textContent?.length || 0;
    }
    return lineOffset + charsBefore;
  }

  // Markdown mode: search for the text in current content near visual position
  const idx = state.currentContent.indexOf(text);
  if (idx !== -1) return idx;

  // Exact match failed -- likely a cross-element selection (e.g. multiple list
  // items) where the browser's selection.toString() strips markdown syntax.
  // Use the DOM block structure to scope the search.
  const markdownBody = fileContentEl.querySelector(".markdown-body");
  if (markdownBody && state.currentBlocks.length) {
    let el = startNode.nodeType === Node.TEXT_NODE ? startNode.parentElement : startNode;
    while (el && el.parentElement !== markdownBody) {
      el = el.parentElement;
    }
    if (el && el.parentElement === markdownBody) {
      let blockIndex = 0;
      let sib = el.previousElementSibling;
      while (sib) {
        blockIndex++;
        sib = sib.previousElementSibling;
      }
      if (blockIndex < state.currentBlocks.length) {
        const block = state.currentBlocks[blockIndex];
        const blockSource = state.currentContent.slice(block.sourceStart, block.sourceEnd);
        const firstLine = text.split("\n")[0].trim();
        if (firstLine) {
          const lineIdx = blockSource.indexOf(firstLine);
          if (lineIdx !== -1) return block.sourceStart + lineIdx;
        }
      }
    }
  }

  // Last resort: match the first line of the selection anywhere in the content
  const firstLine = text.split("\n")[0].trim();
  if (firstLine && firstLine !== text) {
    const flIdx = state.currentContent.indexOf(firstLine);
    if (flIdx !== -1) return flIdx;
  }

  return -1;
}

function hideTrigger() {
  selectionToolbar.hidden = true;
  state.selectionInfo = null;
}

function applyTipTapFormat(editor, format) {
  switch (format) {
    case 'bold': editor.chain().focus().toggleBold().run(); break;
    case 'italic': editor.chain().focus().toggleItalic().run(); break;
    case 'strikethrough': editor.chain().focus().toggleStrike().run(); break;
    case 'code': editor.chain().focus().toggleCode().run(); break;
    case 'link': {
      const url = prompt('Link URL:', 'https://');
      if (url) editor.chain().focus().setLink({ href: url }).run();
      break;
    }
    case 'blockquote': editor.chain().focus().toggleBlockquote().run(); break;
    case 'bulletList': editor.chain().focus().toggleBulletList().run(); break;
  }
}

function applyMarkdownFormat(format) {
  if (!state.selectionInfo || state.selectionInfo.offset < 0) return;

  // Use TipTap commands for markdown files when editor is available
  const editor = getEditor();
  if (editor && isMarkdownFile(state.currentFile)) {
    applyTipTapFormat(editor, format);
    hideTrigger();
    return;
  }

  // Fallback: text manipulation for non-markdown files
  const { offset, length, selectedText } = state.selectionInfo;

  pushUndo();

  if (format === "link") {
    const url = prompt("Link URL:", "https://");
    if (!url) return;
    send({ type: "edit_apply", offset, length, newText: `[${selectedText}](${url})` });
    hideTrigger();
    return;
  }

  if (format === "blockquote") {
    const lines = selectedText.split("\n").map(l => `> ${l}`).join("\n");
    send({ type: "edit_apply", offset, length, newText: lines });
    hideTrigger();
    return;
  }

  if (format === "bulletList") {
    const lines = selectedText.split("\n").map(l => `- ${l}`).join("\n");
    send({ type: "edit_apply", offset, length, newText: lines });
    hideTrigger();
    return;
  }

  const { prefix, suffix } = FORMAT_SYNTAX[format];

  // Toggle detection: check if selection is already wrapped
  const before = state.currentContent.slice(offset - prefix.length, offset);
  const after = state.currentContent.slice(offset + length, offset + length + suffix.length);
  if (before === prefix && after === suffix) {
    // Unwrap: remove the surrounding markers
    send({ type: "edit_apply", offset: offset - prefix.length, length: length + prefix.length + suffix.length, newText: selectedText });
  } else {
    // Wrap: add markers
    send({ type: "edit_apply", offset, length, newText: `${prefix}${selectedText}${suffix}` });
  }

  hideTrigger();
}

function hidePopup() {
  popup.hidden = true;
  state.selectionInfo = null;
  // Reset popup to default state for next use
  popupSelection.hidden = false;
  popup.querySelector(".popup-header").textContent = "Selection";
  commentInput.placeholder = "Leave a comment...";
}

function submitComment() {
  const text = commentInput.value.trim();
  if (!text || !state.selectionInfo) return;

  const msg = {
    type: "comment_add",
    file: state.currentFile,
    offset: state.selectionInfo.offset,
    length: state.selectionInfo.length,
    selectedText: state.selectionInfo.selectedText,
    comment: text,
  };

  // Add hybrid anchor for markdown files
  if (isMarkdownFile(state.currentFile) && state.selectionInfo.anchor) {
    msg.anchor = state.selectionInfo.anchor;
  }

  send(msg);
  hidePopup();
  window.getSelection()?.removeAllRanges();
}

/**
 * Show toolbar for TipTap editor selection (called from onSelectionUpdate).
 * Uses ProseMirror's authoritative selection — no racing with DOM events.
 * @param {any} editor - TipTap Editor instance
 */
export function showToolbarForSelection(editor) {
  const { from, to } = editor.state.selection;
  if (from === to) {
    // Don't clear selectionInfo while the comment popup is open —
    // focus moving to the textarea collapses ProseMirror's selection,
    // but submitComment still needs the original selectionInfo.
    if (!popup.hidden) return;
    hideTrigger();
    return;
  }

  const anchor = createAnchor(editor, from, to);
  state.selectionInfo = {
    offset: anchor.offset,
    length: anchor.length,
    selectedText: anchor.textQuote.exact,
    anchor,
  };

  formatButtons.hidden = false;

  const startCoords = editor.view.coordsAtPos(from);
  const endCoords = editor.view.coordsAtPos(to);
  const left = (startCoords.left + endCoords.right) / 2 - 40;
  const top = Math.max(8, startCoords.top - 40);
  selectionToolbar.style.left = `${left}px`;
  selectionToolbar.style.top = `${top}px`;
  selectionToolbar.hidden = false;
}

export function initToolbar() {
  // --- Selection detection ---

  document.addEventListener("mousedown", (e) => {
    if (!selectionToolbar.contains(e.target) &&
        !popup.contains(e.target) &&
        !$("#sidebar").contains(e.target)) {
      hideTrigger();
    }
  });

  document.addEventListener("mouseup", (e) => {
    // Don't trigger when clicking inside popup, toolbar, or sidebar
    if (popup.contains(e.target) || selectionToolbar.contains(e.target) || $("#sidebar").contains(e.target)) return;

    // For markdown files with editor, let onSelectionUpdate handle it
    const editor = getEditor();
    if (editor && isMarkdownFile(state.currentFile)) return;

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      hideTrigger();
      return;
    }

    const text = selection.toString().trim();
    if (!text) {
      hideTrigger();
      return;
    }

    // Non-markdown: use DOM offset computation
    const offset = computeOffset(selection, text);
    if (offset === -1) { hideTrigger(); return; }
    state.selectionInfo = { offset, length: text.length, selectedText: text };

    formatButtons.hidden = true;

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    selectionToolbar.style.left = `${rect.left + rect.width / 2 - 40}px`;
    selectionToolbar.style.top = `${Math.max(8, rect.top - 40)}px`;
    selectionToolbar.hidden = false;
  });

  // Prevent the mousedown from clearing the text selection
  selectionToolbar.addEventListener("mousedown", (e) => {
    e.preventDefault();
  });

  // --- Comment popup ---

  commentTrigger.addEventListener("click", () => {
    if (!state.selectionInfo) return;

    const toolbarRect = selectionToolbar.getBoundingClientRect();
    let left = Math.min(toolbarRect.left, window.innerWidth - 360);
    let top = toolbarRect.bottom + 8;
    // Clamp so popup doesn't overflow below the viewport
    const popupHeight = 280;
    if (top + popupHeight > window.innerHeight) {
      top = Math.max(8, toolbarRect.top - popupHeight - 8);
    }
    popup.style.left = `${Math.max(8, left)}px`;
    popup.style.top = `${top}px`;
    popupSelection.textContent = state.selectionInfo.selectedText;
    commentInput.value = "";
    popup.hidden = false;
    selectionToolbar.hidden = true;
    commentInput.focus();
  });

  // Make comment popup draggable via its header
  {
    const popupHeader = popup.querySelector(".popup-header");
    let dragging = false, dragStartX = 0, dragStartY = 0, popupStartX = 0, popupStartY = 0;

    popupHeader.addEventListener("mousedown", (e) => {
      dragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      popupStartX = popup.offsetLeft;
      popupStartY = popup.offsetTop;
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      popup.style.left = `${popupStartX + dx}px`;
      popup.style.top = `${popupStartY + dy}px`;
    });

    document.addEventListener("mouseup", () => {
      dragging = false;
    });
  }

  $("#commentCancel").addEventListener("click", hidePopup);
  $("#commentSubmit").addEventListener("click", submitComment);

  commentInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submitComment();
    }
    if (e.key === "Escape") {
      hidePopup();
    }
  });

  // File-level comment button
  fileCommentBtn.addEventListener("click", () => {
    if (!state.currentFile) return;

    // Position popup below the button
    const btnRect = fileCommentBtn.getBoundingClientRect();
    popup.style.left = `${Math.max(8, btnRect.left - 280)}px`;
    popup.style.top = `${btnRect.bottom + 8}px`;

    // Hide the selection preview, set file-comment mode
    popupSelection.hidden = true;
    popup.querySelector(".popup-header").textContent = "File comment";
    commentInput.value = "";
    commentInput.placeholder = "Comment on the whole file...";
    state.selectionInfo = { offset: 0, length: 0, selectedText: "" };
    popup.hidden = false;
    commentInput.focus();
  });

  // --- Format button clicks ---

  selectionToolbar.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-format]");
    if (!btn) return;
    applyMarkdownFormat(btn.dataset.format);
  });

  // --- Keyboard shortcuts for formatting ---

  document.addEventListener("keydown", (e) => {
    if (!state.selectionInfo || state.selectionInfo.offset < 0) return;
    if (!isMarkdownFile(state.currentFile)) return;
    if (e.target.closest("input, textarea, [contenteditable]")) return;

    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;

    const map = { b: "bold", i: "italic", e: "code", k: "link" };
    if (e.shiftKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      applyMarkdownFormat("strikethrough");
    } else if (map[e.key]) {
      e.preventDefault();
      applyMarkdownFormat(map[e.key]);
    }
  });

  // Hide trigger when selection is cleared (non-markdown files only)
  document.addEventListener("selectionchange", () => {
    // For markdown files with editor, onSelectionUpdate handles show/hide
    const editor = getEditor();
    if (editor && isMarkdownFile(state.currentFile)) return;

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      setTimeout(() => {
        const sel = window.getSelection();
        if (popup.hidden && (!sel || sel.isCollapsed)) hideTrigger();
      }, 100);
    }
  });
}
