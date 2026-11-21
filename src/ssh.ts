import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { SshAuth, SshConnection } from "@osuki-dev/react-native-ssh";
import { Alert } from "react-native";
import * as Keychain from "react-native-keychain";

export type SshProfile = {
  host: string; port: number; username: string; fingerprint: string;
  auth: Extract<SshAuth, { type: "password" | "privateKey" }>;
};

const service = "com.lyramobile.ssh";

export function normalizeSshProfile(profile: SshProfile): SshProfile {
  const host = profile.host.trim().replace(/^\[([0-9a-f:.]+)\]$/i, "$1");
  const username = profile.username.trim();
  const fingerprint = profile.fingerprint.trim().replace(/=+$/, "");
  if (!/^[a-z0-9._-]+$/i.test(host) && !/^[0-9a-f:.]+:[0-9a-f:.]+$/i.test(host)) throw new Error("请填写服务器域名或 IP 地址。");
  if (!username || /[\s\u0000-\u001f]/.test(username)) throw new Error("请填写有效的 SSH 用户名。");
  if (!Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535) throw new Error("端口必须在 1 到 65535 之间。");
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint)) throw new Error("请输入服务器的 SHA256 主机公钥指纹。");
  if (profile.auth.type === "password" ? !profile.auth.password : !profile.auth.privateKey.trim()) throw new Error("请输入密码或私钥。");
  return { ...profile, host, username, fingerprint };
}

export async function loadSshProfile(): Promise<SshProfile | null> {
  const saved = await Keychain.getGenericPassword({ service });
  return saved ? normalizeSshProfile(JSON.parse(saved.password) as SshProfile) : null;
}

export async function saveSshProfile(profile: SshProfile) {
  const validated = normalizeSshProfile(profile);
  if (!await Keychain.setGenericPassword("lyra-ssh", JSON.stringify(validated), { service })) {
    throw new Error("无法把 SSH 配置写入系统钥匙串。");
  }
  return sshTarget(validated);
}

function sshTarget(profile: SshProfile) { return JSON.stringify([profile.host.toLowerCase(), profile.port, profile.username, profile.fingerprint]); }

async function connectProfile(profile: SshProfile, signal: AbortSignal) {
  const { connect } = await import("@osuki-dev/react-native-ssh");
  let observed: string | undefined;
  try {
    return await connect({ host: profile.host, port: profile.port, username: profile.username, auth: profile.auth,
      connectTimeoutMs: 15_000, signal, verifyHostKey: (key) => {
        observed = key.fingerprint;
        return key.fingerprint.replace(/=+$/, "") === profile.fingerprint;
      } });
  } catch (error) {
    if (observed && observed.replace(/=+$/, "") !== profile.fingerprint) throw new Error(`服务器主机指纹与配置不一致。服务器返回 ${observed}`);
    throw error;
  }
}

export async function testSsh(profile: SshProfile) {
  const connection = await connectProfile(normalizeSshProfile(profile), new AbortController().signal);
  await connection.disconnect();
}

type SshOutput = { stdout: string; stderr: string; exitCode: number | undefined };
const maxOutput = 48 * 1024;

function approve(profile: SshProfile, command: string, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(false); return; }
    function finish(value: boolean) {
      signal.removeEventListener("abort", cancel);
      resolve(value);
    }
    const cancel = () => finish(false);
    signal.addEventListener("abort", cancel, { once: true });
    Alert.alert("在服务器执行命令？", `${profile.username}@${profile.host}:${profile.port}\n\n${command}`, [
      { text: "拒绝", style: "cancel", onPress: () => finish(false) },
      { text: "执行", onPress: () => finish(true) },
    ], { cancelable: true, onDismiss: cancel });
  });
}

function runRemote(connection: SshConnection, command: string, signal: AbortSignal, progress: (text: string) => void): Promise<SshOutput> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let total = 0;
    let last = 0;
    let settled = false;
    const out = new TextDecoder();
    const err = new TextDecoder();
    function finish(error?: Error, exitCode?: number) {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", cancel);
      if (error) reject(error);
      else resolve({ stdout: stdout + out.decode(), stderr: stderr + err.decode(), exitCode });
    }
    const cancel = () => finish(new Error("SSH 操作已取消或超时。"));
    if (signal.aborted) { cancel(); return; }
    signal.addEventListener("abort", cancel, { once: true });
    function append(buffer: ArrayBuffer, isError: boolean) {
      if (settled) return;
      const available = Math.max(0, maxOutput - total);
      const received = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, available));
      total += received.length;
      const text = (isError ? err : out).decode(received, { stream: true });
      if (isError) stderr += text;
      else stdout += text;
      if (Date.now() - last > 280 && text) { progress((stderr || stdout).slice(-1000)); last = Date.now(); }
      if (available < buffer.byteLength && !stdout.endsWith("\n[SSH 输出已截断]")) stdout += "\n[SSH 输出已截断]";
    }
    connection.openShell({ term: "", command }, {
      onData: (buffer) => append(buffer, false), onStderr: (buffer) => append(buffer, true), onClosed: (code) => finish(undefined, code),
    }).then((channel) => { if (settled) void channel.close().catch(() => {}); }).catch((error: unknown) => {
      finish(error instanceof Error ? error : new Error("无法启动 SSH 命令。"));
    });
  });
}

export function createSshTool(target: string): AgentTool<any> {
  return {
    name: "ssh_exec", label: "服务器命令",
    replay: "never",
    description: "Run one command on the SSH server that the user selected in this conversation. Only use when explicitly asked to operate on that server. The app asks the user to approve each command. Returns stdout, stderr and exit code.",
    parameters: { type: "object", properties: { command: { type: "string", minLength: 1, maxLength: 2000 },
      timeout: { type: "integer", minimum: 1, maximum: 120 } }, required: ["command"], additionalProperties: false },
    async execute(_call, input: { command: string; timeout?: number }, parent, update) {
      const profile = await loadSshProfile();
      if (!profile) throw new Error("请在设置中配置 SSH 服务器。");
      if (sshTarget(profile) !== target) throw new Error("SSH 服务器配置已变更，请在当前对话重新启用。");
      const command = input.command.trim();
      if (!command || command.length > 2000 || command.includes("\0")) throw new Error("SSH 命令长度无效。");
      const controller = new AbortController();
      const cancel = () => controller.abort();
      parent?.addEventListener("abort", cancel, { once: true });
      if (parent?.aborted) cancel();
      const report = (text: string) => update?.({ content: [{ type: "text", text }], details: {} });
      let connection: SshConnection | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        report("等待确认服务器命令…");
        if (!await approve(profile, command, controller.signal) || controller.signal.aborted) throw new Error("用户未批准执行服务器命令。");
        report("正在连接服务器…");
        connection = await connectProfile(profile, controller.signal);
        timer = setTimeout(cancel, Math.min(Math.max(input.timeout ?? 40, 1), 120) * 1000);
        report("正在执行服务器命令…");
        const result = await runRemote(connection, command, controller.signal, report);
        const text = [result.stdout.trimEnd(), result.stderr.trimEnd(), `退出码 ${result.exitCode ?? "未返回"}`].filter(Boolean).join("\n");
        return { content: [{ type: "text", text }], details: { exitCode: result.exitCode ?? null } };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        parent?.removeEventListener("abort", cancel);
        if (connection) void connection.disconnect().catch(() => {});
      }
    },
  };
}
