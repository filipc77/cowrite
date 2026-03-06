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
   c. If the comment requests a text change on selected text, use `propose_change` — the user sees a diff and can Apply or Reject.
      For questions or clarifications, use `reply_to_comment`.
   d. NEVER edit files directly. All text changes must go through `propose_change`.
3. After processing all comments, call `wait_for_comment` to listen for follow-ups.
   When a follow-up arrives, handle it the same way (step 2) and call `wait_for_comment` again.
   Keep this loop going until the timeout returns with no new comments.
