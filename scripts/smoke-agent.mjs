import assert from "node:assert/strict";
import { build } from "esbuild";

const { outputFiles } = await build({
  entryPoints: ["src/agent.ts", "src/chat-messages.ts"],
  outdir: "dist",
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2017",
  write: false,
});

function load(name) {
  const output = outputFiles.find((file) => file.path.endsWith(name));
  return import("data:text/javascript;base64," + Buffer.from(output.contents).toString("base64"));
}

const { createLocalAgent } = await load("agent.js");
const { toThreadMessages } = await load("chat-messages.js");

const readLocalNote = async () => "Lyra Mobile\n下一步：连接你自己的模型。";
const demo = createLocalAgent({ settings: null, readLocalNote });
const demoEvents = [];
demo.agent.subscribe((event) => { demoEvents.push(event.type); });
await demo.send("读取示例笔记");
assert.ok(demoEvents.includes("message_update"));
assert.ok(demoEvents.includes("tool_execution_end"));
const transcript = toThreadMessages(demo.agent.state.messages, undefined, false);
assert.ok(transcript.some((message) => Array.isArray(message.content) &&
  message.content.some((part) => part.type === "tool-call" && String(part.result).includes("Lyra Mobile"))));
assert.match(demo.agent.state.messages.at(-1).content[0].text, /连接你自己的模型/);

const reopened = createLocalAgent({ settings: null, readLocalNote, messages: JSON.parse(JSON.stringify(demo.agent.state.messages)) });
assert.equal(JSON.stringify(reopened.agent.state.messages), JSON.stringify(demo.agent.state.messages));

let requests = 0;
const remote = createLocalAgent({
  settings: { endpoint: "https://lyra.example.invalid/v1", model: "mock-model", apiKey: "test-only" },
  readLocalNote,
  async fetch(input, init) {
    assert.equal(String(input), "https://lyra.example.invalid/v1/chat/completions");
    const body = JSON.parse(init.body);
    assert.equal(body.stream, true);
    assert.equal(body.model, "mock-model");
    const first = ++requests === 1;
    if (!first) {
      assert.ok(body.messages.some((message) => message.role === "tool" && JSON.stringify(message.content).includes("Lyra Mobile")));
    }
    const delta = first
      ? { role: "assistant", tool_calls: [{ index: 0, id: "call_note", type: "function", function: { name: "read_local_note", arguments: "{}" } }] }
      : { role: "assistant", content: "已执行本地工具。" };
    const chunk = (delta, finish_reason) => "data: " + JSON.stringify({
      id: "test", object: "chat.completion.chunk", created: 1, model: "mock-model",
      choices: [{ index: 0, delta, finish_reason }],
    }) + "\n\n";
    return new Response(chunk(delta, null) + chunk({}, first ? "tool_calls" : "stop") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
  },
});
await remote.send("读取示例笔记");
assert.equal(requests, 2);
assert.equal(remote.agent.state.messages.at(-1).content[0].text, "已执行本地工具。");

const cancelled = createLocalAgent({ settings: null, readLocalNote });
const run = cancelled.send("读取示例笔记");
cancelled.agent.abort();
await run;
assert.equal(cancelled.agent.state.isStreaming, false);
console.log("Pi demo, transcript restoration, local tool card, mocked model stream, and cancellation passed.");
