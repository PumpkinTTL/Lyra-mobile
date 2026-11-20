import { useCallback, useEffect, useRef, useState } from "react";
import type { ThreadMessageLike } from "@assistant-ui/react-native";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { createLocalAgent } from "./agent";
import { prepareUserMessage } from "./chat-attachments";
import { defaultProject, projectIO, workspaceSupported, type Project, type WorkspaceAttachment } from "./device-workspace";
import { createWorkspaceTools } from "./workspace-tools";
import { toThreadMessages, type AgentPhase, type ToolRun } from "./chat-messages";
import { newConversation, orderedConversations, replaceConversation, userTitle, type Conversation, type Workspace } from "./conversations";
import { resolveConnection, safeModelError, type ModelRef, type Provider } from "./model-catalog";
import { streamingFetch } from "./model-fetch";
import { loadMessages, openStorage, removeMessages, saveMessages, saveProviders, saveWorkspace } from "./storage";

type Snapshot = { workspace: Workspace; providers: Provider[] };
type Runtime = ReturnType<typeof createLocalAgent>;
type Session = { runtime: Runtime | null; transcript: AgentMessage[] };

function currentConversation(workspace: Workspace): Conversation {
  const current = workspace.conversations.find((item) => item.id === workspace.activeId);
  if (!current) throw new Error("找不到当前会话。");
  return current;
}

export function useLocalChat() {
  const data = useRef<Snapshot | null>(null);
  const session = useRef<Session | null>(null);
  const unsubscribe = useRef<(() => void) | undefined>(undefined);
  const working = useRef(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [messages, setMessages] = useState<ThreadMessageLike[]>([]);
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<AgentPhase>("waiting");
  const [toolRuns, setToolRuns] = useState<Record<string, ToolRun>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retryCount, setRetryCount] = useState(0);

  const updateSnapshot = useCallback((next: Snapshot) => {
    data.current = next;
    setSnapshot(next);
  }, []);

  const attach = useCallback((next: Snapshot, transcript: AgentMessage[]) => {
    unsubscribe.current?.();
    const current = currentConversation(next.workspace);
    const connection = resolveConnection(next.providers, current.model);
    const projectId = current.projectId ?? defaultProject;
    const tools = workspaceSupported() ? createWorkspaceTools(projectIO(projectId)) : [];
    const runtime = connection
      ? createLocalAgent({
        settings: connection, tools, thinking: current.thinking, projectName: current.projectName ?? "本机工作区",
        messages: transcript, fetch: streamingFetch,
      })
      : null;

    session.current = { runtime, transcript };
    setToolRuns({});
    setPhase("waiting");
    if (runtime) {
      unsubscribe.current = runtime.agent.subscribe((event) => {
        if (event.type === "message_update") {
          const kind = event.assistantMessageEvent.type;
          if (kind === "thinking_start" || kind === "thinking_delta") setPhase("thinking");
          else if (kind === "text_start" || kind === "text_delta") setPhase("writing");
          else if (kind === "toolcall_start" || kind === "toolcall_delta") setPhase("tool");
        } else if (event.type === "tool_execution_start") {
          setPhase("tool");
          setToolRuns((runs) => ({ ...runs, [event.toolCallId]: { state: "running" } }));
        } else if (event.type === "tool_execution_update") {
          const output = event.partialResult?.content?.find((part: { type: string; text?: string }) => part.type === "text")?.text;
          setToolRuns((runs) => ({ ...runs, [event.toolCallId]: { state: "running", output } }));
        } else if (event.type === "tool_execution_end") {
          setToolRuns((runs) => ({ ...runs, [event.toolCallId]: { state: event.isError ? "error" : "done", duration: event.durationMs } }));
        }
        const { messages: finalized, streamingMessage } = runtime.agent.state;
        setMessages(toThreadMessages(finalized, streamingMessage, true, current.id, connection?.apiKey));
      });
    }
    setMessages(toThreadMessages(transcript, undefined, false, current.id, connection?.apiKey));
    updateSnapshot(next);
  }, [updateSnapshot]);

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
      unsubscribe.current?.();
      session.current?.runtime?.agent.abort();
    };
  }, [attach, retryCount]);

  async function edit<T>(run: (current: Snapshot) => Promise<T>) {
    if (!data.current || working.current) throw new Error("请先结束当前操作。");
    working.current = true;
    setBusy(true);
    setError("");
    try {
      return await run(data.current);
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  const send = useCallback(async (input: string, attachments: readonly WorkspaceAttachment[] = []) => {
    const currentData = data.current;
    const active = session.current?.runtime;
    const text = input.trim();
    if (!currentData || !active || working.current || (!text && !attachments.length)) return false;

    const conversation = currentConversation(currentData.workspace);
    const secret = resolveConnection(currentData.providers, conversation.model)?.apiKey;
    working.current = true;
    setRunning(true);
    setPhase("waiting");
    setError("");
    let prepared = false;
    try {
      const message = attachments.length ? await prepareUserMessage(conversation.projectId ?? defaultProject, text, attachments) : text;
      prepared = true;
      await active.send(message);
      const agentState = active.agent.state;
      const finalized = secret ? agentState.messages.map((message) => message.role === "assistant" && message.errorMessage
        ? { ...message, errorMessage: safeModelError(message.errorMessage, secret) }
        : message) : agentState.messages;
      const sessionError = agentState.errorMessage;
      if (sessionError && !agentState.messages.some((message) => message.role === "assistant" && message.errorMessage === sessionError)) {
        setError(safeModelError(sessionError, secret));
      }
      const updated = {
        ...conversation,
        title: conversation.title || userTitle(finalized) || "新对话",
        updatedAt: Date.now(),
      };
      const workspace = replaceConversation(currentData.workspace, updated);
      await saveMessages(workspace, conversation.id, finalized);
      updateSnapshot({ ...currentData, workspace });
      return true;
    } catch (cause) {
      setError(safeModelError(cause, secret));
      return prepared;
    } finally {
      working.current = false;
      setMessages(toThreadMessages(active.agent.state.messages, undefined, false, conversation.id, secret));
      setRunning(false);
    }
  }, [updateSnapshot]);

  function transcript() {
    return session.current?.runtime?.agent.state.messages ?? session.current?.transcript ?? [];
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
      if (!transcript().some((message) => message.role === "user") && !previous.title) return;
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
      attach({ ...current, workspace }, transcript());
    });
  }

  function chooseProject(project: Project) {
    return edit(async (current) => {
      const conversation = currentConversation(current.workspace);
      const workspace = replaceConversation(current.workspace, { ...conversation, projectId: project.id, projectName: project.name });
      await saveWorkspace(workspace);
      attach({ ...current, workspace }, transcript());
    });
  }

  function chooseThinking(thinking: ThinkingLevel) {
    return edit(async (current) => {
      const workspace = replaceConversation(current.workspace, { ...currentConversation(current.workspace), thinking });
      await saveWorkspace(workspace);
      attach({ ...current, workspace }, transcript());
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
      try {
        await saveWorkspace(workspace);
        attach({ providers, workspace }, retained);
      } catch (cause) {
        attach({ providers, workspace: current.workspace }, retained);
        throw cause;
      }
    });
  }

  function deleteProvider(id: string) {
    return edit(async (current) => {
      const providers = current.providers.filter((item) => item.id !== id);
      await saveProviders(providers);
      attach({ ...current, providers }, transcript());
    });
  }

  const current = snapshot ? currentConversation(snapshot.workspace) : null;
  const providers = snapshot?.providers ?? [];
  const stopped = () => session.current?.runtime?.agent.abort();
  return {
    ready: snapshot !== null,
    canSend: current !== null && !!resolveConnection(providers, current.model),
    current,
    providers,
    conversations: snapshot ? orderedConversations(snapshot.workspace.conversations) : [],
    messages, running, busy, error, phase, toolRuns,
    send, stop: stopped, retry: () => setRetryCount((count) => count + 1),
    startChat, openChat, renameChat, deleteChat, chooseModel, chooseProject, chooseThinking, updateProvider, deleteProvider,
  };
}
