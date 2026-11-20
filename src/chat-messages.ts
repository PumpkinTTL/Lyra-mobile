import type { ThreadMessageLike } from "@assistant-ui/react-native";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export function toThreadMessages(
  messages: readonly AgentMessage[],
  partial: AgentMessage | undefined,
  busy: boolean,
): ThreadMessageLike[] {
  const all = partial ? [...messages, partial] : messages;
  const results = new Map(
    all.flatMap((message) => message.role === "toolResult" ? [[message.toolCallId, message] as const] : []),
  );

  return all.flatMap((message, index): ThreadMessageLike[] => {
    const id = String(index);
    const createdAt = new Date(message.timestamp);
    if (message.role === "user") {
      const text = typeof message.content === "string"
        ? message.content
        : message.content.map((part) => part.type === "text" ? part.text : "").join("");
      return [{ id, role: "user", createdAt, content: text }];
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
            result: result.content.map((item) => item.type === "text" ? item.text : "").join("\n"),
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
          ? { type: "incomplete", reason: "error", error: message.errorMessage }
          : message === partial && busy
            ? { type: "running" }
            : { type: "complete", reason: "stop" },
    }];
  });
}
