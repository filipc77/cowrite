import * as vscode from "vscode";

export function offsetToRange(
  document: vscode.TextDocument,
  offset: number,
  length: number
): vscode.Range {
  const start = document.positionAt(offset);
  const end = document.positionAt(offset + length);
  return new vscode.Range(start, end);
}

export function rangeToOffset(
  document: vscode.TextDocument,
  range: vscode.Range
): { offset: number; length: number } {
  const offset = document.offsetAt(range.start);
  const end = document.offsetAt(range.end);
  return { offset, length: end - offset };
}

export function offsetToRangeFromContent(
  content: string,
  offset: number,
  length: number
): { startLine: number; startChar: number; endLine: number; endChar: number } {
  let line = 0;
  let col = 0;

  let startLine = 0;
  let startChar = 0;
  let endLine = 0;
  let endChar = 0;

  for (let i = 0; i <= Math.min(offset + length, content.length); i++) {
    if (i === offset) {
      startLine = line;
      startChar = col;
    }
    if (i === offset + length) {
      endLine = line;
      endChar = col;
      break;
    }
    if (content[i] === "\n") {
      line++;
      col = 0;
    } else {
      col++;
    }
  }

  // Handle case where offset + length === content.length
  if (offset + length >= content.length) {
    endLine = line;
    endChar = col;
  }

  return { startLine, startChar, endLine, endChar };
}
