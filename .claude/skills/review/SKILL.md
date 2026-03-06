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
   c. If the comment has `selectedText`, you **MUST** use `propose_change` to suggest the edit. NEVER edit the file directly. The user will see a diff and can Apply or Reject.
   d. If the comment has NO `selectedText` (file-level comment) or is a question, use `reply_to_comment`.
3. Summarize what was done.
