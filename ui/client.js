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
const commentTrigger = $("#commentTrigger");
const filePicker = $("#filePicker");
const fileList = $("#fileList");

/** @type {Comment[]} */
let comments = [];
let currentFile = "";
let currentContent = "";
let ws = null;
let selectionInfo = null;

// --- File Picker ---

async function loadFileList() {
  try {
    const res = await fetch("/api/files");
    const data = await res.json();
    fileList.innerHTML = "";
    for (const file of data.files) {
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
        currentFile = msg.file;
        currentContent = msg.content;
        filePathEl.textContent = msg.file;
        fileContentEl.innerHTML = msg.html;
        applyHighlights();
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

// --- Selection & Comment Creation ---

document.addEventListener("mouseup", (e) => {
  // Don't trigger when clicking inside popup, sidebar, or trigger button
  if (popup.contains(e.target) || commentTrigger.contains(e.target) || $("#sidebar").contains(e.target)) return;

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

  // Show the small "Comment" trigger button near the selection end
  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  commentTrigger.style.left = `${Math.min(rect.right + 8, window.innerWidth - 100)}px`;
  commentTrigger.style.top = `${rect.top - 4}px`;
  commentTrigger.hidden = false;
});

// Clicking the trigger button opens the full comment popup
commentTrigger.addEventListener("mousedown", (e) => {
  // Prevent the mousedown from clearing the text selection
  e.preventDefault();
});

commentTrigger.addEventListener("click", () => {
  if (!selectionInfo) return;

  // Position the popup near the trigger
  const triggerRect = commentTrigger.getBoundingClientRect();
  popup.style.left = `${Math.min(triggerRect.left, window.innerWidth - 340)}px`;
  popup.style.top = `${triggerRect.bottom + 8}px`;
  popupSelection.textContent = selectionInfo.selectedText;
  commentInput.value = "";
  popup.hidden = false;
  commentTrigger.hidden = true;
  commentInput.focus();
});

function computeOffset(selection, text) {
  const range = selection.getRangeAt(0);
  const startNode = range.startContainer;
  const startCharOffset = range.startOffset;

  // Walk up from the range start to find a [data-offset] element
  let lineEl = startNode.nodeType === Node.TEXT_NODE ? startNode.parentElement : startNode;
  while (lineEl && !lineEl.dataset?.offset && lineEl !== fileContentEl) {
    lineEl = lineEl.parentElement;
  }

  if (lineEl?.dataset?.offset !== undefined) {
    // Compute exact character offset within the line using the range start
    const lineOffset = parseInt(lineEl.dataset.offset, 10);
    // Walk text nodes inside this line element to find the position of startNode
    const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
    let charsBefore = 0;
    while (walker.nextNode()) {
      if (walker.currentNode === startNode) {
        return lineOffset + charsBefore + startCharOffset;
      }
      charsBefore += walker.currentNode.textContent.length;
    }
    // If the start node wasn't found in this line, the selection might start
    // at the line element boundary itself
    return lineOffset;
  }

  // Fallback: multi-strategy search for rendered text in raw source
  // (selection.toString() strips markdown syntax like #, **, etc.)

  // Strategy 1: exact match
  const exactIdx = currentContent.indexOf(text);
  if (exactIdx !== -1) return exactIdx;

  // Strategy 2: progressive prefix matching — shorter prefixes are more likely
  // to appear verbatim in source even when selection spans markdown elements
  for (const len of [200, 100, 50, 30, 15]) {
    if (text.length <= len) continue;
    const prefix = text.slice(0, len);
    const idx = currentContent.indexOf(prefix);
    if (idx !== -1) return idx;
  }

  // Strategy 3: line-by-line search — find the first line of the selection in source
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.length < 3) continue;
    const idx = currentContent.indexOf(line);
    if (idx !== -1) return idx;
  }

  // Strategy 4: DOM position estimation — walk text nodes to compute the
  // selection's DOM offset, then map proportionally to source offset and
  // search nearby for a matching line
  const domOffset = computeDomOffset(range.startContainer, range.startOffset);
  if (domOffset !== -1) {
    const fullTextLen = fileContentEl.textContent?.length || 1;
    const ratio = domOffset / fullTextLen;
    const estimatedSrcOffset = Math.floor(ratio * currentContent.length);

    // Search for any selection line near the estimated offset
    const searchRadius = 500;
    const start = Math.max(0, estimatedSrcOffset - searchRadius);
    const end = Math.min(currentContent.length, estimatedSrcOffset + searchRadius);
    const nearby = currentContent.slice(start, end);

    for (const line of lines) {
      if (line.length < 3) continue;
      const idx = nearby.indexOf(line);
      if (idx !== -1) return start + idx;
    }

    // If no line matched, return the estimated offset as a best guess
    return estimatedSrcOffset;
  }

  return -1;
}

function computeDomOffset(node, charOffset) {
  const walker = document.createTreeWalker(fileContentEl, NodeFilter.SHOW_TEXT);
  let offset = 0;
  while (walker.nextNode()) {
    if (walker.currentNode === node) {
      return offset + charOffset;
    }
    offset += (walker.currentNode.textContent || "").length;
  }
  return -1;
}

function hideTrigger() {
  commentTrigger.hidden = true;
  // Only clear selectionInfo if popup isn't open
  if (popup.hidden) {
    selectionInfo = null;
  }
}

function hidePopup() {
  popup.hidden = true;
  commentTrigger.hidden = true;
  selectionInfo = null;
}

$("#commentSubmit").addEventListener("click", submitComment);
$("#commentCancel").addEventListener("click", hidePopup);

commentInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    submitComment();
  }
  if (e.key === "Escape") {
    hidePopup();
  }
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
        <p>Select text in the preview and add a comment.</p>
      </div>
    `;
    return;
  }

  commentListEl.innerHTML = comments.map((c) => `
    <div class="comment-card ${c.status}" data-id="${c.id}">
      <div class="comment-selected-text">${escapeHtml(c.selectedText)}</div>
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
      ${c.status === "pending" ? `
        <div class="comment-actions">
          <button onclick="showReplyForm('${c.id}')">Reply</button>
          <button onclick="resolveComment('${c.id}')">Resolve</button>
        </div>
      ` : ""}
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

window.submitReply = function (id) {
  const form = document.getElementById(`reply-form-${id}`);
  const textarea = form?.querySelector("textarea");
  const text = textarea?.value.trim();
  if (!text) return;
  send({ type: "comment_reply", commentId: id, text });
  textarea.value = "";
  form.hidden = true;
};

// --- Comment Highlights ---

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

  // For each comment, find the selected text and wrap in highlight
  for (const comment of comments) {
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
      // After wrapping, we need to update remaining text nodes
      // Simply break — for simplicity, one highlight per pass is fine
      return;
    } catch {
      // Range may cross element boundaries; skip this highlight
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
  // Update toggle icon
  const icon = themeToggle.closest(".theme-toggle").querySelector(".toggle-icon");
  if (icon) icon.textContent = theme === "light" ? "\u2600" : "\u263E";
  // Update toggle label
  const label = document.querySelector(".toggle-label");
  if (label) label.textContent = theme === "light" ? "Light" : "Dark";
}

// Load saved preference, default to dark
const savedTheme = localStorage.getItem(THEME_KEY) || "dark";
applyTheme(savedTheme);

themeToggle.addEventListener("change", () => {
  const theme = themeToggle.checked ? "light" : "dark";
  localStorage.setItem(THEME_KEY, theme);
  applyTheme(theme);
});

// Hide trigger when selection is cleared (e.g. clicking elsewhere)
document.addEventListener("selectionchange", () => {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) {
    // Small delay to avoid race with the trigger button click
    setTimeout(() => {
      if (popup.hidden) hideTrigger();
    }, 100);
  }
});

// --- Init ---
connect();
