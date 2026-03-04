// @ts-check

import { $ } from './utils.js';
import { state } from './state.js';

// --- Resizable Sidebar ---

function initResizableSidebar() {
  const handle = document.getElementById("sidebarDragHandle");
  const sidebar = document.getElementById("sidebar");
  if (!handle || !sidebar) return;

  // Restore saved width
  const saved = localStorage.getItem("cowrite-sidebar-width");
  if (saved) document.documentElement.style.setProperty("--sidebar-width", saved + "px");

  let startX = 0;
  let startWidth = 0;

  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    startX = e.clientX;
    startWidth = sidebar.offsetWidth;
    document.body.classList.add("sidebar-resizing");
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });

  function onMouseMove(e) {
    const delta = startX - e.clientX; // sidebar is on the right
    const newWidth = Math.min(Math.max(startWidth + delta, 300), window.innerWidth * 0.5);
    document.documentElement.style.setProperty("--sidebar-width", newWidth + "px");
  }

  function onMouseUp() {
    document.body.classList.remove("sidebar-resizing");
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    const width = sidebar.offsetWidth;
    localStorage.setItem("cowrite-sidebar-width", String(width));
  }
}

// --- Theme Toggle ---

const THEME_KEY = "cowrite-theme";

/** @type {(renderFn: () => void) => void} */
let onThemeRender = () => {};

function applyTheme(theme) {
  const themeToggle = /** @type {HTMLInputElement} */ ($("#themeToggle"));

  document.documentElement.setAttribute("data-theme", theme);
  themeToggle.checked = theme === "light";
  const icon = themeToggle.closest(".theme-toggle")?.querySelector(".toggle-icon");
  if (icon) icon.textContent = theme === "light" ? "\u2600" : "\u263E";
  const label = document.querySelector(".toggle-label");
  if (label) label.textContent = theme === "light" ? "Light" : "Dark";
  const hljsDark = document.getElementById("hljs-dark");
  const hljsLight = document.getElementById("hljs-light");
  if (hljsDark && hljsLight) {
    hljsDark.disabled = theme === "light";
    hljsLight.disabled = theme !== "light";
  }
  const gmcDark = document.getElementById("gmc-dark");
  const gmcLight = document.getElementById("gmc-light");
  if (gmcDark && gmcLight) {
    gmcDark.disabled = theme === "light";
    gmcLight.disabled = theme !== "light";
  }
  if (window.__mermaid && state.currentHtml) {
    window.__mermaid.initialize({ startOnLoad: false, theme: theme === "light" ? "default" : "dark" });
    onThemeRender();
  }
}

function initTheme(renderCallback) {
  onThemeRender = renderCallback;
  const themeToggle = /** @type {HTMLInputElement} */ ($("#themeToggle"));

  const savedTheme = localStorage.getItem(THEME_KEY) || "dark";
  applyTheme(savedTheme);

  themeToggle.addEventListener("change", () => {
    const theme = themeToggle.checked ? "light" : "dark";
    localStorage.setItem(THEME_KEY, theme);
    applyTheme(theme);
  });
}

// --- Font Size Toggle ---

const FONT_SIZE_KEY = "cowrite-font-size";

function initFontSize() {
  const saved = localStorage.getItem(FONT_SIZE_KEY) || "large";
  if (saved === "large") document.body.classList.add("font-large");
  for (const btn of document.querySelectorAll(".font-size-btn")) {
    btn.setAttribute("aria-pressed", btn.dataset.size === saved ? "true" : "false");
    btn.addEventListener("click", () => {
      const size = btn.dataset.size;
      document.body.classList.toggle("font-large", size === "large");
      localStorage.setItem(FONT_SIZE_KEY, size);
      for (const b of document.querySelectorAll(".font-size-btn")) {
        b.setAttribute("aria-pressed", b.dataset.size === size ? "true" : "false");
      }
    });
  }
}

/**
 * Initialize all preference-related UI (sidebar, theme, font size).
 * @param {() => void} renderCallback - Called when theme change requires re-rendering content
 */
export function initPreferences(renderCallback) {
  initResizableSidebar();
  initTheme(renderCallback);
  initFontSize();
}
