// @ts-check

/** @typedef {import('../src/types.js').Comment} Comment */
/** @typedef {import('../src/types.js').WSServerMessage} WSServerMessage */

const $ = (sel) => document.querySelector(sel);
const fileContentEl = $("#fileContent");
const commentListEl = $("#commentList");
const commentCountEl = $("#commentCount");
const filePathEl = $("#filePath");
const statusEl = $("#status");
const popup = $("#commentPopup");
const popupSelection = $("#popupSelection");
const commentInput = $("#commentInput");
const selectionToolbar = $("#selectionToolbar");
const commentTrigger = $("#commentTrigger");
const highlightPopover = $("#highlightPopover");
const highlightPopoverText = $("#highlightPopoverText");
const highlightEditBtn = $("#highlightEditBtn");
const undoBtn = $("#undoBtn");
const filePicker = $("#filePicker");
const fileList = $("#fileList");
const fileCommentBtn = $("#fileCommentBtn");

/** @type {Comment[]} */
let comments = [];
let currentFile = "";
let currentContent = "";
let ws = null;
let selectionInfo = null;
let currentHtml = "";
let currentBlocks = [];
let insertBtn = null;
let insertLine = null;
let activeGapIndex = -1;
let activeHighlightCommentId = null;
let undoStack = [];
const MAX_UNDO = 50;

// Click-to-edit state
let editingBlockIndex = -1;
let editingBlockEl = null;
let editingOriginalSource = "";
let editingContentSnapshot = "";
let pendingFileUpdate = null;
let pendingEditAfterInsert = -1;
let contentEditableActive = false;

const BLOCK_TYPES = [
  { id: "text",    label: "Text",          category: "Basic blocks", icon: "Aa",  template: "\u200B" },
  { id: "h1",      label: "Heading 1",     category: "Basic blocks", icon: "H1",  template: "# " },
  { id: "h2",      label: "Heading 2",     category: "Basic blocks", icon: "H2",  template: "## " },
  { id: "h3",      label: "Heading 3",     category: "Basic blocks", icon: "H3",  template: "### " },
  { id: "bullet",  label: "Bulleted list", category: "Basic blocks", icon: "\u2022",   template: "- " },
  { id: "number",  label: "Numbered list", category: "Basic blocks", icon: "1.",  template: "1. " },
  { id: "quote",   label: "Quote",         category: "Basic blocks", icon: "\u201C",   template: "> " },
  { id: "divider", label: "Divider",       category: "Basic blocks", icon: "\u2014",   template: "---" },
  { id: "code",    label: "Code block",    category: "Advanced",     icon: "</>", template: "```\n\n```" },
  { id: "table",   label: "Table",         category: "Advanced",     icon: "\u229E",  template: "| Column 1 | Column 2 |\n| -------- | -------- |\n| Cell 1   | Cell 2   |" },
];

// --- File Picker ---

async function loadFileList() {
  try {
    const res = await fetch("/api/files");
    const data = await res.json();
    fileList.innerHTML = "";
    for (const file of data.files) {
      if (!/\.(md|markdown|mdx)$/i.test(file)) continue;
      const option = document.createElement("option");
      option.value = file;
      fileList.appendChild(option);
    }
  } catch {
    // Will retry on reconnect
  }
}

function switchFile(file) {
  if (!file || !ws || ws.readyState !== WebSocket.OPEN) return;
  if (currentFile) saveUndoStack(currentFile);
  undoStack = loadUndoStack(file);
  undoBtn.disabled = undoStack.length === 0;
  send({ type: "switch_file", file });
  filePicker.value = "";
  // Update URL without reload
  const url = new URL(location.href);
  url.searchParams.set("file", file);
  history.replaceState(null, "", url.toString());
}

filePicker.addEventListener("change", () => {
  const file = filePicker.value.trim();
  if (file) switchFile(file);
});

filePicker.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const file = filePicker.value.trim();
    if (file) switchFile(file);
  }
});

// --- WebSocket ---

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    statusEl.innerHTML = '<span class="status-dot"></span>Connected';
    statusEl.className = "status connected";

    // If URL has ?file= param, switch to that file
    const params = new URLSearchParams(location.search);
    const fileParam = params.get("file");
    if (fileParam) {
      send({ type: "switch_file", file: fileParam });
      undoStack = loadUndoStack(fileParam);
      undoBtn.disabled = undoStack.length === 0;
    }

    loadFileList();
  };

  ws.onclose = () => {
    statusEl.innerHTML = '<span class="status-dot"></span>Disconnected';
    statusEl.className = "status";
    setTimeout(connect, 2000);
  };

  ws.onmessage = (event) => {
    /** @type {WSServerMessage} */
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case "file_update":
        closeBlockTypeMenu();
        if (editingBlockIndex !== -1) {
          pendingFileUpdate = msg;
          currentFile = msg.file;
          currentContent = msg.content;
          currentHtml = msg.html;
          break;
        }
        applyFileUpdate(msg);
        break;
      case "comments_update":
        comments = msg.comments;
        commentCountEl.textContent = String(comments.filter(c => c.status === "pending").length);
        renderComments();
        applyHighlights();
        break;
      case "error":
        console.error("Server error:", msg.message);
        break;
    }
  };
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function applyFileUpdate(msg) {
  const fileChanged = currentFile !== msg.file;
  currentFile = msg.file;
  currentContent = msg.content;
  currentHtml = msg.html;
  if (fileChanged && msg.file) {
    undoStack = loadUndoStack(msg.file);
    undoBtn.disabled = undoStack.length === 0;
  }
  filePathEl.textContent = msg.file;
  fileContentEl.innerHTML = msg.html;
  insertBtn = null;
  insertLine = null;
  renderMermaidDiagrams();
  applyHighlights();
  updateBlockMap();

  if (pendingEditAfterInsert !== -1) {
    const idx = pendingEditAfterInsert;
    pendingEditAfterInsert = -1;
    if (idx >= 0 && idx < currentBlocks.length) {
      // Enter edit mode synchronously so editingBlockIndex is set before
      // any subsequent file_update messages can re-render the DOM
      enterBlockEditDispatch(idx);
    }
  }
}

function reRenderContent() {
  fileContentEl.innerHTML = currentHtml;
  insertBtn = null;
  insertLine = null;
  renderMermaidDiagrams();
  applyHighlights();
  updateBlockMap();
}

// --- Selection & Comment Creation ---

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

  // Compute character offset in the source content
  const offset = computeOffset(selection, text);
  if (offset === -1) {
    hideTrigger();
    return;
  }

  selectionInfo = { offset, length: text.length, selectedText: text };

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  selectionToolbar.style.left = `${rect.left + rect.width / 2 - 40}px`;
  selectionToolbar.style.top = `${rect.top - 40}px`;
  selectionToolbar.hidden = false;
});

// Prevent the mousedown from clearing the text selection
selectionToolbar.addEventListener("mousedown", (e) => {
  e.preventDefault();
});

// Clicking Comment opens the full comment popup
commentTrigger.addEventListener("click", () => {
  if (!selectionInfo) return;

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
  popupSelection.textContent = selectionInfo.selectedText;
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
  const idx = currentContent.indexOf(text);
  if (idx !== -1) return idx;

  return -1;
}

function hideTrigger() {
  selectionToolbar.hidden = true;
  selectionInfo = null;
}

function hidePopup() {
  popup.hidden = true;
  selectionInfo = null;
  // Reset popup to default state for next use
  popupSelection.hidden = false;
  popup.querySelector(".popup-header").textContent = "Selection";
  commentInput.placeholder = "Leave a comment...";
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

fileCommentBtn.addEventListener("click", () => {
  if (!currentFile) return;

  // Position popup below the button
  const btnRect = fileCommentBtn.getBoundingClientRect();
  popup.style.left = `${Math.max(8, btnRect.left - 280)}px`;
  popup.style.top = `${btnRect.bottom + 8}px`;

  // Hide the selection preview, set file-comment mode
  popupSelection.hidden = true;
  popup.querySelector(".popup-header").textContent = "File comment";
  commentInput.value = "";
  commentInput.placeholder = "Comment on the whole file...";
  selectionInfo = { offset: 0, length: 0, selectedText: "" };
  popup.hidden = false;
  commentInput.focus();
});

function submitComment() {
  const text = commentInput.value.trim();
  if (!text || !selectionInfo) return;

  send({
    type: "comment_add",
    file: currentFile,
    offset: selectionInfo.offset,
    length: selectionInfo.length,
    selectedText: selectionInfo.selectedText,
    comment: text,
  });

  hidePopup();
  window.getSelection()?.removeAllRanges();
}

// --- Comment Sidebar Rendering ---

function renderComments() {
  if (comments.length === 0) {
    commentListEl.innerHTML = `
      <div class="empty-state">
        <p>No comments yet.</p>
        <p>Select text to comment, or use + for file comments.</p>
      </div>
    `;
    return;
  }

  commentListEl.innerHTML = comments.map((c) => `
    <div class="comment-card ${c.status}" data-id="${c.id}">
      <button class="comment-delete-btn" onclick="deleteComment('${c.id}')" title="Delete comment">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
      ${c.selectedText
        ? `<div class="comment-selected-text">${escapeHtml(c.selectedText)}</div>`
        : `<div class="comment-file-badge">Whole file</div>`
      }
      <div class="comment-text">${escapeHtml(c.comment)}</div>
      ${c.replies.length > 0 ? `
        <div class="comment-replies">
          ${c.replies.map((r) => `
            <div class="reply ${r.from}">
              <div class="reply-from ${r.from}">${r.from}</div>
              <div>${escapeHtml(r.text)}</div>
            </div>
          `).join("")}
        </div>
      ` : ""}
      <div class="comment-meta">
        <span>${timeAgo(c.createdAt)}</span>
        <span class="comment-status ${c.status}">${c.status}</span>
      </div>
      ${c.status !== "resolved" ? `
        <div class="comment-actions">
          <button onclick="showReplyForm('${c.id}')">Reply</button>
          <button onclick="resolveComment('${c.id}')">Resolve</button>
        </div>
      ` : `
        <div class="comment-actions">
          <button onclick="reopenComment('${c.id}')">Reopen</button>
        </div>
      `}
      <div class="reply-form" id="reply-form-${c.id}" hidden>
        <textarea rows="2" placeholder="Reply..."></textarea>
        <div class="reply-form-actions">
          <button onclick="submitReply('${c.id}')">Send</button>
        </div>
      </div>
    </div>
  `).join("");

  // Click to scroll to highlight
  for (const card of commentListEl.querySelectorAll(".comment-card")) {
    card.addEventListener("click", (e) => {
      if (e.target.tagName === "BUTTON" || e.target.tagName === "TEXTAREA") return;
      const id = card.dataset.id;
      const highlight = fileContentEl.querySelector(`[data-comment-id="${id}"]`);
      if (highlight) {
        highlight.scrollIntoView({ behavior: "smooth", block: "center" });
        highlight.style.outline = "2px solid var(--accent)";
        setTimeout(() => highlight.style.outline = "", 1500);
      }
    });
  }
}

// Global functions for inline onclick handlers
window.showReplyForm = function (id) {
  const form = document.getElementById(`reply-form-${id}`);
  if (form) {
    form.hidden = !form.hidden;
    if (!form.hidden) form.querySelector("textarea").focus();
  }
};

window.resolveComment = function (id) {
  send({ type: "comment_resolve", commentId: id });
};

window.reopenComment = function (id) {
  send({ type: "comment_reopen", commentId: id });
};

window.deleteComment = function (id) {
  send({ type: "comment_delete", commentId: id });
};

window.submitReply = function (id) {
  const form = document.getElementById(`reply-form-${id}`);
  const textarea = form?.querySelector("textarea");
  const text = textarea?.value.trim();
  if (!text) return;
  send({ type: "comment_reply", commentId: id, text });
  textarea.value = "";
  form.hidden = true;
};

// --- Highlights ---

function applyHighlights() {
  // Remove existing highlights
  for (const el of fileContentEl.querySelectorAll(".comment-highlight")) {
    const parent = el.parentNode;
    parent.replaceChild(document.createTextNode(el.textContent), el);
    parent.normalize();
  }

  if (comments.length === 0) return;

  // Build a text-node map
  const walker = document.createTreeWalker(fileContentEl, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let totalOffset = 0;

  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.textContent || "";
    textNodes.push({ node, start: totalOffset, end: totalOffset + text.length });
    totalOffset += text.length;
  }

  const fullText = textNodes.map((n) => n.node.textContent).join("");

  // Highlight pending and answered comments — resolved ones act as regular text
  for (const comment of comments) {
    // Render highlights for all statuses (resolved ones are invisible via CSS but present for click-to-scroll)
    if (!comment.selectedText) continue;
    const searchText = comment.selectedText;
    // Search near the expected offset first, then globally
    let textIdx = fullText.indexOf(searchText, Math.max(0, comment.offset - 50));
    if (textIdx === -1 || Math.abs(textIdx - comment.offset) > 200) {
      textIdx = fullText.indexOf(searchText);
    }
    if (textIdx === -1) continue;

    wrapRange(textNodes, textIdx, textIdx + searchText.length, comment);
  }
}

function wrapRange(textNodes, start, end, comment) {
  for (let i = 0; i < textNodes.length; i++) {
    const tn = textNodes[i];
    if (tn.end <= start || tn.start >= end) continue;

    const nodeStart = Math.max(start - tn.start, 0);
    const nodeEnd = Math.min(end - tn.start, tn.node.textContent.length);

    const range = document.createRange();
    range.setStart(tn.node, nodeStart);
    range.setEnd(tn.node, nodeEnd);

    const span = document.createElement("span");
    span.className = `comment-highlight ${comment.status}`;
    span.dataset.commentId = comment.id;
    span.title = comment.comment;

    try {
      range.surroundContents(span);
      return;
    } catch {
      return;
    }
  }
}

// --- Utilities ---

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// --- Theme Toggle ---

const themeToggle = $("#themeToggle");
const THEME_KEY = "cowrite-theme";

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  themeToggle.checked = theme === "light";
  const icon = themeToggle.closest(".theme-toggle").querySelector(".toggle-icon");
  if (icon) icon.textContent = theme === "light" ? "\u2600" : "\u263E";
  const label = document.querySelector(".toggle-label");
  if (label) label.textContent = theme === "light" ? "Light" : "Dark";
  const hljsDark = document.getElementById("hljs-dark");
  const hljsLight = document.getElementById("hljs-light");
  if (hljsDark && hljsLight) {
    hljsDark.disabled = theme === "light";
    hljsLight.disabled = theme !== "light";
  }
  const gmcDark = document.getElementById("gmc-dark");
  const gmcLight = document.getElementById("gmc-light");
  if (gmcDark && gmcLight) {
    gmcDark.disabled = theme === "light";
    gmcLight.disabled = theme !== "light";
  }
  if (window.__mermaid && currentHtml) {
    window.__mermaid.initialize({ startOnLoad: false, theme: theme === "light" ? "default" : "dark" });
    fileContentEl.innerHTML = currentHtml;
    renderMermaidDiagrams();
    applyHighlights();
    updateBlockMap();
  }
}

const savedTheme = localStorage.getItem(THEME_KEY) || "dark";
applyTheme(savedTheme);

themeToggle.addEventListener("change", () => {
  const theme = themeToggle.checked ? "light" : "dark";
  localStorage.setItem(THEME_KEY, theme);
  applyTheme(theme);
});

// Hide trigger when selection is cleared
document.addEventListener("selectionchange", () => {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) {
    setTimeout(() => {
      if (popup.hidden) hideTrigger();
    }, 100);
  }
});

// --- Mermaid Rendering ---

async function renderMermaidDiagrams() {
  if (!window.__mermaid) return;
  const blocks = fileContentEl.querySelectorAll("pre.mermaid");
  if (blocks.length === 0) return;
  try {
    await window.__mermaid.run({ nodes: blocks });
  } catch (err) {
    console.error("Mermaid rendering failed:", err);
  }
}

// --- Block Gutter Insert ---

function updateBlockMap() {
  const container = fileContentEl.querySelector(".markdown-body, .plain-text");
  if (!container || !container.dataset.blocks) {
    currentBlocks = [];
    return;
  }
  try {
    currentBlocks = JSON.parse(container.dataset.blocks);
  } catch {
    currentBlocks = [];
  }
}

function ensureInsertElements() {
  if (!insertBtn) {
    insertBtn = document.createElement("button");
    insertBtn.className = "block-insert-btn";
    insertBtn.textContent = "+";
    insertBtn.addEventListener("mousedown", (e) => e.preventDefault());
    insertBtn.addEventListener("click", handleInsertClick);
    fileContentEl.appendChild(insertBtn);

    insertLine = document.createElement("div");
    insertLine.className = "block-insert-line";
    fileContentEl.appendChild(insertLine);
  }
}

function getBlockChildren() {
  const container = fileContentEl.querySelector(".markdown-body, .plain-text");
  if (!container) return [];
  return Array.from(container.children).filter(
    (el) =>
      !el.classList.contains("block-insert-btn") &&
      !el.classList.contains("block-insert-line") &&
      !el.classList.contains("inline-editor") &&
      !el.classList.contains("block-type-menu") &&
      !el.classList.contains("block-edit-wrapper")
  );
}

$("#contentPanel").addEventListener("mousemove", (e) => {
  if (!currentBlocks.length) return;
  ensureInsertElements();

  const children = getBlockChildren();
  if (children.length === 0) return;

  const containerRect = fileContentEl.getBoundingClientRect();
  const mouseY = e.clientY;
  const hitZone = 14;
  let foundGap = -1;

  // Gap before first block
  const firstRect = children[0].getBoundingClientRect();
  if (mouseY < firstRect.top + hitZone && mouseY > firstRect.top - hitZone * 2) {
    foundGap = 0;
  }

  // Gaps between blocks
  if (foundGap === -1) {
    for (let i = 0; i < children.length - 1; i++) {
      const bottomOfCurrent = children[i].getBoundingClientRect().bottom;
      const topOfNext = children[i + 1].getBoundingClientRect().top;
      const gapCenter = (bottomOfCurrent + topOfNext) / 2;

      if (Math.abs(mouseY - gapCenter) < hitZone) {
        foundGap = i + 1;
        break;
      }
    }
  }

  // Gap after last block
  if (foundGap === -1) {
    const lastRect = children[children.length - 1].getBoundingClientRect();
    if (mouseY > lastRect.bottom - hitZone && mouseY < lastRect.bottom + hitZone * 2) {
      foundGap = children.length;
    }
  }

  if (foundGap !== -1) {
    activeGapIndex = foundGap;
    let gapY;
    if (foundGap === 0) {
      gapY = children[0].getBoundingClientRect().top - containerRect.top - 8;
    } else if (foundGap === children.length) {
      gapY = children[children.length - 1].getBoundingClientRect().bottom - containerRect.top + 8;
    } else {
      const bottom = children[foundGap - 1].getBoundingClientRect().bottom;
      const top = children[foundGap].getBoundingClientRect().top;
      gapY = (bottom + top) / 2 - containerRect.top;
    }

    insertBtn.style.top = `${gapY}px`;
    insertBtn.classList.add("visible");
    insertLine.style.top = `${gapY}px`;
    insertLine.classList.add("visible");
  } else {
    insertBtn.classList.remove("visible");
    insertLine.classList.remove("visible");
    activeGapIndex = -1;
  }
});

$("#contentPanel").addEventListener("mouseleave", () => {
  if (insertBtn) {
    insertBtn.classList.remove("visible");
    insertLine.classList.remove("visible");
  }
  activeGapIndex = -1;
});

function handleInsertClick() {
  if (activeGapIndex === -1 || !currentBlocks.length) return;

  let insertOffset;
  if (activeGapIndex === 0) {
    insertOffset = 0;
  } else if (activeGapIndex >= currentBlocks.length) {
    insertOffset = currentContent.length;
  } else {
    insertOffset = currentBlocks[activeGapIndex].sourceStart;
  }

  showBlockTypeMenu(insertOffset, activeGapIndex);
}

function closeBlockTypeMenu() {
  const existing = fileContentEl.querySelector(".block-type-menu");
  if (existing) existing.remove();
  if (closeBlockTypeMenu._handler) {
    document.removeEventListener("mousedown", closeBlockTypeMenu._handler);
    closeBlockTypeMenu._handler = null;
  }
}

function showBlockTypeMenu(insertOffset, gapIndex) {
  closeBlockTypeMenu();

  const container = fileContentEl.querySelector(".markdown-body, .plain-text");
  if (!container) return;

  if (insertBtn) {
    insertBtn.classList.remove("visible");
    insertLine.classList.remove("visible");
  }

  // Capture gapIndex now — activeGapIndex may change as the user moves the mouse to the menu
  const capturedGapIndex = gapIndex;

  const menu = document.createElement("div");
  menu.className = "block-type-menu";

  const filter = document.createElement("input");
  filter.className = "block-type-filter";
  filter.placeholder = "Filter...";
  menu.appendChild(filter);

  const list = document.createElement("div");
  list.className = "block-type-list";
  menu.appendChild(list);

  let highlightIdx = 0;

  function renderItems(query) {
    list.innerHTML = "";
    const q = query.toLowerCase();
    const filtered = BLOCK_TYPES.filter(
      (bt) => !q || bt.label.toLowerCase().includes(q) || bt.id.includes(q)
    );

    if (filtered.length === 0) {
      list.innerHTML = '<div class="block-type-empty">No matches</div>';
      return [];
    }

    let lastCategory = "";
    const items = [];
    for (const bt of filtered) {
      if (bt.category !== lastCategory) {
        lastCategory = bt.category;
        const header = document.createElement("div");
        header.className = "block-type-category";
        header.textContent = bt.category;
        list.appendChild(header);
      }
      const item = document.createElement("div");
      item.className = "block-type-item";
      item.innerHTML = `<span class="block-type-icon">${escapeHtml(bt.icon)}</span><span>${escapeHtml(bt.label)}</span>`;
      item.addEventListener("click", () => {
        applyBlockTypeInsert(bt, insertOffset, capturedGapIndex);
        closeBlockTypeMenu();
      });
      list.appendChild(item);
      items.push({ el: item, bt });
    }

    items.forEach((it, i) => {
      it.el.addEventListener("mouseenter", () => {
        highlightIdx = i;
        updateHighlight(items);
      });
    });

    highlightIdx = Math.min(highlightIdx, items.length - 1);
    updateHighlight(items);
    return items;
  }

  function updateHighlight(items) {
    for (let i = 0; i < items.length; i++) {
      items[i].el.classList.toggle("highlighted", i === highlightIdx);
    }
  }

  let currentItems = renderItems("");

  filter.addEventListener("input", () => {
    highlightIdx = 0;
    currentItems = renderItems(filter.value);
  });

  filter.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (currentItems.length > 0) {
        highlightIdx = (highlightIdx + 1) % currentItems.length;
        updateHighlight(currentItems);
        currentItems[highlightIdx].el.scrollIntoView({ block: "nearest" });
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (currentItems.length > 0) {
        highlightIdx = (highlightIdx - 1 + currentItems.length) % currentItems.length;
        updateHighlight(currentItems);
        currentItems[highlightIdx].el.scrollIntoView({ block: "nearest" });
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (currentItems.length > 0 && currentItems[highlightIdx]) {
        applyBlockTypeInsert(currentItems[highlightIdx].bt, insertOffset, capturedGapIndex);
        closeBlockTypeMenu();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeBlockTypeMenu();
    }
  });

  const children = getBlockChildren();
  if (gapIndex >= children.length) {
    container.appendChild(menu);
  } else {
    container.insertBefore(menu, children[gapIndex]);
  }

  filter.focus();

  setTimeout(() => {
    const handler = (e) => {
      if (!menu.contains(e.target)) {
        closeBlockTypeMenu();
      }
    };
    closeBlockTypeMenu._handler = handler;
    document.addEventListener("mousedown", handler);
  }, 0);
}

function applyBlockTypeInsert(blockType, insertOffset, gapIndex) {
  const template = blockType.template;
  let newText;
  if (insertOffset === 0) {
    newText = template + "\n\n";
  } else if (insertOffset === currentContent.length) {
    newText = "\n\n" + template;
  } else {
    // Must use \n\n separators so marked treats the new block as a separate paragraph
    newText = "\n\n" + template + "\n\n";
  }

  if (blockType.id !== "divider") {
    pendingEditAfterInsert = gapIndex;
  }

  pushUndo();
  send({
    type: "edit_apply",
    offset: insertOffset,
    length: 0,
    newText: newText,
  });
}

// --- Click-to-edit ---

function findClickedBlockIndex(target) {
  const container = fileContentEl.querySelector(".markdown-body, .plain-text");
  if (!container) return -1;

  let el = target;
  while (el && el.parentElement !== container) {
    el = el.parentElement;
    if (!el) return -1;
  }

  const children = getBlockChildren();
  return children.indexOf(el);
}

function enterBlockEdit(blockIndex) {
  if (editingBlockIndex !== -1) return;
  if (blockIndex < 0 || blockIndex >= currentBlocks.length) return;

  const block = currentBlocks[blockIndex];
  const source = currentContent.slice(block.sourceStart, block.sourceEnd);

  const container = fileContentEl.querySelector(".markdown-body, .plain-text");
  if (!container) return;

  const children = getBlockChildren();
  const blockEl = children[blockIndex];
  if (!blockEl) return;

  editingBlockIndex = blockIndex;
  editingOriginalSource = source;
  editingContentSnapshot = currentContent;

  const wrapper = document.createElement("div");
  wrapper.className = "block-edit-wrapper";

  const textarea = document.createElement("textarea");
  textarea.className = "block-edit-textarea";
  textarea.value = source.replace(/\u200B/g, "");
  wrapper.appendChild(textarea);

  const hint = document.createElement("div");
  hint.className = "block-edit-hint";
  hint.textContent = "Cmd+Enter to save \u00B7 Escape to cancel";
  wrapper.appendChild(hint);

  container.replaceChild(wrapper, blockEl);
  editingBlockEl = wrapper;

  textarea.style.height = "auto";
  textarea.style.height = textarea.scrollHeight + "px";

  textarea.addEventListener("input", () => {
    textarea.style.height = "auto";
    textarea.style.height = textarea.scrollHeight + "px";
  });

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commitBlockEdit(textarea.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelBlockEdit();
    } else if (e.key === "Tab") {
      e.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      textarea.value = textarea.value.substring(0, start) + "  " + textarea.value.substring(end);
      textarea.selectionStart = textarea.selectionEnd = start + 2;
      textarea.dispatchEvent(new Event("input"));
    }
  });

  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  // Ensure focus sticks after any pending browser layout/paint
  requestAnimationFrame(() => {
    if (document.activeElement !== textarea) {
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }
  });

  textarea.addEventListener("blur", () => {
    setTimeout(() => {
      if (editingBlockIndex !== -1) commitBlockEdit(textarea.value);
    }, 100);
  });
}

function commitBlockEdit(newSource) {
  if (editingBlockIndex === -1) return;

  const blockIndex = editingBlockIndex;
  const originalSource = editingOriginalSource;
  const snapshot = editingContentSnapshot;

  editingBlockIndex = -1;
  editingBlockEl = null;
  editingOriginalSource = "";
  editingContentSnapshot = "";

  if (newSource === originalSource) {
    if (pendingFileUpdate) {
      applyFileUpdate(pendingFileUpdate);
      pendingFileUpdate = null;
    } else {
      reRenderContent();
    }
    return;
  }

  let block;
  if (currentContent === snapshot) {
    block = currentBlocks[blockIndex];
  } else {
    const tmp = document.createElement("div");
    tmp.innerHTML = currentHtml;
    const tmpContainer = tmp.querySelector("[data-blocks]");
    if (tmpContainer) {
      try {
        const updatedBlocks = JSON.parse(tmpContainer.dataset.blocks);
        if (blockIndex < updatedBlocks.length) {
          block = updatedBlocks[blockIndex];
        }
      } catch {}
    }
  }

  if (!block) {
    if (pendingFileUpdate) {
      applyFileUpdate(pendingFileUpdate);
      pendingFileUpdate = null;
    } else {
      reRenderContent();
    }
    return;
  }

  pushUndo();
  send({
    type: "edit_apply",
    offset: block.sourceStart,
    length: block.sourceEnd - block.sourceStart,
    newText: newSource,
  });

  if (pendingFileUpdate) {
    applyFileUpdate(pendingFileUpdate);
    pendingFileUpdate = null;
  }
}

function cancelBlockEdit() {
  editingBlockIndex = -1;
  editingBlockEl = null;
  editingOriginalSource = "";
  editingContentSnapshot = "";

  if (pendingFileUpdate) {
    applyFileUpdate(pendingFileUpdate);
    pendingFileUpdate = null;
  } else {
    reRenderContent();
  }
}

// --- Block type detection for hybrid editing ---

function getBlockType(element) {
  if (!element || !element.tagName) return "unknown";
  const tag = element.tagName.toLowerCase();
  if (tag === "p") return "paragraph";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "ul" || tag === "ol") return "list";
  if (tag === "blockquote") return "blockquote";
  if (element.classList.contains("code-block-wrapper")) return "code";
  if (tag === "pre") return "code";
  if (tag === "table") return "table";
  if (tag === "hr") return "divider";
  if (element.classList.contains("mermaid-container")) return "mermaid";
  return "unknown";
}

function enterBlockEditDispatch(blockIndex) {
  if (editingBlockIndex !== -1) return;
  if (blockIndex < 0 || blockIndex >= currentBlocks.length) return;

  const container = fileContentEl.querySelector(".markdown-body, .plain-text");
  if (!container) return;

  const children = getBlockChildren();
  const blockEl = children[blockIndex];
  if (!blockEl) return;

  const blockType = getBlockType(blockEl);

  if (blockType === "divider" || blockType === "mermaid") return;
  if (blockType === "code" || blockType === "table" || blockType === "unknown") {
    enterBlockEdit(blockIndex);
    return;
  }

  enterContentEditable(blockIndex, blockEl);
}

function enterContentEditable(blockIndex, blockEl) {
  if (editingBlockIndex !== -1) return;
  if (blockIndex < 0 || blockIndex >= currentBlocks.length) return;

  const block = currentBlocks[blockIndex];
  const source = currentContent.slice(block.sourceStart, block.sourceEnd);

  editingBlockIndex = blockIndex;
  editingOriginalSource = source;
  editingContentSnapshot = currentContent;
  contentEditableActive = true;
  editingBlockEl = blockEl;

  blockEl.contentEditable = "true";
  blockEl.classList.add("block-editing");

  // For empty blocks (ZWS placeholder), set up a clean empty editable state
  const isEmpty = !blockEl.textContent.replace(/\u200B/g, "").trim();
  if (isEmpty) {
    blockEl.innerHTML = "";
  }

  blockEl.focus();

  if (isEmpty) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.setStart(blockEl, 0);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Ensure focus sticks after any pending browser events
  setTimeout(() => {
    if (document.activeElement !== blockEl) {
      blockEl.focus();
    }
  }, 0);

  const blockType = getBlockType(blockEl);

  const onKeydown = (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commitContentEditable(blockEl);
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelContentEditable(blockEl);
    } else if (e.key === "Enter" && blockType === "heading") {
      e.preventDefault();
      commitContentEditable(blockEl);
    }
  };

  const onBlur = () => {
    setTimeout(() => {
      if (editingBlockIndex !== -1 && contentEditableActive) {
        commitContentEditable(blockEl);
      }
    }, 100);
  };

  const onPaste = (e) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    document.execCommand("insertText", false, text);
  };

  blockEl._ceHandlers = { onKeydown, onBlur, onPaste };
  blockEl.addEventListener("keydown", onKeydown);
  blockEl.addEventListener("blur", onBlur);
  blockEl.addEventListener("paste", onPaste);
}

function extractMarkdownFromElement(element, originalSource) {
  const blockType = getBlockType(element);
  const text = element.textContent.replace(/\u200B/g, "").trim();

  if (blockType === "paragraph") {
    return text;
  }

  if (blockType === "heading") {
    const match = originalSource.match(/^(#{1,6})\s/);
    const prefix = match ? match[1] : "#";
    return prefix + " " + text;
  }

  if (blockType === "blockquote") {
    return text.split("\n").map(line => "> " + line.trim()).join("\n");
  }

  if (blockType === "list") {
    const isOrdered = element.tagName.toLowerCase() === "ol";
    const items = Array.from(element.querySelectorAll("li"));
    return items.map((li, i) => {
      const prefix = isOrdered ? `${i + 1}. ` : "- ";
      return prefix + li.textContent.trim();
    }).join("\n");
  }

  return text;
}

function cleanupContentEditable(blockEl) {
  blockEl.contentEditable = "false";
  blockEl.classList.remove("block-editing");
  if (blockEl._ceHandlers) {
    blockEl.removeEventListener("keydown", blockEl._ceHandlers.onKeydown);
    blockEl.removeEventListener("blur", blockEl._ceHandlers.onBlur);
    blockEl.removeEventListener("paste", blockEl._ceHandlers.onPaste);
    blockEl._ceHandlers = null;
  }
  contentEditableActive = false;
}

function commitContentEditable(blockEl) {
  if (editingBlockIndex === -1 || !contentEditableActive) return;

  let newSource = extractMarkdownFromElement(blockEl, editingOriginalSource);

  // Preserve trailing whitespace from original source (e.g. \n\n after headings)
  const trimmedOriginal = editingOriginalSource.trimEnd();
  const trailingWs = editingOriginalSource.slice(trimmedOriginal.length);
  if (trailingWs) newSource = newSource.trimEnd() + trailingWs;

  cleanupContentEditable(blockEl);
  commitBlockEdit(newSource);
}

function cancelContentEditable(blockEl) {
  cleanupContentEditable(blockEl);
  cancelBlockEdit();
}

fileContentEl.addEventListener("click", (e) => {
  if (editingBlockIndex !== -1) return;

  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return;

  const target = e.target;
  if (target.closest("a, .mermaid-container, .block-insert-btn, .block-type-menu, .inline-editor, .block-edit-wrapper, .block-editing, .code-block-header")) return;

  // Handle comment highlight clicks
  const highlightEl = target.closest(".comment-highlight");
  if (highlightEl) {
    const commentId = highlightEl.dataset.commentId;
    const comment = comments.find(c => c.id === commentId);
    if (comment) {
      showHighlightPopover(highlightEl, comment);
    }
    return;
  }

  if (!currentBlocks.length) return;

  const blockIndex = findClickedBlockIndex(target);
  if (blockIndex === -1) return;

  enterBlockEditDispatch(blockIndex);
});

// --- Code copy button handler ---
fileContentEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".code-copy-btn");
  if (!btn) return;
  e.stopPropagation();
  const wrapper = btn.closest(".code-block-wrapper");
  const code = wrapper?.querySelector("code");
  if (!code) return;
  navigator.clipboard.writeText(code.textContent || "").then(() => {
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = "Copy"; }, 2000);
  });
});

// --- Highlight Popover ---

function showHighlightPopover(el, comment) {
  activeHighlightCommentId = comment.id;
  highlightPopoverText.textContent = comment.comment;

  const rect = el.getBoundingClientRect();
  highlightPopover.style.left = `${Math.min(rect.left, window.innerWidth - 260)}px`;
  highlightPopover.style.top = `${rect.bottom + 8}px`;
  highlightPopover.hidden = false;

  // Highlight and scroll to the corresponding comment card in the sidebar
  for (const card of commentListEl.querySelectorAll(".comment-card")) {
    card.classList.remove("active");
  }
  const card = commentListEl.querySelector(`.comment-card[data-id="${comment.id}"]`);
  if (card) {
    card.classList.add("active");
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function hideHighlightPopover() {
  highlightPopover.hidden = true;
  activeHighlightCommentId = null;
  for (const card of commentListEl.querySelectorAll(".comment-card.active")) {
    card.classList.remove("active");
  }
}

highlightEditBtn.addEventListener("click", () => {
  if (!activeHighlightCommentId) return;
  const comment = comments.find(c => c.id === activeHighlightCommentId);
  if (!comment) { hideHighlightPopover(); return; }

  for (let i = 0; i < currentBlocks.length; i++) {
    const b = currentBlocks[i];
    if (comment.offset >= b.sourceStart && comment.offset < b.sourceEnd) {
      hideHighlightPopover();
      enterBlockEditDispatch(i);
      return;
    }
  }
  hideHighlightPopover();
});

document.addEventListener("mousedown", (e) => {
  if (!highlightPopover.hidden && !highlightPopover.contains(e.target) && !e.target.closest(".comment-highlight")) {
    hideHighlightPopover();
  }
});

// --- Undo Stack ---

function saveUndoStack(file) {
  try {
    sessionStorage.setItem("cowrite-undo:" + file, JSON.stringify(undoStack));
  } catch (e) {
    undoStack.splice(0, undoStack.length - 5);
    try { sessionStorage.setItem("cowrite-undo:" + file, JSON.stringify(undoStack)); } catch (_) {}
  }
}

function loadUndoStack(file) {
  try {
    const data = sessionStorage.getItem("cowrite-undo:" + file);
    if (data) {
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {}
  return [];
}

function pushUndo() {
  if (!currentContent || !currentFile) return;
  undoStack.push({ file: currentFile, content: currentContent });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  undoBtn.disabled = false;
  saveUndoStack(currentFile);
}

function performUndo() {
  if (undoStack.length === 0) return;
  const snapshot = undoStack.pop();
  if (undoStack.length === 0) undoBtn.disabled = true;
  saveUndoStack(currentFile);

  send({
    type: "edit_apply",
    offset: 0,
    length: currentContent.length,
    newText: snapshot.content,
  });
}

undoBtn.addEventListener("click", performUndo);

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
    const tag = document.activeElement?.tagName?.toLowerCase();
    if (tag === "textarea" || tag === "input") return;
    if (document.activeElement?.contentEditable === "true") return;

    e.preventDefault();
    performUndo();
  }
});

// --- Init ---
connect();
