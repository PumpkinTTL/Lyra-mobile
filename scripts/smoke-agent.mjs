import assert from "node:assert/strict";
import { mkdir as mkdirArtifact, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { unzipSync } from "fflate";

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
const { toThreadMessages, toolFailed } = await load("chat-messages.js");
const { createWorkspaceTools } = await load("workspace-tools.js");
const { prepareUserMessage } = await load("chat-attachments.js");
const tools = createWorkspaceTools(io);
const expectedNames = ["read", "write", "edit", "ls", "find", "grep", "bash", "office_inspect", "office_create", "office_edit", "archive_create", "artifact_show"];
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
const failedCommand = await run("bash", { command: "exit 7" });
assert.equal(failedCommand.details.exitCode, 7);
assert.equal(toolFailed(false, failedCommand.details), true);
assert.equal(toolFailed(false, zip.details), false);

const office = [
  { path: "office/brief.docx", title: "移动端文档", blocks: [{ kind: "heading", text: "工作进度", level: 2 },
    { kind: "paragraph", text: "原始段落" }, { kind: "bullet", text: "保留的第二段" }, { kind: "table", rows: [["任务", "状态"], ["交付", "完成"]] }] },
  { path: "office/report.xlsx", title: "表格", sheets: [{ name: "进度", header: true, rows: [["已完成", "待办", "合计"], [2, 1, { formula: "SUM(A2:B2)", result: 3 }]] }] },
  { path: "office/deck.pptx", title: "移动端演示", slides: [{ title: "开始", bullets: ["可编辑幻灯片"] }, { title: "第二页", bullets: ["保留其他内容"], table: [["项目", "完成"], ["工具", "已验证"]] }] },
];
for (const file of office) {
  const result = await run("office_create", file);
  assert.equal(result.details.artifacts[0].path, file.path);
  const raw = Buffer.from(entries.get(file.path), "base64");
  assert.equal(raw.subarray(0, 2).toString(), "PK");
  assert.ok(unzipSync(raw)["[Content_Types].xml"]);
}
await run("office_edit", { path: office[0].path, replacements: [{ oldText: "原始段落", newText: "修改后的段落" }] });
await run("office_edit", { path: office[1].path, cells: [{ sheet: "进度", cell: "A2", value: 3 }, { sheet: "进度", cell: "C3", value: "补充" }, { sheet: "进度", cell: "AD105", value: { formula: "SUM(A2:B2)", result: 4 } }] });
await run("office_edit", { path: office[2].path, replacements: [{ oldText: "可编辑幻灯片", newText: "真正的 PowerPoint" }] });
assert.match(output(await run("read", { path: office[0].path })), /修改后的段落[\s\S]*保留的第二段/);
assert.match(output(await run("read", { path: office[1].path })), /3\t1[\s\S]*补充/);
assert.match(output(await run("read", { path: office[2].path })), /真正的 PowerPoint[\s\S]*第二页/);
assert.match(output(await run("office_inspect", { path: office[1].path, section: "进度", offset: 105, firstColumn: 30, limit: 1, columns: 1 })), /105\t=SUM\(A2:B2\) → 4/);
assert.match(output(await run("office_inspect", { path: office[2].path, section: "2" })), /已验证/);
const copied = await run("office_edit", { path: office[0].path, outputPath: "office/copy.docx", replacements: [{ oldText: "修改后的段落", newText: "副本修改" }] });
assert.equal(copied.details.artifacts[0].path, "office/copy.docx");
assert.match(output(await run("read", { path: office[0].path })), /修改后的段落/);
assert.match(output(await run("read", { path: "office/copy.docx" })), /副本修改/);
await run("archive_create", { path: "office/bundle.zip", files: office.map(({ path }) => path) });
assert.deepEqual(Object.keys(unzipSync(Buffer.from(entries.get("office/bundle.zip"), "base64"))), office.map(({ path }) => path));
if (process.env.LYRA_OFFICE_FIXTURES) {
  const dir = process.env.LYRA_OFFICE_FIXTURES;
  await mkdirArtifact(dir, { recursive: true });
  for (const { path } of office) await writeFile(join(dir, path.split("/").pop()), Buffer.from(entries.get(path), "base64"));
}

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
let executingStatus;
agent.agent.subscribe((event) => {
  events.push(event.type === "message_update" ? event.assistantMessageEvent.type : event.type);
  if (event.type === "tool_execution_start") executingStatus = toThreadMessages(agent.agent.state.messages, undefined, true).at(-1).status.type;
});
await agent.send("Read result.txt");
assert.equal(requests, 2);
assert.ok(events.includes("thinking_delta"));
assert.ok(events.includes("tool_execution_start") && events.includes("tool_execution_end"));
assert.equal(executingStatus, "running");
const agentMessages = agent.agent.state.messages;
const transcript = toThreadMessages(agentMessages, undefined, false);
const assistantTurns = transcript.filter((message) => message.role === "assistant");
assert.equal(assistantTurns.length, 1);
const [turn] = assistantTurns;
assert.deepEqual(turn.content.map((part) => part.type), ["reasoning", "tool-call", "text"]);
assert.match(String(turn.content[1].result), /updated/);
assert.match(turn.content[2].text, /done with the file/);
const streamingTurn = toThreadMessages(agentMessages.slice(0, -1), agentMessages.at(-1), true).at(-1);
assert.equal(streamingTurn.id, turn.id);
assert.equal(streamingTurn.status.type, "running");

let summaries = 0;
let compactedRequests = 0;
const compaction = createLocalAgent({
  settings: { ...settings, options: { contextWindow: 4096, maxTokens: 512 } }, tools,
  messages: [{ role: "user", content: "早期原文。".repeat(1300), timestamp: 1 }],
  async fetch(_input, init) {
    const request = JSON.parse(init.body);
    if (!(request.tools?.length)) summaries++;
    else {
      compactedRequests++;
      assert.equal(request.tools.length, expectedNames.length);
      assert.match(JSON.stringify(request.messages), /早期内容的摘要/);
      assert.match(JSON.stringify(request.messages), /最新的问题/);
      assert.ok(!JSON.stringify(request.messages).includes("早期原文。".repeat(1300)));
    }
    return stream(settings.model, false);
  },
});
await compaction.send("最新的问题");
assert.equal(summaries, 1);
assert.equal(compactedRequests, 1);
assert.ok(compaction.agent.state.messages.some((message) => message.role === "user" && message.content === "早期原文。".repeat(1300)));

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
console.log("Workspace tools, Bash and gzip, editable Office and ZIP files, attachments, restored tools, streaming and cancellation passed.");
