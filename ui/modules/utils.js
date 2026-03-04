// @ts-check

/**
 * Shorthand DOM selector.
 * @param {string} sel
 * @returns {HTMLElement}
 */
export const $ = (sel) => document.querySelector(sel);

/**
 * Escape HTML entities to prevent XSS.
 * @param {string} text
 * @returns {string}
 */
export function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Human-readable relative time.
 * @param {string} iso
 * @returns {string}
 */
export function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
