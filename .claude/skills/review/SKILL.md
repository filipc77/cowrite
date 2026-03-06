---
name: review
description: Check and address cowrite comments left by the user in the live preview
user_invocable: true
---

# Review Cowrite Comments

Check for any pending comments left in the Cowrite live preview and address them.

## Steps

1. Call the `get_pending_comments` tool to retrieve all unresolved comments.
2. For each pending comment:
   a. Read the comment text and the selected text it refers to.
   b. Use `get_file_with_annotations` to see the comment in context.
   c. If the comment has `selectedText` **and requests a text change**, use `propose_change` — NEVER edit the file directly. The user will see a diff and can Apply or Reject.
   d. If the comment is a question, clarification, or has no `selectedText` (file-level comment), use `reply_to_comment`.
3. Summarize what was done.

## Important

- **NEVER edit files directly.** All text changes must go through `propose_change` so the user can review and Apply or Reject. No exceptions.
