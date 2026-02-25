---
name: watch
description: Enter a live comment-watching loop — wait for comments, handle them, and keep listening
user_invocable: true
---

# Watch for Live Comments

Enter a continuous loop that watches for comments in the Cowrite live preview and addresses them as they arrive.

## Steps

1. Call `get_pending_comments` to pick up any comments already posted.
2. For each pending comment:
   a. Use `get_file_with_annotations` to see the comment anchored in the file.
   b. Make the requested change, or call `reply_to_comment` to ask a clarifying question.
   c. Call `resolve_comment` to mark it as addressed.
3. Call `wait_for_comment` to block until the next comment is posted.
4. When a comment arrives, process it (repeat step 2).
5. **IMPORTANT**: Go back to step 3 immediately — even on timeout. Never stop the loop. Always re-call `wait_for_comment` right away. Keep watching until the user explicitly tells you to stop.
