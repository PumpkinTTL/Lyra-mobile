import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { decodeFile, encodeFile, relativePath, type WorkspaceIO } from "./device-workspace";
import { assertActive, runWorkspaceShell } from "./workspace-shell";

type Field = Record<string, unknown>;
const str = (description: string) => ({ type: "string", description });
const num = (description: string, maximum: number) => ({ type: "integer", minimum: 1, maximum, description });
const flag = (description: string) => ({ type: "boolean", description });
const pathField = str("A path relative to the worktree root /workspace.");
const imageTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_TEXT = 54_000;
const MAX_READ = 6 * 1024 * 1024;

function answer(text: string): AgentToolResult {
  return { content: [{ type: "text", text }], details: {} };
}

function define(
  name: string,
  label: string,
  description: string,
  properties: Record<string, Field>,
  required: string[],
  execute: AgentTool<any>["execute"],
): AgentTool {
  return { name, label, description, parameters: { type: "object", properties, required, additionalProperties: false }, execute };
}

function matchGlob(glob: string) {
  let re = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        index++;
        if (glob[index + 1] === "/") { re += "(?:.*/)?"; index++; }
        else re += ".*";
      } else re += "[^/]*";
    } else if (char === "?") re += "[^/]";
    else re += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  const pattern = new RegExp("^" + re + "$");
  return (path: string) => pattern.test(path) || (!glob.includes("/") && pattern.test(path.split("/").pop() ?? ""));
}

export const toolLabels: Record<string, string> = {
  read: "读取文件", write: "写入文件", edit: "编辑文件", grep: "搜索内容", find: "查找文件", ls: "查看目录",
  bash: "执行 Bash", read_local_note: "读取本地笔记",
};

export function createWorkspaceTools(io: WorkspaceIO): AgentTool[] {
  return [
    define("read", toolLabels.read, "Read a UTF-8 text file by optional line range, or return a supported image from the current workspace.", {
      path: pathField, offset: num("First line, 1-based.", 1_000_000), limit: num("Maximum lines to return.", 500),
    }, ["path"], async (_id, { path, offset = 1, limit = 200 }, signal) => {
      assertActive(signal);
      const file = await io.read(relativePath(path), MAX_READ);
      if (imageTypes.has(file.mime)) {
        if (file.truncated) throw new Error("图片过大，无法送入模型。");
        return { content: [{ type: "image", data: file.base64, mimeType: file.mime }], details: { path } };
      }
      const lines = decodeFile(file.base64).split(/\r?\n/);
      const selected = lines.slice(offset - 1, offset - 1 + limit).join("\n");
      if (offset > lines.length) return answer("起始行超出文件范围。");
      const cropped = selected.length > MAX_TEXT;
      return answer(selected.slice(0, MAX_TEXT) + (cropped || file.truncated || offset - 1 + limit < lines.length ? "\n[输出已截断，可用 offset 分段读取。]" : ""));
    }),
    define("write", toolLabels.write, "Create or overwrite a UTF-8 file inside the current workspace. Creates parent folders.", {
      path: pathField, content: str("New complete file contents."),
    }, ["path", "content"], async (_id, { path, content }, signal) => {
      assertActive(signal);
      const normalized = relativePath(path);
      const bytes = encodeFile(content);
      await io.write(normalized, bytes);
      return answer("已写入 " + normalized + "（" + new TextEncoder().encode(content).length + " 字节）。");
    }),
    define("edit", toolLabels.edit, "Replace one or more exact, unique text occurrences in the selected file. Each oldText must have exactly one match.", {
      path: pathField, oldText: str("Exact text to replace."), newText: str("Replacement text."),
      edits: { type: "array", minItems: 1, items: { type: "object", properties: { oldText: str("Exact text."), newText: str("Replacement.") }, required: ["oldText", "newText"], additionalProperties: false } },
    }, ["path"], async (_id, { path, edits, oldText, newText }, signal) => {
      assertActive(signal);
      const normalized = relativePath(path);
      const file = await io.read(normalized, MAX_READ);
      if (file.truncated) throw new Error("文件太大，无法执行完整替换。");
      const replacements: { oldText: string; newText: string }[] = edits ?? (typeof oldText === "string" && typeof newText === "string" ? [{ oldText, newText }] : []);
      if (!replacements.length) throw new Error("请提供 edits，或同时提供 oldText 和 newText。");
      let text = decodeFile(file.base64);
      for (const replacement of replacements) {
        if (!replacement.oldText) throw new Error("oldText 不能为空。");
        const start = text.indexOf(replacement.oldText);
        if (start === -1 || text.indexOf(replacement.oldText, start + 1) !== -1) throw new Error("oldText 未匹配或存在多处匹配，请提供唯一上下文。");
        text = text.slice(0, start) + replacement.newText + text.slice(start + replacement.oldText.length);
      }
      assertActive(signal);
      await io.write(normalized, encodeFile(text));
      return answer("已更新 " + normalized + "（" + replacements.length + " 处）。");
    }),
    define("ls", toolLabels.ls, "List files and folders directly under a directory in the workspace.", {
      path: pathField, limit: num("Maximum entries.", 1000),
    }, [], async (_id, { path = ".", limit = 100 }, signal) => {
      assertActive(signal);
      const result = await io.list(relativePath(path), false, limit);
      const text = result.entries.map((entry) => entry.path + (entry.directory ? "/" : "")).join("\n");
      return answer((text || "目录为空。") + (result.truncated ? "\n[结果已截断。]" : ""));
    }),
    define("find", toolLabels.find, "Find file and folder paths in the workspace by glob pattern, such as **/*.ts.", {
      pattern: str("Glob pattern."), path: pathField, limit: num("Maximum matches.", 1000),
    }, ["pattern"], async (_id, { path = ".", pattern, limit = 100 }, signal) => {
      assertActive(signal);
      const root = relativePath(path);
      const result = await io.list(root, true, 4096);
      const matches = matchGlob(pattern);
      const list = result.entries.filter((entry) => matches(root ? entry.path.slice(root.length + 1) : entry.path));
      return answer(list.slice(0, limit).map((entry) => entry.path + (entry.directory ? "/" : "")).join("\n") +
        (list.length > limit || result.truncated ? "\n[搜索结果已截断。]" : "") || "未找到匹配路径。");
    }),
    define("grep", toolLabels.grep, "Search UTF-8 file contents in a directory or a particular file, by regex or literal text.", {
      pattern: str("Regular expression or literal search text."), path: pathField, glob: str("Optional file glob filter."),
      ignoreCase: flag("Ignore case."), literal: flag("Treat the pattern as text."), limit: num("Maximum matching lines.", 300),
    }, ["pattern"], async (_id, { path = ".", pattern, glob, ignoreCase = false, literal = false, limit = 100 }, signal, onUpdate) => {
      const root = relativePath(path);
      const expression = literal ? pattern.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&") : pattern;
      const reg = new RegExp(expression, ignoreCase ? "i" : "");
      const filter = matchGlob(glob || "**");
      let list;
      try {
        list = await io.list(root, true, 4096);
      } catch (error) {
        if (!root) throw error;
        list = { entries: [{ path: root, directory: false, size: 0 }], truncated: false };
      }
      const result: string[] = [];
      let searched = 0;
      for (const file of list.entries) {
        assertActive(signal);
        if (file.directory || !filter(file.path) || file.size > MAX_READ) continue;
        let text: string;
        try {
          const source = await io.read(file.path, MAX_READ);
          if (source.truncated) continue;
          text = decodeFile(source.base64);
        } catch (error) {
          if (list.entries.length === 1) throw error;
          continue;
        }
        if (++searched % 40 === 0) onUpdate?.(answer("已搜索 " + searched + " 个文本文件。"));
        const lines = text.split(/\r?\n/);
        for (const [index, line] of lines.entries()) {
          if (!reg.test(line)) continue;
          result.push(file.path + ":" + (index + 1) + ": " + line.slice(0, 600));
          if (result.length >= limit) return answer(result.join("\n") + "\n[已达到匹配数上限。]");
        }
      }
      return answer((result.join("\n") || "未找到匹配内容。") + (list.truncated ? "\n[部分目录未扫描。]" : ""));
    }),
    define("bash", toolLabels.bash, "Run Bash commands in an on-device virtual shell backed by the current workspace. Files changed under /workspace are persisted. Supports shell pipelines and built-in utilities.", {
      command: str("Bash command or script."), cwd: pathField, timeout: num("Timeout in seconds.", 60),
    }, ["command"], async (_id, input, signal, onUpdate) => {
      const result = await runWorkspaceShell(io, input, signal, (text) => onUpdate?.(answer(text)));
      const output = [result.stdout.trimEnd(), result.stderr.trimEnd(), "退出码 " + result.exitCode].filter(Boolean).join("\n");
      return answer(output.slice(0, MAX_TEXT));
    }),
  ];
}
