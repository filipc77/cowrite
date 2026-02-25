export interface Reply {
  id: string;
  from: "user" | "agent";
  text: string;
  createdAt: string;
}

export interface Comment {
  id: string;
  file: string;
  offset: number;
  length: number;
  selectedText: string;
  comment: string;
  status: "pending" | "resolved";
  replies: Reply[];
  createdAt: string;
  resolvedAt: string | null;
}
