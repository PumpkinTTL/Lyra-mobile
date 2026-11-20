import type { AgentMessage, AgentTool, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model, TextContent, UserMessage } from "@earendil-works/pi-ai";
import { Agent, streamAnthropic, streamGoogle, streamOpenAI } from "./pi-runtime";
import { safeModelError, type ModelConnection } from "./model-catalog";

const systemPrompt = "你是 Lyra 的移动端编程助手。使用用户的语言，用工作区工具实际完成任务。路径一律相对于 /workspace。通过 ls、find 和 grep 了解项目，使用 read 检查文件，用 edit 或 write 修改文件，用 bash 运行工作区里的脚本和命令。说明实际做过的更改与验证。";

type Options = {
  settings: ModelConnection;
  tools?: AgentTool[];
  thinking?: ThinkingLevel;
  projectName?: string;
  messages?: AgentMessage[];
  fetch?: typeof fetch;
  probe?: boolean;
};

function configureModel(settings: ModelConnection, request: typeof fetch, probe: boolean, thinking: ThinkingLevel): { model: Model<string>; streamFn: StreamFn } {
  const common = {
    id: settings.model,
    name: settings.model,
    baseUrl: settings.endpoint,
    reasoning: thinking !== "off",
    input: ["text" as const, "image" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: probe ? 128 : 4096,
  };

  const apiOptions = {
    apiKey: settings.apiKey || "lyra-local",
    fetch: settings.apiKey ? request : (input: RequestInfo | URL, init?: RequestInit) => {
      const derived = typeof input === "object" && "headers" in input ? input.headers : undefined;
      const headers = new Headers(init?.headers ?? derived);
      for (const name of ["authorization", "x-api-key", "x-goog-api-key"]) headers.delete(name);
      return request(input, { ...init, headers });
    },
    maxRetries: 0,
  };

  switch (settings.protocol) {
    case "anthropic": {
      const model: Model<"anthropic-messages"> = { ...common, provider: "anthropic", api: "anthropic-messages" };
      return { model, streamFn: (_model, context, options) => streamAnthropic(model, context, { ...options, ...apiOptions }) };
    }
    case "google": {
      const model: Model<"google-generative-ai"> = { ...common, provider: "google", api: "google-generative-ai" };
      return { model, streamFn: (_model, context, options) => streamGoogle(model, context, { ...options, ...apiOptions }) };
    }
    default: {
      const model: Model<"openai-completions"> = { ...common, provider: "lyra-openai-compatible", api: "openai-completions" };
      return { model, streamFn: (_model, context, options) => streamOpenAI(model, context, { ...options, ...apiOptions }) };
    }
  }
}

export type LocalUserMessage = UserMessage & {
  lyraDisplayText?: string;
  lyraAttachments?: { name: string; path: string; mime: string }[];
};

export function createLocalAgent({ settings, tools = [], thinking = "off", projectName, messages, fetch: request = fetch, probe = false }: Options) {
  const { model, streamFn } = configureModel(settings, request, probe, thinking);
  const prompt = projectName ? systemPrompt + " 当前工作区：" + projectName : systemPrompt;
  const agent = new Agent({
    initialState: {
      model, thinkingLevel: thinking, systemPrompt: probe ? "Reply briefly in plain text." : prompt,
      tools, messages: messages?.filter((message) => message.role !== "system"),
    },
    streamFn,
    toolExecution: "sequential",
  });
  return {
    agent,
    send(message: string | LocalUserMessage) {
      if (typeof message === "string") return agent.prompt(message);
      return agent.prompt(message);
    },
  };
}

export function localUserMessage(
  displayText: string,
  content: (ImageContent | TextContent)[],
  attachments: LocalUserMessage["lyraAttachments"] = [],
): LocalUserMessage {
  return { role: "user", content, timestamp: Date.now(), lyraDisplayText: displayText, lyraAttachments: attachments };
}

export async function testModelConnection(settings: ModelConnection, request: typeof fetch, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("连接测试已取消。");
  const { agent, send } = createLocalAgent({ settings, fetch: request, probe: true });
  const abort = () => agent.abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abort(); }, 25_000);
  signal?.addEventListener("abort", abort);
  try {
    await send("Reply with OK.");
    if (timedOut) throw new Error("连接测试超时，请检查 API 地址和网络。");
    if (signal?.aborted) throw new Error("连接测试已取消。");
    const reply = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
    if (!reply || reply.stopReason === "error" || reply.stopReason === "aborted") {
      throw new Error(reply?.errorMessage ?? agent.state.errorMessage ?? "没有收到模型回复。");
    }
    if (!reply.content.some((part) => part.type === "text" && part.text.trim())) {
      throw new Error("模型已连通，但没有返回文本。请检查模型是否支持聊天。");
    }
  } catch (error) {
    throw new Error(safeModelError(error, settings.apiKey));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
