import { describe, it, expect, beforeEach } from "vitest";
import { createMcpServer } from "../src/mcp-server.js";
import { CommentStore } from "../src/comment-store.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { tmpdir } from "node:os";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

describe("MCP Server", () => {
  let store: CommentStore;
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cowrite-mcp-test-"));
    store = new CommentStore(tempDir);

    const mcpServer = createMcpServer(store, tempDir);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    client = new Client({ name: "test-client", version: "1.0.0" });
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
  });

  it("should list tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("get_pending_comments");
    expect(names).toContain("resolve_comment");
    expect(names).toContain("reply_to_comment");
    expect(names).toContain("get_file_with_annotations");
  });

  it("should get pending comments (empty)", async () => {
    const result = await client.callTool({ name: "get_pending_comments", arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toBe("No comments found.");
  });

  it("should get pending comments after adding one", async () => {
    store.add({
      file: join(tempDir, "test.md"),
      offset: 0,
      length: 5,
      selectedText: "hello",
      comment: "Fix this typo",
    });

    const result = await client.callTool({
      name: "get_pending_comments",
      arguments: { file: "test.md" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const comments = JSON.parse(text);
    expect(comments).toHaveLength(1);
    expect(comments[0].comment).toBe("Fix this typo");
  });

  it("should resolve a comment", async () => {
    const comment = store.add({
      file: join(tempDir, "test.md"),
      offset: 0,
      length: 5,
      selectedText: "hello",
      comment: "test",
    });

    const result = await client.callTool({
      name: "resolve_comment",
      arguments: { commentId: comment.id },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("resolved");
    expect(store.get(comment.id)?.status).toBe("resolved");
  });

  it("should return error for unknown comment", async () => {
    const result = await client.callTool({
      name: "resolve_comment",
      arguments: { commentId: "nonexistent" },
    });
    expect(result.isError).toBe(true);
  });

  it("should reply to a comment", async () => {
    const comment = store.add({
      file: join(tempDir, "test.md"),
      offset: 0,
      length: 5,
      selectedText: "hello",
      comment: "test",
    });

    await client.callTool({
      name: "reply_to_comment",
      arguments: { commentId: comment.id, reply: "On it!" },
    });

    expect(store.get(comment.id)?.replies).toHaveLength(1);
    expect(store.get(comment.id)?.replies[0].from).toBe("agent");
  });

  it("should get file with annotations", async () => {
    const testFile = join(tempDir, "annotated.md");
    await writeFile(testFile, "Hello world, this is a test file.", "utf-8");

    store.add({
      file: testFile,
      offset: 6,
      length: 5,
      selectedText: "world",
      comment: "Should be uppercase",
    });

    const result = await client.callTool({
      name: "get_file_with_annotations",
      arguments: { file: "annotated.md" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("[COMMENT #");
    expect(text).toContain("Should be uppercase");
    expect(text).toContain("Hello world");
  });

  it("should list resources", async () => {
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain("cowrite://comments");
  });

  it("should read comments resource", async () => {
    store.add({
      file: "/test.md",
      offset: 0,
      length: 3,
      selectedText: "abc",
      comment: "resource test",
    });

    const result = await client.readResource({ uri: "cowrite://comments" });
    const text = (result.contents as Array<{ text: string }>)[0].text;
    const comments = JSON.parse(text);
    expect(comments).toHaveLength(1);
    expect(comments[0].comment).toBe("resource test");
  });
});
