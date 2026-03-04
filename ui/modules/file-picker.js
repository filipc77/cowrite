// @ts-check

import { $ } from './utils.js';
import { state } from './state.js';
import { send } from './ws-client.js';
import { loadUndoStack, saveUndoStack } from './undo-manager.js';

const filePicker = /** @type {HTMLInputElement} */ ($("#filePicker"));
const fileList = $("#fileList");
const undoBtn = /** @type {HTMLButtonElement} */ ($("#undoBtn"));

// Track meta key for Cmd+Click to open in new tab
let lastClickHadMeta = false;
document.addEventListener("mousedown", (e) => { lastClickHadMeta = e.metaKey || e.ctrlKey; });

export async function loadFileList() {
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
  if (!file || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  if (state.currentFile) saveUndoStack(state.currentFile);
  state.undoStack = loadUndoStack(file);
  undoBtn.disabled = state.undoStack.length === 0;
  send({ type: "switch_file", file });
  filePicker.value = "";
  // Update URL without reload
  const url = new URL(location.href);
  url.searchParams.set("file", file);
  history.replaceState(null, "", url.toString());
}

function openFileInNewTab(file) {
  const url = new URL(location.href);
  url.searchParams.set("file", file);
  window.open(url.toString(), "_blank");
}

export function initFilePicker() {
  filePicker.addEventListener("change", () => {
    const file = filePicker.value.trim();
    if (!file) return;
    if (lastClickHadMeta) {
      openFileInNewTab(file);
      filePicker.value = "";
    } else {
      switchFile(file);
    }
  });

  filePicker.addEventListener("keydown", (e) => {
    const file = filePicker.value.trim();
    if (!file) return;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      openFileInNewTab(file);
      filePicker.value = "";
    } else if (e.key === "Enter") {
      switchFile(file);
    }
  });
}
