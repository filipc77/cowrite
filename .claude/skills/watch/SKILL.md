---
name: watch
description: Start a background watcher for cowrite comments — does not block the main conversation
user_invocable: true
---

# Watch for Live Comments (Background)

Start a background agent that watches for cowrite comments and handles them as they arrive. The main conversation stays free for other work.

## Steps

1. First, handle any existing pending comments:
   a. Call `get_pending_comments` to check for unresolved comments.
   b. For each pending comment, use `get_file_with_annotations` to see context.
   c. If the comment requests a text change on selected text, use `propose_change` — NEVER edit files directly.
      For questions or clarifications, use `reply_to_comment`.

2. Then, launch a **background** watcher using the Task tool:
   - Use `subagent_type: "general-purpose"` and `run_in_background: true`
   - The background agent should call `wait_for_comment` in a loop
   - When a comment arrives, it handles it (read file, use `propose_change` for text changes or `reply_to_comment` for questions — NEVER edit files directly)
   - On timeout, it re-calls `wait_for_comment` immediately
   - The loop continues until the user says stop

3. Tell the user the background watcher is running and they can continue working normally. Comments will be handled automatically.
