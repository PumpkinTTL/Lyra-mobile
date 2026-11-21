import type { ThreadMessageLike } from "@assistant-ui/react-native";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { LocalUserMessage } from "./agent";
import { safeModelError } from "./model-catalog";
import type { WorkspaceArtifact } from "./device-workspace";

export type AgentPhase = "preparing" | "waiting" | "thinking" | "tool" | "writing" | "compacting";
export type ToolRun = { state: "running" | "done" | "error" | "cancelled"; output?: string; duration?: number };

export function toolFailed(isError: boolean, details: unknown) {
  return isError || (!!details && typeof details === "object" && "exitCode" in details
    && typeof details.exitCode === "number" && details.exitCode !== 0);
}

export function toolArtifacts(details: unknown): WorkspaceArtifact[] {
  if (!details || typeof details !== "object" || !("artifacts" in details) || !Array.isArray(details.artifacts)) return [];
  return details.artifacts.flatMap((item: unknown) => {
    if (!item || typeof item !== "object" || !("path" in item) || typeof item.path !== "string" || !item.path) return [];
    return [{ path: item.path, projectId: "projectId" in item && typeof item.projectId === "string" ? item.projectId : undefined }];
  });
}

export function toThreadMessages(
  messages: readonly AgentMessage[],
  partial: AgentMessage | undefined,
  busy: boolean,
  conversationId = "",
  apiKey = "",
): ThreadMessageLike[] {
  const all = partial ? [...messages, partial] : messages;
  const results = new Map(
    all.flatMap((message) => message.role === "toolResult" ? [[message.toolCallId, message] as const] : []),
  );

  const rows = all.flatMap((message, index): ThreadMessageLike[] => {
    const id = conversationId + ":" + index;
    const createdAt = new Date(message.timestamp);
    if (message.role === "user") {
      const local = message as LocalUserMessage;
      const parts = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
      const text = local.lyraDisplayText ?? parts.map((part) => part.type === "text" ? part.text : "").join("");
      const content: Exclude<ThreadMessageLike["content"], string>[number][] = [];
      if (text) content.push({ type: "text", text });
      for (const part of parts) {
        if (part.type === "image") content.push({ type: "image", image: "data:" + part.mimeType + ";base64," + part.data });
      }
      for (const attachment of local.lyraAttachments ?? []) {
        content.push({ type: "file", filename: attachment.name, mimeType: attachment.mime, data: attachment.path, sourceType: "id",
          ...(attachment.projectId ? { providerMetadata: { lyra: { projectId: attachment.projectId } } } : {}) });
      }
      return [{ id, role: "user", createdAt, content }];
    }
    if (message.role !== "assistant") return [];
    const content: Exclude<ThreadMessageLike["content"], string>[number][] = [];
    for (const part of message.content) {
      if (part.type === "text" && part.text) {
        content.push({ type: "text", text: part.text });
      } else if (part.type === "thinking" && part.thinking) {
        content.push({ type: "reasoning", text: part.thinking });
      } else if (part.type === "toolCall") {
        const result = results.get(part.id);
        const artifacts = toolArtifacts(result?.details);
        const text = result?.content.filter((item) => item.type === "text").map((item) => item.text).join("\n") ?? "";
        const images = result?.content.filter((item) => item.type === "image").map((item) => "data:" + item.mimeType + ";base64," + item.data) ?? [];
        content.push({
          type: "tool-call",
          toolCallId: part.id,
          toolName: part.name,
          args: part.arguments,
          ...(result ? {
            result: images.length || artifacts.length ? { text, images, artifacts } : text,
            isError: toolFailed(result.isError, result.details),
          } : !busy ? { result: { text: "工具没有完成。", cancelled: true } } : {}),
        });
      }
    }
    if (!content.length && !message.errorMessage && message.stopReason !== "length" && message !== partial) return [];
    return [{
      id,
      role: "assistant",
      createdAt,
      content,
      status: message.stopReason === "aborted"
        ? { type: "incomplete", reason: "cancelled" }
        : message.errorMessage
          ? { type: "incomplete", reason: "error", error: safeModelError(message.errorMessage, apiKey) }
          : message.stopReason === "length"
            ? { type: "incomplete", reason: "length" }
            : message === partial && busy
            ? { type: "running" }
            : { type: "complete", reason: "stop" },
    }];
  });

  const turns: ThreadMessageLike[] = [];
  for (const row of rows) {
    const previous = turns.at(-1);
    if (row.role === "assistant" && previous?.role === "assistant" && previous.status?.type !== "incomplete"
      && typeof previous.content !== "string" && typeof row.content !== "string") {
      turns[turns.length - 1] = { ...previous, content: [...previous.content, ...row.content], status: row.status };
    } else {
      turns.push(row);
    }
  }
  const last = turns.at(-1);
  if (busy && last?.role === "assistant" && last.status?.type !== "incomplete") {
    turns[turns.length - 1] = { ...last, status: { type: "running" } };
  }
  return turns;
}
