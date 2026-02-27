export interface Proposal {
  oldText: string;
  newText: string;
  explanation: string;
  status: "pending" | "applied" | "rejected";
}

export interface Reply {
  id: string;
  from: "user" | "agent";
  text: string;
  createdAt: string;
  proposal?: Proposal;
}

export interface Comment {
  id: string;
  file: string;
  offset: number;
  length: number;
  selectedText: string;
  comment: string;
  status: "pending" | "answered" | "resolved";
  replies: Reply[];
  createdAt: string;
  resolvedAt: string | null;
}

// WebSocket messages: Browser → Server
export type WSClientMessage =
  | { type: "comment_add"; file: string; offset: number; length: number; selectedText: string; comment: string }
  | { type: "comment_reply"; commentId: string; text: string }
  | { type: "comment_resolve"; commentId: string }
  | { type: "comment_reopen"; commentId: string }
  | { type: "comment_delete"; commentId: string }
  | { type: "switch_file"; file: string }
  | { type: "edit_apply"; offset: number; length: number; newText: string }
  | { type: "proposal_apply"; commentId: string; replyId: string }
  | { type: "proposal_reject"; commentId: string; replyId: string };

// WebSocket messages: Server → Browser
export type WSServerMessage =
  | { type: "file_update"; file: string; content: string; html: string }
  | { type: "comments_update"; comments: Comment[] }
  | { type: "error"; message: string };
