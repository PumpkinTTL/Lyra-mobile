export const protocols = {
  openai: { label: "OpenAI 兼容", endpoint: "https://api.openai.com/v1" },
  anthropic: { label: "Anthropic", endpoint: "https://api.anthropic.com" },
  google: { label: "Google Gemini", endpoint: "https://generativelanguage.googleapis.com/v1beta" },
};

export type Protocol = keyof typeof protocols;
export type ModelConnection = { endpoint: string; model: string; apiKey: string; protocol?: Protocol };
export type Provider = { id: string; name: string; protocol: Protocol; endpoint: string; apiKey: string; models: string[] };
export type ModelRef = { providerId: string; model: string } | null;

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
  return { endpoint: provider.endpoint, apiKey: provider.apiKey, protocol: provider.protocol, model: ref.model };
}

function isLocalHost(host: string) {
  if (host === "localhost" || host === "[::1]" || host.endsWith(".local")) return true;
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  const [first, second] = parts.map(Number);
  return first === 127 || first === 10 || (first === 192 && second === 168) || (first === 172 && second >= 16 && second <= 31);
}

export function normalizeProvider(draft: Provider): Provider {
  const name = draft.name.trim();
  if (!name) throw new Error("请填写供应商名称。");

  let url: URL;
  try {
    url = new URL(draft.endpoint.trim());
  } catch {
    throw new Error("请填写完整的 API 基础地址。");
  }

  if (!url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error("API 地址中不能包含账号、密码、查询参数或片段。");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHost(url.hostname))) {
    throw new Error("请使用 HTTPS。HTTP 仅支持本机和局域网地址。");
  }

  let endpoint = url.toString().replace(/\/+$/, "");
  if (draft.protocol === "openai") endpoint = endpoint.replace(/\/chat\/completions$/i, "");
  if (draft.protocol === "anthropic") endpoint = endpoint.replace(/\/v1(?:\/messages)?$/i, "");
  const apiKey = draft.apiKey.trim();
  if (!apiKey && url.protocol !== "http:") throw new Error("请填写 API Key。");
  if (/\r|\n/.test(apiKey)) throw new Error("API Key 不能包含换行。");
  return { ...draft, name, endpoint, apiKey, models: [...new Set(draft.models.map((model) => model.trim()).filter(Boolean))] };
}

type UpstreamModel = { id?: string; name?: string; supportedGenerationMethods?: string[] };
type ModelPage = { data?: UpstreamModel[]; models?: UpstreamModel[]; has_more?: boolean; last_id?: string; nextPageToken?: string; error?: { message?: string } };
type Fetch = typeof fetch;

function readableError(message: unknown, apiKey: string) {
  const text = typeof message === "string" ? message : "";
  return (apiKey ? text.split(apiKey).join("••••") : text).slice(0, 260);
}

export async function fetchProviderModels(provider: Provider, request: Fetch = fetch, signal?: AbortSignal): Promise<string[]> {
  const models = new Set<string>();
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
      const id = provider.protocol === "google"
        ? entry.supportedGenerationMethods?.includes("generateContent") && entry.name?.replace(/^models\//, "")
        : entry.id;
      if (typeof id === "string" && id.trim()) models.add(id.trim());
    }
    cursor = (provider.protocol === "anthropic" && body?.has_more ? body.last_id : body?.nextPageToken) ?? "";
    if (cursor && pages.has(cursor)) throw new Error("供应商返回了重复的模型分页。");
    if (cursor) pages.add(cursor);
  } while (cursor && provider.protocol !== "openai");

  return [...models].sort((first, second) => first.localeCompare(second));
}

export function safeModelError(error: unknown, apiKey = ""): string {
  const value = error instanceof Error ? error.message : String(error);
  return readableError(value, apiKey) || "模型请求失败。";
}
