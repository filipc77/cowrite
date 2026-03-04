// @ts-check

/** @typedef {import('../../src/types.js').Comment} Comment */

/**
 * Centralized application state.
 */
export const state = {
  /** @type {Comment[]} */
  comments: [],
  /** @type {string} */
  currentFile: "",
  /** @type {string} */
  currentContent: "",
  /** @type {WebSocket|null} */
  ws: null,
  /** @type {{offset: number, length: number, selectedText: string, anchor?: {textQuote: {exact: string, prefix: string, suffix: string}, offset: number, length: number}}|null} */
  selectionInfo: null,
  /** @type {string} */
  currentHtml: "",
  /** @type {Array<{sourceStart: number, sourceEnd: number}>} */
  currentBlocks: [],
  /** @type {HTMLElement|null} */
  insertBtn: null,
  /** @type {HTMLElement|null} */
  insertLine: null,
  /** @type {number} */
  activeGapIndex: -1,
  /** @type {Array<{file: string, content: string}>} */
  undoStack: [],
  /** @type {number} */
  MAX_UNDO: 50,
  // Click-to-edit state
  /** @type {number} */
  editingBlockIndex: -1,
  /** @type {HTMLElement|null} */
  editingBlockEl: null,
  /** @type {string} */
  editingOriginalSource: "",
  /** @type {string} */
  editingContentSnapshot: "",
  /** @type {object|null} */
  pendingFileUpdate: null,
  /** @type {number} */
  pendingEditAfterInsert: -1,
  /** @type {boolean} */
  contentEditableActive: false,
  /** @type {boolean} Whether the user has actually edited content in TipTap (not just clicked) */
  editorDirty: false,
};

// --- Simple pub/sub ---

/** @type {Map<string, Set<Function>>} */
const listeners = new Map();

/**
 * Subscribe to state change notifications.
 * @param {string} key
 * @param {Function} fn
 */
export function subscribe(key, fn) {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(fn);
}

/**
 * Notify all subscribers of a state change.
 * @param {string} key
 */
export function notify(key) {
  if (listeners.has(key)) listeners.get(key).forEach((fn) => fn());
}
