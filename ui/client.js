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

/** @type {Comment[]} */
let comments = [];
let currentFile = "";
let currentContent = "";
let ws = null;
let selectionInfo = null;

// --- WebSocket ---

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    statusEl.textContent = "Connected";
    statusEl.className = "status connected";
  };

  ws.onclose = () => {
    statusEl.textContent = "Disconnected";
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
  // Don't trigger when clicking inside popup or sidebar
  if (popup.contains(e.target) || $("#sidebar").contains(e.target)) return;

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) {
    hidePopup();
    return;
  }

  const text = selection.toString().trim();
  if (!text) {
    hidePopup();
    return;
  }

  // Compute character offset in the source content
  const offset = computeOffset(selection, text);
  if (offset === -1) {
    hidePopup();
    return;
  }

  selectionInfo = { offset, length: text.length, selectedText: text };

  // Position popup near the selection
  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  popup.style.left = `${Math.min(rect.left, window.innerWidth - 340)}px`;
  popup.style.top = `${rect.bottom + 8}px`;
  popupSelection.textContent = text.length > 120 ? text.slice(0, 120) + "..." : text;
  commentInput.value = "";
  popup.hidden = false;
  commentInput.focus();
});

function computeOffset(selection, text) {
  // For plain text: use data-offset on span.line elements
  const anchor = selection.anchorNode;
  if (!anchor) return -1;

  // Walk up to find a [data-offset] element
  let node = anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor;
  while (node && !node.dataset?.offset && node !== fileContentEl) {
    node = node.parentElement;
  }

  if (node?.dataset?.offset !== undefined) {
    // Plain text mode: compute from data-offset + text offset within the line
    const lineOffset = parseInt(node.dataset.offset, 10);
    const nodeText = node.textContent || "";
    const idx = nodeText.indexOf(text);
    if (idx !== -1) return lineOffset + idx;
  }

  // Fallback: search for the text in the raw content
  const idx = currentContent.indexOf(text);
  return idx;
}

function hidePopup() {
  popup.hidden = true;
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
        <div class="popup-actions" style="margin-top:6px;">
          <button onclick="submitReply('${c.id}')" style="font-size:11px;padding:4px 10px;border-radius:4px;border:none;background:var(--accent);color:var(--bg);cursor:pointer;">Send</button>
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

// --- Init ---
connect();
