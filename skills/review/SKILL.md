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
   c. Make the requested change or reply explaining why you can't.
   d. Call `reply_to_comment` to acknowledge the feedback.
   e. Call `resolve_comment` to mark it as addressed.
3. Summarize what was done.
