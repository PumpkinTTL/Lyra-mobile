import type { AgentMessage, AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { Agent, createFauxCore, fauxAssistantMessage, fauxToolCall, streamSimple } from "./pi-runtime";

export type ModelSettings = { endpoint: string; model: string; apiKey: string };

const systemPrompt = "你是 Lyra 的端侧助手。使用用户的语言回复，保持简洁。用户要求读取示例笔记时使用 read_local_note。";

type Options = {
  settings: ModelSettings | null;
  readLocalNote: () => Promise<string>;
  messages?: AgentMessage[];
  fetch?: typeof fetch;
};

export function createLocalAgent({ settings, readLocalNote, messages, fetch }: Options) {
  const noteTool: AgentTool = {
    name: "read_local_note",
    label: "读取本地笔记",
    description: "Read the sample note stored in Lyra on this device.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      return { content: [{ type: "text", text: await readLocalNote() }], details: {} };
    },
  };
  let model: Model<string>;
  let streamFn: StreamFn;
  let prepareDemo: ((text: string) => void) | undefined;

  if (settings) {
    const connection = settings;
    const remoteModel: Model<"openai-completions"> = {
      id: connection.model,
      name: connection.model,
      api: "openai-completions",
      provider: "lyra-openai-compatible",
      baseUrl: connection.endpoint,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_768,
      maxTokens: 4096,
    };
    model = remoteModel;
    streamFn = (_model, context, options) => streamSimple(remoteModel, context, {
      ...options,
      apiKey: connection.apiKey,
      fetch,
      maxRetries: 0,
    });
  } else {
    const demo = createFauxCore({ tokensPerSecond: 36 });
    model = demo.getModel();
    streamFn = demo.streamSimple;
    prepareDemo = (text) => {
      if (!/笔记|读取|示例|note|demo/i.test(text)) {
        demo.setResponses([fauxAssistantMessage("本机 Pi Agent 已就绪。试试让我读取示例笔记，查看工具调用过程。")]);
        return;
      }
      demo.setResponses([
        fauxAssistantMessage(fauxToolCall(noteTool.name, {})),
        (context) => {
          const result = [...context.messages].reverse().find((message) => message.role === "toolResult");
          const content = result?.content.find((part) => part.type === "text");
          return fauxAssistantMessage(content ? "已读取本地笔记。\n\n" + content.text : "读取笔记失败。");
        },
      ]);
    };
  }

  const agent = new Agent({
    initialState: { model, systemPrompt, tools: [noteTool], messages },
    streamFn,
    toolExecution: "sequential",
  });

  return {
    agent,
    send(text: string) {
      prepareDemo?.(text);
      return agent.prompt(text);
    },
  };
}
