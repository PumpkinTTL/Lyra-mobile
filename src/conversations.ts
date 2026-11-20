import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ModelRef } from "./model-catalog";

export type Conversation = {
  id: string;
  title: string;
  updatedAt: number;
  model: ModelRef;
};

export type Workspace = {
  activeId: string;
  conversations: Conversation[];
};

export function localId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
}

export function newConversation(model: ModelRef): Conversation {
  return { id: localId(), title: "", updatedAt: Date.now(), model };
}

export function userTitle(messages: readonly AgentMessage[]) {
  const first = messages.find((item) => item.role === "user");
  const text = typeof first?.content === "string"
    ? first.content
    : first?.content.map((part) => part.type === "text" ? part.text : "").join("") ?? "";
  return Array.from(text.replace(/\s+/g, " ").trim()).slice(0, 36).join("");
}

export function orderedConversations(conversations: readonly Conversation[]) {
  return [...conversations].sort((first, second) => second.updatedAt - first.updatedAt);
}

export function replaceConversation(workspace: Workspace, next: Conversation): Workspace {
  return {
    ...workspace,
    conversations: workspace.conversations.map((item) => item.id === next.id ? next : item),
  };
}
