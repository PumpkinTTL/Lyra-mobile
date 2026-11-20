import assert from "node:assert/strict";
import { build } from "esbuild";

const { outputFiles } = await build({
  entryPoints: ["src/model-catalog.ts", "src/agent.ts", "src/storage.ts", "src/model-fetch.ts"],
  outdir: "dist",
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2017",
  write: false,
  plugins: [{
    name: "native-test-adapters",
    setup(plugin) {
      plugin.onResolve({ filter: /^(@react-native-async-storage\/async-storage|react-native|react-native-keychain|react-native-fetch-api)$/ }, (args) =>
        ({ path: args.path, namespace: "test" }));
      plugin.onLoad({ filter: /.*/, namespace: "test" }, ({ path }) => {
        if (path === "react-native") return { contents: "export const NativeModules = {};" };
        if (path.endsWith("async-storage")) return { contents: "export default globalThis.lyraTestStorage;" };
        if (path === "react-native-keychain") return { contents: [
          "export const getGenericPassword = () => globalThis.lyraTestPassword;",
          "export const setGenericPassword = (_user, password) => { globalThis.lyraTestPassword = { password }; return true; };",
        ].join("\n") };
        return { contents: "export const fetch = (...args) => globalThis.lyraTestFetcher(...args);" };
      });
    },
  }],
});

function load(name) {
  const output = outputFiles.find((file) => file.path.endsWith(name));
  return import("data:text/javascript;base64," + Buffer.from(output.contents).toString("base64"));
}

const { fetchProviderModels, normalizeProvider } = await load("model-catalog.js");
const { testModelConnection } = await load("agent.js");
const provider = { id: "test", name: "  上游模型  ", protocol: "openai", endpoint: "https://example.invalid/v1/chat/completions", apiKey: "test-key", models: [" model-a ", "model-a", ""] };
const openai = normalizeProvider(provider);
assert.equal(openai.name, "上游模型");
assert.equal(openai.endpoint, "https://example.invalid/v1");
assert.deepEqual(openai.models, ["model-a"]);
const http = normalizeProvider({ ...provider, endpoint: "http://models.example.invalid:8080/v1/" });
assert.equal(http.endpoint, "http://models.example.invalid:8080/v1");
assert.equal(normalizeProvider({ ...provider, endpoint: "http://203.0.113.10:11434/v1" }).endpoint, "http://203.0.113.10:11434/v1");
assert.throws(() => normalizeProvider({ ...provider, endpoint: "ftp://example.invalid/v1" }), /http/);
assert.deepEqual(await fetchProviderModels(http, async (url, options) => {
  assert.equal(url, http.endpoint + "/models");
  assert.equal(options.headers.Authorization, "Bearer test-key");
  return Response.json({ data: [{ id: "http-model" }] });
}), ["http-model"]);
assert.equal(normalizeProvider({ ...provider, endpoint: "http://192.168.1.10:11434/v1", apiKey: "" }).apiKey, "");
assert.throws(() => normalizeProvider({ ...provider, apiKey: "" }), /Key/);

const models = await fetchProviderModels(openai, async (url, options) => {
  assert.equal(url, openai.endpoint + "/models");
  assert.equal(options.headers.Authorization, "Bearer test-key");
  return Response.json({ data: [{ id: "model-b" }, { id: "model-a" }, { id: "model-b" }] });
});
assert.deepEqual(models, ["model-a", "model-b"]);
await assert.rejects(fetchProviderModels(openai, async () => Response.json({ error: { message: "Key test-key rejected" } }, { status: 401 })),
  (error) => error.message.includes("401") && !error.message.includes("test-key"));

const anthropic = normalizeProvider({ ...provider, endpoint: "https://anthropic.example.invalid/v1", protocol: "anthropic" });
const anthropicModels = await fetchProviderModels(anthropic, async (url, options) => {
  assert.equal(options.headers["x-api-key"], "test-key");
  return new URL(url).searchParams.has("after_id")
    ? Response.json({ data: [{ id: "claude-b" }], has_more: false })
    : Response.json({ data: [{ id: "claude-a" }], has_more: true, last_id: "claude-a" });
});
assert.deepEqual(anthropicModels, ["claude-a", "claude-b"]);

const google = normalizeProvider({ ...provider, endpoint: "https://google.example.invalid/v1beta", protocol: "google" });
const geminiModels = await fetchProviderModels(google, async (url, options) => {
  assert.equal(options.headers["x-goog-api-key"], "test-key");
  return new URL(url).searchParams.has("pageToken")
    ? Response.json({ models: [{ name: "models/gemini-b", supportedGenerationMethods: ["generateContent"] }] })
    : Response.json({ models: [
      { name: "models/gemini-a", supportedGenerationMethods: ["generateContent"] },
      { name: "models/embedding", supportedGenerationMethods: ["embedContent"] },
    ], nextPageToken: "test-page" });
});
assert.deepEqual(geminiModels, ["gemini-a", "gemini-b"]);

function sse(payload) {
  return new Response(payload, { headers: { "content-type": "text/event-stream" } });
}
function data(value, event) {
  return (event ? "event: " + event + "\n" : "") + "data: " + JSON.stringify(value) + "\n\n";
}
await testModelConnection({ ...openai, model: "model-a" }, async (url, init) => {
  assert.equal(String(url), openai.endpoint + "/chat/completions");
  assert.equal(JSON.parse(init.body).tools, undefined);
  const chunk = (delta, finish_reason) => data({ id: "mock", object: "chat.completion.chunk", created: 1, model: "model-a", choices: [{ index: 0, delta, finish_reason }] });
  return sse(chunk({ role: "assistant", content: "OK" }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
});

await testModelConnection({ ...anthropic, model: "claude-a" }, async (url) => {
  assert.equal(new URL(url).pathname, "/v1/messages");
  const event = (type, body = {}) => data({ type, ...body }, type);
  return sse(
    event("message_start", { message: { id: "mock", type: "message", role: "assistant", model: "claude-a", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 2, output_tokens: 0 } } }) +
    event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
    event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "OK" } }) +
    event("content_block_stop", { index: 0 }) +
    event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }) +
    event("message_stop"),
  );
});

await testModelConnection({ ...google, model: "gemini-a" }, async (url) => {
  const requested = typeof url === "object" && "url" in url ? url.url : String(url);
  const parsed = new URL(requested);
  assert.equal(parsed.pathname, "/v1beta/models/gemini-a:streamGenerateContent");
  assert.equal(parsed.searchParams.get("alt"), "sse");
  return sse(data({ candidates: [{ index: 0, finishReason: "STOP", content: { role: "model", parts: [{ text: "OK" }] } }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 } }));
});

globalThis.lyraTestFetcher = async (url, options) => {
  assert.equal(url, openai.endpoint + "/chat/completions");
  assert.deepEqual(options.headers, { authorization: "Bearer test-key", "content-type": "application/json" });
  assert.equal(options.body, "{}");
  assert.equal(options.reactNative.textStreaming, true);
  return sse("");
};
const { streamingFetch } = await load("model-fetch.js");
await streamingFetch(new Request(openai.endpoint + "/chat/completions", {
  method: "POST", headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" }, body: "{}",
}));

const prior = [{ role: "user", content: "旧对话", timestamp: 10 }];
const records = new Map([
  ["lyra.chat.demo.v1", JSON.stringify([{ role: "user", content: "旧示例", timestamp: 5 }])],
  ["lyra.chat.model.v1:" + encodeURIComponent(openai.endpoint) + ":model-a", JSON.stringify(prior)],
]);
globalThis.lyraTestStorage = {
  getItem: async (key) => records.get(key) ?? null,
  getAllKeys: async () => [...records.keys()],
  multiGet: async (keys) => keys.map((key) => [key, records.get(key) ?? null]),
  multiSet: async (values) => { for (const [key, value] of values) records.set(key, value); },
};
globalThis.lyraTestPassword = { password: JSON.stringify({ endpoint: openai.endpoint, apiKey: "test-key", model: "model-a" }) };
const { openStorage, loadMessages, saveProviders } = await load("storage.js");
const migrated = await openStorage();
assert.equal(migrated.providers[0].apiKey, "test-key");
assert.equal(migrated.workspace.conversations.length, 2);
assert.equal(migrated.workspace.conversations.find((conversation) => conversation.id === migrated.workspace.activeId).title, "旧对话");
assert.deepEqual(await loadMessages(migrated.workspace.activeId), prior);
assert.deepEqual((await openStorage()).workspace, migrated.workspace);
await saveProviders([openai, anthropic]);
assert.equal((await openStorage()).providers.length, 2);
assert.ok(!records.get("lyra.workspace.v2").includes("test-key"));
console.log("Provider catalogs, three streaming protocol probes, Android fetch adaptation, and 0.1 data migration passed.");
