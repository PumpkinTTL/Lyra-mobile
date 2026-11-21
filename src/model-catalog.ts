export const protocols = {
  openai: { label: "OpenAI 兼容", endpoint: "https://api.openai.com/v1" },
  anthropic: { label: "Anthropic", endpoint: "https://api.anthropic.com" },
  google: { label: "Google Gemini", endpoint: "https://generativelanguage.googleapis.com/v1beta" },
};

export type Protocol = keyof typeof protocols;
export const thinkingLevels = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = typeof thinkingLevels[number];
export const thinkingLabels: Record<Effort | "off" | "on", string> = {
  off: "Off", on: "On", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max",
};
export type ModelOptions = { contextWindow?: number; maxTokens?: number; images?: boolean; reasoning?: boolean; thinkingLevels?: Effort[] };
export type UpstreamModel = { id: string; name?: string; options: ModelOptions };
export type ModelConnection = { endpoint: string; model: string; apiKey: string; protocol?: Protocol; options?: ModelOptions };
export type Provider = { id: string; name: string; protocol: Protocol; endpoint: string; apiKey: string; models: string[];
  modelOptions?: Record<string, ModelOptions>; modelMetadata?: Record<string, ModelOptions> };
export type ModelRef = { providerId: string; model: string } | null;
export const defaultContextWindow = 32_768;

export function modelOptions(provider: Provider, model: string): ModelOptions {
  return { ...(Object.hasOwn(provider.modelMetadata ?? {}, model) ? provider.modelMetadata?.[model] : undefined),
    ...(Object.hasOwn(provider.modelOptions ?? {}, model) ? provider.modelOptions?.[model] : undefined) };
}

export function reasoningChoices(options?: ModelOptions): readonly Effort[] {
  if (options?.reasoning === false) return [];
  return options?.thinkingLevels ?? ["low", "medium", "high"];
}

export function effectiveThinking(options: ModelOptions | undefined, selected: "off" | Effort = "off"): "off" | Effort {
  if (selected === "off" || options?.reasoning === false) return "off";
  const choices = reasoningChoices(options);
  return choices.includes(selected) ? selected : choices[0] ?? "low";
}

export function providerRef(provider: Provider, model: string): ModelRef {
  return { providerId: provider.id, model };
}

export function sameModel(first: ModelRef, second: ModelRef): boolean {
  return first?.providerId === second?.providerId && first?.model === second?.model;
}

export function resolveConnection(providers: readonly Provider[], ref: ModelRef): ModelConnection | null | undefined {
  if (!ref) return null;
  const provider = providers.find((item) => item.id === ref.providerId);
  if (!provider?.models.includes(ref.model)) return undefined;
  return { endpoint: provider.endpoint, apiKey: provider.apiKey, protocol: provider.protocol, model: ref.model, options: modelOptions(provider, ref.model) };
}

export function normalizeProvider(draft: Provider): Provider {
  const name = draft.name.trim();
  if (!name) throw new Error("请填写供应商名称。");

  let url: URL;
  try {
    url = new URL(draft.endpoint.trim());
  } catch {
    throw new Error("请填写完整的 API 基础地址，以 http:// 或 https:// 开头。");
  }

  if (!url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error("API 地址中不能包含账号、密码、查询参数或片段。");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("API 地址请以 http:// 或 https:// 开头。");
  }

  let endpoint = url.toString().replace(/\/+$/, "");
  if (draft.protocol === "openai") endpoint = endpoint.replace(/\/chat\/completions$/i, "");
  if (draft.protocol === "anthropic") endpoint = endpoint.replace(/\/v1(?:\/messages)?$/i, "");
  const apiKey = draft.apiKey.trim();
  if (!apiKey && url.protocol !== "http:") throw new Error("请填写 API Key。");
  if (/\r|\n/.test(apiKey)) throw new Error("API Key 不能包含换行。");
  const models = [...new Set(draft.models.map((model) => model.trim()).filter(Boolean))];
  const retainModels = (entries: Record<string, ModelOptions> | undefined) => Object.fromEntries(Object.entries(entries ?? {}).filter(([id]) => models.includes(id)));
  const options = retainModels(draft.modelOptions);
  const metadata = retainModels(draft.modelMetadata);
  for (const [id, { contextWindow, maxTokens, thinkingLevels: efforts }] of Object.entries(options)) {
    if (contextWindow !== undefined && (!Number.isInteger(contextWindow) || contextWindow < 2048 || contextWindow > 2_000_000)) throw new Error("上下文窗口请输入 2048 到 2000000 的整数。");
    const limit = contextWindow ?? metadata[id]?.contextWindow;
    if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens < 128 || maxTokens > 1_000_000 || (limit !== undefined && maxTokens > limit))) throw new Error("最大输出须为 128 到 1000000 之间的整数，且不大于已知的上下文窗口。");
    if (efforts?.some((level) => !thinkingLevels.includes(level))) throw new Error("思考档位无效。");
  }
  return { ...draft, name, endpoint, apiKey, models, modelOptions: options, modelMetadata: metadata };
}

type ModelPage = { data?: unknown[]; models?: unknown[]; has_more?: boolean; last_id?: string; nextPageToken?: string; error?: { message?: string } };
type Fetch = typeof fetch;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parsedModel(value: unknown, protocol: Protocol): UpstreamModel | undefined {
  const entry = record(value);
  const methods = entry.supportedGenerationMethods;
  if (protocol === "google" && (!Array.isArray(methods) || !methods.includes("generateContent"))) return;
  const id = protocol === "google" && typeof entry.name === "string" ? entry.name.replace(/^models\//, "") : entry.id;
  if (typeof id !== "string" || !id.trim()) return;
  const caps = record(entry.capabilities);
  const limit = record(entry.limit ?? entry.limits);
  const top = record(entry.top_provider);
  const architecture = record(entry.architecture);
  function number(min: number, max: number, ...values: unknown[]) {
    return values.find((item): item is number => typeof item === "number" && Number.isInteger(item) && item >= min && item <= max);
  }
  function flag(...values: unknown[]) { return values.find((item): item is boolean => typeof item === "boolean"); }
  const modalities = [entry.input_modalities, entry.inputModalities, architecture.input_modalities, record(entry.modalities).input].find(Array.isArray);
  const supported = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : [];
  const declared = [entry.supported_efforts, entry.thinking_levels, entry.reasoning_efforts, caps.thinking_levels].find(Array.isArray);
  const efforts = declared ? thinkingLevels.filter((level) => declared.includes(level)) : undefined;
  const adjustable = flag(entry.supports_thinking_levels, caps.supports_thinking_levels);
  const contextWindow = number(2048, 2_000_000, top.context_length, entry.context_length, entry.context_window, entry.inputTokenLimit, limit.context);
  const maxTokens = number(128, 1_000_000, top.max_completion_tokens, entry.max_completion_tokens, entry.max_output_tokens, entry.outputTokenLimit, limit.output);
  const options: ModelOptions = {
    contextWindow, maxTokens: contextWindow && maxTokens ? Math.min(contextWindow, maxTokens) : maxTokens,
    images: flag(entry.supports_vision, caps.vision, caps.supports_vision, caps.images) ?? modalities?.includes("image"),
    reasoning: flag(entry.supports_reasoning, entry.thinking, entry.reasoning, caps.reasoning, caps.supports_reasoning)
      ?? (efforts?.length || supported.includes("reasoning") || supported.includes("reasoning_effort") ? true : undefined),
    thinkingLevels: efforts?.length ? efforts : adjustable === false ? [] : undefined,
  };
  const name = entry.displayName ?? entry.display_name ?? (protocol === "google" ? undefined : entry.name);
  return { id: id.trim(), name: typeof name === "string" ? name.trim() : undefined, options };
}

function readableError(message: unknown, apiKey: string) {
  const text = typeof message === "string" ? message : "";
  return (apiKey ? text.split(apiKey).join("••••") : text).slice(0, 260);
}

export async function fetchProviderCatalog(provider: Provider, request: Fetch = fetch, signal?: AbortSignal): Promise<UpstreamModel[]> {
  const models = new Map<string, UpstreamModel>();
  const pages = new Set<string>();
  let cursor = "";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (provider.protocol === "anthropic") {
    headers["x-api-key"] = provider.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (provider.protocol === "google") {
    headers["x-goog-api-key"] = provider.apiKey;
  } else if (provider.apiKey) {
    headers.Authorization = "Bearer " + provider.apiKey;
  }

  do {
    let path = provider.protocol === "anthropic" ? "/v1/models?limit=1000" : "/models";
    if (provider.protocol === "google") path += "?pageSize=1000";
    if (cursor) path += (provider.protocol === "anthropic" ? "&after_id=" : "&pageToken=") + encodeURIComponent(cursor);

    const response = await request(provider.endpoint + path, { headers, signal });
    const body = await response.json().catch(() => null) as ModelPage | null;
    if (!response.ok) {
      const detail = readableError(body?.error?.message, provider.apiKey);
      throw new Error("拉取失败（HTTP " + response.status + "）" + (detail ? "：" + detail : "。"));
    }
    const entries = provider.protocol === "google" ? body?.models : body?.data;
    if (!Array.isArray(entries)) throw new Error("供应商的模型列表格式不受支持，可以手动添加模型 ID。");
    for (const entry of entries) {
      const row = parsedModel(entry, provider.protocol);
      if (row) models.set(row.id, row);
    }
    cursor = (provider.protocol === "anthropic" && body?.has_more ? body.last_id : body?.nextPageToken) ?? "";
    if (cursor && pages.has(cursor)) throw new Error("供应商返回了重复的模型分页。");
    if (cursor) pages.add(cursor);
  } while (cursor && provider.protocol !== "openai");

  return [...models.values()].sort((first, second) => first.id.localeCompare(second.id));
}

export function safeModelError(error: unknown, apiKey = ""): string {
  const value = error instanceof Error ? error.message : String(error);
  if (/stream ended (?:without (?:a )?finish[_ ]?reason|before message_stop)/i.test(value)) {
    return "模型回复提前结束，未收到协议结束标记。可以继续回答或重试。";
  }
  return readableError(value, apiKey) || "模型请求失败。";
}
