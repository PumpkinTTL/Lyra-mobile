import assert from "node:assert/strict";
import { build } from "esbuild";

const { outputFiles } = await build({
  entryPoints: ["src/agent.ts", "src/chat-messages.ts", "src/workspace-tools.ts", "src/chat-attachments.ts"],
  outdir: "dist",
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2017",
  write: false,
  plugins: [{
    name: "device-fixture",
    setup(plugin) {
      plugin.onResolve({ filter: /^react-native$/ }, () => ({ path: "device", namespace: "test" }));
      plugin.onLoad({ filter: /^device$/, namespace: "test" }, () => ({
        contents: "export const NativeModules = { LyraWorkspace: globalThis.lyraMockWorkspace };",
      }));
    },
  }],
});

function load(name) {
  const output = outputFiles.find((file) => file.path.endsWith("/" + name) || file.path.endsWith("\\" + name));
  return import("data:text/javascript;base64," + Buffer.from(output.contents).toString("base64"));
}

const entries = new Map();
const b64 = (text) => Buffer.from(text).toString("base64");
const text = (base64) => Buffer.from(base64, "base64").toString("utf8");
function mkdir(path) {
  const components = path.split("/").filter(Boolean);
  for (let i = 1; i <= components.length; i++) entries.set(components.slice(0, i).join("/"), null);
}
const io = {
  async list(path, recursive, limit) {
    if (path && entries.get(path) !== null) throw new Error("directory is missing");
    const found = [...entries].filter(([name]) => (
      name !== path && (!path || name.startsWith(path + "/")) && (recursive || !name.slice(path ? path.length + 1 : 0).includes("/"))
    )).map(([name, data]) => ({ path: name, directory: data === null, size: data === null ? 0 : Buffer.from(data, "base64").length }));
    return { entries: found.slice(0, limit), truncated: found.length > limit };
  },
  async read(path, limit) {
    const entry = entries.get(path);
    if (typeof entry !== "string") throw new Error("file is missing");
    const bytes = Buffer.from(entry, "base64");
    return { base64: bytes.subarray(0, limit).toString("base64"), mime: path.endsWith(".png") ? "image/png" : "text/plain", truncated: bytes.length > limit };
  },
  async write(path, data) {
    mkdir(path.split("/").slice(0, -1).join("/"));
    entries.set(path, data);
  },
  async mkdir(path) { mkdir(path); },
  async remove(path) { entries.delete(path); },
};
globalThis.lyraMockWorkspace = {
  read: (workspace, path, limit) => {
    assert.equal(workspace, "fake-workspace");
    return io.read(path, limit);
  },
};

const { createLocalAgent } = await load("agent.js");
const { toThreadMessages } = await load("chat-messages.js");
const { createWorkspaceTools } = await load("workspace-tools.js");
const { prepareUserMessage } = await load("chat-attachments.js");
const tools = createWorkspaceTools(io);
const expectedNames = ["read", "write", "edit", "ls", "find", "grep", "bash"];
assert.deepEqual(tools.map((tool) => tool.name), expectedNames);

const run = (name, args) => tools.find((tool) => tool.name === name).execute("test", args);
const output = (result) => result.content.map((part) => part.text).join("\n");

await run("write", { path: "src/task.txt", content: "hello\noriginal\n" });
await run("edit", { path: "/workspace/src/task.txt", edits: [{ oldText: "original", newText: "updated" }] });
assert.match(output(await run("read", { path: "src/task.txt", offset: 2 })), /^updated/);
assert.match(output(await run("ls", { path: "." })), /src\//);
assert.match(output(await run("find", { pattern: "**/*.txt" })), /src\/task\.txt/);
assert.match(output(await run("grep", { path: "src", pattern: "^updated" })), /src\/task\.txt:2: updated/);
await assert.rejects(() => run("read", { path: "../secret" }), /工作区/);
const bash = await run("bash", { command: "cat src/task.txt | grep updated > result.txt; cat result.txt" });
assert.match(output(bash), /updated[\s\S]*退出码 0/);
assert.equal(text(entries.get("result.txt")), "updated\n");
const zip = await run("bash", { command: "gzip -c result.txt > result.gz; gunzip -c result.gz" });
assert.match(output(zip), /updated[\s\S]*退出码 0/);
assert.ok(entries.has("result.gz"));

await io.write(".attachments/project.txt", b64("attachment body"));
await io.write(".attachments/test.png", b64("test image bytes"));
const attachmentMessage = await prepareUserMessage("fake-workspace", "check attachments", [
  { name: "project.txt", path: ".attachments/project.txt", mime: "text/plain", size: 15 },
  { name: "test.png", path: ".attachments/test.png", mime: "image/png", size: 16 },
]);
assert.ok(attachmentMessage.content.some((part) => part.type === "text" && part.text.includes("attachment body")));
assert.ok(attachmentMessage.content.some((part) => part.type === "image"));
const display = toThreadMessages([attachmentMessage], undefined, false);
assert.equal(display[0].content.filter((part) => part.type === "file").length, 2);

function stream(model, first) {
  const chunk = (delta, finish_reason) => "data: " + JSON.stringify({
    id: "test", object: "chat.completion.chunk", created: 1, model,
    choices: [{ index: 0, delta, finish_reason }],
  }) + "\n\n";
  const response = first
    ? chunk({ role: "assistant", reasoning_content: "Thinking about the file" }, null)
      + chunk({ tool_calls: [{ index: 0, id: "call_read", type: "function", function: { name: "read", arguments: '{"path":"result.txt"}' } }] }, null)
      + chunk({}, "tool_calls")
    : chunk({ role: "assistant", content: "done with the file" }, null) + chunk({}, "stop");
  return new Response(response + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}

let requests = 0;
const settings = { endpoint: "https://api.example.invalid/v1", model: "mock-model", apiKey: "test-only" };
const saved = [{ role: "system", content: "Old read_local_note prompt", toolsAdded: [{ name: "read_local_note", description: "Old demo", parameters: { type: "object" } }], timestamp: 0 },
  { role: "user", content: [{ type: "text", text: "older conversation" }], timestamp: 1 }];
const agent = createLocalAgent({
  settings, tools, thinking: "low", messages: saved, projectName: "test",
  async fetch(input, init) {
    assert.equal(String(input), settings.endpoint + "/chat/completions");
    const body = JSON.parse(init.body);
    assert.deepEqual(body.tools.map((tool) => tool.function.name), expectedNames);
    assert.ok(body.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("older conversation")));
    assert.ok(!JSON.stringify(body.messages).includes("Old read_local_note prompt"));
    const first = ++requests === 1;
    if (!first) assert.ok(body.messages.some((message) => message.role === "tool" && JSON.stringify(message.content).includes("updated")));
    return stream(settings.model, first);
  },
});
const events = [];
agent.agent.subscribe((event) => { events.push(event.type === "message_update" ? event.assistantMessageEvent.type : event.type); });
await agent.send("Read result.txt");
assert.equal(requests, 2);
assert.ok(events.includes("thinking_delta"));
assert.ok(events.includes("tool_execution_start") && events.includes("tool_execution_end"));
const transcript = toThreadMessages(agent.agent.state.messages, undefined, false);
assert.ok(transcript.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "reasoning")));
assert.ok(transcript.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "tool-call" && String(part.result).includes("updated"))));
assert.match(JSON.stringify(transcript.at(-1)), /done with the file/);

const cancelled = createLocalAgent({
  settings,
  fetch: async (_url, request) => new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException("Stopped", "AbortError"));
    if (request.signal.aborted) abort();
    else request.signal.addEventListener("abort", abort, { once: true });
  }),
});
const active = cancelled.send("wait");
cancelled.agent.abort();
await active;
assert.equal(cancelled.agent.state.isStreaming, false);
console.log("Seven workspace tools, persisted Bash I/O and gzip, attachments, restored transcript tools, streamed reasoning/tool/text, and cancellation passed.");
