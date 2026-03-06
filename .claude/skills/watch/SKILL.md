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
   b. For each pending comment with `selectedText`: use `propose_change` — NEVER edit the file directly. The user sees a diff and can Apply or Reject.
   c. For file-level comments (no `selectedText`) or questions: use `reply_to_comment`.

2. Then, launch a **background** watcher using the Task tool:
   - Use `subagent_type: "general-purpose"` and `run_in_background: true`
   - The background agent should call `wait_for_comment` in a loop
   - When a comment arrives: if it has `selectedText`, use `propose_change`; otherwise use `reply_to_comment`
   - On timeout, it re-calls `wait_for_comment` immediately
   - The loop continues until the user says stop

3. Tell the user the background watcher is running and they can continue working normally. Comments will be handled automatically.
