import { useCallback, useEffect, useRef, useState } from "react";
import type { ThreadMessageLike } from "@assistant-ui/react-native";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { createLocalAgent, localUserMessage } from "./agent";
import { prepareUserMessage } from "./chat-attachments";
import { defaultProject, projectIO, workspaceSupported, type Project, type WorkspaceAttachment } from "./device-workspace";
import { createWorkspaceTools } from "./workspace-tools";
import { createSshTools, type AuthorizeSsh } from "./ssh";
import { toThreadMessages, toolFailed, type AgentPhase, type PartTiming, type ReplyTiming, type TimedAssistantMessage, type TimedToolResult, type ToolRun } from "./chat-messages";
import { newConversation, orderedConversations, replaceConversation, userTitle, type Conversation, type Workspace } from "./conversations";
import { resolveConnection, safeModelError, type ModelRef, type Provider } from "./model-catalog";
import { streamingFetch } from "./model-fetch";
import { checkpointMessages, loadMessages, openStorage, removeMessages, saveMessages, saveProviders, saveWorkspace } from "./storage";

type Snapshot = { workspace: Workspace; providers: Provider[] };
type Runtime = ReturnType<typeof createLocalAgent>;
type Session = { id: string; runtime: Runtime | null; transcript: AgentMessage[]; secret?: string; phase: AgentPhase;
  tools: Record<string, ToolRun>; thinking: ReplyTiming; detach?: () => void; refresh?: boolean;
  processing?: PartTiming; beforeTurn?: AgentMessage; clock?: number };
type ActiveRun = { owner: Session; controller: AbortController };

function currentConversation(workspace: Workspace): Conversation {
  const current = workspace.conversations.find((item) => item.id === workspace.activeId);
  if (!current) throw new Error("找不到当前会话。");
  return current;
}

export function useLocalChat(authorizeSsh: AuthorizeSsh) {
  const data = useRef<Snapshot | null>(null);
  const session = useRef<Session | null>(null);
  const activeRun = useRef<ActiveRun | null>(null);
  const editing = useRef(false);
  const writes = useRef(Promise.resolve());
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [messages, setMessages] = useState<ThreadMessageLike[]>([]);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [phase, setPhase] = useState<AgentPhase>("waiting");
  const [toolRuns, setToolRuns] = useState<Record<string, ToolRun>>({});
  const [processing, setProcessing] = useState<PartTiming>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retryCount, setRetryCount] = useState(0);

  const updateSnapshot = useCallback((next: Snapshot) => {
    data.current = next;
    setSnapshot(next);
  }, []);

  const transact = useCallback(<T,>(action: (current: Snapshot) => Promise<T>) => {
    const pending = writes.current.then(() => {
      if (!data.current) throw new Error("本地会话尚未就绪。");
      return action(data.current);
    });
    writes.current = pending.then(() => {}, () => {});
    return pending;
  }, []);

  const publish = useCallback((owner: Session, streaming: boolean) => {
    if (session.current !== owner) return;
    setPhase(owner.phase);
    setToolRuns(owner.tools);
    setProcessing(streaming ? owner.processing : undefined);
    const state = owner.runtime?.agent.state;
    const liveMessage = streaming && !!state && (state.streamingMessage !== undefined || state.messages.at(-1) !== owner.beforeTurn);
    setMessages(toThreadMessages(state?.messages ?? owner.transcript, state?.streamingMessage, liveMessage, owner.id, owner.secret, owner.thinking, owner.processing));
  }, []);

  const attach = useCallback((next: Snapshot, transcript: AgentMessage[]) => {
    const current = currentConversation(next.workspace);
    const background = activeRun.current?.owner;
    if (session.current !== background) session.current?.detach?.();
    if (current.id === background?.id) {
      session.current = background;
      updateSnapshot(next);
      publish(background, true);
      return;
    }
    const connection = resolveConnection(next.providers, current.model);
    const projectId = current.projectId ?? defaultProject;
    const tools = workspaceSupported() ? createWorkspaceTools(projectIO(projectId), projectId) : [];
    tools.push(...createSshTools(authorizeSsh));
    const owner: Session = { id: current.id, runtime: null, transcript, secret: connection?.apiKey, phase: "waiting", tools: {}, thinking: {} };
    const runtime = connection
      ? createLocalAgent({
        settings: connection, tools, thinking: current.thinking, projectName: current.projectName ?? "本机工作区",
        messages: transcript, fetch: streamingFetch, onCompaction: (active) => { owner.phase = active ? "compacting" : "waiting"; publish(owner, true); },
      })
      : null;

    owner.runtime = runtime;
    session.current = owner;
    if (runtime) {
      let checkpointAt = 0;
      const toolTiming = new Map<string, PartTiming>();
      function finishThinking(now: number) {
        for (const [index, part] of Object.entries(owner.thinking)) {
          if (part.completedAt === undefined) owner.thinking[Number(index)] = { ...part, completedAt: now };
        }
      }
      owner.detach = runtime.agent.subscribe(async (event, signal) => {
        if (event.type === "agent_start") {
          owner.tools = {};
          owner.phase = "waiting";
          checkpointAt = 0;
          toolTiming.clear();
        } else if (event.type === "turn_start") {
          owner.phase = "waiting";
        } else if (event.type === "message_start" && event.message.role === "assistant") {
          owner.thinking = {};
        } else if (event.type === "message_update") {
          const update = event.assistantMessageEvent;
          if (update.type === "thinking_start" || update.type === "thinking_delta") {
            owner.thinking[update.contentIndex] ??= { startedAt: Date.now() };
            owner.phase = "thinking";
          } else if (update.type === "thinking_end") {
            const timing = owner.thinking[update.contentIndex];
            if (timing && timing.completedAt === undefined) owner.thinking[update.contentIndex] = { ...timing, completedAt: Date.now() };
            owner.phase = "waiting";
          } else if (update.type === "text_start" || update.type === "text_delta") {
            finishThinking(Date.now()); owner.phase = "writing";
          } else if (update.type === "toolcall_start" || update.type === "toolcall_delta") {
            finishThinking(Date.now()); owner.phase = "tool";
          }
        } else if (event.type === "message_end" && event.message.role === "assistant") {
          finishThinking(Date.now());
          if (Object.keys(owner.thinking).length) (event.message as TimedAssistantMessage).lyraThinking = owner.thinking;
        } else if (event.type === "message_end" && event.message.role === "toolResult") {
          const timing = toolTiming.get(event.message.toolCallId);
          if (timing) (event.message as TimedToolResult).lyraTiming = timing;
        } else if (event.type === "tool_execution_start") {
          owner.phase = "tool";
          toolTiming.set(event.toolCallId, { startedAt: Date.now() });
          owner.tools = { ...owner.tools, [event.toolCallId]: { state: "running" } };
        } else if (event.type === "tool_execution_update") {
          const output = event.partialResult?.content?.find((part: { type: string; text?: string }) => part.type === "text")?.text;
          if (owner.tools[event.toolCallId]?.state === "running") owner.tools = { ...owner.tools, [event.toolCallId]: { state: "running", output } };
        } else if (event.type === "tool_execution_end") {
          const output = event.result?.content?.filter((part: { type: string; text?: string }) => part.type === "text")
            .map((part: { text?: string }) => part.text).join("\n") as string | undefined;
          const state = toolFailed(event.isError, event.result?.details) ? signal.aborted ? "cancelled" : "error" : "done";
          const timing = toolTiming.get(event.toolCallId);
          if (timing) toolTiming.set(event.toolCallId, { ...timing, completedAt: event.durationMs === undefined ? Date.now() : timing.startedAt + event.durationMs });
          owner.tools = { ...owner.tools, [event.toolCallId]: { state, duration: event.durationMs, output } };
        } else if (event.type === "agent_end") {
          owner.tools = Object.fromEntries(Object.entries(owner.tools).map(([id, run]) => [id, run.state === "running" ? { ...run, state: "cancelled" } : run]));
          const startedAt = owner.processing?.startedAt;
          const clock = owner.clock;
          if (startedAt !== undefined && clock !== undefined) {
            const timing = { startedAt, completedAt: startedAt + Math.max(0, performance.now() - clock) };
            for (let index = event.messages.length - 1; index >= 0; index--) {
              const message = event.messages[index];
              if (message === owner.beforeTurn || message.role === "user") break;
              if (message.role === "assistant") { (message as TimedAssistantMessage).lyraTurn = timing; break; }
            }
          }
        }
        const { messages: finalized, streamingMessage } = runtime.agent.state;
        publish(owner, event.type !== "agent_end");
        let checkpoint: AgentMessage[] | undefined;
        if ((event.type === "message_end" && event.message.role === "user") || (event.type === "turn_end" && event.toolResults.length)) checkpoint = finalized;
        else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta" && streamingMessage?.role === "assistant"
          && Date.now() - checkpointAt >= 4000) {
          checkpointAt = Date.now();
          checkpoint = [...finalized, { ...streamingMessage, content: streamingMessage.content.filter((part) => part.type === "text"),
            stopReason: "error", errorMessage: "上次回复中断，已保留收到的正文。" }];
        }
        if (checkpoint) {
          try { await checkpointMessages(current.id, checkpoint); }
          catch { /* The final save surfaces any persistent storage error. */ }
        }
      });
    }
    updateSnapshot(next);
    publish(owner, false);
  }, [authorizeSsh, publish, updateSnapshot]);

  useEffect(() => {
    let mounted = true;
    async function initialize() {
      setError("");
      try {
        const initial = await openStorage();
        const transcript = await loadMessages(initial.workspace.activeId);
        if (mounted) attach(initial, transcript);
      } catch (cause) {
        if (mounted) setError("读取本地数据失败：" + safeModelError(cause));
      }
    }
    void initialize();
    return () => {
      mounted = false;
      const run = activeRun.current;
      run?.controller.abort();
      run?.owner.runtime?.agent.abort();
      run?.owner.detach?.();
      if (session.current !== run?.owner) session.current?.detach?.();
    };
  }, [attach, retryCount]);

  async function edit<T>(run: (current: Snapshot) => Promise<T>) {
    if (!data.current || editing.current) throw new Error("请先结束当前设置操作。");
    editing.current = true;
    setBusy(true);
    setError("");
    try {
      return await transact(run);
    } finally {
      editing.current = false;
      setBusy(false);
    }
  }

  const run = useCallback(async (perform: (runtime: Runtime, conversation: Conversation, signal: AbortSignal) => Promise<boolean>, initialPhase: AgentPhase) => {
    const currentData = data.current;
    const owner = session.current;
    const active = owner?.runtime;
    if (!currentData || !owner || !active || activeRun.current || editing.current) return false;

    const conversation = currentConversation(currentData.workspace);
    const secret = owner.secret;
    const controller = new AbortController();
    activeRun.current = { owner, controller };
    setRunningId(owner.id);
    owner.phase = initialPhase;
    owner.beforeTurn = active.agent.state.messages.at(-1);
    owner.clock = performance.now();
    owner.processing = { startedAt: Date.now() };
    publish(owner, true);
    setError("");
    let prepared = false;
    try {
      prepared = await perform(active, conversation, controller.signal);
      if (!prepared) return false;
      const agentState = active.agent.state;
      const finalized = secret ? agentState.messages.map((message) => message.role === "assistant" && message.errorMessage
        ? { ...message, errorMessage: safeModelError(message.errorMessage, secret) }
        : message) : agentState.messages;
      const sessionError = agentState.errorMessage;
      if (session.current === owner && sessionError && !agentState.messages.some((message) => message.role === "assistant" && message.errorMessage === sessionError)) {
        setError(safeModelError(sessionError, secret));
      }
      await transact(async (latest) => {
        const existing = latest.workspace.conversations.find((item) => item.id === conversation.id);
        if (!existing) return;
        const updated = { ...existing, title: existing.title || userTitle(finalized) || "新对话", updatedAt: Date.now() };
        const workspace = replaceConversation(latest.workspace, updated);
        await saveMessages(workspace, conversation.id, finalized);
        updateSnapshot({ ...latest, workspace });
      });
      return true;
    } catch (cause) {
      if (session.current === owner && !controller.signal.aborted) setError(safeModelError(cause, secret));
      return prepared;
    } finally {
      activeRun.current = null;
      owner.processing = undefined;
      owner.beforeTurn = undefined;
      owner.clock = undefined;
      if (session.current !== owner) owner.detach?.();
      else if (owner.refresh && data.current) attach(data.current, active.agent.state.messages);
      else publish(owner, false);
      setRunningId(null);
    }
  }, [attach, publish, transact, updateSnapshot]);

  const send = useCallback((input: string, attachments: readonly WorkspaceAttachment[] = []) => {
    const text = input.trim();
    if (!text && !attachments.length) return Promise.resolve(false);
    return run(async (active, conversation, signal) => {
      const message = attachments.length ? await prepareUserMessage(conversation.projectId ?? defaultProject, text, attachments, signal,
        active.agent.state.model.input.includes("image")) : text;
      if (signal.aborted) return false;
      await active.send(message);
      return true;
    }, attachments.length ? "preparing" : "waiting");
  }, [run]);

  const regenerate = useCallback(() => run(async (active) => {
    const saved = active.agent.state.messages;
    if (!saved.some((message) => message.role === "assistant")) return false;
    let end = saved.length - 1;
    while (end >= 0 && saved[end].role !== "user" && saved[end].role !== "toolResult") end--;
    if (end < 0) return false;
    // Continue from completed tool results so rerunning a response does not repeat an already executed tool batch.
    active.agent.state.messages = saved.slice(0, end + 1);
    try { await active.agent.continue(); }
    catch (error) { active.agent.state.messages = saved; throw error; }
    return true;
  }, "waiting"), [run]);

  const continueReply = useCallback(() => run(async (active) => {
    const last = active.agent.state.messages.at(-1);
    if (last?.role !== "assistant" || (last.stopReason !== "length" && last.stopReason !== "error")) return false;
    const text = last.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
    if (!text.trim() && last.stopReason !== "length") return false;
    const context = last.stopReason === "error" ? "\n上次回复已收到的末尾：\n" + text.slice(-16_000) : "";
    await active.send(localUserMessage("继续回答", [{ type: "text", text: "接着上次回复的中断处继续，避免重复已输出的内容或已完成的工具操作。" + context }]));
    return true;
  }, "waiting"), [run]);

  function transcript() {
    return session.current?.runtime?.agent.state.messages ?? session.current?.transcript ?? [];
  }

  function refresh(next: Snapshot, retained = transcript()) {
    const owner = activeRun.current?.owner;
    if (owner && session.current === owner) {
      owner.refresh = true;
      updateSnapshot(next);
    } else attach(next, retained);
  }

  function openChat(id: string) {
    return edit(async (current) => {
      if (id === current.workspace.activeId) return;
      if (!current.workspace.conversations.some((conversation) => conversation.id === id)) return;
      const workspace = { ...current.workspace, activeId: id };
      const messagesForChat = await loadMessages(id);
      await saveWorkspace(workspace);
      attach({ ...current, workspace }, messagesForChat);
    });
  }

  function startChat() {
    return edit(async (current) => {
      const previous = currentConversation(current.workspace);
      const model = resolveConnection(current.providers, previous.model) === undefined ? null : previous.model;
      if (previous.id !== activeRun.current?.owner.id && !transcript().some((message) => message.role === "user") && !previous.title) return;
      const conversation = { ...newConversation(model), projectId: previous.projectId, projectName: previous.projectName, thinking: previous.thinking };
      const workspace = { activeId: conversation.id, conversations: [conversation, ...current.workspace.conversations] };
      await saveWorkspace(workspace);
      attach({ ...current, workspace }, []);
    });
  }

  function renameChat(id: string, title: string) {
    return edit(async (current) => {
      const conversation = current.workspace.conversations.find((item) => item.id === id);
      const cleaned = title.trim();
      if (!conversation || !cleaned) return;
      const workspace = replaceConversation(current.workspace, { ...conversation, title: cleaned });
      await saveWorkspace(workspace);
      updateSnapshot({ ...current, workspace });
    });
  }

  function deleteChat(id: string) {
    return edit(async (current) => {
      if (id === activeRun.current?.owner.id) throw new Error("请先停止这段对话正在运行的任务。");
      const remaining = current.workspace.conversations.filter((item) => item.id !== id);
      if (remaining.length === current.workspace.conversations.length) return;
      if (id === current.workspace.activeId) {
        const model = currentConversation(current.workspace).model;
        const next = orderedConversations(remaining)[0]
          ?? newConversation(resolveConnection(current.providers, model) === undefined ? null : model);
        const workspace = { activeId: next.id, conversations: remaining.length ? remaining : [next] };
        const nextMessages = await loadMessages(next.id);
        await saveWorkspace(workspace);
        attach({ ...current, workspace }, nextMessages);
      } else {
        const workspace = { ...current.workspace, conversations: remaining };
        await saveWorkspace(workspace);
        updateSnapshot({ ...current, workspace });
      }
      await removeMessages(id);
    });
  }

  function chooseModel(model: ModelRef) {
    return edit(async (current) => {
      if (resolveConnection(current.providers, model) === undefined) throw new Error("模型已移除，请重新选择。");
      const workspace = replaceConversation(current.workspace, { ...currentConversation(current.workspace), model });
      await saveWorkspace(workspace);
      refresh({ ...current, workspace });
    });
  }

  function chooseProject(project: Project) {
    return edit(async (current) => {
      const conversation = currentConversation(current.workspace);
      if (conversation.id === activeRun.current?.owner.id) throw new Error("请在当前任务完成后切换它的工作区。");
      const workspace = replaceConversation(current.workspace, { ...conversation, projectId: project.id, projectName: project.name });
      await saveWorkspace(workspace);
      attach({ ...current, workspace }, transcript());
    });
  }

  function chooseThinking(thinking: ThinkingLevel) {
    return edit(async (current) => {
      const workspace = replaceConversation(current.workspace, { ...currentConversation(current.workspace), thinking });
      await saveWorkspace(workspace);
      refresh({ ...current, workspace });
    });
  }

  function updateProvider(provider: Provider, selected: ModelRef) {
    return edit(async (current) => {
      const providers = current.providers.some((item) => item.id === provider.id)
        ? current.providers.map((item) => item.id === provider.id ? provider : item)
        : [...current.providers, provider];
      await saveProviders(providers);

      const previous = currentConversation(current.workspace);
      const model = selected ?? previous.model;
      const workspace = replaceConversation(current.workspace, { ...previous, model });
      const retained = transcript();
      if (activeRun.current) activeRun.current.owner.refresh = true;
      try {
        await saveWorkspace(workspace);
        refresh({ providers, workspace }, retained);
      } catch (cause) {
        refresh({ providers, workspace: current.workspace }, retained);
        throw cause;
      }
    });
  }

  function deleteProvider(id: string) {
    return edit(async (current) => {
      const providers = current.providers.filter((item) => item.id !== id);
      await saveProviders(providers);
      if (activeRun.current) activeRun.current.owner.refresh = true;
      refresh({ ...current, providers });
    });
  }

  const current = snapshot ? currentConversation(snapshot.workspace) : null;
  const providers = snapshot?.providers ?? [];
  function stop() {
    const active = activeRun.current;
    if (active?.owner !== session.current || !active) return;
    active.controller.abort();
    active.owner.runtime?.agent.abort();
  }

  function steer(input: string) {
    const active = session.current?.runtime?.agent;
    const text = input.trim();
    if (!active?.signal || active.signal.aborted || !text) return false;
    active.steer({ role: "user", content: text, timestamp: Date.now() });
    return true;
  }
  return {
    ready: snapshot !== null,
    canSend: current !== null && !!resolveConnection(providers, current.model),
    current,
    providers,
    conversations: snapshot ? orderedConversations(snapshot.workspace.conversations) : [],
    messages, running: runningId !== null && runningId === current?.id, runningElsewhere: runningId !== null && runningId !== current?.id,
    runningId, busy, error, phase, toolRuns, processing,
    send, regenerate, continueReply, steer, stop, retry: () => setRetryCount((count) => count + 1),
    startChat, openChat, renameChat, deleteChat, chooseModel, chooseProject, chooseThinking, updateProvider, deleteProvider,
  };
}
