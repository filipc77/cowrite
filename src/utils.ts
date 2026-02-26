import { exec } from "node:child_process";
import { marked, Renderer, type Tokens } from "marked";
import hljs from "highlight.js";
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
  // Build block offset map from lexer tokens
  const tokens = marked.lexer(content);
  const blocks: Array<{ sourceStart: number; sourceEnd: number }> = [];
  let blockOffset = 0;
  for (const token of tokens) {
    if (token.type !== "space") {
      blocks.push({ sourceStart: blockOffset, sourceEnd: blockOffset + token.raw.length });
    }
    blockOffset += token.raw.length;
  }

  const renderer = new Renderer();
  const defaultCodeRenderer = renderer.code.bind(renderer);

  renderer.code = function (token: Tokens.Code) {
    if (token.lang === "mermaid") {
      return `<div class="mermaid-container"><pre class="mermaid">${token.text}</pre></div>`;
    }
    try {
      let highlighted: string;
      let lang: string;
      if (token.lang && hljs.getLanguage(token.lang)) {
        const result = hljs.highlight(token.text, { language: token.lang });
        highlighted = result.value;
        lang = token.lang;
      } else {
        const result = hljs.highlightAuto(token.text);
        highlighted = result.value;
        lang = result.language || "plaintext";
      }
      return `<div class="code-block-wrapper" data-lang="${lang}"><div class="code-block-header"><span class="code-block-lang">${lang}</span><button class="code-copy-btn" type="button">Copy</button></div><pre><code class="hljs language-${lang}">${highlighted}</code></pre></div>`;
    } catch {
      return defaultCodeRenderer(token);
    }
  };

  const html = marked.parse(content, { async: false, renderer }) as string;
  const blocksAttr = JSON.stringify(blocks).replace(/"/g, "&quot;");
  return `<div class="markdown-body" data-source-length="${content.length}" data-blocks="${blocksAttr}">${html}</div>`;
}

function renderPlainTextWithOffsets(content: string): string {
  const lines = content.split("\n");
  let offset = 0;
  const blocks: Array<{ sourceStart: number; sourceEnd: number }> = [];
  const htmlParts: string[] = [];
  let currentLines: string[] = [];
  let blockStart = 0;
  let blockIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineOffset = offset;
    offset += line.length + 1; // +1 for the newline

    if (line.trim() === "") {
      if (currentLines.length > 0) {
        blocks.push({ sourceStart: blockStart, sourceEnd: lineOffset });
        htmlParts.push(`<div class="text-block" data-block-index="${blockIndex}">${currentLines.join("\n")}</div>`);
        blockIndex++;
        currentLines = [];
      }
      htmlParts.push("");
      blockStart = offset;
    } else {
      if (currentLines.length === 0) {
        blockStart = lineOffset;
      }
      const escaped = escapeHtml(line);
      currentLines.push(`<span class="line" data-offset="${lineOffset}" data-length="${line.length}">${escaped}</span>`);
    }
  }

  if (currentLines.length > 0) {
    blocks.push({ sourceStart: blockStart, sourceEnd: Math.min(offset, content.length) });
    htmlParts.push(`<div class="text-block" data-block-index="${blockIndex}">${currentLines.join("\n")}</div>`);
  }

  const blocksAttr = JSON.stringify(blocks).replace(/"/g, "&quot;");
  return `<pre class="plain-text" data-source-length="${content.length}" data-blocks="${blocksAttr}">${htmlParts.join("\n")}</pre>`;
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
    if (!c.selectedText) {
      // File comment — prepend to file
      result = `[FILE COMMENT #${c.id.slice(0, 8)}: "${c.comment}"]\n` + result;
      continue;
    }
    const marker = `[COMMENT #${c.id.slice(0, 8)}: "${c.comment}"]`;
    const end = c.offset + c.length;
    // Insert marker after the selected text
    result = result.slice(0, end) + " " + marker + result.slice(end);
  }

  return result;
}
