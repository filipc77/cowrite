import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CommentStore } from "./comment-store.js";
import { annotateFileWithComments } from "./utils.js";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

export function createMcpServer(store: CommentStore, projectDir: string, getPreviewPort?: () => number | null): McpServer {
  const server = new McpServer(
    { name: "cowrite", version: "0.1.0" },
    { capabilities: { logging: {} } },
  );

  // Tool: get_pending_comments
  const getPendingTool = server.tool(
    "get_pending_comments",
    "Get comments from the live preview (0 pending). Call this first to catch comments posted before you started listening.",
    {
      file: z.string().optional().describe("Filter by file path"),
      status: z.enum(["pending", "answered", "resolved", "all"]).optional().describe("Filter by status (default: pending)"),
    },
    async ({ file, status }) => {
      const filter: { file?: string; status?: "pending" | "answered" | "resolved" | "all" } = {};
      if (file) filter.file = resolve(projectDir, file);
      filter.status = status ?? "pending";
      const comments = store.getAll(filter);
      return {
        content: [
          {
            type: "text" as const,
            text: comments.length === 0
              ? "No comments found."
              : JSON.stringify(comments, null, 2),
          },
        ],
      };
    }
  );

  // Tool: reply_to_comment
  server.tool(
    "reply_to_comment",
    "Reply to a comment from the agent. Your reply automatically marks the comment as 'answered'. The user reviews it and can resolve or reply back.",
    {
      commentId: z.string().describe("The comment ID to reply to"),
      reply: z.string().describe("The reply text"),
    },
    async ({ commentId, reply }) => {
      const replyObj = store.addReply(commentId, "agent", reply);
      if (!replyObj) {
        return {
          content: [{ type: "text" as const, text: `Comment ${commentId} not found.` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: `Reply added to comment ${commentId}.` }],
      };
    }
  );

  // Tool: get_file_with_annotations
  server.tool(
    "get_file_with_annotations",
    "Get file content with inline comment markers showing where comments are anchored.",
    {
      file: z.string().describe("File path to annotate"),
    },
    async ({ file }) => {
      const filePath = resolve(projectDir, file);
      try {
        const content = await readFile(filePath, "utf-8");
        const comments = store.getForFile(filePath);
        const annotated = annotateFileWithComments(content, comments);
        return {
          content: [{ type: "text" as const, text: annotated }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error reading file: ${err}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: wait_for_comment
  // Track reply counts at the time each comment was last returned, so we can
  // detect new user replies on already-handled comments in the early pending check.
  const lastSeenReplyCounts = new Map<string, number>();

  function formatCommentPayload(
    comment: { id: string; file: string; selectedText: string; comment: string; replies?: Array<{ from: string; text: string }> },
    event: "new_comment" | "follow_up",
  ) {
    const file = relative(projectDir, comment.file);
    const replies = comment.replies ?? [];
    lastSeenReplyCounts.set(comment.id, replies.length);
    const payload: Record<string, unknown> = { ...comment, file, event };
    if (event === "follow_up" && replies.length > 0) {
      // Include the latest user reply so the agent can see what changed
      const userReplies = replies.filter((r) => r.from === "user");
      if (userReplies.length > 0) {
        payload.latestUserReply = userReplies[userReplies.length - 1].text;
      }
    }
    return payload;
  }

  server.tool(
    "wait_for_comment",
    "Block until a new or follow-up comment is posted in the live preview, then return it. Returns an 'event' field: 'new_comment' for brand-new comments, 'follow_up' when the user replied to an already-answered comment. For follow-ups, 'latestUserReply' contains the new reply text. Call again immediately after handling each result to keep listening.",
    {
      timeout: z.number().optional().describe("Max seconds to wait (default: 30)"),
    },
    ({ timeout }, { signal }: { signal?: AbortSignal }) => {
      const maxWait = (timeout ?? 30) * 1000;

      // Check for comments that arrived while no one was listening.
      // Only return a pending comment if it's brand-new (never seen) or
      // has new replies since we last returned it.
      const pending = store.getAll({ status: "pending" });
      for (const c of pending) {
        const prevCount = lastSeenReplyCounts.get(c.id);
        if (prevCount === undefined) {
          // Brand-new comment we've never returned
          const payload = formatCommentPayload(c, "new_comment");
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify(payload, null, 2),
            }],
          };
        }
        if (c.replies.length > prevCount) {
          // Existing comment with new replies (user follow-up)
          const payload = formatCommentPayload(c, "follow_up");
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify(payload, null, 2),
            }],
          };
        }
      }

      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          cleanup();
          const count = store.getAll({ status: "pending" }).length;
          resolve({
            content: [{ type: "text" as const, text: count > 0
              ? `Timeout, but ${count} pending comment(s) exist. Call get_pending_comments now.`
              : "No new comments yet. Call wait_for_comment again to keep listening." }],
          });
        }, maxWait);

        const onNewComment = (comment: { id: string; file: string; selectedText: string; comment: string; replies?: Array<{ from: string; text: string }> }) => {
          cleanup();
          const payload = formatCommentPayload(comment, "new_comment");
          resolve({
            content: [{
              type: "text" as const,
              text: JSON.stringify(payload, null, 2),
            }],
          });
        };

        const onReopened = (comment: { id: string; file: string; selectedText: string; comment: string; replies?: Array<{ from: string; text: string }> }) => {
          cleanup();
          const payload = formatCommentPayload(comment, "follow_up");
          resolve({
            content: [{
              type: "text" as const,
              text: JSON.stringify(payload, null, 2),
            }],
          });
        };

        const onAbort = () => {
          cleanup();
          resolve({
            content: [{ type: "text" as const, text: "Cancelled. Call wait_for_comment again to resume listening." }],
          });
        };

        const cleanup = () => {
          clearTimeout(timer);
          store.off("new_comment", onNewComment);
          store.off("comment_reopened", onReopened);
          signal?.removeEventListener("abort", onAbort);
        };

        store.on("new_comment", onNewComment);
        store.on("comment_reopened", onReopened);
        signal?.addEventListener("abort", onAbort, { once: true });

        // If already aborted before we set up
        if (signal?.aborted) {
          onAbort();
        }
      });
    }
  );

  // Tool: get_preview_url
  server.tool(
    "get_preview_url",
    "Get the URL of the Cowrite live preview. Share this with the user so they can open it in their browser.",
    {},
    async () => {
      const port = getPreviewPort?.();
      if (!port) {
        return {
          content: [{ type: "text" as const, text: "Preview server is not running." }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: `http://localhost:${port}` }],
      };
    }
  );

  // Resource: cowrite://comments
  server.resource(
    "all-comments",
    "cowrite://comments",
    { description: "Live list of all comments", mimeType: "application/json" },
    async () => {
      const comments = store.getAll();
      return {
        contents: [
          {
            uri: "cowrite://comments",
            mimeType: "application/json",
            text: JSON.stringify(comments, null, 2),
          },
        ],
      };
    }
  );

  // Wire store changes to MCP resource notifications
  store.on("change", () => {
    if (!server.isConnected()) return;
    server.server.notification({
      method: "notifications/resources/updated",
      params: { uri: "cowrite://comments" },
    }).catch(() => {});
  });

  // --- Comment propagation signals ---
  // Only send signals when an MCP client is actually connected.
  // 1. Update tool description with pending count + sendToolListChanged
  // 2. sendLoggingMessage as additional context
  // Primary real-time mechanism is wait_for_comment via the /watch skill.
  function notifyCommentNeedsAttention(comment: { file: string; selectedText: string; comment: string }, prefix: string) {
    if (!server.isConnected()) return;

    const count = store.getAll({ status: "pending" }).length;
    const file = relative(projectDir, comment.file);
    const selectedPreview = comment.selectedText.length > 80
      ? comment.selectedText.slice(0, 80) + "..."
      : comment.selectedText;

    // Signal 1: Update tool description + notify tool list changed
    try {
      getPendingTool.update({
        description: `Get comments from the live preview (${count} pending). Call this first to catch comments posted before you started listening.`,
      });
      server.sendToolListChanged();
    } catch {
      // Not connected or transport issue — skip
    }

    // Signal 2: Logging message
    const logMsg = comment.selectedText
      ? `${prefix} on ${file}: "${comment.comment}" (selected: "${selectedPreview}"). Call get_pending_comments to see it.`
      : `${prefix} on ${file}: "${comment.comment}". Call get_pending_comments to see it.`;
    server.sendLoggingMessage({
      level: "warning",
      data: logMsg,
    }).catch(() => {});

    // Signal 3: Resource list changed
    server.server.notification({
      method: "notifications/resources/list_changed",
    }).catch(() => {});
  }

  store.on("new_comment", (comment: { file: string; selectedText: string; comment: string }) => {
    notifyCommentNeedsAttention(comment, "NEW COMMENT");
  });

  store.on("comment_reopened", (comment: { file: string; selectedText: string; comment: string }) => {
    notifyCommentNeedsAttention(comment, "COMMENT REOPENED");
  });

  // Update description count when comments are resolved
  store.on("change", () => {
    const count = store.getAll({ status: "pending" }).length;
    try {
      getPendingTool.update({
        description: `Get comments from the live preview (${count} pending). Call this first to catch comments posted before you started listening.`,
      });
    } catch {
      // Ignore — may not be connected yet
    }
  });

  // Prompt: cowrite-workflow
  server.prompt(
    "cowrite-workflow",
    "How to process live preview comments in a wait-handle-reply loop",
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "You are monitoring a live code preview where users leave comments on selected text.",
              "",
              "Comment lifecycle: pending → answered (auto on your reply) → resolved (user only).",
              "If the user disagrees with your answer, they reply back and it returns to pending.",
              "",
              "Follow this loop:",
              "1. Call `get_pending_comments` to check for any comments already posted.",
              "2. Process each pending comment: read the file, make the requested change, then call `reply_to_comment` to explain what you did.",
              "   Your reply automatically marks the comment as 'answered'. The user will review and resolve it.",
              "3. Call `wait_for_comment` to block until the next comment (or reopened comment) arrives.",
              "4. When a comment arrives, process it the same way (step 2).",
              "5. Go back to step 3 and keep listening.",
              "",
              "Tips:",
              "- Use `get_file_with_annotations` to see comments in context within the file.",
              "- Use `reply_to_comment` to acknowledge or ask clarifying questions.",
              "- Do NOT resolve comments — the user does that after reviewing your work.",
            ].join("\n"),
          },
        },
      ],
    })
  );

  return server;
}
