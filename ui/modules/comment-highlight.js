// @ts-check

import { $ } from './utils.js';
import { state } from './state.js';
import { resolveAnchor } from './comment-anchoring.js';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Extension } from '@tiptap/core';

const commentHighlightKey = new PluginKey('commentHighlight');

/**
 * Create the CommentHighlight TipTap extension.
 * This extension manages a DecorationSet for comment highlights.
 */
export function createCommentHighlightExtension() {
  return Extension.create({
    name: 'commentHighlight',

    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: commentHighlightKey,
          state: {
            init() {
              return DecorationSet.empty;
            },
            apply(tr, oldSet) {
              const meta = tr.getMeta(commentHighlightKey);
              if (meta?.decorations) {
                return meta.decorations;
              }
              // Remap existing decorations through document changes
              if (tr.docChanged) {
                return oldSet.map(tr.mapping, tr.doc);
              }
              return oldSet;
            },
          },
          props: {
            decorations(editorState) {
              return commentHighlightKey.getState(editorState);
            },
          },
        }),
      ];
    },
  });
}

/**
 * Apply comment highlights using ProseMirror decorations for markdown files,
 * or DOM wrapping for non-markdown files.
 * @param {import('@tiptap/core').Editor} [editor] - TipTap editor instance (optional)
 * @param {boolean} [isMarkdown] - Whether the current file is markdown
 */
export function applyHighlights(editor, isMarkdown) {
  if (editor && isMarkdown) {
    applyProseMirrorHighlights(editor);
  } else {
    applyDomHighlights();
  }
}

/**
 * Apply highlights via ProseMirror decorations.
 * @param {import('@tiptap/core').Editor} editor
 */
function applyProseMirrorHighlights(editor) {
  const doc = editor.state.doc;
  const decorations = [];

  for (const comment of state.comments) {
    if (!comment.selectedText) continue;

    // Build an anchor-like object from the comment
    const anchor = comment.anchor || {
      textQuote: { exact: comment.selectedText, prefix: '', suffix: '' },
      offset: comment.offset,
      length: comment.length,
    };

    // Get the full text from ProseMirror doc
    const fullText = doc.textBetween(0, doc.content.size, '\n', '\n');
    const resolved = resolveAnchor(anchor, fullText);

    if (!resolved) continue;

    // Map text offset to ProseMirror position
    const pmFrom = textOffsetToPmPos(doc, resolved.offset);
    const pmTo = textOffsetToPmPos(doc, resolved.offset + resolved.length);

    if (pmFrom === null || pmTo === null) continue;
    if (pmFrom >= pmTo || pmTo > doc.content.size) continue;

    decorations.push(
      Decoration.inline(pmFrom, pmTo, {
        class: `comment-highlight ${comment.status}`,
        'data-comment-id': comment.id,
        title: comment.comment,
      })
    );
  }

  const decoSet = DecorationSet.create(doc, decorations);

  // Dispatch a transaction with our decorations as metadata
  const tr = editor.state.tr;
  tr.setMeta(commentHighlightKey, { decorations: decoSet });
  editor.view.dispatch(tr);
}

/**
 * Convert a text offset (character position in flat text) to a ProseMirror position.
 * Mirrors the traversal logic of doc.textBetween(0, size, '\n', '\n') exactly,
 * tracking both the flat-text offset and the corresponding PM position.
 *
 * textBetween inserts '\n' block separators only before textblock nodes
 * (paragraph, heading, code_block) and block-level leaf nodes (horizontal_rule),
 * NOT before container blocks (ordered_list, bullet_list, list_item, blockquote).
 *
 * @param {import('@tiptap/pm/model').Node} doc
 * @param {number} targetOffset
 * @returns {number | null}
 */
function textOffsetToPmPos(doc, targetOffset) {
  let textPos = 0;
  let first = true; // mirrors textBetween's `first` flag
  let result = null;

  doc.descendants((node, pos) => {
    if (result !== null) return false;

    // Block separator: textBetween only adds '\n' before textblocks and block leaves
    if (node.isBlock && (node.isTextblock || node.isLeaf)) {
      if (!first) {
        if (textPos >= targetOffset) {
          result = pos + (node.isTextblock ? 1 : 0);
          return false;
        }
        textPos += 1; // block separator '\n'
      }
      first = false;
    }

    // Text node content
    if (node.isText) {
      const len = node.text.length;
      if (textPos + len >= targetOffset) {
        result = pos + (targetOffset - textPos);
        return false;
      }
      textPos += len;
      return false;
    }

    // Non-text leaf (hard break, horizontal rule, etc.) — leafText '\n'
    if (node.isLeaf) {
      if (textPos >= targetOffset) {
        result = pos;
        return false;
      }
      textPos += 1;
      return false;
    }

    return true; // descend into children
  });

  return result;
}

/**
 * Fallback: apply highlights via DOM wrapping (for non-markdown files).
 */
function applyDomHighlights() {
  const fileContentEl = $('#fileContent');
  const container = fileContentEl.querySelector('.plain-text-container') || fileContentEl;

  // Remove existing highlights
  for (const el of container.querySelectorAll('.comment-highlight')) {
    const parent = el.parentNode;
    parent.replaceChild(document.createTextNode(el.textContent), el);
    parent.normalize();
  }

  if (state.comments.length === 0) return;

  // Build text-node map
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let totalOffset = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.textContent || '';
    textNodes.push({ node, start: totalOffset, end: totalOffset + text.length });
    totalOffset += text.length;
  }
  const fullText = textNodes.map(n => n.node.textContent).join('');

  for (const comment of state.comments) {
    if (!comment.selectedText) continue;
    const searchText = comment.selectedText;
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
    const span = document.createElement('span');
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

/**
 * Initialize comment highlight click behavior.
 * Clicking a highlight scrolls to & highlights the matching sidebar card.
 */
export function initCommentHighlights() {
  const commentListEl = $('#commentList');

  document.addEventListener('mousedown', (e) => {
    const highlight = e.target.closest('.comment-highlight');

    // Clear active state when clicking outside highlights
    if (!highlight) {
      for (const card of commentListEl.querySelectorAll('.comment-card.active')) {
        card.classList.remove('active');
      }
      return;
    }

    // Scroll sidebar to the matching comment card
    const commentId = highlight.dataset?.commentId;
    if (!commentId) return;
    const card = commentListEl.querySelector(`.comment-card[data-id="${commentId}"]`);
    if (!card) return;

    // Clear previous active states
    for (const c of commentListEl.querySelectorAll('.comment-card.active')) {
      c.classList.remove('active');
    }
    card.classList.add('active');
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}
