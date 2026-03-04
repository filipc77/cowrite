// @ts-check

import { $, escapeHtml, timeAgo } from './utils.js';
import { state } from './state.js';
import { send } from './ws-client.js';
import { resolveAnchor } from './comment-anchoring.js';
import { isMarkdownFile } from './editor.js';

const fileContentEl = $("#fileContent");
const commentListEl = $("#commentList");

export function renderComments() {
  if (state.comments.length === 0) {
    commentListEl.innerHTML = `
      <div class="empty-state">
        <p>No comments yet.</p>
        <p>Select text to comment, or use + for file comments.</p>
      </div>
    `;
    return;
  }

  commentListEl.innerHTML = state.comments.map((c) => {
    // Check if the anchor is orphaned (text no longer found in content)
    const isOrphaned = c.selectedText && state.currentContent && (() => {
      const anchor = c.anchor || {
        textQuote: { exact: c.selectedText, prefix: '', suffix: '' },
        offset: c.offset || 0,
        length: c.selectedText.length,
      };
      return resolveAnchor(anchor, state.currentContent) === null;
    })();

    const repliesHtml = c.replies.length > 0 ? `
      <div class="comment-replies">
        ${c.replies.map((r) => r.proposal ? `
          <div class="reply agent proposal-reply proposal-${r.proposal.status}">
            <div class="reply-from agent">agent \u2014 proposal</div>
            <div class="proposal-explanation">${escapeHtml(r.proposal.explanation)}</div>
            ${r.proposal.status === "pending" ? `
              <div class="proposal-diff">
                <div class="proposal-old"><span class="proposal-label">Current</span><pre>${escapeHtml(r.proposal.oldText)}</pre></div>
                <div class="proposal-new"><span class="proposal-label">Proposed</span><pre>${escapeHtml(r.proposal.newText)}</pre></div>
              </div>
              <div class="proposal-actions">
                <button class="proposal-apply-btn" onclick="applyProposal('${c.id}', '${r.id}')">Apply</button>
                <button class="proposal-reject-btn" onclick="rejectProposal('${c.id}', '${r.id}')">Reject</button>
              </div>
            ` : r.proposal.status === "applied" ? `
              <div class="proposal-diff">
                <div class="proposal-new"><span class="proposal-label">&#10003; Applied</span><pre>${escapeHtml(r.proposal.newText)}</pre></div>
              </div>
            ` : `
              <div class="proposal-diff">
                <div class="proposal-old"><span class="proposal-label">&#10007; Rejected</span><pre>${escapeHtml(r.proposal.oldText)}</pre></div>
              </div>
            `}
          </div>
        ` : `
          <div class="reply ${r.from}">
            <div class="reply-from ${r.from}">${r.from}</div>
            <div>${escapeHtml(r.text)}</div>
          </div>
        `).join("")}
      </div>
    ` : "";

    if (c.status === "resolved") {
      const truncated = c.comment.length > 60 ? c.comment.slice(0, 60) + "..." : c.comment;
      return `
        <div class="comment-card resolved" data-id="${c.id}">
          <button class="comment-delete-btn" onclick="deleteComment('${c.id}')" title="Delete comment">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
          <div class="resolved-summary" onclick="toggleResolvedExpand('${c.id}')">
            <svg class="resolved-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            <span class="comment-status resolved">resolved</span>
            <span class="resolved-summary-text">${escapeHtml(truncated)}</span>
          </div>
          <div class="resolved-details" hidden>
            ${c.selectedText
              ? `<div class="comment-selected-text">${escapeHtml(c.selectedText)}</div>`
              : `<div class="comment-file-badge">Whole file</div>`
            }
            <div class="comment-text">${escapeHtml(c.comment)}</div>
            ${repliesHtml}
            <div class="comment-meta">
              <span>${timeAgo(c.createdAt)}</span>
            </div>
            <div class="comment-actions">
              <button onclick="reopenComment('${c.id}')">Reopen</button>
            </div>
          </div>
        </div>
      `;
    }

    return `
      <div class="comment-card ${c.status}${isOrphaned ? ' orphaned' : ''}" data-id="${c.id}">
        <button class="comment-delete-btn" onclick="deleteComment('${c.id}')" title="Delete comment">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
        ${c.selectedText
          ? `<div class="comment-selected-text">${escapeHtml(c.selectedText)}${isOrphaned ? '<span class="orphaned-badge">Anchor lost</span>' : ''}</div>`
          : `<div class="comment-file-badge">Whole file</div>`
        }
        <div class="comment-text">${escapeHtml(c.comment)}</div>
        ${repliesHtml}
        <div class="comment-meta">
          <span>${timeAgo(c.createdAt)}</span>
          <span class="comment-status ${c.status}">${c.status}</span>
        </div>
        <div class="comment-actions">
          <button onclick="showReplyForm('${c.id}')">Reply</button>
          <button onclick="resolveComment('${c.id}')">Resolve</button>
        </div>
        <div class="reply-form" id="reply-form-${c.id}" hidden>
          <textarea rows="2" placeholder="Reply..."></textarea>
          <div class="reply-form-actions">
            <button onclick="submitReply('${c.id}')">Send</button>
          </div>
        </div>
      </div>
    `;
  }).join("");

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

export function initCommentSidebar() {
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

  window.applyProposal = function (commentId, replyId) {
    send({ type: "proposal_apply", commentId, replyId });
  };

  window.rejectProposal = function (commentId, replyId) {
    send({ type: "proposal_reject", commentId, replyId });
  };

  window.toggleResolvedExpand = function (id) {
    const card = commentListEl.querySelector(`.comment-card[data-id="${id}"]`);
    if (!card) return;
    const details = card.querySelector(".resolved-details");
    const chevron = card.querySelector(".resolved-chevron");
    if (!details) return;
    const expanding = details.hidden;
    details.hidden = !expanding;
    card.classList.toggle("resolved-expanded", expanding);
  };
}
