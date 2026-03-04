// @ts-check
import { Extension } from '@tiptap/core';
import Suggestion from '@tiptap/suggestion';

/** True while a block command is being applied — prevents focusout from submitting edits. */
export let blockCommandInProgress = false;

const BLOCK_TYPES = [
  { id: 'text',    label: 'Text',           category: 'Basic blocks', icon: 'Aa',  command: (editor) => editor.chain().focus().setParagraph().run() },
  { id: 'h1',      label: 'Heading 1',      category: 'Basic blocks', icon: 'H1',  command: (editor) => editor.chain().focus().setHeading({ level: 1 }).run() },
  { id: 'h2',      label: 'Heading 2',      category: 'Basic blocks', icon: 'H2',  command: (editor) => editor.chain().focus().setHeading({ level: 2 }).run() },
  { id: 'h3',      label: 'Heading 3',      category: 'Basic blocks', icon: 'H3',  command: (editor) => editor.chain().focus().setHeading({ level: 3 }).run() },
  { id: 'bullet',  label: 'Bulleted list',  category: 'Basic blocks', icon: '\u2022',   command: (editor) => editor.chain().focus().toggleBulletList().run() },
  { id: 'number',  label: 'Numbered list',  category: 'Basic blocks', icon: '1.',  command: (editor) => editor.chain().focus().toggleOrderedList().run() },
  { id: 'task',    label: 'Task list',      category: 'Basic blocks', icon: '\u2611',   command: (editor) => editor.chain().focus().toggleTaskList().run() },
  { id: 'quote',   label: 'Quote',          category: 'Basic blocks', icon: '\u201C',   command: (editor) => editor.chain().focus().toggleBlockquote().run() },
  { id: 'divider', label: 'Divider',        category: 'Basic blocks', icon: '\u2014',   command: (editor) => editor.chain().focus().setHorizontalRule().run() },
  { id: 'code',    label: 'Code block',     category: 'Advanced',     icon: '</>', command: (editor) => editor.chain().focus().toggleCodeBlock().run() },
  { id: 'table',   label: 'Table',          category: 'Advanced',     icon: '\u229E',  command: (editor) => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
];

/**
 * Escape HTML entities.
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Create the popup DOM element.
 * @param {object} props - Suggestion props
 * @param {number} selectedIndex
 * @returns {{ element: HTMLElement, currentItems: Array<object> }}
 */
function createPopupElement(props, selectedIndex) {
  const menu = document.createElement('div');
  menu.className = 'block-type-menu';
  menu.style.position = 'fixed';
  menu.style.zIndex = '1001';

  const list = document.createElement('div');
  list.className = 'block-type-list';
  menu.appendChild(list);

  const component = { element: menu, currentItems: [], commandFn: props.command || null };
  renderItems(component, props.items, selectedIndex, component.commandFn);
  return component;
}

/**
 * Render filtered items into the popup list, grouped by category.
 * @param {{ element: HTMLElement, currentItems: Array<object> }} component
 * @param {Array<object>} items
 * @param {number} selectedIndex
 */
function renderItems(component, items, selectedIndex, commandFn) {
  const list = component.element.querySelector('.block-type-list');
  if (!list) return;
  list.innerHTML = '';
  component.currentItems = items;

  if (items.length === 0) {
    list.innerHTML = '<div class="block-type-empty">No matches</div>';
    return;
  }

  let lastCategory = '';
  items.forEach((item, i) => {
    if (item.category !== lastCategory) {
      lastCategory = item.category;
      const header = document.createElement('div');
      header.className = 'block-type-category';
      header.textContent = item.category;
      list.appendChild(header);
    }
    const el = document.createElement('div');
    el.className = 'block-type-item';
    if (i === selectedIndex) el.classList.add('highlighted');
    el.innerHTML = `<span class="block-type-icon">${escapeHtml(item.icon)}</span><span>${escapeHtml(item.label)}</span>`;
    el.addEventListener('mouseenter', () => {
      for (const other of list.querySelectorAll('.block-type-item')) {
        other.classList.remove('highlighted');
      }
      el.classList.add('highlighted');
    });
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
    });
    el.addEventListener('click', () => {
      if (commandFn) {
        blockCommandInProgress = true;
        commandFn(item);
        setTimeout(() => { blockCommandInProgress = false; }, 300);
      }
    });
    list.appendChild(el);
  });
}

/**
 * Update the popup with new items.
 * @param {{ element: HTMLElement, currentItems: Array<object> }} component
 * @param {object} props - Suggestion props
 * @param {number} selectedIndex
 */
function updatePopupItems(component, props, selectedIndex) {
  component.commandFn = props.command || null;
  component.currentItems = props.items;
  renderItems(component, props.items, selectedIndex, component.commandFn);
}

/**
 * Update the highlighted item in the popup.
 * @param {{ element: HTMLElement, currentItems: Array<object> }} component
 * @param {number} selectedIndex
 */
function updateHighlight(component, selectedIndex) {
  const items = component.element.querySelectorAll('.block-type-item');
  items.forEach((el, i) => {
    el.classList.toggle('highlighted', i === selectedIndex);
  });
  // Scroll highlighted item into view
  if (items[selectedIndex]) {
    items[selectedIndex].scrollIntoView({ block: 'nearest' });
  }
}

/**
 * Position the popup near the cursor.
 * @param {HTMLElement} element
 * @param {object} props - Suggestion props with clientRect
 */
function positionPopup(element, props) {
  const rect = props.clientRect?.();
  if (!rect) return;

  element.style.left = `${rect.left}px`;
  element.style.top = `${rect.bottom + 4}px`;

  // Clamp so popup doesn't overflow below viewport
  requestAnimationFrame(() => {
    const popupRect = element.getBoundingClientRect();
    if (popupRect.bottom > window.innerHeight) {
      element.style.top = `${rect.top - popupRect.height - 4}px`;
    }
    if (popupRect.right > window.innerWidth) {
      element.style.left = `${window.innerWidth - popupRect.width - 8}px`;
    }
  });
}

/**
 * Create the slash command TipTap extension.
 * @returns {Extension}
 */
export function createSlashCommandExtension() {
  return Extension.create({
    name: 'slashCommand',

    addOptions() {
      return {
        suggestion: {
          char: '/',
          startOfLine: true,
          command: ({ editor, range, props }) => {
            // Delete the slash command text
            editor.chain().focus().deleteRange(range).run();
            // Execute the block type command
            props.command(editor);
          },
        },
      };
    },

    addProseMirrorPlugins() {
      return [
        Suggestion({
          editor: this.editor,
          ...this.options.suggestion,
          items: ({ query }) => {
            return BLOCK_TYPES.filter(item =>
              item.label.toLowerCase().includes(query.toLowerCase()) ||
              item.id.includes(query.toLowerCase())
            );
          },
          render: () => {
            let component = null;
            let selectedIndex = 0;

            return {
              onStart(props) {
                selectedIndex = 0;
                component = createPopupElement(props, selectedIndex);
                document.body.appendChild(component.element);
                positionPopup(component.element, props);
              },
              onUpdate(props) {
                if (!component) return;
                selectedIndex = 0;
                updatePopupItems(component, props, selectedIndex);
                positionPopup(component.element, props);
              },
              onKeyDown(props) {
                if (!component) return false;
                const items = component.currentItems;
                if (items.length === 0) return false;

                if (props.event.key === 'ArrowDown') {
                  selectedIndex = (selectedIndex + 1) % items.length;
                  updateHighlight(component, selectedIndex);
                  return true;
                }
                if (props.event.key === 'ArrowUp') {
                  selectedIndex = (selectedIndex - 1 + items.length) % items.length;
                  updateHighlight(component, selectedIndex);
                  return true;
                }
                if (props.event.key === 'Enter') {
                  if (items[selectedIndex] && component.commandFn) {
                    blockCommandInProgress = true;
                    component.commandFn(items[selectedIndex]);
                    setTimeout(() => { blockCommandInProgress = false; }, 300);
                  }
                  return true;
                }
                if (props.event.key === 'Escape') {
                  component.element.remove();
                  component = null;
                  return true;
                }
                return false;
              },
              onExit() {
                if (component) {
                  const el = component.element;
                  component = null;
                  setTimeout(() => { el.remove(); }, 0);
                }
                selectedIndex = 0;
              },
            };
          },
        }),
      ];
    },
  });
}
