import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { SshAuth, SshConnection } from "@osuki-dev/react-native-ssh";

export type SshProfile = {
  host: string; port: number; username: string; fingerprint: string;
  auth: Extract<SshAuth, { type: "password" | "privateKey" }>;
};
export type SshCommand = { host: string; port: number; username: string; command: string };
export type AuthorizeSsh = (request: SshCommand, signal: AbortSignal) => Promise<SshProfile | undefined>;

function sshHost(value: string) {
  const host = value.trim().replace(/^\[([0-9a-f:.]+)\]$/i, "$1");
  if (!/^[a-z0-9._-]+$/i.test(host) && !/^[0-9a-f:.]+:[0-9a-f:.]+$/i.test(host)) throw new Error("请填写服务器域名或 IP 地址。");
  return host;
}

export function normalizeSshProfile(profile: SshProfile): SshProfile {
  const host = sshHost(profile.host);
  const username = profile.username.trim();
  const fingerprint = profile.fingerprint.trim().replace(/=+$/, "");
  if (!username || /[\s\u0000-\u001f]/.test(username)) throw new Error("请填写有效的 SSH 用户名。");
  if (!Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535) throw new Error("端口必须在 1 到 65535 之间。");
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint)) throw new Error("请输入服务器的 SHA256 主机公钥指纹。");
  if (profile.auth.type === "password" ? !profile.auth.password : !profile.auth.privateKey.trim()) throw new Error("请输入密码或私钥。");
  return { ...profile, host, username, fingerprint };
}

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

type SshOutput = { stdout: string; stderr: string; exitCode: number | undefined };
const maxOutput = 48 * 1024;

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

export function createSshTools(authorize: AuthorizeSsh): AgentTool[] {
  return [{
    name: "ssh_exec", label: "服务器命令",
    replay: "never",
    description: "Run a command for a server administration task explicitly requested by the user. Use the host provided by the user. The app displays the exact command and collects login details locally for this execution. Returns stdout, stderr and exit code. Never request passwords or private keys in chat.",
    parameters: { type: "object", properties: { host: { type: "string", description: "User-provided SSH hostname or IP address." },
      port: { type: "integer", minimum: 1, maximum: 65535 }, username: { type: "string", description: "SSH username, if provided by the user." },
      command: { type: "string", minLength: 1, maxLength: 2000 }, timeout: { type: "integer", minimum: 1, maximum: 120 } },
      required: ["host", "command"], additionalProperties: false },
    async execute(_call, parameters, parent, update) {
      const input = parameters as { host: string; port?: number; username?: string; command: string; timeout?: number };
      const host = sshHost(input.host);
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
        const profile = await authorize({ host, port: input.port ?? 22, username: input.username ?? "", command }, controller.signal);
        if (!profile || controller.signal.aborted) throw new Error("用户未批准执行服务器命令。");
        report("正在连接服务器…");
        connection = await connectProfile(normalizeSshProfile(profile), controller.signal);
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
  }];
}
