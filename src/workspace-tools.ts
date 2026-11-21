import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { base64FromBytes, bytesFromBase64, decodeFile, encodeFile, relativePath, type WorkspaceArtifact, type WorkspaceIO } from "./device-workspace";
import { createOffice, editOffice, officeKind, readOffice, type OfficeData, type OfficeEdits } from "./office";
import { zipSync, type Zippable } from "fflate";
import { assertActive, runWorkspaceShell } from "./workspace-shell";

type Field = Record<string, unknown>;
const str = (description: string) => ({ type: "string", description });
const num = (description: string, maximum: number) => ({ type: "integer", minimum: 1, maximum, description });
const flag = (description: string) => ({ type: "boolean", description });
const pathField = str("A path relative to the worktree root /workspace.");
const officeCell = { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" },
  { type: "object", properties: { formula: str("Excel formula, e.g. SUM(B2:B12)"), result: { type: "number" } }, required: ["formula"], additionalProperties: false }] };
const textTable = (rows: number, columns: number) => ({ type: "array", minItems: 1, maxItems: rows,
  items: { type: "array", minItems: 1, maxItems: columns, items: str("Cell text") } });
const imageTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_TEXT = 54_000;
const MAX_READ = 6 * 1024 * 1024;
const MAX_OFFICE = 16 * 1024 * 1024;

function answer(text: string, paths: string[] = [], projectId?: string): AgentToolResult<{ artifacts?: WorkspaceArtifact[] }> {
  return { content: [{ type: "text", text }], details: paths.length ? { artifacts: paths.map((path) => projectId ? { path, projectId } : { path }) } : {} };
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
  office_create: "生成 Office 文档", office_edit: "编辑 Office 文档", office_inspect: "读取 Office 内容", archive_create: "生成 ZIP 压缩包", artifact_show: "提供文件产物", ssh_exec: "服务器命令",
};

export function createWorkspaceTools(io: WorkspaceIO, projectId?: string): AgentTool[] {
  const artifact = (text: string, ...paths: string[]) => answer(text, paths, projectId);
  return [
    define("read", toolLabels.read, "Read text, an image or a quick Office preview. For Office ranges, large files, specific worksheets or slides, use office_inspect.", {
      path: pathField, offset: num("First line, 1-based.", 1_000_000), limit: num("Maximum lines to return.", 500),
    }, ["path"], async (_id, { path, offset = 1, limit = 200 }, signal) => {
      assertActive(signal);
      const file = await io.read(relativePath(path), MAX_READ);
      const office = officeKind(path);
      if (office) {
        if (file.truncated) throw new Error("Office 文件超过内置读取上限，可以通过产物打开。");
        const sections = readOffice(office, bytesFromBase64(file.base64));
        const lines = sections.flatMap((section) => [section.title, ...section.lines]);
        const preview = lines.slice(offset - 1, offset - 1 + limit).join("\n").slice(0, MAX_TEXT);
        return artifact((preview || "此预览范围内没有提取到文本。") + "\n[用 office_inspect 按工作表、幻灯片或段落读取详情。]", relativePath(path));
      }
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
      return artifact("已写入 " + normalized + "（" + new TextEncoder().encode(content).length + " 字节）。", normalized);
    }),
    define("edit", toolLabels.edit, "Replace one or more exact, unique text occurrences in the selected file. Each oldText must have exactly one match.", {
      path: pathField, oldText: str("Exact text to replace."), newText: str("Replacement text."),
      edits: { type: "array", minItems: 1, items: { type: "object", properties: { oldText: str("Exact text."), newText: str("Replacement.") }, required: ["oldText", "newText"], additionalProperties: false } },
    }, ["path"], async (_id, { path, edits, oldText, newText }, signal, onUpdate) => {
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
      onUpdate?.(answer("正在保存 " + normalized));
      await io.write(normalized, encodeFile(text));
      return artifact("已更新 " + normalized + "（" + replacements.length + " 处）。", normalized);
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
      const response = artifact(output.slice(0, MAX_TEXT), ...result.changedFiles.slice(0, 12));
      return { ...response, details: { ...response.details, exitCode: result.exitCode } };
    }),
    define("office_inspect", toolLabels.office_inspect, "Read a local DOCX by paragraph, XLSX by exact sheet and a range of Excel row/column numbers with formulas, or PPTX by slide number. Omit section to see the beginning of each sheet or slide.", {
      path: pathField, section: str("Exact XLSX worksheet name or 1-based PPTX slide number as a string"),
      offset: num("1-based start: Word paragraphs, Excel physical rows, or slide text blocks", 1_048_576),
      limit: num("Count per section, defaults to 20", 200), firstColumn: num("First Excel column, A=1", 16384),
      columns: num("Excel column count, defaults to 16", 64),
    }, ["path"], async (_id, { path, section, offset, limit = 20, firstColumn, columns = 16 }, signal) => {
      const source = relativePath(path);
      const kind = officeKind(source);
      if (!kind) throw new Error("可读取的 Office 文件格式为 DOCX、XLSX、PPTX。");
      const file = await io.read(source, MAX_OFFICE);
      assertActive(signal);
      if (file.truncated) throw new Error("Office 文件超过 16 MB，无法在本机提取内容。");
      const sections = readOffice(kind, bytesFromBase64(file.base64), 60, { section, offset: offset ?? 1, limit, firstColumn, columns, formulas: true });
      const text = sections.map(({ title, lines }) => `【${title}】\n${lines.join("\n") || "此范围无可读取内容。"}`).join("\n\n");
      return artifact(text.slice(0, MAX_TEXT) + (text.length > MAX_TEXT ? "\n[返回内容已截断，请缩小范围。]" : ""), source);
    }),
    define("office_create", toolLabels.office_create, "Generate editable .docx, .xlsx or .pptx locally. DOCX supports headings, lists and tables; XLSX supports formulas and filterable headers; PPTX supports editable tables and notes.", {
      path: pathField, title: str("Document title."),
      paragraphs: { type: "array", items: str("A paragraph"), maxItems: 4000 },
      blocks: { type: "array", maxItems: 4000, items: { anyOf: [
        { type: "object", properties: { kind: { type: "string", enum: ["heading", "paragraph", "bullet"] }, text: str("Paragraph text"), level: num("Heading level", 3) },
          required: ["kind", "text"], additionalProperties: false },
        { type: "object", properties: { kind: { type: "string", enum: ["table"] }, rows: textTable(200, 16) }, required: ["kind", "rows"], additionalProperties: false },
      ] } },
      sheets: { type: "array", maxItems: 24, items: { type: "object", properties: { name: str("Unique sheet name"), header: flag("Freeze and filter the first row"), rows: {
        type: "array", items: { type: "array", maxItems: 128, items: officeCell },
      } }, required: ["name", "rows"], additionalProperties: false } },
      slides: { type: "array", maxItems: 60, items: { type: "object", properties: { title: str("Slide title"),
        bullets: { type: "array", items: str("A bullet"), maxItems: 14 }, notes: str("Optional speaker notes"), table: textTable(8, 6) }, required: ["title", "bullets"], additionalProperties: false } },
    }, ["path", "title"], async (_id, input: OfficeData & { path: string }, signal, onUpdate) => {
      const path = relativePath(input.path);
      const extension = officeKind(path);
      if (!extension) throw new Error("文件名必须以 .docx、.xlsx 或 .pptx 结尾。");
      assertActive(signal);
      onUpdate?.(answer("正在生成 " + path));
      const bytes = await createOffice(extension, input);
      assertActive(signal);
      await io.write(path, base64FromBytes(bytes));
      return artifact(`已生成 ${path}（${bytes.length} 字节，可在聊天中预览或保存）。`, path);
    }),
    define("office_edit", toolLabels.office_edit, "Edit existing .docx/.pptx text using unique exact replacements, or change addressed .xlsx cells. Preserves the original file's layout and unrelated parts.", {
      path: pathField, outputPath: str("Optional separate output path with the same extension to preserve the input file"), replacements: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", properties: {
        oldText: str("Unique old text within a paragraph"), newText: str("Replacement"),
      }, required: ["oldText", "newText"], additionalProperties: false } },
      cells: { type: "array", minItems: 1, maxItems: 200, items: { type: "object", properties: {
        sheet: str("Sheet name, defaults to the first sheet"), cell: str("Cell reference such as B7"), value: officeCell,
      }, required: ["cell", "value"], additionalProperties: false } },
    }, ["path"], async (_id, input: OfficeEdits & { path: string; outputPath?: string }, signal, onUpdate) => {
      const path = relativePath(input.path);
      const extension = officeKind(path);
      if (!extension) throw new Error("文件名必须以 .docx、.xlsx 或 .pptx 结尾。");
      const destination = input.outputPath ? relativePath(input.outputPath) : path;
      if (officeKind(destination) !== extension) throw new Error("输出文件必须与源文件使用相同的 Office 格式。");
      const file = await io.read(path, MAX_OFFICE);
      if (file.truncated) throw new Error("Office 文件太大，无法原地编辑。");
      assertActive(signal);
      onUpdate?.(answer("正在更新 " + path));
      const result = editOffice(extension, bytesFromBase64(file.base64), input);
      assertActive(signal);
      await io.write(destination, base64FromBytes(result.bytes));
      return artifact(`已更新 ${destination}（${result.edits} 处）。`, destination);
    }),
    define("archive_create", toolLabels.archive_create, "Create a standard ZIP archive from selected files in this workspace.", {
      path: pathField, files: { type: "array", minItems: 1, maxItems: 200, items: pathField },
    }, ["path", "files"], async (_id, input: { path: string; files: string[] }, signal, onUpdate) => {
      const path = relativePath(input.path);
      if (!/\.zip$/i.test(path)) throw new Error("压缩文件名必须以 .zip 结尾。");
      const entries: Zippable = Object.create(null);
      let budget = 15 * 1024 * 1024;
      for (const filePath of new Set(input.files.map(relativePath))) {
        assertActive(signal);
        if (!filePath || path === filePath) throw new Error("只能压缩其他文件，不能包含压缩包自身。");
        const file = await io.read(filePath, budget + 1);
        const bytes = bytesFromBase64(file.base64);
        if (file.truncated || bytes.length > budget) throw new Error("所选文件超过 ZIP 输入上限。");
        entries[filePath] = bytes;
        budget -= bytes.length;
      }
      onUpdate?.(answer("正在打包 " + path));
      const bytes = zipSync(entries, { level: 6 });
      assertActive(signal);
      await io.write(path, base64FromBytes(bytes));
      return artifact(`已生成 ${path}（${bytes.length} 字节）。`, path);
    }),
    define("artifact_show", toolLabels.artifact_show, "Offer an existing workspace file in the chat with preview, native sharing, and saving.", {
      path: pathField,
    }, ["path"], async (_id, { path }, signal) => {
      const file = relativePath(path);
      assertActive(signal);
      await io.read(file, 1);
      return artifact("文件已提供：" + file, file);
    }),
  ];
}
