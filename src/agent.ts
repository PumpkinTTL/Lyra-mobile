import type { AgentMessage, AgentTool, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model, TextContent, UserMessage } from "@earendil-works/pi-ai";
import { Agent, streamAnthropic, streamGoogle, streamOpenAI } from "./pi-runtime";
import { makeContextBudget } from "./context-budget";
import { defaultContextWindow, effectiveThinking, safeModelError, thinkingLevels, type ModelConnection } from "./model-catalog";

const systemPrompt = "你是 Lyra 的端侧助手。使用用户的语言，用工作区工具实际完成任务。路径相对于 /workspace。Office 附件使用 office_inspect 按段落、工作表范围或幻灯片读取，可编辑 Word、Excel 和 PowerPoint 用 office_create 生成，现有文档用 office_edit 修改。要求保留原稿时传 outputPath。普通文本和图片用 read，写文本用 edit 或 write。压缩使用 archive_create，交付现有文件使用 artifact_show。bash 是内置命令和管道的沙箱，不能启动外部 Node、Python 或系统程序。用户明确要求管理服务器时，用 ssh_servers 查找已配置的连接，自己拟定命令并通过 ssh_exec 完成任务。凭据在 SSH 设置中管理。说明实际做过的更改与验证。";

type Options = {
  settings: ModelConnection;
  tools?: AgentTool[];
  thinking?: ThinkingLevel;
  projectName?: string;
  messages?: AgentMessage[];
  fetch?: typeof fetch;
  probe?: boolean;
  onCompaction?(active: boolean): void;
};

function configureModel(settings: ModelConnection, request: typeof fetch, probe: boolean, thinking: ThinkingLevel): { model: Model<string>; streamFn: StreamFn } {
  const knownOutput = settings.options?.maxTokens;
  const contextWindow = settings.options?.contextWindow ?? Math.max(defaultContextWindow, (knownOutput ?? 0) * 2);
  const capabilities = settings.options;
  const available = capabilities?.thinkingLevels;
  const reasoning = capabilities?.reasoning !== false && (capabilities?.reasoning === true || thinking !== "off");
  const common = {
    id: settings.model,
    name: settings.model,
    baseUrl: settings.endpoint,
    reasoning,
    input: capabilities?.images === false ? ["text" as const] : ["text" as const, "image" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: probe ? 128 : Math.min(knownOutput ?? Math.min(16_384, Math.floor(contextWindow / 3)), contextWindow),
    thinkingLevelMap: available?.length ? Object.fromEntries(thinkingLevels.map((level) => [level, available.includes(level) ? level : null])) : undefined,
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
      const glm = reasoning && /(?:^|\/)glm[-_]/i.test(settings.model);
      const model: Model<"openai-completions"> = { ...common, provider: "lyra-openai-compatible", api: "openai-completions",
        compat: glm ? { thinkingFormat: "zai", supportsReasoningEffort: (available?.length ?? 0) > 0 } : undefined };
      return { model, streamFn: (_model, context, options) => streamOpenAI(model, context, { ...options, ...apiOptions,
        onPayload: async (original, activeModel) => {
          const payload = (await options?.onPayload?.(original, activeModel) ?? original) as Record<string, unknown>;
          if (!probe && !knownOutput && options?.maxTokens === undefined) {
            delete payload.max_tokens;
            delete payload.max_completion_tokens;
          }
          if (available?.length === 0) delete payload.reasoning_effort;
          return payload;
        },
      }) };
    }
  }
}

export type LocalUserMessage = UserMessage & {
  lyraDisplayText?: string;
  lyraAttachments?: { name: string; path: string; mime: string; projectId?: string }[];
};

export function createLocalAgent({ settings, tools = [], thinking = "off", projectName, messages, fetch: request = fetch, probe = false, onCompaction }: Options) {
  const activeThinking = effectiveThinking(settings.options, thinking);
  const { model, streamFn } = configureModel(settings, request, probe, activeThinking);
  const prompt = projectName ? systemPrompt + " 当前工作区：" + projectName : systemPrompt;
  const agent = new Agent({
    initialState: {
      model, thinkingLevel: model.reasoning ? activeThinking : "off", systemPrompt: probe ? "Reply briefly in plain text." : prompt,
      tools, messages: messages?.filter((message) => message.role !== "system"),
    },
    streamFn,
    transformContext: probe ? undefined : makeContextBudget(model, streamFn, onCompaction),
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
