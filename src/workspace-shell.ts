import { Bash, InMemoryFs } from "./pi-runtime";
import { base64FromBytes, bytesFromBase64, relativePath, type WorkspaceIO } from "./device-workspace";

const root = "/workspace";
const bytesLimit = 16 * 1024 * 1024;
const fileLimit = 1400;

type ShellInput = { command: string; timeout?: number; cwd?: string };

function isBelowRoot(path: string) { return path.startsWith(root + "/"); }

export function assertActive(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("工具调用已停止。");
}

export async function runWorkspaceShell(io: WorkspaceIO, input: ShellInput, signal?: AbortSignal, update?: (text: string) => void) {
  assertActive(signal);
  const listing = await io.list("", true, fileLimit);
  const bytes = listing.entries.reduce((size, entry) => size + entry.size, 0);
  if (listing.truncated || bytes > bytesLimit) {
    throw new Error("工作区快照超过 Bash 的内存范围（1400 项或 16 MB）。可以用 read、edit、grep 直接操作文件。");
  }
  const initial = new Map<string, string | null>();
  const fs = new InMemoryFs({}, { maxTotalBytes: bytesLimit + 1024 * 1024 });
  await fs.mkdir(root, { recursive: true });
  for (const entry of listing.entries) {
    assertActive(signal);
    const path = root + "/" + relativePath(entry.path);
    if (entry.directory) {
      await fs.mkdir(path, { recursive: true });
      initial.set(path, null);
    } else {
      const file = await io.read(entry.path, bytesLimit);
      if (file.truncated) throw new Error("工作区文件超过 Bash 的加载范围。");
      await fs.writeFile(path, bytesFromBase64(file.base64));
      initial.set(path, file.base64);
    }
  }

  const cwd = relativePath(input.cwd);
  const bash = new Bash({ fs, cwd: root, executionLimitProfile: "hardened",
    executionLimits: { maxCommandCount: 4500, maxLoopIterations: 5000, maxOutputSize: 60_000 } });
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  signal?.addEventListener("abort", cancel);
  const timeout = Math.min(60, Math.max(1, input.timeout ?? 25));
  const timer = setTimeout(cancel, timeout * 1000);
  try {
    assertActive(signal);
    update?.("正在执行工作区命令…");
    const result = await bash.exec(input.command, { cwd: cwd ? root + "/" + cwd : root, signal: cancellation.signal, rawScript: true });
    if (cancellation.signal.aborted) throw new Error(signal?.aborted ? "命令已停止。" : "命令执行超时。");

    const changes = new Map<string, string | null>();
    for (const path of fs.getAllPaths().filter(isBelowRoot)) {
      const stat = await fs.lstat(path);
      if (stat.isSymbolicLink) throw new Error("当前工作区无法保存符号链接。");
      if (stat.isDirectory) changes.set(path, null);
      else if (stat.isFile) changes.set(path, base64FromBytes(await fs.readFileBuffer(path)));
    }
    assertActive(signal);
    update?.("正在保存命令修改的文件…");
    const removals = [...initial.keys()].filter((path) => (
      !changes.has(path) || (initial.get(path) === null) !== (changes.get(path) === null)
    ));
    for (const path of removals.sort((first, second) => second.length - first.length)) await io.remove(relativePath(path));
    for (const [path, data] of changes) {
      if (initial.get(path) === data) continue;
      if (data === null) await io.mkdir(relativePath(path));
      else await io.write(relativePath(path), data);
    }
    return result;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
