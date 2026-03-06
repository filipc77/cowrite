// @ts-check
import { state } from './state.js';
import { getEditor, setMarkdownContent, getMarkdownContent, isMarkdownFile } from './editor.js';
import { send } from './ws-client.js';
import { pushUndo } from './undo-manager.js';
import { loadUndoStack } from './undo-manager.js';
import { applyHighlights } from './comment-highlight.js';
import { renderComments } from './comment-sidebar.js';
import { $ } from './utils.js';

let pendingUpdate = null;
let submitEditTimer = 0;

/** Debounced submitEdit — saves 500ms after last keystroke. */
export function debouncedSubmitEdit() {
  clearTimeout(submitEditTimer);
  submitEditTimer = setTimeout(submitEdit, 500);
}

/** Cancel any pending debounced submit (e.g. when an external file change arrives). */
function cancelDebouncedSubmit() {
  clearTimeout(submitEditTimer);
  state.editorDirty = false;
}

/**
 * Render mermaid diagrams.
 * - Plain-text container: modifies DOM directly (safe, not tracked by ProseMirror).
 * - ProseMirror (markdown): renders into an overlay container OUTSIDE the editor
 *   to avoid corrupting the doc model. Original code blocks are hidden via CSS.
 */
async function renderMermaidDiagrams() {
  if (!window.__mermaid) return;
  const fileContentEl = $('#fileContent');

  // --- Plain-text container (non-markdown files) ---
  const plainContainer = fileContentEl.querySelector('.plain-text-container');
  if (plainContainer) {
    const blocks = plainContainer.querySelectorAll('pre code.language-mermaid');
    const containers = [];
    for (const code of blocks) {
      const pre = code.parentElement;
      if (!pre) continue;
      if (!pre.parentElement?.classList.contains('mermaid-container')) {
        const wrapper = document.createElement('div');
        wrapper.className = 'mermaid-container';
        pre.parentElement.insertBefore(wrapper, pre);
        wrapper.appendChild(pre);
      }
      pre.classList.add('mermaid');
      containers.push(pre);
    }
    if (containers.length > 0) {
      try { await window.__mermaid.run({ nodes: containers }); }
      catch (err) { console.error('Mermaid rendering failed:', err); }
    }
    return;
  }

  // --- ProseMirror (markdown files) ---
  // Render into an overlay container OUTSIDE ProseMirror to avoid DOM corruption.
  const proseMirror = fileContentEl.querySelector('.ProseMirror');
  if (!proseMirror) return;

  // Remove old overlay
  const oldOverlay = fileContentEl.querySelector('.mermaid-overlay');
  if (oldOverlay) oldOverlay.remove();

  const codeBlocks = proseMirror.querySelectorAll('pre code.language-mermaid');
  if (codeBlocks.length === 0) {
    fileContentEl.classList.remove('has-mermaid-overlays');
    return;
  }

  // Create overlay container as sibling of ProseMirror (not inside it)
  const overlay = document.createElement('div');
  overlay.className = 'mermaid-overlay';
  fileContentEl.appendChild(overlay);
  fileContentEl.classList.add('has-mermaid-overlays');

  const renderTargets = [];
  for (const code of codeBlocks) {
    const pre = code.parentElement;
    if (!pre) continue;

    // Get position of the code block relative to fileContent
    const preRect = pre.getBoundingClientRect();
    const parentRect = fileContentEl.getBoundingClientRect();
    const top = preRect.top - parentRect.top + fileContentEl.scrollTop;
    const left = preRect.left - parentRect.left;

    const renderDiv = document.createElement('div');
    renderDiv.className = 'mermaid mermaid-overlay-item';
    renderDiv.textContent = code.textContent;
    renderDiv.style.position = 'absolute';
    renderDiv.style.top = `${top}px`;
    renderDiv.style.left = `${left}px`;
    renderDiv.style.width = `${preRect.width}px`;
    overlay.appendChild(renderDiv);
    renderTargets.push(renderDiv);
  }

  if (renderTargets.length > 0) {
    try { await window.__mermaid.run({ nodes: renderTargets }); }
    catch (err) { console.error('Mermaid rendering failed:', err); }
  }
}

/**
 * Enhance code blocks with a header (language label + copy button).
 * Only operates on the plain-text container (non-markdown files).
 * NEVER modifies ProseMirror DOM — injecting elements there corrupts the
 * doc model and produces "codeCopy" artifacts in the serialized markdown.
 */
function enhanceCodeBlocks() {
  const fileContentEl = $('#fileContent');
  // Only process plain-text container — never touch ProseMirror DOM
  const container = fileContentEl.querySelector('.plain-text-container');
  if (!container) return;
  const codeBlocks = container.querySelectorAll('pre');

  for (const pre of codeBlocks) {
    if (pre.closest('.mermaid-container')) continue;
    if (pre.parentElement?.classList.contains('code-block-wrapper')) continue;

    const code = pre.querySelector('code');
    const langClass = code?.className.match(/language-(\w+)/);
    const lang = langClass ? langClass[1] : '';

    const wrapper = document.createElement('div');
    wrapper.className = 'code-block-wrapper';

    const header = document.createElement('div');
    header.className = 'code-block-header';

    const langSpan = document.createElement('span');
    langSpan.className = 'code-block-lang';
    langSpan.textContent = lang || 'code';
    header.appendChild(langSpan);

    const copyBtn = document.createElement('button');
    copyBtn.className = 'code-copy-btn';
    copyBtn.textContent = 'Copy';
    header.appendChild(copyBtn);

    pre.parentElement.insertBefore(wrapper, pre);
    wrapper.appendChild(header);
    wrapper.appendChild(pre);

    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(code?.textContent || '').then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
      });
    });
  }
}

/**
 * Post-process content after updates.
 * Code block enhancement and mermaid rendering only apply to the plain-text
 * container (non-markdown files). ProseMirror DOM is never modified.
 */
async function postProcessContent() {
  enhanceCodeBlocks();
  await renderMermaidDiagrams();
}

/**
 * Handle file_update from WebSocket.
 * For markdown files: update TipTap editor content.
 * For non-markdown files: render as plain text with data-offset spans.
 * @param {object} msg - {file, content, html}
 */
export function handleFileUpdate(msg) {
  const filePathEl = $('#filePath');
  filePathEl.textContent = msg.file;

  const fileChanged = state.currentFile !== msg.file;
  state.currentFile = msg.file;

  if (fileChanged && msg.file) {
    state.undoStack = loadUndoStack(msg.file);
    const undoBtn = /** @type {HTMLButtonElement} */ ($('#undoBtn'));
    undoBtn.disabled = state.undoStack.length === 0;
  }

  const fileContentEl = $('#fileContent');
  const editor = getEditor();

  if (!isMarkdownFile(msg.file)) {
    // Non-markdown: use server-rendered HTML (plain text with data-offset spans)
    state.currentContent = msg.content;
    state.currentHtml = msg.html;
    // Hide TipTap editor, show plain HTML
    const proseMirror = fileContentEl.querySelector('.ProseMirror');
    if (proseMirror) /** @type {HTMLElement} */ (proseMirror).style.display = 'none';

    // Create or reuse a plain-text container
    let plainContainer = /** @type {HTMLElement|null} */ (fileContentEl.querySelector('.plain-text-container'));
    if (!plainContainer) {
      plainContainer = document.createElement('div');
      plainContainer.className = 'plain-text-container';
      fileContentEl.appendChild(plainContainer);
    }
    plainContainer.style.display = '';
    plainContainer.innerHTML = msg.html;
    applyHighlights(null, false);
    return;
  }

  // Markdown file: use TipTap
  // Show TipTap, hide plain container
  const proseMirror = fileContentEl.querySelector('.ProseMirror');
  if (proseMirror) /** @type {HTMLElement} */ (proseMirror).style.display = '';
  const plainContainer = /** @type {HTMLElement|null} */ (fileContentEl.querySelector('.plain-text-container'));
  if (plainContainer) plainContainer.style.display = 'none';

  if (editor && editor.isFocused && state.editorDirty) {
    // External file change arrived while user has unsaved preview edits.
    // Cancel the debounced submit to prevent it from overwriting the file
    // with stale editor content, then fall through to apply the update.
    cancelDebouncedSubmit();
  }

  // Update state after the dirty check so any in-flight submitEdit()
  // doesn't use mismatched lengths
  state.currentContent = msg.content;
  state.currentHtml = msg.html;

  if (editor) {
    // Apply content update
    setMarkdownContent(msg.content);
    // Re-render comments so orphan checks run against fresh editor content,
    // but skip when editor is focused to avoid a full-DOM sidebar flash
    if (!editor.isFocused) {
      renderComments();
    }
    postProcessContent().then(() => applyHighlights(editor, true));
  }
}

/**
 * Apply any pending file update (called when editor loses focus).
 */
export function applyPendingUpdate() {
  if (!pendingUpdate) return;
  const msg = pendingUpdate;
  pendingUpdate = null;

  state.currentContent = msg.content;
  state.currentHtml = msg.html;
  state.editorDirty = false;
  setMarkdownContent(msg.content);
  renderComments();
  const editor = getEditor();
  postProcessContent().then(() => applyHighlights(editor, true));
}

/**
 * Submit the current editor content as an edit if it changed.
 */
export function submitEdit() {
  const editor = getEditor();
  if (!editor) return;

  // Only submit if the user actually edited (typed/pasted/formatted),
  // not just clicked in and out. TipTap's markdown serialization isn't
  // lossless, so comparing content alone causes false positives that
  // corrupt the file.
  if (!state.editorDirty) return;

  const newContent = getMarkdownContent();
  if (newContent === state.currentContent) {
    state.editorDirty = false;
    return;
  }

  pushUndo();
  send({
    type: 'edit_apply',
    offset: 0,
    length: state.currentContent.length,
    newText: newContent,
  });
  state.currentContent = newContent;
  state.editorDirty = false;
}

/**
 * Re-render content for theme changes etc.
 * For TipTap markdown files, highlights just need to be re-applied.
 * For non-markdown files, re-render from stored HTML.
 */
export function reRenderContent() {
  const editor = getEditor();
  const isMd = isMarkdownFile(state.currentFile);
  if (isMd) {
    postProcessContent().then(() => applyHighlights(editor, true));
  } else {
    const fileContentEl = $('#fileContent');
    const plainContainer = /** @type {HTMLElement|null} */ (fileContentEl.querySelector('.plain-text-container'));
    if (plainContainer) {
      plainContainer.innerHTML = state.currentHtml;
    }
    applyHighlights(null, false);
  }
}
