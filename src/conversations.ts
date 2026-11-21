import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { LocalUserMessage } from "./agent";
import type { ModelRef } from "./model-catalog";

export type Conversation = {
  id: string;
  title: string;
  updatedAt: number;
  model: ModelRef;
  projectId?: string;
  projectName?: string;
  thinking?: ThinkingLevel;
  sshTarget?: string;
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
  const local = first as LocalUserMessage | undefined;
  const title = local?.lyraDisplayText || local?.lyraAttachments?.[0]?.name || text;
  return Array.from(title.replace(/\s+/g, " ").trim()).slice(0, 36).join("");
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
