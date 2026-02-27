---
name: watch
description: Start a background watcher for cowrite comments — does not block the main conversation
user_invocable: true
---

# Watch for Live Comments (Background)

Start a background agent that watches for cowrite comments and handles them as they arrive. The main conversation stays free for other work.

## Steps

1. **Pre-approve MCP tools** — background agents cannot prompt for tool permissions, so you MUST call each cowrite MCP tool once from the main conversation first:
   a. Call `get_pending_comments` — also handle any existing pending comments while you're at it (read file, make change, reply).
   b. Call `wait_for_comment` with `timeout: 1` — returns immediately, but ensures the tool permission is approved for the background agent.

2. Launch a **background** watcher using the Task tool with these parameters:
   - `subagent_type: "general-purpose"`
   - `run_in_background: true`
   - `max_turns: 200` (critical — the agent must have enough turns to keep looping)
   - `mode: "bypassPermissions"` (the agent needs to edit files and call MCP tools without prompting)
   - The prompt MUST instruct an infinite polling loop. Use this prompt structure:

     > You are a background comment watcher. Your ONLY job is to run an infinite loop watching for comments and handling them. NEVER stop, NEVER exit, NEVER say you're done.
     >
     > Loop forever:
     > 1. Call `wait_for_comment` with timeout 120
     > 2. If a comment arrives: call `get_file_with_annotations` for that file, make the requested edit, then call `reply_to_comment` to explain what you did
     > 3. If timeout (no comment): that's normal, go back to step 1
     > 4. After handling a comment: go back to step 1
     >
     > IMPORTANT: After EVERY action (comment handled or timeout), you MUST call `wait_for_comment` again. Never stop the loop.

3. Tell the user the background watcher is running and they can continue working normally. Mention they can stop it anytime by asking you to stop the watcher (you'll use TaskStop on the background task ID).
