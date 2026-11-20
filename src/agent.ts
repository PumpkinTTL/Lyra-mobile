import type { AgentMessage, AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { Agent, createFauxCore, fauxAssistantMessage, fauxToolCall, streamAnthropic, streamGoogle, streamOpenAI } from "./pi-runtime";
import { safeModelError, type ModelConnection } from "./model-catalog";

const systemPrompt = "你是 Lyra 的端侧助手。使用用户的语言回复，保持简洁。用户要求读取示例笔记时使用 read_local_note。";

type Options = {
  settings: ModelConnection | null;
  readLocalNote?: () => Promise<string>;
  messages?: AgentMessage[];
  fetch?: typeof fetch;
  probe?: boolean;
};

function configureModel(settings: ModelConnection, request: typeof fetch, probe: boolean): { model: Model<string>; streamFn: StreamFn } {
  const common = {
    id: settings.model,
    name: settings.model,
    baseUrl: settings.endpoint,
    reasoning: false,
    input: ["text" as const],
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

export function createLocalAgent({ settings, readLocalNote, messages, fetch: request = fetch, probe = false }: Options) {
  const tools: AgentTool[] = readLocalNote ? [{
    name: "read_local_note",
    label: "读取本地笔记",
    description: "Read the sample note stored in Lyra on this device.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      return { content: [{ type: "text", text: await readLocalNote() }], details: {} };
    },
  }] : [];
  const demo = settings ? null : createFauxCore({ tokensPerSecond: 36 });
  const { model, streamFn } = settings
    ? configureModel(settings, request, probe)
    : { model: demo!.getModel(), streamFn: demo!.streamSimple };

  const agent = new Agent({
    initialState: { model, systemPrompt: probe ? "Reply briefly in plain text." : systemPrompt, tools, messages },
    streamFn,
    toolExecution: "sequential",
  });

  return {
    agent,
    send(text: string) {
      if (demo) {
        const tool = tools[0];
        const useTool = tool && /笔记|读取|示例|note|demo/i.test(text);
        demo.setResponses(useTool ? [
          fauxAssistantMessage(fauxToolCall(tool.name, {})),
          (context) => {
            const result = [...context.messages].reverse().find((message) => message.role === "toolResult");
            const content = result?.content.find((part) => part.type === "text");
            return fauxAssistantMessage(content ? "已读取本地笔记。\n\n" + content.text : "读取笔记失败。");
          },
        ] : [fauxAssistantMessage("体验模式已就绪。试试让我读取示例笔记，或者打开设置连接你的模型。")]);
      }
      return agent.prompt(text);
    },
  };
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
