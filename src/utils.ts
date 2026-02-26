import { exec } from "node:child_process";
import { marked } from "marked";
import type { Comment } from "./types.js";

/**
 * Open a URL in the user's default browser.
 * Returns a promise so callers can await if needed (e.g. before process exit).
 */
export function openBrowser(url: string): Promise<void> {
  const cmd = process.platform === "darwin" ? `open "${url}"`
    : process.platform === "win32" ? `cmd /c start "" "${url}"`
    : `xdg-open "${url}"`;
  return new Promise((resolve) => {
    exec(cmd, (err) => {
      if (err) process.stderr.write(`Could not open browser: ${err.message}\n`);
      resolve();
    });
  });
}

/**
 * Render file content as HTML. Markdown files get full rendering;
 * other text files are wrapped in <pre> with offset-tagged spans.
 */
export function renderToHtml(content: string, filePath: string): string {
  const isMarkdown = /\.(md|markdown|mdx)$/i.test(filePath);
  if (isMarkdown) {
    return renderMarkdownWithOffsets(content);
  }
  return renderPlainTextWithOffsets(content);
}

function renderMarkdownWithOffsets(content: string): string {
  const html = marked.parse(content, { async: false }) as string;
  // Wrap the rendered HTML in a container with data attributes for offset mapping
  // The client-side JS will handle offset computation from the rendered text nodes
  return `<div class="markdown-body" data-source-length="${content.length}">${html}</div>`;
}

function renderPlainTextWithOffsets(content: string): string {
  const lines = content.split("\n");
  let offset = 0;
  const htmlLines: string[] = [];

  for (const line of lines) {
    const escaped = escapeHtml(line);
    htmlLines.push(`<span class="line" data-offset="${offset}" data-length="${line.length}">${escaped}</span>`);
    offset += line.length + 1; // +1 for the newline
  }

  return `<pre class="plain-text" data-source-length="${content.length}">${htmlLines.join("\n")}</pre>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Annotate file content with inline comment markers for the agent.
 * Inserts `[COMMENT #id: "text"]` at the comment offsets.
 */
export function annotateFileWithComments(content: string, comments: Comment[]): string {
  // Sort by offset descending so insertions don't shift earlier offsets
  const sorted = [...comments].sort((a, b) => b.offset - a.offset);
  let result = content;

  for (const c of sorted) {
    const marker = `[COMMENT #${c.id.slice(0, 8)}: "${c.comment}"]`;
    const end = c.offset + c.length;
    // Insert marker after the selected text
    result = result.slice(0, end) + " " + marker + result.slice(end);
  }

  return result;
}
