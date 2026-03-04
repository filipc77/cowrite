// @ts-check

/**
 * Create a CommentAnchor from TipTap editor selection.
 * @param {import('@tiptap/core').Editor} editor - TipTap editor instance
 * @param {number} from - ProseMirror selection start
 * @param {number} to - ProseMirror selection end
 * @returns {{textQuote: {exact: string, prefix: string, suffix: string}, offset: number, length: number}}
 */
export function createAnchor(editor, from, to) {
  const doc = editor.state.doc;

  // Get the selected text
  const exact = doc.textBetween(from, to, '\n', '\n');

  // Get prefix (up to 30 chars before selection)
  const prefixStart = Math.max(0, from - 30);
  const prefix = doc.textBetween(prefixStart, from, '\n', '\n');

  // Get suffix (up to 30 chars after selection)
  const suffixEnd = Math.min(doc.content.size, to + 30);
  const suffix = doc.textBetween(to, suffixEnd, '\n', '\n');

  // Compute character offset in the flat text
  const textBefore = doc.textBetween(0, from, '\n', '\n');
  const offset = textBefore.length;

  return {
    textQuote: { exact, prefix, suffix },
    offset,
    length: exact.length,
  };
}

/**
 * Resolve a comment anchor in current content.
 * Returns {offset, length} or null if orphaned.
 * @param {{textQuote?: {exact: string, prefix: string, suffix: string}, offset: number, length: number}} anchor
 * @param {string} content - Current document text content
 * @returns {{offset: number, length: number} | null}
 */
export function resolveAnchor(anchor, content) {
  if (!anchor) return null;

  const searchText = anchor.textQuote?.exact || '';
  if (!searchText) return null;

  // Strategy 1: Text quote selector with prefix/suffix scoring
  if (anchor.textQuote) {
    const candidates = [];
    let pos = 0;
    while (pos < content.length) {
      const idx = content.indexOf(searchText, pos);
      if (idx === -1) break;

      // Score by prefix/suffix match
      const actualPrefix = content.slice(Math.max(0, idx - 30), idx);
      const actualSuffix = content.slice(idx + searchText.length, idx + searchText.length + 30);
      const prefixScore = matchScore(anchor.textQuote.prefix, actualPrefix);
      const suffixScore = matchScore(anchor.textQuote.suffix, actualSuffix);
      const proximityScore = 1000 - Math.min(1000, Math.abs(idx - anchor.offset));

      candidates.push({
        offset: idx,
        score: prefixScore + suffixScore + proximityScore * 0.1,
      });
      pos = idx + 1;
    }

    if (candidates.length > 0) {
      candidates.sort((a, b) => b.score - a.score);
      return { offset: candidates[0].offset, length: searchText.length };
    }
  }

  // Strategy 2: Try exact text near expected offset (+/-100 chars)
  const windowStart = Math.max(0, anchor.offset - 100);
  const windowEnd = Math.min(content.length, anchor.offset + anchor.length + 100);
  const windowText = content.slice(windowStart, windowEnd);
  const localIdx = windowText.indexOf(searchText);
  if (localIdx !== -1) {
    return { offset: windowStart + localIdx, length: searchText.length };
  }

  // Strategy 3: Global search
  const globalIdx = content.indexOf(searchText);
  if (globalIdx !== -1) {
    return { offset: globalIdx, length: searchText.length };
  }

  return null; // Orphaned
}

/**
 * Score how well two strings match from their boundaries.
 * @param {string} expected
 * @param {string} actual
 * @returns {number}
 */
function matchScore(expected, actual) {
  if (!expected || !actual) return 0;
  let score = 0;
  const minLen = Math.min(expected.length, actual.length);
  for (let i = 0; i < minLen; i++) {
    if (expected[expected.length - 1 - i] === actual[actual.length - 1 - i]) {
      score++;
    } else {
      break;
    }
  }
  return score;
}
