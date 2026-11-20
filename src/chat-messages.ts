import type { ThreadMessageLike } from "@assistant-ui/react-native";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { LocalUserMessage } from "./agent";
import { safeModelError } from "./model-catalog";

export type AgentPhase = "waiting" | "thinking" | "tool" | "writing";
export type ToolRun = { state: "running" | "done" | "error"; output?: string; duration?: number };

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

  return all.flatMap((message, index): ThreadMessageLike[] => {
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
        content.push({ type: "file", filename: attachment.name, mimeType: attachment.mime, data: attachment.path, sourceType: "id" });
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
        content.push({
          type: "tool-call",
          toolCallId: part.id,
          toolName: part.name,
          args: part.arguments,
          ...(result ? {
            result: result.content.some((item) => item.type === "image") ? {
              text: result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n"),
              images: result.content.filter((item) => item.type === "image").map((item) => "data:" + item.mimeType + ";base64," + item.data),
            } : result.content.map((item) => item.type === "text" ? item.text : "").join("\n"),
            isError: result.isError,
          } : !busy ? { result: "工具未执行完毕", isError: true } : {}),
        });
      }
    }
    if (!content.length && !message.errorMessage && message !== partial) return [];
    return [{
      id,
      role: "assistant",
      createdAt,
      content,
      status: message.stopReason === "aborted"
        ? { type: "incomplete", reason: "cancelled" }
        : message.errorMessage
          ? { type: "incomplete", reason: "error", error: safeModelError(message.errorMessage, apiKey) }
          : message === partial && busy
            ? { type: "running" }
            : { type: "complete", reason: "stop" },
    }];
  });
}
