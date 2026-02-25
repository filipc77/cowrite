import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CommentStore } from "./comment-store.js";
import { annotateFileWithComments } from "./utils.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export function createMcpServer(store: CommentStore, projectDir: string): McpServer {
  const server = new McpServer({
    name: "cowrite",
    version: "0.1.0",
  });

  // Tool: get_pending_comments
  server.tool(
    "get_pending_comments",
    "Get comments from the live preview. Returns unresolved comments by default.",
    {
      file: z.string().optional().describe("Filter by file path"),
      status: z.enum(["pending", "resolved", "all"]).optional().describe("Filter by status (default: pending)"),
    },
    async ({ file, status }) => {
      const filter: { file?: string; status?: "pending" | "resolved" | "all" } = {};
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

  // Tool: resolve_comment
  server.tool(
    "resolve_comment",
    "Mark a comment as resolved/addressed.",
    {
      commentId: z.string().describe("The comment ID to resolve"),
    },
    async ({ commentId }) => {
      const comment = store.resolve(commentId);
      if (!comment) {
        return {
          content: [{ type: "text" as const, text: `Comment ${commentId} not found.` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: `Comment ${commentId} resolved.` }],
      };
    }
  );

  // Tool: reply_to_comment
  server.tool(
    "reply_to_comment",
    "Reply to a comment from the agent.",
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
    server.server.notification({
      method: "notifications/resources/updated",
      params: { uri: "cowrite://comments" },
    }).catch(() => {
      // Notification may fail if client doesn't support it, that's OK
    });
  });

  return server;
}
