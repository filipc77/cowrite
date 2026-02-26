#!/bin/bash
# Auto-installed by cowrite — injects pending comments into Claude Code context.
# Only outputs when there are pending comments. Silent otherwise.
COMMENTS_FILE="${CLAUDE_PROJECT_DIR:-.}/.cowrite-comments.json"
if [ ! -f "$COMMENTS_FILE" ] || [ ! -s "$COMMENTS_FILE" ]; then exit 0; fi
PENDING=$(jq '[.[] | select(.status == "pending")] | length' "$COMMENTS_FILE" 2>/dev/null || echo 0)
if [ "$PENDING" -eq 0 ]; then exit 0; fi
jq -r '[.[] | select(.status == "pending")] | "COWRITE: \(length) pending comment(s) from the live preview. For EACH comment: (1) make the requested change, (2) call reply_to_comment to explain what you did. Your reply automatically marks it as answered. The user will review and resolve it.\n" + ([.[] | "- [\(.id)] File: \(.file | split("/") | last) | Text: \"\(.selectedText)\" | Comment: \(.comment)"] | join("\n"))' "$COMMENTS_FILE" 2>/dev/null
