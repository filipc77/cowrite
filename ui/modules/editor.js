// @ts-check
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Placeholder from '@tiptap/extension-placeholder';

let editor = null;
let isProgrammaticUpdate = false;

/**
 * Create the TipTap editor and mount it into the given container.
 * @param {HTMLElement} container
 * @param {object} options
 * @param {(markdown: string) => void} [options.onUpdate] - Called on content change
 * @param {(params: {editor: any}) => void} [options.onSelectionUpdate] - Called on selection change
 * @param {Array} [options.extensions] - Extra TipTap extensions to include
 * @returns {Editor}
 */
export function createEditor(container, options = {}) {
  if (editor) editor.destroy();

  editor = new Editor({
    element: container,
    editable: true,
    extensions: [
      StarterKit.configure({
        codeBlock: {
          HTMLAttributes: { class: 'hljs' },
        },
      }),
      Markdown.configure({
        html: true,
        tightLists: true,
        transformPastedText: true,
        transformCopiedText: true,
      }),
      Table.configure({ resizable: false }),
      TableRow,
      TableCell,
      TableHeader,
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({
        placeholder: 'Type / for commands...',
      }),
      ...(options.extensions || []),
    ],
    onUpdate({ editor }) {
      if (options.onUpdate) {
        const md = editor.storage.markdown.getMarkdown();
        options.onUpdate(md);
      }
    },
    onSelectionUpdate({ editor }) {
      if (options.onSelectionUpdate) {
        options.onSelectionUpdate({ editor });
      }
    },
  });

  // @ts-ignore - expose for browser testing
  window.__tiptap = editor;

  return editor;
}

/**
 * Set the editor content from markdown string.
 * @param {string} markdown
 */
export function setMarkdownContent(markdown) {
  if (!editor) return;
  isProgrammaticUpdate = true;
  // Preserve scroll position — setContent resets cursor which causes scroll jumps
  const scrollEl = editor.view.dom.closest('.content-panel') || editor.view.dom.parentElement;
  const scrollTop = scrollEl?.scrollTop ?? 0;
  editor.commands.setContent(markdown, false);
  if (scrollEl) scrollEl.scrollTop = scrollTop;
  isProgrammaticUpdate = false;
}

/**
 * Check if a programmatic content update is in progress.
 * Used to prevent onUpdate from setting editorDirty during setMarkdownContent().
 * @returns {boolean}
 */
export function isProgrammaticContentUpdate() {
  return isProgrammaticUpdate;
}

/**
 * Get the current editor content as markdown.
 * @returns {string}
 */
export function getMarkdownContent() {
  if (!editor) return '';
  return editor.storage.markdown.getMarkdown();
}

/**
 * Get the TipTap editor instance.
 * @returns {Editor|null}
 */
export function getEditor() {
  return editor;
}

/**
 * Check if a file is markdown based on extension.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isMarkdownFile(filePath) {
  return /\.(md|mdx|markdown)$/i.test(filePath);
}
