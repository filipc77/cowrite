// @ts-check

/** @typedef {import('../../src/types.js').WSServerMessage} WSServerMessage */

import { $ } from './utils.js';
import { state } from './state.js';

/**
 * Send a message over the WebSocket.
 * @param {object} msg
 */
export function send(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
  }
}

/**
 * Initialize WebSocket connection with auto-reconnect.
 * @param {object} handlers
 * @param {(msg: any) => void} handlers.onFileUpdate
 * @param {(msg: any) => void} handlers.onCommentsUpdate
 * @param {(msg: any) => void} handlers.onError
 * @param {() => void} handlers.onOpen
 */
export function initWebSocket(handlers) {
  const statusEl = $("#status");

  function connect() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    state.ws = new WebSocket(`${protocol}//${location.host}`);

    state.ws.onopen = () => {
      statusEl.innerHTML = '<span class="status-dot"></span>Connected';
      statusEl.className = "status connected";
      handlers.onOpen();
    };

    state.ws.onclose = () => {
      statusEl.innerHTML = '<span class="status-dot"></span>Disconnected';
      statusEl.className = "status";
      setTimeout(connect, 2000);
    };

    state.ws.onmessage = (event) => {
      /** @type {WSServerMessage} */
      const msg = JSON.parse(event.data);
      switch (msg.type) {
        case "file_update":
          handlers.onFileUpdate(msg);
          break;
        case "comments_update":
          handlers.onCommentsUpdate(msg);
          break;
        case "error":
          handlers.onError(msg);
          break;
      }
    };
  }

  connect();
}
